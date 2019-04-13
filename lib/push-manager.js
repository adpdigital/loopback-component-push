var assert = require('assert');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var format = require('util').format;
var async = require('async');
var providers = require('./providers');
var loopback = require('loopback');
var NodeCache = require('node-cache');
var AsyncCache = require('async-cache');
var debug = require('debug')('loopback:component:push:push-manager');

var Installation = require('../models').Installation;
var Notification = require('../models').Notification;

/*!
 * Exports a function to bootstrap PushManager
 * @param {Object} settings An object to configure APNS
 *
 */
module.exports = PushManager;

/**
 * The PushManager class.
 * See the {@link https://github.com/tcs-de/nodecache#options|node-cache options}
 * for more information on the settings parameters.
 * @options {Object} settings The push settings.
 * @property {Number} ttlInSeconds Time-to-live, in seconds.
 * @property {Number} checkPeriodInSeconds A number in seconds for the automatic delete check interval
 *
 * @class
 * @header PushManager(settings)
 */
function PushManager(settings) {
  if (!(this instanceof PushManager)) {
    return new PushManager(settings);
  }

  settings = settings || {};
  var self = this;
  this.settings = settings;
  this._defineDependencies();
  this.ttlInSeconds = this.settings.ttlInSeconds || 0;
  this.checkPeriodInSeconds = this.settings.checkPeriodInSeconds || 0;
  this.applicationsCache = new NodeCache({stdTTL: this.ttlInSeconds, checkperiod: this.checkPeriodInSeconds});

  this.asyncApplicationsCache = new AsyncCache({
    max: 1000,
    maxAge: 1000 * 60 * 10,
    // method to load a thing if it's not in the cache.
    // key must be unique in the context of this cache.
    load: function (key, cb) {
      var appId = key.split(':')[0];
      var deviceType = key.split(':')[1];
      self._configureApplication(appId, deviceType, cb);
    }
  })

}

inherits(PushManager, EventEmitter);

function resetPushManager(platform) {
  return function(appId) {
    var cacheApp = this.applicationsCache.get(appId);
    if (cacheApp) {
      if (platform === 'ios' && cacheApp[platform]) {
        cacheApp['ios'].shutdown()
      }
      cacheApp[platform] = undefined;
      this.applicationsCache.set(appId, cacheApp);
    }
    this.asyncApplicationsCache.set(appId + ':' + platform, undefined)
  }
}

PushManager.prototype.on('settingsUpdate:android', resetPushManager('android'))
PushManager.prototype.on('settingsUpdate:ios', resetPushManager('ios'))
PushManager.prototype.on('settingsUpdate:windows', resetPushManager('windows'))
PushManager.prototype.on('settingsUpdate:web', resetPushManager('web'))

/**
 * Define the dependent models lazily to avoid race condition
 * as the push data source can be created before installation/notification
 * models are defined.
 *
 * @private
 */
PushManager.prototype._defineDependencies = function () {

  Object.defineProperties(this,
    {
      Installation: {
        get: function () {
          if (!this._Installation) {
            this._Installation = loopback.findModel(this.settings.installation) ||
              loopback.getModelByType(Installation);
          }
          return this._Installation;
        },
        set: function (installation) {
          this._Installation = installation;
        }
      },
      Notification: {
        get: function () {
          if (!this._Notification) {
            this._Notification = loopback.findModel(this.settings.notification) ||
              loopback.getModelByType(Notification);
          }
          return this._Notification;
        },
        set: function (notification) {
          this._Notification = notification;
        }
      },
      Application: {
        get: function () {
          if (!this._Application) {
            this._Application = loopback.findModel(this.settings.application) ||
              loopback.getModelByType(loopback.Application);
          }
          return this._Application;
        },
        set: function (application) {
          this._Application = application;
        }
      }

    });
};

/**
 * Registry of providers
 * Key: device type, e.g. 'ios' or 'android'
 * Value: constructor function, e.g providers.ApnsProvider
 */
PushManager.providers = {
  ios: providers.ApnsProvider,
  android: providers.GcmProviderHttp,
  androidXcs: providers.GcmProvider,
  GcmProviderHttp: providers.GcmProviderHttp,
  windows: providers.WnsProvider,
  web: providers.WebProvider
};

/**
 * Configure push notification for a given device type. Return null when
 * no provider is registered for the device type.
 * @param {String} deviceType The type of device (android, ios)
 * @param {Object} pushSettings The push settings
 * @returns {Provider|null} A provider from PushManager.providers (GcmCcsProvider, ApnsProvider, WnsProvider, WebProvider)
 * matching the deviceType (android, ios)
 */
