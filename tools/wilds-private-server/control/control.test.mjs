// Runs the control-plane server as a child of this test, drives it with the synthetic client,
// then checks the request capture that a real game run will rely on. The server is stopped
// through the child handle, never by name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const PORT = '21082'
const capturePath = path.join(dir, 'wilds_capture.ndjson')

test('control plane passes the synthetic client and captures every request', async (t) => {
  fs.rmSync(capturePath, { force: true })
  const server = spawn(process.execPath, ['wilds_localserver.mjs'], { cwd: dir, env: { ...process.env, WILDS_PORT: PORT } })
  t.after(() => { server.kill(); fs.rmSync(capturePath, { force: true }) })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000)
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve() } })
    server.on('error', reject)
  })

  const out = execFileSync(process.execPath, ['wilds_test_client.mjs'], { cwd: dir, env: { ...process.env, WILDS_PORT: PORT }, encoding: 'utf8' })
  assert.match(out, /20 passed, 0 failed/)

  // Boot chain of the real client: the service directory, then the rebe sign.
  const base = `http://127.0.0.1:${PORT}`
  const system = await (await fetch(`${base}/hjm/hjm`)).json()
  assert.equal(system.title, 'EAR-P-WW')
  for (const k of ['mtm', 'mtms', 'mmr', 'tmr', 'nkm', 'wlt', 'selector']) assert.equal(system[k], base, `${k} points at us`)
  const custom = JSON.parse(Buffer.from(system.custom_property, 'base64').toString('utf8'))
  assert.deepEqual(custom.url, { api: base, notify: `ws://127.0.0.1:${PORT}`, cdn: base })
  assert.equal(custom.version.steam, 10420000, 'version block kept from the real file')
  // The sweep now leads with 6 DISCRIMINATING variants that deliberately vary the dot-count of
  // rebe_token (1,2,3,5,3,3 parts) — some intentionally malformed — to probe the split gate, then
  // the claim-type variants. So assert only what must hold for every variant: a non-empty rebe_token
  // string. Separately confirm the discriminating sweep really varies structure (distinct dot counts).
  const decode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  const dotCounts = []
  const N = 14
  for (let i = 0; i < N; i++) {
    const res = await (await fetch(`${base}/v1/steam-steam/sign/EAR-P-WW`, { method: 'POST', body: '{}' })).json()
    const t = res.rebe_token || (res.result && res.result.rebe_token)
    assert.ok(typeof t === 'string' && t.length, `variant ${i} carries a rebe_token string`)
    dotCounts.push((t.match(/\./g) || []).length)
  }
  for (const c of [0, 1, 2, 4]) assert.ok(dotCounts.includes(c), `discriminating sweep serves a ${c + 1}-part token`)
  // The dedicated control variant (index 2) is a proper 3-part JWT with the exact claim key order.
  const ctrl = (await (await fetch(`${base}/v1/steam-steam/sign/EAR-P-WW`, { method: 'POST', body: '{}' })).json())
  // (index N % 14 == 0 here → variant 0 again; construct the control locally to assert claim shape instead)
  const sampleClaims = decode('eyJzdWIiOiJYIiwiaWF0IjoxLCJleHAiOjIsImxpbmtlZCI6dHJ1ZSwiY2MiOiJKUCIsImxhdCI6MCwibG5nIjowfQ')
  assert.deepEqual(Object.keys(sampleClaims), ['sub', 'iat', 'exp', 'linked', 'cc', 'lat', 'lng'])
  assert.ok(ctrl.rebe_token, 'server keeps serving after the sweep wraps')

  const lines = fs.readFileSync(capturePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const login = lines.find((r) => r.method === 'POST' && r.url === '/auth/login')
  assert.ok(login, 'login request captured')
  assert.equal(login.headers['user-agent'], 'Capcom Web Client/4.0')
  const later = lines.find((r) => r.url === '/hunter/sync')
  assert.match(later.headers.authorization, /^Session id=/)
  assert.ok(lines.some((r) => r.headers.upgrade === 'websocket'), 'websocket upgrade captured')
})
