// Synthetic client for wilds_localserver.mjs.
// Walks the recovered boot -> auth -> social -> lobby -> quest brokering sequence
// and asserts the control-plane contract executes end to end. Local only.

import http from 'node:http'
import crypto from 'node:crypto'

const HOST = '127.0.0.1'
const PORT = Number(process.env.WILDS_PORT || 21080)

let pass = 0, fail = 0
const results = []
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(['PASS', name, detail]) }
  else { fail++; results.push(['FAIL', name, detail]) }
}

function req(method, path, { body, session, nonce, rebe } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : ''
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Capcom Web Client/4.0', 'X-Api-Version': '1.1.0' }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    if (rebe) headers['x-rebe-token'] = rebe
    if (session) headers['Authorization'] = 'Session id=' + session
    if (nonce) headers['x-session-nonce'] = nonce
    const r = http.request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let json = null
        try { json = raw ? JSON.parse(raw) : null } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json })
      })
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

function wsConnect(path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const r = http.request({
      host: HOST, port: PORT, path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    })
    r.on('upgrade', (res, socket) => {
      socket.once('data', (buf) => {
        // decode a small unmasked server text frame
        let txt = ''
        try {
          const len = buf[1] & 0x7f
          txt = buf.slice(2, 2 + len).toString('utf8')
        } catch {}
        socket.end()
        resolve({ status: res.statusCode, accept: res.headers['sec-websocket-accept'], first: txt })
      })
    })
    r.on('error', reject)
    r.end()
    setTimeout(() => reject(new Error('ws timeout')), 2000)
  })
}

async function main() {
  // 0. boot gates (no session)
  const health = await req('GET', '/sys/health')
  check('sys/health 200', health.status === 200 && health.json && health.json.Status === 'ok', JSON.stringify(health.json))

  const consent = await req('GET', '/v1/consent/documents/')
  check('consent GET 200 (auth-exempt)', consent.status === 200)

  // 1. auth requires session for protected routes
  const noauth = await req('POST', '/ban/info', { body: {} })
  check('protected route without session -> 401', noauth.status === 401, 'got ' + noauth.status)

  // 2. login with rebe token -> session + nonce in HEADER
  const login = await req('POST', '/auth/login', { rebe: 'DUMMY_REBE_' + crypto.randomBytes(6).toString('hex'), body: { RebeToken: 'DUMMY', CrossplayEnabled: true, RomVersion: 1042 } })
  const session = login.json && login.json.SessionId
  let nonce = login.headers['x-session-nonce']
  check('auth/login 200', login.status === 200)
  check('auth/login returns SessionId+UserId', !!(session && login.json.UserId), JSON.stringify(login.json))
  check('auth/login IsInCommunityBan=false', login.json && login.json.IsInCommunityBan === false)
  check('auth/login nonce in response HEADER (not body)', !!nonce && !('Nonce' in (login.json || {})), 'nonce=' + nonce)

  // 3. protected call with session -> nonce rolls
  const ban = await req('POST', '/ban/info', { session, nonce, body: {} })
  const nonce2 = ban.headers['x-session-nonce']
  check('ban/info with session 200', ban.status === 200)
  check('nonce rotates after each call', !!nonce2 && nonce2 !== nonce, nonce + ' -> ' + nonce2)
  nonce = nonce2

  // 4. hunter sync assigns HunterId + ShortId per slot
  const sync = await req('POST', '/hunter/sync', { session, nonce, body: { HunterSaveList: [{ Name: 'Aloy', Hr: 7, SaveSlot: 0 }], UsingSaveSlot: 0, MainLanguage: 1 } })
  nonce = sync.headers['x-session-nonce']
  const slot = sync.json && sync.json.SaveSlotInfoList && sync.json.SaveSlotInfoList[0]
  check('hunter/sync assigns HunterId', !!(slot && slot.HunterId), JSON.stringify(slot))
  check('hunter/sync assigns ShortId', !!(slot && slot.ShortId))

  const hlist = await req('POST', '/hunter/list', { session, nonce, body: {} })
  nonce = hlist.headers['x-session-nonce']
  check('hunter/list reflects synced hunter', !!(hlist.json && hlist.json.HunterList && hlist.json.HunterList.length === 1 && hlist.json.HunterList[0].Name === 'Aloy'), JSON.stringify(hlist.json))

  // 5. lobby brokering -> WS endpoint
  const lob = await req('POST', '/lobby/private/create', { session, nonce, body: { IsFriendOpen: true } })
  nonce = lob.headers['x-session-nonce']
  const lobbyId = lob.json && lob.json.LobbyId
  const lobEndpoint = lob.json && lob.json.Endpoint
  check('lobby/private/create returns LobbyId', !!lobbyId)
  check('lobby endpoint is a ws:// URL (broker)', /^ws:\/\//.test(lobEndpoint || ''), lobEndpoint)

  // 6. quest brokering -- QuestEndpoint is CLIENT-SUPPLIED (proves REST only brokers)
  const hostP2P = 'playfab-party://' + crypto.randomBytes(8).toString('hex') // stand-in for host's real P2P endpoint
  const qstart = await req('POST', '/quest/session/start', { session, nonce, body: { QuestEndpoint: hostP2P, MemberLimit: 4, ClientEnvId: 'env1', JoinHunterInfos: [], Password: '' } })
  nonce = qstart.headers['x-session-nonce']
  const qsid = qstart.json && qstart.json.QuestSessionId
  check('quest/session/start returns QuestSessionId', !!qsid)

  const qjoin = await req('POST', '/quest/session/join', { session, nonce, body: { QuestSessionId: qsid, ClientEnvId: 'env2', JoinHunterInfos: [], Password: '' } })
  nonce = qjoin.headers['x-session-nonce']
  check('quest/session/join hands back the HOST P2P endpoint verbatim (broker, not relay)',
        qjoin.json && qjoin.json.QuestEndpoint === hostP2P,
        'expected ' + hostP2P + ' got ' + (qjoin.json && qjoin.json.QuestEndpoint))

  // 7. a stubbed route still answers a schema-plausible 200
  const ranking = await req('POST', '/ranking/quest_time/board', { session, nonce, body: {} })
  nonce = ranking.headers['x-session-nonce']
  check('unimplemented route auto-stubbed 200 JSON', ranking.status === 200 && ranking.json !== null, 'status ' + ranking.status)
  check('auto-stub is schema-shaped (List field -> array, scalar -> 0)', ranking.json && Array.isArray(ranking.json.Contents) && ranking.json.TotalCount === 0, JSON.stringify(ranking.json))

  // 8. WebSocket lobby hub accepts the upgrade
  try {
    const ws = await wsConnect('/lobby/' + lobbyId)
    check('WS lobby upgrade 101 + valid accept', ws.status === 101 && !!ws.accept, 'status ' + ws.status)
    check('WS hub pushes a WELCOME frame', /WELCOME/.test(ws.first || ''), ws.first)
  } catch (e) {
    check('WS lobby upgrade 101 + valid accept', false, String(e))
  }

  // report
  console.log('\n=== SYNTHETIC CLIENT: control-plane sequence ===')
  for (const [st, name, detail] of results) {
    console.log((st === 'PASS' ? '  ✓ ' : '  ✗ ') + name + (st === 'FAIL' && detail ? '  [' + detail + ']' : ''))
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('client error', e); process.exit(2) })