PushManager.prototype.configureProvider = function (deviceType, pushSettings, cb) {
  var providerType = pushSettings[deviceType+'Provider'] || deviceType
  var Provider = PushManager.providers[providerType]
  if (!Provider) {
    return cb(new Error('Provider not implemented ' + deviceType));
  }

  try {
    var provider = new Provider(pushSettings, this.Application.app);

    provider.on('devicesGone', function (deviceTokens, notificationPayload) {
      this.emit('devicesGone', deviceTokens, deviceType, pushSettings.appId, notificationPayload);
    }.bind(this));

    provider.on('error', function (err) {
      if (err.message.indexOf('XMPP authentication') > -1 || err.message === '401') {
        var cacheApp = this.applicationsCache.get(pushSettings.appId)
        if (cacheApp) {
          cacheApp[deviceType] = undefined;
          this.applicationsCache.set(pushSettings.appId, cacheApp);
        }
        this.asyncApplicationsCache.set(pushSettings.appId + ':' + deviceType, undefined)
        if (cb) {
          cb(err)
          cb = null
          return
        }
      }
      this.emit('error', err, deviceType, pushSettings.appId);
    }.bind(this));

    provider.on('transmitted', function (notif, result, notificationPayload) {
      this.emit('transmitted', notif, result, pushSettings.appId, notificationPayload);
    }.bind(this));

    provider.on('transmissionError', function (err, notification, recipient, notificationPayload) {
      this.emit('transmissionError', err, notification, recipient, pushSettings.appId, notificationPayload);
    }.bind(this));

    provider.on('gcm-ccs-connected', function () {
      this.emit('gcm-ccs-connected', pushSettings.appId);
      cb && cb(null, provider)
      cb = null
    }.bind(this));

    provider.on('gcm-ccs-disconnected', function () {
      this.emit('gcm-ccs-disconnected', pushSettings.appId);
    }.bind(this));

    provider.on('gcm-ccs-delivery', function (messageId, from, category, data) {
      this.emit('gcm-ccs-delivery', messageId, from, category, data);
    }.bind(this));

    provider.on('gcm-ccs-message', function (messageId, from, category, data) {
      this.emit('gcm-ccs-message', messageId, from, category, data);
    }.bind(this));

    // this condition only required in xmpp connection
    // if (providerType !== 'android') {
    // return cb(null, provider)
    // }

    return cb(null, provider)

  } catch (err) {
    return cb(err)
  }
};


PushManager.prototype.configureApplication = function (appId, deviceType, cb) {
  this.asyncApplicationsCache.get(appId + ':' + deviceType, cb);
};

/**
 * Lookup or set up push notification service for the given appId
 * @param {String} appId The application id
 * @param {String} deviceType The type of device (android, ios)
 * @param {function(Error=,Application)} cb Callback function called with `cb(err, obj)` signature.
 */
PushManager.prototype._configureApplication = function (appId, deviceType, cb) {
  assert.ok(cb, 'callback should be defined');
  var self = this;
  var msg;

  // Check the cache first
  var cacheApp = self.applicationsCache.get(appId);
  if (cacheApp && cacheApp[deviceType]) {
    return process.nextTick(function () {
      cb(null, cacheApp[deviceType]);
    });
  }

  // Look up the application object by id
  self.Application.findById(appId, function (err, application) {
    if (err) {
      debug('Cannot find application with id %j: %s',
        appId, err.stack || err.message);
      return cb(err);
    }

    if (!application) {
      msg = format(
        'Cannot configure push notifications - unknown application id %j',
        appId);
      debug('Error: %s', msg);

      err = new Error(msg);
      err.details = {appId: appId};
      return cb(err);
    }

    var pushSettings = application.pushSettings;
    if (!pushSettings) {
      msg = format(
        'No push settings configured for application %j (id: %j)',
        application.name, application.id);
      debug('Error: %s', msg);

      err = new Error(msg);
      err.details = {
        application: {
          id: application.id,
          name: application.name
        }
      };
      return cb(err);
    }

    debug(
      'Setting up push notification for application id %j deviceType %j',
      application.id,
      deviceType
    );

    pushSettings.appId = application.id
    pushSettings.deviceType = deviceType

    self.configureProvider(deviceType, pushSettings, function(err, provider) {
      if (err) {
        debug('There is no provider registered for deviceType ', deviceType, err);
        err.details = {
          deviceType: deviceType
        };
        return cb(err);
      }

      cacheApp = cacheApp || {};
      cacheApp[deviceType] = provider;
      self.applicationsCache.set(appId, cacheApp);
      cb(null, provider);
    })
  });
};


/**
 * Push a notification to the device with the given registration id.
 * @param {Object} installationId Registration id created by call to Installation.create().
 * @param {Notification} notification The notification to send.
 * @param {function(Error=)} cb
 */
