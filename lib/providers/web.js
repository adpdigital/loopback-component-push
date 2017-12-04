var inherits = require('util').inherits
var EventEmitter = require('events').EventEmitter

var debug = require('debug')('loopback:component:push:provider:web')
var webpush = require('web-push')


function WebProvider(pushSettings) {
  pushSettings = pushSettings || {}
  var webSettings = pushSettings.web || {}

  var vapidKeys = webpush.generateVAPIDKeys()

  this._pushOptions = {
    mailto: 'mailto:chabokpush@adpdigital.com',
    publicKey: vapidKeys.publicKey,
    privateKey: vapidKeys.privateKey
  }

  if (webSettings.mailto) {
    this._pushOptions.mailto = webSettings.mailto
  }
  if (webSettings.publicKey) {
    this._pushOptions.publicKey = webSettings.publicKey
  }
  if (webSettings.privateKey) {
    this._pushOptions.privateKey = webSettings.privateKey
  }

  console.log('Setup Web-Pusb for ', pushSettings, this._pushOptions)
  webpush.setVapidDetails(
    this._pushOptions.mailto,
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

  var webNotif = JSON.stringify({
    title: notification.alert,
    body: notification.body || notification.alert,
    url: notification.url
  });

  // note.alert = notification.alert
  // note.badge = notification.badge
  // note.sound = notification.sound
  // if (notification.body) note.body = notification.body
  // if (notification.locKey) note.locKey = notification.locKey
  // if (notification.locArgs) note.locArgs = notification.locArgs
  // if (notification.title) note.title = notification.title
  // if (notification.titleLocKey) note.titleLocKey = notification.titleLocKey
  // if (notification.titleLocArgs) note.titleLocArgs = notification.titleLocArgs
  // if (notification.action) note.action = notification.action
  // if (notification.actionLocKey) note.actionLocKey = notification.actionLocKey
  // if (notification.launchImage) note.launchImage = notification.launchImage
  // note.expiry = notification.getTimeToLiveInSecondsFromNow() || note.expiry
  // note.priority = note.contentAvailable === 1 ? 5 : notification.priority
  // note.category = notification.category
  // note.collapseId = notification.collapseId //displayed to the user as a single notification
  // note.threadId = notification.threadId //visually groups notifications
  // note.contentAvailable = notification.contentAvailable
  // note.mutableContent = notification.mutableContent
  // note.urlArgs = notification.urlArgs
  // note.mdm = notification.mdm

  // note.payload = {}
  // Object.keys(notification).forEach(function (key) {
  //   note.payload[key] = notification[key]
  // })

  webpush
    .sendNotification(subscription, webNotif)
    .then(function(success) {
      console.log('WebPush Success ', success)
      self.emit("transmitted", notification, installation && installation.id)
    })
    .catch(function(error) {
      console.log('WebPush Error ', error)
      self.emit('transmissionError', error, notification, installation && installation.id)

      // TODO
      // self.emit('devicesGone', [e.device])
    })
}