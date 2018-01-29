var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var gcm = require('node-xcs');

var Sender = require('node-xcs').Sender;
var Result = require('node-xcs').Result;
var Message = require('node-xcs').Message;
var Notification = require('node-xcs').Notification;

var GcmProvider = require('./gcm');
var debug = require('debug')('loopback:component:push:provider:gcm-xcs');

var Queue = require('fastq');

function GcmCcsProvider(pushSettings) {
  var settings = pushSettings.gcm || {};
  settings.concurrency = settings.concurrency || 1000
  this._queue = Queue(this.sender.bind(this), settings.concurrency);
  this._setupPushConnection(settings);
}

inherits(GcmCcsProvider, EventEmitter);
inherits(GcmCcsProvider, GcmProvider);

exports = module.exports = GcmCcsProvider;

GcmCcsProvider.prototype._setupPushConnection = function(options) {
  debug('Using GCM-XCS Server API key %s & senderId %s', options.serverApiKey, options.senderId);
  if(!options.serverApiKey || !options.senderId) {
    return "No senderId or serverApiKey defined";
  }
  var self = this;

  this._connection = new Sender(options.senderId, options.serverApiKey);

  this._connection.on('message', function(messageId, from, data, category){
    debug('GCM-XCS new message ', messageId, from, category, data);
    self.emit('gcm-ccs-message', messageId, from, category, data);
  });

  this._connection.on('receipt', function(messageId, from, data, category){
    debug('GCM-XCS Delivery ', messageId, from, category, data);
    var parts = messageId.split(':')
    if (parts.length === 2) {
      self.emit('gcm-ccs-delivery', parts[0], from, category, data, parts[1]);
    } else {
      self.emit('gcm-ccs-delivery', messageId, from, category, data);
    }
  });

  this._connection.on('connected', function(){
    debug('GCM-XCS Connected');
    self.emit('gcm-ccs-connected');
  });

  this._connection.on('disconnected', function(){
    debug('GCM-XCS Disconnected');
    self.emit('gcm-ccs-disconnected');
  });

  this._connection.on('online', function(){
    debug('GCM-XCS Online');
    self.emit('gcm-ccs-online');
  });

  this._connection.on('error', function(err){
    debug('GCM-XCS Error ',err);
    if(err === 'XMPP authentication failure') {
      self._connection.close();
    }
    self.emit('error', new Error(err));
  });

  this._connection.on('message-error', function(err){
    debug('GCM-XCS message-error ',err);
    self.emit('error', new Error(err));
  });
};

GcmCcsProvider.prototype.pushNotification = function(notification, deviceToken) {
  var self = this;
  var targets = [];
  if( deviceToken && deviceToken.topic ) {
    targets = [deviceToken.topic];
  } else {
    targets = (typeof deviceToken === 'string') ? [deviceToken] : deviceToken;
  }
  debug('Sending message to %j: %j', targets, notification);
  if( notification.priority === 10) {
    notification.priority = 'high';
  }

  targets.map( function(token){
    var xcs_notif = new Notification(notification.messageIcon || 'ic_launcher');
    if(notification.title) {
      xcs_notif
        .title(notification.title)
        .body(notification.body || notification.message);
    } else {
      xcs_notif.title(notification.message || notification.body);
    }
    xcs_notif.badge(notification.androidBadge);
    if(notification.sound) {
      xcs_notif.sound(notification.sound);
    }
    if(notification.sound) {
      xcs_notif.sound(notification.sound);
    }
    if(notification.tag) {
      xcs_notif.tag(notification.tag);
    }
    if(notification.color) {
      xcs_notif.color(notification.color);
    }
    xcs_notif.build();

    var xcs_message = new Message(notification.messageId + ':' + notification.deviceId)
      .priority(notification.priority === 'high' ? 2 : 1)
      .timeToLive(notification.getTimeToLiveInSecondsFromNow())
      .collapseKey(notification.collapseKey)
      .dryRun(notification.dryRun || false)
      .delayWhileIdle(notification.delayWhileIdle || false)
      .deliveryReceiptRequested(true)
      .addData("title", notification.title)
      .addData("message", notification.message || notification.body)
      .addData("messageId", notification.messageId)
      .addData("deviceId", notification.deviceId)
      .addData("push", notification.push)
      .addData("data", notification.data)
      .addData("live", notification.live)
      .addData("androidBadge", notification.androidBadge)
      .addData("trackId", notification.trackId);

    if(notification.messageIcon) {
      xcs_message.notification(xcs_notif)
    }
    xcs_message.build();

    if (!self._connection) {
      console.error('Connection not setup:', xcs_message, notification)
      self.emit('error', new Error('Connection not setup'), notification);
      return
    }

    self._queue.push({
      note: xcs_message,
      deviceToken: token
    }, function(err, result){
      if (err) {
        if( err === 'DEVICE_UNREGISTERED' ) {
          self.emit('devicesGone', [result.getFrom()]);
        }
        var notif = self._createMessage(notification);
        notif.message_id = result.getMessageId();
        notif.android = true
        self.emit('transmissionError', new Error(err), notif, result.getFrom(), result.getErrorDescription());
      } else {
        self.emit("transmitted", self._createMessage(notification), result.getMessageId());
      }
    });
  });
};

GcmCcsProvider.prototype.sender = function (item, callback) {
  console.log('Pushing GCM to [%s] app=[%s] ', item.deviceToken, item.note);
  this._connection.sendNoRetry(item.note, item.deviceToken, function(result){
    if (result.getError()) {
      var err = result.getError();
      console.error('Failed to send message: ', err, result.getFrom());
      callback(err, result)
    } else {
      console.log('sent gcm to', item.deviceToken, ' message_id: ', result.getMessageId());
      callback(null, result)
    }
  });
};