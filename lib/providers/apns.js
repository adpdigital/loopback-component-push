var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var debug = require('debug')('loopback:component:push:provider:apns');
var apn = require('apn');
var Queue = require('fastq');


function ApnsProvider(pushSettings, app) {
  this.app = app;
  pushSettings = pushSettings || {};
  var apnSettings = pushSettings.apns || {};
  this.appId = pushSettings.appId;
  this._pushOptions = {};

  if (apnSettings.certData || apnSettings.cert) {
    this._pushOptions.cert = apnSettings.certData || apnSettings.cert;
  }
  if (apnSettings.keyData || apnSettings.key) {
    this._pushOptions.key = apnSettings.keyData || apnSettings.key;
  }
  if (apnSettings.token) {
    this._pushOptions.token = apnSettings.token;
  }

  if (apnSettings.teamId && apnSettings.keyId && apnSettings.p8Data) {
    this._pushOptions.token = {
      key: apnSettings.p8Data,
      keyId: apnSettings.keyId,
      teamId: apnSettings.teamId
    }
  }

  if (this._pushOptions.token) {
    delete this._pushOptions.cert
    delete this._pushOptions.key
  }

  this._pushOptions.production = apnSettings.production || false;

  if (apnSettings.bundleId) {
    this._pushOptions.bundleId = apnSettings.bundleId;
  }
  if (apnSettings.connectionRetryLimit) {
    this._pushOptions.connectionRetryLimit = apnSettings.connectionRetryLimit;
  }
  if (apnSettings.heartBeat) {
    this._pushOptions.heartBeat = apnSettings.heartBeat;
  }

  if (!this._pushOptions.token && !this._pushOptions.cert && !this._pushOptions.key) {
    return this.emit('error', 'APNs certificate or token not set, either set one of token, cert/key fields');
  }

  this.apnSettings = apnSettings
  this.concurrency = apnSettings.concurrency || 1000;
// this.maxConnections = apnSettings.maxConnections || 1;
  this.maxConnections = 1;
  this._connections = [];
  this._current = 0;
  this.currentLength = 0;

  this._queue = Queue(this.sender.bind(this), this.maxConnections * this.apnSettings);
  setInterval(function () {
    this.app.statsD && this.app.statsD.gauge(['app', this.appId, 'apn', 'queue'].join('.'), this._queue.length())
    const rate = (this.currentLength - this._queue.length()) / 5
    this.currentLength = this._queue.length()
    if (rate !== 0) {
      console.log('APNS queue[%s] rate=%s msg/sec', this.currentLength, rate)
    }
  }.bind(this), 5000)
  for (var i = 0; i < this.maxConnections; i++) {
    this.addConnection(i)
  }

  var self = this
  setInterval(function () {
    self.reInitConnections()
  }, 1000 * 60 * 58)
}

inherits(ApnsProvider, EventEmitter);


exports = module.exports = ApnsProvider;


ApnsProvider.prototype.pushNotification = function (notification, deviceToken, installation, cb) {
  var self = this;

// Note parameters are described here:
// http://bit.ly/apns-notification-payload
  var note = new apn.Notification();

  note.alert = notification.alert;
  note.badge = notification.badge;
  note.sound = notification.sound;
  if (notification.body) note.body = notification.body;
  if (notification.locKey) note.locKey = notification.locKey;
  if (notification.locArgs) note.locArgs = notification.locArgs;
  if (notification.title) note.title = notification.title;
  if (notification.titleLocKey) note.titleLocKey = notification.titleLocKey;
  if (notification.titleLocArgs) note.titleLocArgs = notification.titleLocArgs;
  if (notification.action) note.action = notification.action;
  if (notification.actionLocKey) note.actionLocKey = notification.actionLocKey;
  if (notification.launchImage) note.launchImage = notification.launchImage;
  if (notification.clickUrl) note.clickUrl = notification.clickUrl;
  if (notification.groupId) note.groupId = notification.groupId;

// 0 indicates that the notification expires immediately
  note.expiry = notification.getTimeToLiveInSecondsFromNow() || note.expiry;
  note.priority = note.contentAvailable === 1 ? 5 : notification.priority;
  note.category = notification.category;
  note.collapseId = notification.collapseId; //displayed to the user as a single notification
  note.threadId = notification.threadId; //visually groups notifications
  note.contentAvailable = notification.contentAvailable;
  note.mutableContent = notification.mutableContent;
  note.urlArgs = notification.urlArgs;
  note.mdm = notification.mdm;

  note.errorCallback = notification.errorCallback;

  note.payload = {};
  Object.keys(notification).forEach(function (key) {
    note.payload[key] = notification[key];
  });

  if (this._pushOptions.bundleId) {
    note.topic = this._pushOptions.bundleId;
  }

  if (installation.appBundleId) {
    note.topic = installation.appBundleId
  }

  note.ios = true

  this.app.statsD && this.app.statsD.increment(['app', this.appId, 'apn', 'request'].join('.'));

  this._queue.push({
    note: note,
    notification: notification,
    deviceToken: deviceToken
  }, function (err, result) {
    cb()

    if (err) {
      self.emit('error', err);
      self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'error'].join('.'));
      return console.error('WOW! what the hell out of apn? ', err);
    }
    if (!result && notification.statsClbk) {
      self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'sent'].join('.'));
      return
    }
    result.sent.map(function (s) {
      self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'sent'].join('.'));
      debug('Sent APN to %s messageId=%s ', note.payload.deviceId, note.payload.messageId);
      self.emit("transmitted", note, s.device, notification);
    });

    result.failed.map(function (e) {
      if (e.error) {
        self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'error'].join('.'));
        debug('apn error ', JSON.stringify(e));
        self.emit('error', e, notification);

      } else if (e.status && e.response) {
        self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'fail'].join('.'));
        debug('apn failed ', JSON.stringify(e));
        self.emit('transmissionError', e, note, e.device, notification);

        if (e.status === '410') { //Unregistered
          self.emit('devicesGone', [e.device], notification);
        }
      }
    });
  });
};

ApnsProvider.prototype.sender = function (item, callback) {
  if (item.notification && item.notification.statsClbk) {
    item.notification.statsClbk()
    return callback()
  }
  this.app.statsD && this.app.statsD.increment(['app', this.appId, 'apn', 'submit'].join('.'));
  debug('Pushing APN to [%s] app=[%s] ', item.deviceToken, item.note.topic, item.note);
  this._connections[this._current++ % this.maxConnections]
      .send(item.note, item.deviceToken)
      .then(function (result) {
        callback(null, result);
      })
      .catch(callback);
};

ApnsProvider.prototype.reInitConnections = function () {
  var self = this
  var current = this._connections.length

  for (var i = 0; i < current; i++) {
    var c = this._connections.shift()
    c.shutdown()
    self.addConnection(i)
  }
};

ApnsProvider.prototype.on('shutdown-connections', function() {
  if (this._connections) {
    for (var i=0 ; i < this._connections.length; i++) {
      this._connections[i].shutdown()
    }
    this._connections = []
  }
})

ApnsProvider.prototype.addConnection = function (i) {
  console.log(
      'Setting up APNS connection [%s of %s] with concurrency %s for %s',
      i+1, this.maxConnections, this.concurrency, this.appId)

  this._connections.push(new apn.Provider(this._pushOptions));
}
