var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var debug = require('debug')('loopback:component:push:provider:apns');
var apn = require('apn');
var Queue = require('fastq');


function ApnsProvider(pushSettings) {
  pushSettings = pushSettings || {};
  var apnSettings = pushSettings.apns || {};

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
  if (apnSettings.production) {
    this._pushOptions.production = apnSettings.production;
  }
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

  var concurrency = apnSettings.concurrency || 1000;
  // this.maxConnections = apnSettings.maxConnections || 1;
  this.maxConnections = 1;
  this._connections = [];
  this._current = 0;

  this._queue = Queue(this.sender.bind(this), this.maxConnections * concurrency);

  for(var i = 0; i < this.maxConnections; i++) {
    this.addConnection(i)
  }

  var self = this
  setInterval(function () {
    self.reInitConnections()
  }, 1000 * 60 * 58)
}

inherits(ApnsProvider, EventEmitter);


exports = module.exports = ApnsProvider;


ApnsProvider.prototype.pushNotification = function (notification, deviceToken) {
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

  this._queue.push({
    note: note,
    deviceToken: deviceToken
  }, function(err, result){
    if(err) {
      self.emit('error', err);
      return console.error('WOW! what the hell out of apn? ', err);
    }
    result.sent.map(function (s) {
      // s.device
      debug('apn success ', JSON.stringify(s), note);
      self.emit("transmitted", note, s.device);
    });

    result.failed.map(function (e) {
      if (e.error) {
        debug('apn error ', JSON.stringify(e));
        self.emit('error', e);

      } else if (e.status && e.response) {
        debug('apn failed ', JSON.stringify(e));
        self.emit('transmissionError', e, note, e.device);

        if (e.status === '410') { //Unregistered
          self.emit('devicesGone', [e.device]);
        }
      }
    });
  });
};

ApnsProvider.prototype.sender = function (item, callback) {
  console.log('Pushing apn to [%s] app=[%s] ', item.deviceToken, item.note.topic, item.note.aps.alert);
  this._connections[this._current++ % this.maxConnections]
    .send(item.note, item.deviceToken)
    .then(function(result){
      callback(null, result);
    })
    .catch(callback);
};

ApnsProvider.prototype.reInitConnections = function () {
  var self = this
  this._connections.forEach(function (c, i) {
    c.shutdown()
    self.addConnection(i)
  })
};

ApnsProvider.prototype.addConnection = function (i) {
  console.log(
    'Creating new apn connection [%s of %s] with concurrency %s for ',
    i+1, this.maxConnections, concurrency, apnSettings.bundleId
  )
  this._connections.push(new apn.Provider(this._pushOptions));
}