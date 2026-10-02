'use strict';

/*
 * End-to-end test of the PartyWin.dll replacement, without the game.
 *
 * Builds the shim, builds party_client.exe (a tiny title written against the
 * real Party C API), starts the relay in-process and runs two client processes
 * against it: one hosts, one joins from the serialized descriptor. Every
 * assertion is on what the clients themselves printed, so the expected values
 * come from what a Party title observes, not from the shim's own bookkeeping.
 *
 * Run: node --test native/partyshim/test/party-shim.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { build } = require('../build.js');
const { createRelay } = require('../../../tools/wilds-private-server/party-relay.js');

const REAL_DLL = process.env.PARTYWIN_REAL || 'E:\\Games\\steam\\steamapps\\common\\Monster_Hunter_Wilds\\PartyWin.dll';
const OUT = path.join(__dirname, '..', 'out');
const VCVARS = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';

function buildClient() {
  const win = p => path.resolve(p).replace(/\//g, '\\');
  const bat = path.join(OUT, 'build-client.bat');
  fs.writeFileSync(bat, [
    '@echo off',
    `call "${VCVARS}" >nul || exit /b 1`,
    `cl /nologo /MT /O2 /W3 /EHsc /std:c++17 /D_CRT_SECURE_NO_WARNINGS /I"${win(path.join(__dirname, '..', 'vendor'))}" "${win(path.join(__dirname, 'party_client.cpp'))}" /Fo"${win(OUT)}\\\\" /Fe"${win(path.join(OUT, 'party_client.exe'))}" /link "${win(path.join(OUT, 'PartyWin.lib'))}"`,
    'exit /b %ERRORLEVEL%',
  ].join('\r\n') + '\r\n');
  execFileSync('cmd.exe', ['/c', win(bat)], { cwd: OUT, encoding: 'utf8' });
}

function run(args, env) {
  const proc = spawn(path.join(OUT, 'party_client.exe'), args, { cwd: OUT, env: { ...process.env, ...env } });
  const lines = [];
  const waiters = [];
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      lines.push(line);
      for (const w of [...waiters]) if (w.re.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  });
  const exited = new Promise(resolve => proc.on('close', code => resolve(code)));
  const waitFor = re => {
    const hit = lines.find(l => re.test(l));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      waiters.push({ re, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${re}\n${lines.join('\n')}`)), 15000).unref();
    });
  };
  return { proc, lines, exited, waitFor };
}

test('two Party clients host, join and trade messages through the relay', async t => {
  const built = build(REAL_DLL, OUT);
  assert.equal(built.exports, 157);
  buildClient();

  const relayLog = [];
  const { server, rooms } = createRelay({ log: m => relayLog.push(m) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const env = { LIBRARIAN_PARTY_RELAY: `127.0.0.1:${server.address().port}` };

  const host = run(['host'], env);
  const descLine = await host.waitFor(/^DESCRIPTOR /);
  const descriptor = descLine.slice('DESCRIPTOR '.length);
  assert.match(descriptor, /^LBP1:[0-9a-f-]{36}@127\.0\.0\.1:\d+$/);

  const join = run(['join', descriptor], env);
  const [hostCode, joinCode] = await Promise.all([host.exited, join.exited]);

  const dump = `\n--- host ---\n${host.lines.join('\n')}\n--- join ---\n${join.lines.join('\n')}\n--- relay ---\n${relayLog.join('\n')}`;
  assert.equal(hostCode, 0, `host exit code${dump}`);
  assert.equal(joinCode, 0, `join exit code${dump}`);

  // Ordering a title depends on: connect completes before anything else about the network.
  const order = lines => lines.filter(l => l.startsWith('EV ')).map(l => l.split(' ')[1]);
  for (const side of [host, join]) {
    const seq = order(side.lines);
    assert.ok(seq.indexOf('ConnectToNetworkCompleted') < seq.indexOf('AuthenticateLocalUserCompleted'), `connect before auth${dump}`);
    assert.ok(seq.indexOf('AuthenticateLocalUserCompleted') < seq.indexOf('CreateEndpointCompleted'), `auth before endpoint${dump}`);
    assert.ok(seq.includes('CreateChatControlCompleted') && seq.includes('ConnectChatControlCompleted'), `chat control setup${dump}`);
    assert.ok(seq.indexOf('ConnectToNetworkCompleted') < seq.indexOf('ConnectChatControlCompleted'), `chat connects after the network${dump}`);
  }

  // Messages: exact bytes, from the right entity, delivered to exactly our one endpoint.
  assert.ok(host.lines.includes('GOT hello-from-join from=ENTITY-JOIN receivers=1 options=3'), `host got join's hello${dump}`);
  assert.ok(join.lines.includes('GOT hello-from-host from=ENTITY-HOST receivers=1 options=3'), `join got host's hello${dump}`);
  assert.ok(host.lines.some(l => /^GOT bye from=ENTITY-JOIN receivers=1 options=1$/.test(l)), `host got bye${dump}`);

  // DONT_COPY buffers come back through DataBuffersReturned with the caller's identifier.
  assert.ok(join.lines.some(l => /^EV DataBuffersReturned count=2 id=0*1234$/.test(l)), `buffers returned${dump}`);

  // Each side sees the other's endpoint as remote and its own as local.
  assert.ok(host.lines.includes('EV EndpointCreated local=0 entity=ENTITY-JOIN'), `host sees join's endpoint${dump}`);
  assert.ok(join.lines.includes('EV EndpointCreated local=0 entity=ENTITY-HOST'), `join sees host's endpoint${dump}`);
  assert.ok(host.lines.some(l => l.startsWith('EV EndpointCreated local=1')), `host sees its own endpoint${dump}`);

  // Both left cleanly and the relay dropped the empty network.
  assert.ok(host.lines.includes('EXIT clean') && join.lines.includes('EXIT clean'), `clean exit${dump}`);
  assert.equal(rooms.size, 0, `relay closed the network${dump}`);
});

test('joining a network that does not exist reports NetworkNoLongerExists', async t => {
  buildClient();
  const { server } = createRelay();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const join = run(['join', `LBP1:00000000-0000-4000-8000-000000000000@127.0.0.1:${server.address().port}`], {});
  const code = await join.exited;
  assert.equal(code, 3);
  assert.ok(join.lines.includes('EV ConnectToNetworkCompleted result=11'), join.lines.join('\n'));
});

test('an unreachable relay reports an internet connectivity error', async () => {
  const join = run(['join', 'LBP1:00000000-0000-4000-8000-000000000000@127.0.0.1:1'], {});
  const code = await join.exited;
  assert.equal(code, 3);
  assert.ok(join.lines.includes('EV ConnectToNetworkCompleted result=3'), join.lines.join('\n'));
});
