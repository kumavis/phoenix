var WSStream = require('websocket-stream')
var prpc = require('phoenix-rpc')
var through = require('through')
var pull = require('pull-stream')
var toPull = require('stream-to-pull-stream')
var multicb = require('multicb')

var util = require('../../../lib/util')
var models = require('./models')

// setup the server api connection
var client = exports.client = prpc.client()
var conn = WSStream('ws://' + window.location.host + '/ws')
conn.on('error', function(e) { console.error('WS ERROR', e) })
client.pipe(through(toBuffer)).pipe(conn).pipe(client)
function toBuffer(chunk) {
  this.queue((Buffer.isBuffer(chunk)) ? chunk : new Buffer(chunk))
}

// pulls down remote data for the session
exports.setupHomeApp = function(state) {
  // session
  client.api.getKeys(function(err, keys) {
    if (err) throw err
    state.user.id.set(util.toBuffer(keys.name))
    state.user.idStr.set(util.toHexString(keys.name))
    state.user.pubkey.set(util.toBuffer(keys.public))
    state.user.pubkeyStr.set(util.toHexString(keys.public))
  })
  client.api.getSyncState(function(err, syncState) {
    if (syncState && syncState.lastSync)
      state.lastSync.set(new Date(syncState.lastSync))
  })
  // followed profiles
  pull(toPull(client.api.following()), pull.drain(function (entry) { fetchProfile(state, entry.key) }))
}

// pulls down remote data for the session
exports.setupPubApp = function(state) {
  // followed profiles
  pull(toPull(client.api.following()), pull.drain(function (entry) { fetchProfile(state, entry.key) }))
}

// adds a new profile
var addProfile =
exports.addProfile = function(state, p) {
  var pm = state.profileMap()
  var id = util.toHexString(p.id)
  if (id in pm) return state.profiles.get(pm[id])

  // add profile
  var i = state.profiles().length
  p = models.profile(p)
  state.profiles.push(p)

  // add index to the profile map
  pm[id] = i
  state.profileMap(pm)

  return p
}

// fetches a profile from the backend or cache
var fetchProfileQueue = util.queue()
var fetchProfile =
exports.fetchProfile = function(state, profid, cb) {
  var idStr = util.toHexString(profid)
  var idBuf = util.toBuffer(profid)
  cb = cb || function(){}
  var pm = state.profileMap()

  // load from cache
  var profi = pm[idStr]
  var profile = (typeof profi != 'undefined') ? state.profiles.get(profi) : undefined
  if (profile) return cb(null, profile)

  // try to load from backend
  fetchProfileQueue(idStr, cb, function(cbs) {
    client.api.profile_getProfile(idBuf, function(err, profile) {
      if (err && !err.notFound) return cb(err)
      profile = profile || {}
      
      // cache the profile
      profile.id = idBuf
      profile.idStr = idStr
      profile = addProfile(state, profile)

      // drain the queue
      cbs(null, profile)
    })
  })
}

// loads the full feed
var fetchFeedQueue = util.queue().bind(null, 'feed')
var fetchFeed =
exports.fetchFeed = function(state, opts, cb) {
  if (!cb && typeof opts == 'function') {
    cb = opts
    opts = 0
  }
  if (!opts) opts = {}

  fetchFeedQueue(cb, function(cbs) {
    // do we have a local cache?
    if (opts.refresh && state.feed.getLength()) {
      state.feed.splice(0, state.feed.getLength()) // clear it out
    }

    // fetch feed stream
    // :TODO: start from where we currently are if there are already messages in the feed
    pull(
      toPull(client.api.createFeedStream()),
      pull.asyncMap(function(m, cb) {
        fetchProfile(state, m.author, function(err, profile) {
          if (err) console.error('Error loading profile for message', err, m)
          else m.authorNickname = profile.nickname
          cb(null, m)
        })
      }),
      pull.drain(function (m) {
        m = models.message(m)
        if (messageIsCached(state, m)) return // :TODO: remove this once we only pull new messages
        if (m) state.feed.unshift(m)
      }, function() { cbs(null, state.feed()) })
    )
  })
}

// temporary helper to check if we already have the message in our feed cache
function messageIsCached(state, a) {
  if (!a) return false
  for (var i=0; i < state.feed.getLength(); i++) {
    var b = state.feed.get(i)
    if (util.toHexString(a.signature) == util.toHexString(b.signature)) {
      return true
    }
  }
  return false
}

