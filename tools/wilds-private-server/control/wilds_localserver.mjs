// Wilds control-plane local server (research spike).
// Implements the app.Net_APIServer REST contract recovered statically from
// MonsterHunterWilds.exe (174 endpoints) + a minimal WebSocket lobby/notify hub.
//
// SCOPE / HONEST CEILING:
//   This serves the CONTROL PLANE only (auth, boot gates, social hub, lobby,
//   matchmaking, session BROKERING). It gets a client to the online menu and
//   lets it create/join a lobby+quest session. It does NOT and cannot carry the
//   playable hunt: combat sync is PlayFab Party P2P (Azure relay), host-
//   authoritative, out of a local server's reach. See RAPPORT_FAISABILITE_WILDS.md.
//
// Local only. Binds 127.0.0.1. No external contact. No dependencies (Node >=18).

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST = '127.0.0.1'
const PORT = Number(process.env.WILDS_PORT || 21080)
const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'routes.json'), 'utf8'))

// ---- logging -------------------------------------------------------------
const logPath = path.join(__dirname, 'wilds_localserver.log')
fs.writeFileSync(logPath, '')
// Every request, verbatim (headers that matter + body), one JSON object per line: what the real
// client sends is the ground truth this server is built from, so nothing is filtered out here.
const capturePath = path.join(__dirname, 'wilds_capture.ndjson')
const CAPTURE_HEADERS = ['host', 'user-agent', 'authorization', 'x-rebe-token', 'x-session-nonce', 'x-api-version', 'content-type', 'content-length', 'upgrade']
function capture(req, raw) {
  const headers = {}
  for (const h of CAPTURE_HEADERS) if (req.headers[h] !== undefined) headers[h] = req.headers[h]
  fs.appendFileSync(capturePath, JSON.stringify({ t: new Date().toISOString(), method: req.method, url: req.url, headers, body: raw.length > 4000 ? raw.slice(0, 4000) + '...[truncated]' : raw }) + '\n')
}
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ')
  process.stdout.write(line + '\n')
  fs.appendFileSync(logPath, line + '\n')
}

// ---- in-memory state -----------------------------------------------------
const db = {
  sessions: new Map(), // sessionId -> {userId, nonce, hunterIds:[]}
  lobbies: new Map(),  // lobbyId -> {ownerUserId, members:Set, isFriendOpen}
  quests: new Map(),   // questSessionId -> {hostUserId, questEndpoint, members:[]}
  signals: new Map(),  // questSessionId -> signal payload (matchmaking board)
  hunters: new Map(),  // hunterId -> {shortId, name, hr}
  seq: 1,
}
const rnd = (n = 16) => crypto.randomBytes(n).toString('hex')
const newId = (p) => p + '_' + (db.seq++).toString().padStart(6, '0') + rnd(4)
const shortId = () => String(100000000 + Math.floor(Math.random() * 899999999)) // 9-digit

// ---- JSON stub generation from recovered field types ---------------------
function defaultFor(type) {
  const t = type.trim()
  if (/List`1</.test(t) || /Dictionary`2</.test(t) || /\[\]$/.test(t)) return []
  if (/^(System\.)?String$/.test(t)) return ''
  if (/^(System\.)?Boolean$/.test(t)) return false
  if (/Guid$/.test(t)) return '00000000-0000-0000-0000-000000000000'
  if (/(Int16|Int32|Int64|UInt16|UInt32|UInt64|SByte|Byte|Single|Double|Decimal)$/.test(t)) return 0
  if (/^ace_network\.Enum/.test(t) || /\.Enum/.test(t)) return 0
  // nested class we do not have fields for -> empty object
  return {}
}
function stubResp(route) {
  const o = {}
  for (const [name, type] of route.resp) o[name] = defaultFor(type)
  return o
}

// ---- header / session model (recovered) ----------------------------------
// login/register carry x-rebe-token (from the upstream Rebe/Capcom-ID layer).
// every other call carries Authorization: Session id=<SessionId> and a rolling
// x-session-nonce; the server rotates the nonce and returns it in the response.
function issueSession(userId) {
  const sessionId = newId('sess')
  const nonce = rnd(12)
  db.sessions.set(sessionId, { userId, nonce, hunterIds: [] })
  return { sessionId, nonce }
}
function authOf(req) {
  const a = req.headers['authorization'] || ''
  const m = /Session\s+id=([^,\s]+)/i.exec(a)
  if (!m) return null
  const s = db.sessions.get(m[1])
  if (!s) return null
  return { sessionId: m[1], s }
}

