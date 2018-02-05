var inherits = require('util').inherits
var EventEmitter = require('events').EventEmitter

var debug = require('debug')('loopback:component:push:provider:web')
var webpush = require('web-push')


function WebProvider(pushSettings) {
  pushSettings = pushSettings || {}
  var webSettings = pushSettings.web || {}

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

  console.log('Setting up Web-Push for ', this._pushOptions)

  webpush.setVapidDetails(
    this._pushOptions.subject,
    this._pushOptions.publicKey,
    this._pushOptions.privateKey
  )
}

inherits(WebProvider, EventEmitter)


exports = module.exports = WebProvider


WebProvider.prototype.pushNotification = function (notification, deviceToken, installation) {
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
  if (notification.tag) notif.tag = notification.tag
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

  console.log('Sending web notification to ', subscription, notif)

  webpush
    .sendNotification(subscription, JSON.stringify(notif))
    .then(function(success) {
      console.log('WebPush Success ', success)

      self.emit("transmitted", notification, installation && installation.id)
    })
    .catch(function(error) {
      console.log('WebPush Error ', error)
      self.emit('transmissionError', error, notification, installation && installation.id)

      if (error.body && error.body.indexOf('NotRegistered') > -1) {
        self.emit('devicesGone', [deviceToken])
      }
    })
}
