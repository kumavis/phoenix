var window = require('global/window')
var HashRouter = require('hash-router')
var Event = require('geval')
var mercury = require('mercury')

module.exports = createEvents
function createEvents() {
  var events = mercury.input([
    // feed page publish form
    'updatePublishFormTextField',
    'setPublishFormTextField',
    'submitPublishForm',

    // network page
    'addServer',
    'removeServer',

    // common buttons
    'addFeed',
    'showIntroToken',
    'follow',
    'unfollow',
    'sync'
  ])
  events.setRoute = EventRouter()
  return events
}

function EventRouter() {
  var router = HashRouter()
  window.addEventListener('hashchange', router)

  return Event(function (emit) {
    router.on('hash', emit)
  })
}