// ---- explicit handlers for the critical path -----------------------------
// keys are "VERB path"
const H = {}
H['GET /sys/health'] = () => ({ status: 200, body: { Status: 'ok', ServerTime: Date.now() } })
H['GET /sys/speed'] = () => ({ status: 200, body: {} })

for (const p of ['/v1/consent/countries/', '/v1/consent/restrictions/', '/v1/consent/documents/',
                 '/v1/consent/parent/initialize', '/v1/consent/parent/finalize']) {
  H['GET ' + p] = () => ({ status: 200, body: {} })
}

H['POST /auth/login'] = (req, body) => {
  const rebe = req.headers['x-rebe-token'] || (body && body.RebeToken) || ''
  if (!rebe) log('WARN /auth/login without x-rebe-token/RebeToken (dev accepts dummy)')
  const userId = 'U' + shortId()
  const { sessionId, nonce } = issueSession(userId)
  return {
    status: 200, nonce,
    body: {
      SessionId: sessionId, UserId: userId, SubHash: rnd(8),
      IpAddress: '127.0.0.1', IpAddressHash: rnd(8), IsInCommunityBan: false,
    },
  }
}
H['POST /auth/register'] = (req, body) => {
  const userId = 'U' + shortId()
  const { sessionId, nonce } = issueSession(userId)
  return { status: 200, nonce, body: { SessionId: sessionId, UserId: userId } }
}
H['POST /auth/ticket'] = () => ({ status: 200, body: { Ticket: rnd(24) } })

H['POST /ban/info'] = () => ({ status: 200, body: { UnlockTime: 0, BanReasons: [], Status: 0 } })

H['POST /hunter/list'] = (req, body, ctx) => {
  const list = ctx.s.hunterIds.map((hid) => {
    const h = db.hunters.get(hid)
    return { HunterId: hid, ShortId: h.shortId, Name: h.name, Hr: h.hr, Status: 0 }
  })
  return { status: 200, body: { HunterList: list } }
}
H['POST /hunter/sync'] = (req, body, ctx) => {
  const saves = (body && body.HunterSaveList) || []
  const out = []
  for (const slot of saves) {
    let hid = slot.HunterId
    if (!hid || !db.hunters.has(hid)) {
      hid = 'H' + shortId()
      db.hunters.set(hid, { shortId: shortId(), name: slot.Name || 'Hunter', hr: slot.Hr || 1 })
      ctx.s.hunterIds.push(hid)
    }
    const h = db.hunters.get(hid)
    out.push({ HunterId: hid, ShortId: h.shortId, SaveSlot: slot.SaveSlot || 0 })
  }
  return { status: 200, body: { SaveSlotInfoList: out, InvalidClientHunterIdList: [], InvalidSaveSlotInfoList: [] } }
}

const WS_BASE = `ws://${HOST}:${PORT}`
H['POST /lobby/private/create'] = (req, body, ctx) => {
  const lobbyId = newId('lobby')
  db.lobbies.set(lobbyId, { ownerUserId: ctx.s.userId, members: new Set([ctx.s.userId]), isFriendOpen: !!(body && body.IsFriendOpen) })
  return { status: 200, body: { LobbyId: lobbyId, Endpoint: `${WS_BASE}/lobby/${lobbyId}`, DummyUpdateIntervalSec: 30, WelcomeInfo: {} } }
}
H['POST /lobby/join'] = (req, body, ctx) => {
  const lobbyId = (body && body.LobbyId) || [...db.lobbies.keys()][0]
  const lob = db.lobbies.get(lobbyId)
  if (!lob) return { status: 404, body: { error: 'lobby not found' } }
  lob.members.add(ctx.s.userId)
  return { status: 200, body: { Endpoint: `${WS_BASE}/lobby/${lobbyId}` } }
}
H['POST /lobby/auto_join'] = () => ({ status: 200, body: { Endpoints: [`${WS_BASE}/lobby/auto`] } })

