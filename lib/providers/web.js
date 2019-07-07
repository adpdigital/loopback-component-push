var inherits = require('util').inherits
var EventEmitter = require('events').EventEmitter

var debug = require('debug')('loopback:component:push:provider:web')
var webpush = require('web-push')


function WebProvider(pushSettings, app) {
  this.app = app;
  pushSettings = pushSettings || {}
  var webSettings = pushSettings.web || {}
  var gcmSettings = pushSettings.gcm || {}

  var vapidKeys = webpush.generateVAPIDKeys()

  this._pushOptions = {
    subject: 'mailto:chabokpush@adpdigital.com',
    publicKey: vapidKeys.publicKey,
    privateKey: vapidKeys.privateKey
  }

  if (webSettings.subject) {
    if (webSettings.subject.indexOf('mailto:') === -1) {
      webSettings.subject = 'mailto:' + webSettings.subject
    }
    this._pushOptions.subject = webSettings.subject
  }
  if (webSettings.publicKey) {
    this._pushOptions.publicKey = webSettings.publicKey
  }
  if (webSettings.privateKey) {
    this._pushOptions.privateKey = webSettings.privateKey
  }

  if (gcmSettings.serverApiKey) {
    this._pushOptions.gcmAPIKey = gcmSettings.serverApiKey
  }

  console.log('Setting up Web-Push for ', this._pushOptions)
}

inherits(WebProvider, EventEmitter)


exports = module.exports = WebProvider


WebProvider.prototype.pushNotification = function (notification, deviceToken, installation, cb) {
  var self = this


  // var subscription = {
  //   endpoint: 'https://fcm.googleapis.com/fcm/send/eHT6RkSPAC4:APA91bHAVmJVY7xBhMlB2v25OvqQ0ENycbiA9QdS9RfwV8RPCDRaOX-1L05n7Okywh27jAQX_Yod8IA4azpmYqCUR2P-kZyiA02N1l4VWT48Q5hAjsoGDGURRPaw6ET0X9eBAtYMEo_H',
  //   expirationTime: 0,
  //   TTL: 0,
  //   keys: {
  //     p256dh: 'BA77BdtEMPl9HSh5BUt01W9sLN0ZRSwOPkP53fARb2voLN9-w0Gm39U_XGptlwn7aBMg02XU7DpRnmRsJfAqPKc=',
  //     auth: 'oaBKUkGKSGhJfF7klW2AtA==',
  //   },
  // }
  try {
    var subscription = JSON.parse(deviceToken)
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      throw new Error('Bad Web Token ', deviceToken)
    }
    subscription.expirationTime = 0
    subscription.TTL = 0
  } catch (e) {
    // return this.emit('error', e)
  }

  var notif = {
    title: notification.alert || notification.title,
    body: notification.body || notification.message,
    data: notification.data
  }


  notification.web = true

  if (notification.dir) notif.dir = notification.dir
  if (notification.lang) notif.lang = notification.lang
  if (notification.badge) notif.badge = notification.badge
  if (notification.icon) notif.icon = notification.icon
  if (notification.image) notif.image = notification.image
  if (notification.vibrate) notif.vibrate = notification.vibrate
  if (notification.renotify) notif.renotify = notification.renotify
  if (notification.requireInteraction) notif.requireInteraction = notification.requireInteraction
  if (notification.actions) notif.actions = notification.actions

  if (notification.silent) notif.silent = notification.silent
  if (notification.sound) notif.sound = notification.sound
  if (notification.noscreen) notif.noscreen = notification.noscreen
  if (notification.sticky) notif.sticky = notification.sticky
  if (notification.clickUrl) notif.clickUrl = notification.clickUrl
  if (notification.groupId) notif.tag = notification.groupId
  if (notification.notifDelivery) notif.notifDelivery = notification.notifDelivery;
  if (notification.trackId) notif.trackId = notification.trackId
  if (notification.messageId) notif.messageId = notification.messageId
  if (notification.notifDelivery) notif.notifDelivery = notification.notifDelivery

  console.log('Sending web notification to ', subscription, notif)

  const options = {
    vapidDetails: {
      subject: this._pushOptions.subject,
      publicKey: this._pushOptions.publicKey,
      privateKey: this._pushOptions.privateKey
    },
  }

  if (this._pushOptions.gcmAPIKey) {
    options.gcmAPIKey = this._pushOptions.gcmAPIKey
  }

  self.app.statsD && self.app.statsD.increment(['app', installation.appId, 'web', 'submit'].join('.'), 1);

  webpush
    .sendNotification(subscription, JSON.stringify(notif), options)
    .then(function(success) {
      cb()

      console.log('WebPush Success ', success)

      self.app.statsD && self.app.statsD.increment(['app', installation.appId, 'web', 'success'].join('.'), 1);

      self.emit("transmitted", notification, installation && installation.id, notification)
    })
    .catch(function(error) {
      cb()

      if(error.body) {
        const parts = error.body.match(/<TITLE>(.*)<\/TITLE>/)
        if (parts && parts[1]) {
          error.description = parts[1]
        } else {
          try {
            const jsonBody = JSON.parse(error.body)
            error.description = jsonBody.message
          } catch (e) {}
        }
      }

      console.error('WebPush Error ', error)

      self.app.statsD && self.app.statsD.increment(['app', installation.appId, 'web', 'fail'].join('.'), 1);

      self.emit('transmissionError', error, notification, installation && installation.id, notification)

      if (error.statusCode === 410) {
        self.emit('devicesGone', [deviceToken], notification)
      }
    })
}