// loads the profile's feed (from the backend or cache)
var fetchProfileFeedQueue = util.queue()
var fetchProfileFeed = 
exports.fetchProfileFeed = function(state, profid, cb) {
  var idStr = util.toHexString(profid)
  fetchProfileFeedQueue(idStr, cb, function(cbs) {
    fetchProfile(state, profid, function(err, profile) {
      if (err) return cb(err)
      if (!profile) return cb()
      var done = multicb()

      // fetch feed if not empty :TODO: just see if there are any new
      if (!profile.feed.getLength()) { 
        pull(
          toPull(client.api.createHistoryStream(util.toBuffer(profid), 0)),
          pull.drain(function (m) {
            m.authorNickname = profile.nickname
            m = models.message(m)
            if (m.type == 'init') profile.joinDate.set(util.prettydate(new Date(m.timestamp), true))
            if (m) profile.feed.push(m)
          }, done())
        )
      }

      // fetch isFollowing state
      if (state.user && state.user.idStr() != idStr) {
        var cb2 = done()
        client.api.isFollowing(util.toBuffer(profid), function(err) {
          profile.isFollowing.set(!err)
          cb2()
        })
      }

      // done when ALL done
      done(cbs)
    })
  })
}

// loads the network nodes
var fetchServersQueue = util.queue().bind(null, 'servers')
var fetchServers =
exports.fetchServers = function(state, cb) {
  fetchServersQueue(cb, function(cbs) {
    // fetch nodes
    client.api.getNodes(function(err, nodes) {
      if (err) return cbs(err)

      // clear if not empty
      if (state.servers.getLength())
        state.servers.splice(0, state.servers.getLength())

      // add servers
      nodes.forEach(function(node) {
        state.servers.push(models.server({ hostname: node[0], port: node[1] }))
      })
      cbs(null, state.servers())
    })
  })
}

// posts to the feed
var publishText =
exports.publishText = function(state, str, cb) {
  if (!str.trim()) return cb(new Error('Can not post an empty string to the feed'))
  client.api.text_post(str, cb)
}

// begins following a feed
var addFeed =
exports.addFeed = function(state, token, cb) {
  if (typeof token == 'string') {
    try { token = JSON.parse(token) }
    catch (e) { return cb(new Error('Bad intro token - must be valid JSON')) }
  }

  // start following the id
  var id = util.toBuffer(token.id)
  if (!id) return cb(new Error('Bad intro token - invalid ID'))
  client.api.follow(id, function(err) {
    if (err) return cb(err)

    // load the profile into the local cache, if possible
    fetchProfile(state, id, function(err, profile) {
      if (profile)
        profile.isFollowing.set(true)
    })

    // add their relays
    if (!token.relays || token.relays.length === 0)        
      return
    client.api.addNodes(token.relays, cb)
  })
}

// stops following a feed
var removeFeed =
exports.removeFeed = function(state, id, cb) {
  var id = util.toBuffer(id)
  client.api.unfollow(util.toBuffer(id), function(err) {
    if (err) return cb(err)
    fetchProfile(state, id, function(err, profile) {
      if (profile)
        profile.isFollowing.set(false)
      cb()
    })
  })
}

// adds a server to the network table
var addServer =
exports.addServer = function(state, addr, cb) {
  if (typeof addr == 'string')
    addr = addr.split(':')
  if (!addr[0]) return cb(new Error('Invalid address'))
  addr[1] = +addr[1] || 80
  
  client.api.addNode(addr[0], addr[1], function(err) {
    if (err) return cb(err)
    state.servers.push(models.server({ hostname: addr[0], port: addr[1] }))
  })
}

// removes a server from the network table
var removeServer =
exports.removeServer = function(state, addr, cb) {
  if (typeof addr == 'string')
    addr = addr.split(':')
  if (!addr[0]) return cb(new Error('Invalid address'))
  addr[1] = +addr[1] || 80

  client.api.delNode(addr[0], addr[1], function(err) {
    if (err) return cb(err)

    // find and remove from the local cache
    for (var i=0; i < state.servers.getLength(); i++) {
      var s = state.servers.get(i)
      if (s.hostname == addr[0] && s.port == addr[1]) {
        state.servers.splice(i, 1)
        break
      }
    }
    cb()
  })
}