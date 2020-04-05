var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var gcm = require('node-gcm');
var Queue = require('fastq');

function GcmProvider(pushManager, app, pushSettings) {
  this.pushManager = pushManager;
  this.app = app;
  this.appId = pushSettings.appId;
  var settings = pushSettings.gcm || {};
  this.currentLength = 0;
  this._queue = Queue(this.sender.bind(this), settings.concurrency || 1000);
  setInterval(function(){
    this.app.statsD && this.app.statsD.gauge(['app', this.appId, 'gcm', 'queue'].join('.'), this._queue.length())
    const rate = (this.currentLength - this._queue.length()) / 5
    this.currentLength = this._queue.length()
    if (rate !== 0) {
      this.app.log.info({length: this.currentLength, rate}, 'GCM-HTTP queue msg/sec')
    }
  }.bind(this), 5000)
  this._setupPushConnection(settings);
}

inherits(GcmProvider, EventEmitter);

exports = module.exports = GcmProvider;

GcmProvider.prototype._setupPushConnection = function(options) {
  this.app.log.info({appId: this.appId, serverApiKey: options.serverApiKey}, 'Setting up GCM-HTTP')
  this._connection = new gcm.Sender(options.serverApiKey);
  this.counter = 0
};

GcmProvider.prototype.pushNotification = async function(notification, deviceToken, installation, cb) {
  var self = this;
  var to;
  var length = 1
  if( deviceToken && deviceToken.topic ) {
    to = { topic: deviceToken.topic };
  } else {
    var registrationIds = (typeof deviceToken === 'string') ? [deviceToken] : deviceToken;
    to = {registrationTokens: registrationIds};
    length = registrationIds.length
  }

  if( notification.priority === 10) {
    notification.priority = 'high';
  }

  var message = this._createMessage(notification);

  self.app.statsD && self.app.statsD.increment(['app', self.appId, 'gcm', 'request'].join('.'), length);

  if (self.app.dedup && notification.trackId && message.messageId && to.registrationTokens) {
    let newTo = {registrationTokens: []}
    for (const registrationId of to.registrationTokens) {
      const exists = await self.app.dedup(self.appId, `${notification.trackId}-${message.messageId}`, registrationId)
      if (!exists) {
        newTo.registrationTokens.push(registrationId)
      } else {
        // todo pass up notif dedupped event
      }
    }
    to = newTo
  }

  if (to.topic || to.registrationTokens.length > 0) {
    self.app.log.debug({to, notification}, 'Queueing FCM message')
    self.addToQueue(message, notification, to, cb)
  } else {
    self.app.log.warn({notification, deviceToken, installation, to}, 'Empty FCM token?')
  }
}

GcmProvider.prototype.addToQueue = function (message, notification, to, cb = _ => {}) {
  this._queue.push({
    note: message,
    notification: notification,
    deviceToken: to
  }, cb)
}

