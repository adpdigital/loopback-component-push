
var inherits = require('util').inherits;
var extend = require('util')._extend;
var EventEmitter = require('events').EventEmitter;
var gcm = require('node-gcm');
var Queue = require('fastq');

var debug = require('debug')('loopback:component:push:provider:gcm');

function GcmProvider(pushSettings, app) {
  this.app = app;
  this.appId = pushSettings.appId;
  var settings = pushSettings.gcm || {};
  this.currentLength = 0;

  let shuttedDown = false
  const that = this

  app.emit('shutdownable', {
    name: 'FCMQueue-' + this.appId,
    service: this
  })

  this._queue = Queue(this.sender.bind(this), settings.concurrency || 1000);

  app.on('shutdown', function () {
    console.log('Shutting down FCMQueue idle=', that._queue.idle())
    shuttedDown = true
    if (that._queue.idle()) {
      app.emit('shutdownReady', {
        name: 'FCMQueue-' + that.appId,
        service: that
      })
    } else {
      that._queue.drain = function () {
        if (shuttedDown) {
          console.log('FCMQueue empty, let it shutdown')
          app.emit('shutdownReady', {
            name: 'FCMQueue-' + that.appId,
            service: that
          })
        }
      }
    }
  })

  setInterval(function(){
    this.app.statsD && this.app.statsD.gauge(['app', this.appId, 'gcm', 'queue'].join('.'), this._queue.length())
    const rate = (this.currentLength - this._queue.length()) / 5
    this.currentLength = this._queue.length()
    if (rate !== 0) {
      console.log('FCM queue[%s] rate=%s msg/sec', this.currentLength, rate)
    }
  }.bind(this), 5000)
  this._setupPushConnection(settings);
}

inherits(GcmProvider, EventEmitter);

exports = module.exports = GcmProvider;

GcmProvider.prototype._setupPushConnection = function(options) {
  console.log('Setting up GCM-HTTP for "%s" with api_key=%s', this.appId, options.serverApiKey, options.concurrency)
  this._connection = new gcm.Sender(options.serverApiKey);
  this.counter = 0
};

GcmProvider.prototype.pushNotification = function(notification, deviceToken, installation, cb) {
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

  debug('Queueing FCM message to %j: %j', to, notification);

  self._queue.push({
    note: message,
    notification: notification,
    deviceToken: to
  }, function(err, result){
    // all handling is done inside sender function worker
    cb && cb()
  });
};

GcmProvider.prototype.sender = function (item, callback) {
  var self = this
  if (item.notification && item.notification.statsClbk) {
    item.notification.statsClbk()
    return callback()
  }

  let count = 1
  if (item.deviceToken.registrationTokens) {
    count = item.deviceToken.registrationTokens.length
  }
  this.app.statsD && this.app.statsD.increment(['app', this.appId, 'gcm', 'submit'].join('.'), count);

  // debug(`Pushing FCM-HTTP to ${item.deviceToken} app=[${this.appId}]`, item.note)

  this._connection.send(item.note, item.deviceToken, 2, function (err, result) {
    debug('>>>>>>>>>>>>>>>>>>>>>> {FCM-SENT}', err, result)
    item.notification.android = true
    if (err) {
      console.error('FCM-HTTP cannot send message ', err, item.notification.messageId, item.notification.deviceId);

      // item.notification.message_id = item.notification.messageId;

      // TODO recipient is multi tokens? How should be item.deviceToken handled upward?
      var recipients = item.deviceToken.topic || item.deviceToken.registrationTokens
      recipients.forEach(function (token) {
        debug('>>>>>>>>>>> [FCM-MODE] transmissionError before send', item.notification, recipients, err)
        if (err === 401) {
          err = new Error('Unauthorized')
        } else if (!err.message) {
          err = new Error(err)
        }
        self.app.statsD && self.app.statsD.increment(['app', self.appId, 'gcm', 'fail'].join('.'), count)
        self.emit('transmissionError', err, item.notification, token, item.notification);
      })

      self.emit('error', err);

      callback(err, result)
      return;
    }

    debug('FCM-HTTP result: %j', result);

    var devicesGoneRegistrationIds = [], code;
    result.results
      .map(function(value, index){
        if (value.error) {
          self.app.statsD && self.app.statsD.increment(['app', self.appId, 'gcm', 'fail'].join('.'));
          code = value && value.error;
          if (code === 'NotRegistered') {
            devicesGoneRegistrationIds.push(item.deviceToken.registrationTokens[index]);
          }
          debug('>>>>>>>>>>> [FCM-MODE] transmissionError after send', item.notification, item.deviceToken.registrationTokens[index])
          self.emit('transmissionError', new Error(code), item.notification, item.deviceToken.registrationTokens[index], item.notification)
        } else {
          self.app.statsD && self.app.statsD.increment(['app', self.appId, 'gcm', 'sent'].join('.'));
          debug('>>>>>>>>>>> [FCM-MODE] transmitted', item.note, item.notification.messageId || value.message_id, item.notification)
          self.emit("transmitted", item.note, item.notification.messageId || value.message_id, item.notification);
        }
      })

    if (devicesGoneRegistrationIds.length > 0) {
      self.emit('devicesGone', devicesGoneRegistrationIds);
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