// quest brokering: NOTE the QuestEndpoint on start is CLIENT-SUPPLIED (the host's
// P2P endpoint). We only mint/track the QuestSessionId and hand the endpoint back
// to joiners. We never carry gameplay bytes -- that is PlayFab Party P2P.
H['POST /quest/session/start'] = (req, body, ctx) => {
  const qsid = newId('quest')
  db.quests.set(qsid, { hostUserId: ctx.s.userId, questEndpoint: (body && body.QuestEndpoint) || '', members: [ctx.s.userId] })
  return { status: 200, body: { QuestSessionId: qsid } }
}
H['POST /quest/session/join'] = (req, body, ctx) => {
  const q = db.quests.get(body && body.QuestSessionId)
  if (!q) return { status: 404, body: { error: 'quest session not found' } }
  q.members.push(ctx.s.userId)
  return { status: 200, body: { QuestEndpoint: q.questEndpoint } } // hand back HOST's P2P endpoint
}
H['POST /quest/session/update'] = () => ({ status: 200, body: {} })
H['POST /quest/session/end'] = (req, body) => { db.quests.delete(body && body.QuestSessionId); return { status: 200, body: {} } }
H['POST /quest/signal/create'] = (req, body, ctx) => {
  const qsid = (body && body.QuestSessionId) || newId('quest')
  db.signals.set(qsid, { host: ctx.s.userId, ...(body || {}) })
  return { status: 200, body: {} }
}
H['POST /quest/signal/search'] = (req, body) => {
  const results = [...db.signals.entries()].map(([qsid, s]) => ({ QuestSessionId: qsid, QuestId: s.QuestId || 0, HuntingType: s.HuntingType || 0 }))
  return { status: 200, body: { SearchResults: results } }
}
H['POST /quest/signal/auto_join'] = (req, body, ctx) => {
  const e = [...db.quests.values()][0]
  return { status: 200, body: { QuestSessionId: [...db.quests.keys()][0] || '', QuestEndpoint: (e && e.questEndpoint) || '' } }
}
H['POST /quest/signal/delete'] = (req, body) => { db.signals.delete(body && body.QuestSessionId); return { status: 200, body: {} } }
H['POST /quest/signal/touch'] = () => ({ status: 200, body: {} })

// ---- routing -------------------------------------------------------------
const routeByKey = new Map()
for (const r of routes) routeByKey.set(r.verb + ' ' + r.path, r)

const AUTH_EXEMPT = new Set([
  'POST /auth/login', 'POST /auth/register', 'GET /sys/health', 'GET /sys/speed',
])
for (const k of routeByKey.keys()) if (k.startsWith('GET /v1/consent')) AUTH_EXEMPT.add(k)

const META_PREFIX = /^\/(hjm|mtm|mts|tmr|nkm|wlt|gss|gdk)(\/|$)/
const SIGN_PATH = /^\/v1\/[^/]+\/sign\//

// The service directory the real Hjm host serves, with every address pointed back at us.
// custom_property is base64 JSON carrying the REST/notify/cdn bases the game feeds to app.Net_APIServer.
const systemTemplate = JSON.parse(fs.readFileSync(path.join(__dirname, 'system.json'), 'utf8'))
function systemJson(hostHeader) {
  const http = `http://${hostHeader}`
  const ws = `ws://${hostHeader}`
  const custom = JSON.parse(Buffer.from(systemTemplate.custom_property, 'base64').toString('utf8'))
  custom.url = { api: http, notify: ws, cdn: http }
  const out = { ...systemTemplate, custom_property: Buffer.from(JSON.stringify(custom)).toString('base64') }
  for (const k of ['mtm', 'mtms', 'mmr', 'tmr', 'nkm', 'wlt', 'selector']) out[k] = http
  return out
}