GcmProvider.prototype.sender = function (item, callback) {
  var self = this
  if (this.pushManager && this.pushManager.isCancelled(item.notification)) {
    this.app.log.warn({trackId: item.notification.trackId, appId: this.appId}, 'ignoring cancelled push')
    return callback()
  }

  if (item.notification && item.notification.statsClbk) {
    item.notification.statsClbk()
    return callback()
  }

  let count = 1
  if (item.deviceToken.registrationTokens) {
    count = item.deviceToken.registrationTokens.length
  }
  this.app.statsD && this.app.statsD.increment(['app', this.appId, 'gcm', 'submit'].join('.'), count);

  this.app.log.debug({deviceToken: item.deviceToken, appId: this.appId, note: item.note}, `Pushing FCM-HTTP`)

  this._connection.send(item.note, item.deviceToken, {retries: 3, backoff: 3000}, function (err, result) {
    item.notification.android = true
    if (err) {
      self.app.log.error({err, result, messageId: item.notification.messageId, deviceId: item.notification.deviceId}, 'FCM-HTTP cannot send message')
      // item.notification.message_id = item.notification.messageId;
      // TODO recipient is multi tokens? How should be item.deviceToken handled upward?
      var recipients = item.deviceToken.topic || item.deviceToken.registrationTokens
      recipients.forEach(function (token) {
        self.app.log.debug({notification: item.notification, recipients, err}, '[FCM-HTTP] transmissionError before send')
        if (err === 401) {
          err = new Error('Unauthorized')
        } else if (!err.message) {
          err = new Error(err)
        }
        self.app.statsD && self.app.statsD.increment(['app', self.appId, 'gcm', 'fail'].join('.'), count)
        self.emit('transmissionError', err, item.notification, token, item.notification);
      })

      if (!isNaN(err)) {
        err = {message: err+''}
      }
      self.emit('error', err);

      callback(err, result)
      return;
    } else {
      self.app.log.debug({result}, 'FCM-HTTP OK')
    }
    var devicesGoneRegistrationIds = [], code;
    result.results
      .map(function(value, index){
        if (value.error) {
          self.app.statsD && self.app.statsD.increment(['app', self.appId, 'gcm', 'fail'].join('.'));
          code = value && value.error;
          if (code === 'NotRegistered') {
            devicesGoneRegistrationIds.push(item.deviceToken.registrationTokens[index]);
          }
          self.app.log.debug({notification: item.notification, registrationTokens: item.deviceToken.registrationTokens[index]}, '[FCM-HTTP] transmissionError after send')
          self.emit('transmissionError', new Error(code), item.notification, item.deviceToken.registrationTokens[index], item.notification)
        } else {
          self.app.statsD && self.app.statsD.increment(['app', self.appId, 'gcm', 'sent'].join('.'));
          self.app.log.debug({note: item.note, messageId: item.notification.messageId || value.message_id, notification: item.notification}, '[FCM-HTTP] transmitted')
          self.emit("transmitted", item.note, item.notification.messageId || value.message_id, item.notification);
        }
      })

    if (devicesGoneRegistrationIds.length > 0) {
      self.emit('devicesGone', devicesGoneRegistrationIds, item.notification);
    }
    callback(err, result)
  });
};


GcmProvider.prototype._createMessage = function(notification) {
  // Message parameters are documented here: https://developers.google.com/cloud-messaging/server-ref
  var self = this
  var msgId = notification.messageId + ':' + notification.deviceId + ':' + (++self.counter)

  var msg = {
    priority: notification.priority || 'normal',
    timeToLive: notification.getTimeToLiveInSecondsFromNow(),
    // restrictedPackageName: '',
    dryRun: notification.dryRun || false,
    collapseKey: notification.collapseKey,
    delayWhileIdle: notification.delayWhileIdle || false
  }

  if (notification.groupId) {
    msg.collapseKey = notification.groupId
    delete notification.groupId
  }

  var message = new gcm.Message(msg);

  Object.keys(notification).forEach(function (key) {
    if (notification[key] !== null && typeof notification[key] !== 'undefined') {
      message.addData(key, notification[key]);
    }
  });

  if (notification.sound && notification.sound.length > 0) {
    message.addData('sound', notification.sound);
  }

  //.addData("title", notification.title)
  //     .addData("sound", notification.sound)
  //     .addData("mediaType", notification.mediaType)
  //     .addData("color", notification.color)
  //     .addData("mediaUrl", notification.mediaUrl)
  //     .addData("actions", notification.actions)
  //     .addData("message", notification.message || notification.body)
  //     .addData("messageId", notification.messageId)
  //     .addData("deviceId", notification.deviceId)
  //     .addData("push", notification.push)
  //     .addData("data", notification.data)
  //     .addData("live", notification.live)
  //     .addData("androidBadge", notification.androidBadge)
  //     .addData("ledColor", notification.ledColor)
  //     .addData("smallIcon", notification.smallIcon)
  //     .addData("trackId", notification.trackId)
  //     .addData('clickUrl', notification.clickUrl);


  if (notification.autoNotify) {
    message.addNotification({
      title: notification.title ? notification.title : notification.message || notification.body,
      body: notification.body || notification.message,
      icon: notification.messageIcon,
      badge: notification.androidBadge,
      sound: notification.sound,
      tag: notification.tag,
      color: notification.color,
      click_action: '',
    });
  }

  message.android = true
  message.messageId = notification.messageId

  return message;
};
