var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var apn = require('@parse/node-apn');
var Queue = require('fastq');

EventEmitter.defaultMaxListeners = 1000;

function ApnsProvider(pushManager, app, pushSettings) {
  this.pushManager = pushManager;
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
    this.emit('error', 'APNs certificate or token not set, either set one of token, cert/key fields');
    return
  }

  this.apnSettings = apnSettings
  this.concurrency = apnSettings.concurrency || 2000
  this.maxConnections = 1 // apnSettings.maxConnections || 1
  this._connections = [];
  this._current = 0;
  this.currentLength = 0;

  this._queue = Queue(this.sender.bind(this), this.concurrency)
  setInterval(function () {
    this.app.statsD && this.app.statsD.gauge(['app', this.appId, 'apn', 'queue'].join('.'), this._queue.length())
    const rate = -(this.currentLength - this._queue.length()) / 5
    this.currentLength = this._queue.length()
    if (rate !== 0) {
      this.app.log.info({length: this.currentLength, rate}, 'APN queue msg/sec')
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
  if (notification.notifDelivery) note.notifDelivery = notification.notifDelivery;
  if (notification.disableLocalNotif) note.disableLocalNotif = notification.disableLocalNotif;
  if (notification.fromChabok) note.fromChabok = notification.fromChabok;

// 0 indicates that the notification expires immediately
  note.expiry = notification.getTimeToLiveInSecondsFromNow() || note.expiry;
  note.priority = note.contentAvailable === 1 ? 5 : notification.priority;
  note.category = notification.category;
  note.collapseId = notification.collapseId; //displayed to the user as a single notification
  note.threadId = notification.threadId; //visually groups notifications
  if (notification.groupId) {
    note.threadId = notification.groupId;
  }

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
      return self.app.log.error({err}, 'WOW! what the hell out of apn?');
    }
    if (!result && notification.statsClbk) {
      self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'sent'].join('.'));
      return
    }
    result.sent.map(function (s) {
      self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'sent'].join('.'));
      self.app.log.debug({deviceId: note.payload.deviceId, messageId: note.payload.messageId}, 'Sent APN')
      self.emit("transmitted", note, s.device, notification);
    });

    result.failed.map(function (e) {
      if (e.error) {
        self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'error'].join('.'));
        self.app.log.error({e}, 'apn error');
        self.emit('error', e, notification);

      } else if (e.status && e.response) {
        self.app.statsD && self.app.statsD.increment(['app', self.appId, 'apn', 'fail'].join('.'));
        self.app.log.debug({e}, 'apn failed');
        self.emit('transmissionError', e, note, e.device, notification);

        if (e.status === '410') { //Unregistered
          self.emit('devicesGone', [e.device], notification);
        }
      }
    });
  });
};

ApnsProvider.prototype.sender = function (item, callback) {
  if (this.pushManager && this.pushManager.isCancelled(item.notification)) {
    this.app.log.warn({trackId: item.notification.trackId, appId: this.appId}, 'ignoring cancelled push')
    return callback()
  }

  if (item.notification && item.notification.statsClbk) {
    item.notification.statsClbk()
    return callback()
  }
  this.app.statsD && this.app.statsD.increment(['app', this.appId, 'apn', 'submit'].join('.'));
  this.app.log.debug({deviceToken: item.deviceToken, topic: item.note.topic, note: item.note}, 'Pushing APN');
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

ApnsProvider.prototype.shutdown = function() {
  if (this._connections) {
    for (var i=0 ; i < this._connections.length; i++) {
      this._connections[i].shutdown()
    }
    this._connections = []
  }
}

ApnsProvider.prototype.addConnection = function (i) {
  this.app.log.info(
    {i: i+1, maxConnections: this.maxConnections, concurrency: this.concurrency, appId: this.appId},
    'Setting up APN connection'
  )
  this._connections.push(new apn.Provider(this._pushOptions));
}