PushManager.prototype.notifyById = function (installationId, notification, cb) {
  assert.ok(cb, 'callback should be defined');
  var self = this;
  self.Installation.findById(installationId, function (err, installation) {
    if (err) return cb(err);
    if (!installation) {
      var msg = 'Installation id ' + installationId + ' not found';
      debug('notifyById failed: ' + msg);
      err = new Error(msg);
      err.details = {installationId: installationId};
      return cb(err);
    }
    self.notify(installation, notification, cb);
  });
};

/**
 * Push a notification to all installations matching the given query.
 * @param {Object} installationQuery Installation query, e.g.
 *  `{ appId: 'iCarsAppId', userId: 'jane.smith.id' }`
 * @param {Notification} notification The notification to send.
 * @param {function(Error=)} cb
 */
PushManager.prototype.notifyByQuery = function (installationQuery, notification, cb) {
  assert.ok(cb, 'callback should be defined');
  var self = this;
  var filter = {where: installationQuery};
  self.Installation.find(filter, function (err, installationList) {
    if (err) return cb(err);
    async.each(
      installationList,
      function (installation, next) {
        self.notify(installation, notification, next);
      },
      cb
    );
  });
};

/**
 * Push a notification to the given installation. This is a low-level function
 * used by the other higher-level APIs like `notifyById` and `notifyByQuery`.
 * @param {Installation} installation Installation instance - the recipient.
 * @param {Notification} notification The notification to send.
 * @param {function(Error=)} cb
 */
PushManager.prototype.notify = function (installation, notification, cb) {
  assert(cb, 'callback should be defined');

  if (!(typeof notification === 'object' && notification)) {
    return cb(new Error('notification must be an object'));
  }

  var appId = installation.appId;
  var deviceToken = installation.deviceToken;
  var deviceType = installation.deviceType;

  // Normalize the notification from a plain object
  // for remote calls
  if (!(notification instanceof this.Notification)) {
    notification = new this.Notification(notification);
  }

  // Populate the deviceType/deviceToken to avoid validation errors
  // as both properties are required
  notification.deviceType = deviceType || notification.deviceType;
  notification.deviceToken = deviceToken || notification.deviceToken;

  if (!notification.isValid()) {
    return cb(new loopback.ValidationError(notification));
  }

  this.configureApplication(
    appId,
    deviceType,
    function (err, provider) {
      if (err) return cb(err);

      debug('Sending notification: ', deviceType, deviceToken, notification);
      provider.pushNotification(notification, deviceToken, installation, cb);
    }
  );
};

/**
 * Push notification to installations for given devices tokens, device type and app.
 *
 * @param {String} appId application id
 * @param {String} deviceType type of device (android, ios)
 * @param {String[]} deviceTokens device tokens of recipients.
 * @param {Notification} notification The Notification object to send.
 * @param {function(Error=)} cb
 */
PushManager.prototype.notifyMany = function (appId, deviceType, deviceTokens, notification, cb) {
  assert(appId, 'appId should be defined');
  assert(deviceType, 'deviceType should be defined');
  assert(cb, 'callback should be defined');

  if (!(typeof notification === 'object' && notification)) {
    return cb(new Error('notification must be an object'));
  }

  if (!(Array.isArray(deviceTokens) && deviceTokens.length > 0)) {
    return cb(new Error('deviceTokens must be an array'));
  }

  // Normalize the notification from a plain object
  // for remote calls
  if (!(notification instanceof this.Notification)) {
    notification = new this.Notification(notification);
    if (!notification.isValid()) {
      return cb(new loopback.ValidationError(notification));
    }
  }

  this.configureApplication(
    appId,
    deviceType,
    function (err, provider) {
      if (err) {
        return cb(err);
      }

      provider.pushNotification(notification, deviceTokens);
      cb();
    }
  );
};

/*!
 * Configure the remoting attributes for a given function
 * @param {Function} fn The function
 * @param {Object} options The options
 * @private
 */
function setRemoting(fn, options) {
  options = options || {};
  for (var opt in options) {
    if (options.hasOwnProperty(opt)) {
      fn[opt] = options[opt];
    }
  }
  fn.shared = true;
}

setRemoting(PushManager.prototype.notifyByQuery, {
  description: 'Send a push notification by installation query',
  accepts: [
    {arg: 'deviceQuery', type: 'object', description: 'Installation query', http: {source: 'query'}},
    {arg: 'notification', type: 'object', description: 'Notification', http: {source: 'body'}}
  ],
  returns: {arg: 'data', type: 'object', root: true},
  http: {verb: 'post', path: '/'} // The url will be POST /push
});
