
var inherits = require('util').inherits;
var extend = require('util')._extend;
var EventEmitter = require('events').EventEmitter;
var wns = require('wns');
var debug = require('debug')('loopback:component:push:provider:wns');

function WnsProvider(pushSettings) {
  var settings = pushSettings.wns || {};
  this._setupPushConnection(settings);
}

inherits(WnsProvider, EventEmitter);

exports = module.exports = WnsProvider;

WnsProvider.prototype._setupPushConnection = function(options) {
  debug('Using WNS Server API key %j', options.client_id, options.client_secret );
  this.options = options;

  // var base;
  //if ((base = this.options).type == null) {
  //  base.type = "toast";
  //}
  //if (this.options.type === "tile" && !this.options.tileMapping) {
  //  throw new Error("Invalid WNS configuration: missing `tileMapping` for `tile` type");
  //}


};

WnsProvider.prototype.tokenFormat = /^https?:\/\/[a-zA-Z0-9-.]+\.notify\.windows\.com\/\S{0,500}$/;

WnsProvider.prototype.validateToken = function(token) {
  if (WnsProvider.prototype.tokenFormat.test(token)) {
    return token;
  }
};


WnsProvider.prototype.pushNotification = function(notification, deviceToken, installation) {
  var self = this;
  var note = {};
  var sender;
  //var options = this.options;
  //var registrationIds = (typeof deviceToken == 'string') ? [deviceToken] : deviceToken;
  console.log( "Pushing notification to ", notification, deviceToken );

  switch (notification.type) {
    case "toast":
      sender = wns.sendToastText02;
      note.text1 = notification.title;
      note.text2 = notification.body || notification.message;

      //note.launch in options
      //note.duration: long, short in options
      break;

    case "tile":
      debug( "Not implemented: tile notifications");
      break;

    case "badge":
      debug( "Not implemented: badge notifications");
      break;

    case "raw":
      sender = wns.sendRaw;
      note = JSON.stringify(notification.data);
      break;

    default:
      console.warn("Unsupported WNS notification type: ", notification.type);
  }

  if (sender) {
    try {

      debug("WNS client URL: " + deviceToken);
      notification.windows = true

      return sender(deviceToken, note, this.options, function(error, result) {
        self.options.accessToken = error ? error.newAccessToken : result.newAccessToken;

        if (error) {
          if (error.shouldDeleteChannel) {
            console.log("WNS Automatic un-registration for token " + deviceToken);
            self.emit('devicesGone', [deviceToken]);
          } else {
            // self.emit('error', error);
            self.emit('transmissionError', error, notification, installation && installation.id)
          }
        } else {
          debug("WNS result: ", result );
          self.emit("transmitted", notification, result, installation && installation.id)
        }
      });
    } catch (err) {
      debug("WNS Error: ", err );
      self.emit('error', err);
    }
  }
};