// The /sign response schema has never been observed from the real service; the client reads a
// JWT whose payload claims are sub, iat, exp, linked, cc, lat, lng (order recovered from the
// consumer code) and has no key to verify a signature with. Each /sign request is answered with
// the next variant below, so every in-game "retry" tests one shape; the log names the variant
// and wilds_rebe_state.lua logs the client's verdict. SIGN_VARIANT=<n> pins a single one.
// Confirmed by disassembly of the consumer at code rva 0xa75a070:
//   response JSON -> get "rebe_token" -> split on "." (needs >= 3 parts)
//   -> base64-decode part[1] -> parse that as JSON -> read claims sub,iat,exp,linked,cc,lat,lng.
// JsonFormat therefore comes from one of: response not JSON (ruled out, we send JSON), rebe_token
// missing (ruled out, present), token has < 3 dot-parts, part[1] base64 alphabet/padding, or the
// decoded payload not being valid claims JSON. base64url and standard base64 differ ONLY in the
// trailing '=' padding for our payloads (no -_ or +/ bytes), so padding is a real axis. The sweep
// below walks each independent hypothesis; every in-game retry advances one and the poller logs
// the verdict, so we learn which axis flips JsonFormat -> (Authorized | different cause).
const b64 = {
  url: (o) => Buffer.from(JSON.stringify(o)).toString('base64url'),           // no padding
  urlpad: (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'), // padded url
  std: (o) => Buffer.from(JSON.stringify(o)).toString('base64'),              // standard + padding
  stdnopad: (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, ''),
}
function jwt(enc, header, claims, sig) { return `${enc(header)}.${enc(claims)}.${sig}` }
const nowSec = () => Math.floor(Date.now() / 1000)
function claims(extra = {}) {
  const now = Math.floor(Date.now() / 1000)
  return { sub: 'LOCAL' + rnd(6), iat: now, exp: now + 86400, linked: true, cc: 'JP', lat: 35.68, lng: 139.69, ...extra }
}
const sig = () => crypto.randomBytes(256).toString('base64url')
const HDR = { alg: 'RS256', typ: 'JWT' }
// Disassembly proved the claims path (sub=string, iat/exp=int, linked=bool, cc=string, lat/lng=double)
// and our default claims match those types exactly, so JsonFormat is NOT the claims. The 4 encoding
// variants failing identically also rules out payload base64. That leaves the RESPONSE ENVELOPE:
// the code region carries result_code / error / code strings, so /sign likely expects a wrapper.
// These variants walk envelope shapes first (most likely), each a genuinely different top-level.
// rebe_token is read at the TOP level (disasm: response.at("rebe_token")), so no envelope wrapping.
// The only remaining unknown is the exact type each claim getter enforces; the getters trampoline
// into Denuvo-relocated code we can't read statically, so these variants probe the claim types.
const tok = (c) => ({ rebe_token: jwt(b64.url, HDR, c, sig()) })
// DISCRIMINATING SWEEP: two static reads of the split helper (0x37690) disagree — the workflow read
// "first-occurrence, max 2 parts" (=> the >=3 gate at 0xa75a0fd is unreachable, every body doomed to
// sub=-1), my re-read found a loop-back (=> full multi-split, 3-part JWT passes the gate). These
// variants vary ONLY the DOT COUNT of rebe_token so the sub code (logged by wilds_rebe_state.lua)
// tells us which is true: if a 3/5-part token yields a DIFFERENT sub than a 1/2-part token, the gate
// is reachable (multi-split) and we're failing later in the claims path; if all stay sub=-1, the
// gate is truly unreachable in this build. part[1] is valid base64url(claims) wherever it matters.
const P = { hdr: () => b64.url(HDR), claims: () => b64.url(claims()), sig: () => sig() }
const DISCRIMINATE = [
  ['1 part (no dot)', () => ({ rebe_token: P.claims() })],
  ['2 parts (1 dot)', () => ({ rebe_token: `${P.hdr()}.${P.claims()}` })],
  ['3 parts, valid claims (control)', () => ({ rebe_token: `${P.hdr()}.${P.claims()}.${P.sig()}` })],
  ['5 parts, valid part[1]', () => ({ rebe_token: `${P.hdr()}.${P.claims()}.a.b.c` })],
  ['3 parts, part[1] NOT base64/JSON', () => ({ rebe_token: `${P.hdr()}.@@@not-base64@@@.${P.sig()}` })],
  ['3 parts, part[1] valid b64 but not JSON', () => ({ rebe_token: `${P.hdr()}.${Buffer.from('not json').toString('base64url')}.${P.sig()}` })],
]
const SIGN_VARIANTS = [
  ...DISCRIMINATE,
  ['control (int iat/exp, bool linked, double lat/lng)', () => tok(claims())],
  ['iat/exp as strings', () => tok(claims({ iat: String(nowSec()), exp: String(nowSec() + 86400) }))],
  ['linked as int 1', () => tok(claims({ linked: 1 }))],
  ['lat/lng as ints', () => tok(claims({ lat: 0, lng: 0 }))],
  ['iat/exp string + linked int + lat/lng int', () => tok(claims({ iat: String(nowSec()), exp: String(nowSec() + 86400), linked: 1, lat: 0, lng: 0 }))],
  ['every claim a string', () => tok({ sub: 'LOCAL' + rnd(6), iat: String(nowSec()), exp: String(nowSec() + 86400), linked: 'true', cc: 'JP', lat: '0', lng: '0' })],
  ['alg none, empty sig', () => ({ rebe_token: jwt(b64.url, { alg: 'none', typ: 'JWT' }, claims(), '') })],
  ['b64 standard token', () => ({ rebe_token: jwt(b64.std, HDR, claims(), sig()) })],
]
let signCount = 0
function nextSignResponse() {
  const pinned = process.env.SIGN_VARIANT
  const i = pinned !== undefined ? Number(pinned) % SIGN_VARIANTS.length : signCount % SIGN_VARIANTS.length
  signCount++
  const [name, make] = SIGN_VARIANTS[i]
  return { name: `#${i} ${name}`, body: make() }
}
let counters = { total: 0, real: 0, stub: 0, unauth: 0, notfound: 0, meta: 0 }

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    counters.total++
    capture(req, raw)
    const url = req.url.split('?')[0]
    const key = req.method + ' ' + url
    let body = null
    if (raw) { try { body = JSON.parse(raw) } catch { body = null } }

    // Rebe boot chain (recorded from the real client, probe_http_2026-09-28.log):
    //   1. GET  <hjm>/systems/EAR-P-WW/<rev>/system.json  -> service directory (we serve it at /hjm/hjm)
    //   2. POST <mtm>/v1/steam-steam/sign/EAR-P-WW        -> {"rebe_token":"<JWT>"}
    if (key === 'GET /hjm/hjm' || key.startsWith('GET /hjm/systems/')) {
      counters.meta++
      log(200, key, '(system.json)')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Server': 'wilds-localserver/0.1' })
      res.end(JSON.stringify(systemJson(req.headers.host || `${HOST}:${PORT}`), null, 4))
      return
    }
    if (req.method === 'POST' && SIGN_PATH.test(url)) {
      counters.meta++
      const { name, body: signed } = nextSignResponse()
      const text = typeof signed === 'string' ? signed : JSON.stringify(signed)
      log(200, key, `(rebe sign, variant ${name})`)
      fs.appendFileSync(capturePath, JSON.stringify({ t: new Date().toISOString(), response: key, variant: name, body: text }) + '\n')
      res.writeHead(200, { 'Content-Type': typeof signed === 'string' ? 'text/plain' : 'application/json', 'Server': 'wilds-localserver/0.1' })
      res.end(text)
      return
    }

    // Any other Rebe meta service: schema not recovered yet. Answer 200 {} and let the
    // capture show what the client asks for next.
    if (META_PREFIX.test(url)) {
      counters.meta++
      log(200, key, '(meta, empty)')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Server': 'wilds-localserver/0.1' })
      res.end('{}')
      return
    }

    const route = routeByKey.get(key)
    const respHeaders = {
      'Content-Type': 'application/json',
      'X-Api-Version': '1.1.0',
      'Server': 'wilds-localserver/0.1',
    }

    // auth + rolling nonce
    let ctx = null
    if (!AUTH_EXEMPT.has(key)) {
      const a = authOf(req)
      if (!a) {
        counters.unauth++
        log('401', key)
        res.writeHead(401, respHeaders); res.end(JSON.stringify({ error: 'no session' })); return
      }
      ctx = a
      const newNonce = rnd(12)
      a.s.nonce = newNonce
      respHeaders['x-session-nonce'] = newNonce
    }

    const handler = H[key]
    let out
    if (handler) { out = handler(req, body, ctx || {}); counters.real++ }
    else if (route) { out = { status: 200, body: stubResp(route) }; counters.stub++ }
    else { counters.notfound++; log('404', key); res.writeHead(404, respHeaders); res.end(JSON.stringify({ error: 'unknown route' })); return }

    if (out.nonce) respHeaders['x-session-nonce'] = out.nonce
    log(out.status, key, handler ? '(real)' : '(stub)')
    res.writeHead(out.status, respHeaders)
    res.end(JSON.stringify(out.body))
  })
})

// ---- minimal RFC6455 WebSocket hub (lobby / notify) ----------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const wsClients = new Set()
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  capture(req, '')
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  )
  wsClients.add(socket)
  log('WS connect', req.url, 'clients=' + wsClients.size)
  socket.on('data', (buf) => {
    const op = buf[0] & 0x0f
    if (op === 0x8) { wsClients.delete(socket); try { socket.end() } catch {} return } // close
    // (decode of inbound text omitted; hub only needs to accept + push)
  })
  socket.on('close', () => { wsClients.delete(socket); log('WS close clients=' + wsClients.size) })
  socket.on('error', () => { wsClients.delete(socket) })
  wsSend(socket, JSON.stringify({ type: 'WELCOME', endpoint: req.url }))
})
function wsSend(socket, str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  try { socket.write(Buffer.concat([header, payload])) } catch {}
}

process.on('SIGINT', () => { log('counters', JSON.stringify(counters)); process.exit(0) })
process.on('SIGTERM', () => { log('counters', JSON.stringify(counters)); process.exit(0) })

server.listen(PORT, HOST, () => {
  log(`wilds-localserver listening http://${HOST}:${PORT}  (${routes.length} routes registered, ${Object.keys(H).length} real handlers)`)
})

export { server, db, counters }
