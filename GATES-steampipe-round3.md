# Gates: SteamPipe engine, round three — speed, updates and failure handling

OWNS: src/core/steamPipe.js, dev/steampipe-e2e.mjs, dev/verify-steampipe-engine.mjs,
dev/bench-cdn-strategy.cjs, dev/bench-disk-patterns.cjs, GATES-steampipe-round3.md

Scope: the defects and slow paths found by measuring the engine on this machine
— a write order that made the filesystem zero-fill most of a large install, a
mirror rotation that left every connection cold, a request timeout that no slow
line could meet, a full disk that kept the download running, a decoder thread
whose death hung the job, a Lancache asked over TLS, and update staging done
one chunk at a time — fixed, with every gate from the first two rounds still met.

Verified as before: dev/steampipe-e2e.mjs drives the real engine against a
local origin under the shipped Electron runtime, and each new suite is re-run
against a sabotaged clone that must make it fail.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/One/.claude/skills/unlazy/scripts/gate-lint.mjs GATES-steampipe-round3.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=b4f5c7ae28df2c5c938b9b22448f0597ff02e4a466c679df88490549fafb6327; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G1: every file is written front to back — no write lands past what its file already holds by more than the concurrent connections account for — and each repeated chunk still crosses the network once
  CHECK: node dev/verify-steampipe-engine.mjs e2e-writeorder
  EXPECT: OK e2e-writeorder
  EVIDENCE: automatic-evidence=v1; definition-sha256=76419a13094a336c6ee0e9ee64486a3c7909a8bff4d0566cbd8e84b56e5c2433; exit=0; EXPECT=matched; output-sha256=c92f9989158bf07e6a837b97e787ad8e794c5e1220ab52114389418538837178; output-bytes=18; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G2: a resumed download takes a repeated chunk from the destination already on disk instead of asking the network for it again
  CHECK: node dev/verify-steampipe-engine.mjs e2e-home
  EXPECT: OK e2e-home
  EVIDENCE: automatic-evidence=v1; definition-sha256=4c4ecd99dd043035844779e55e7b0b1ff2c7ac0adbb764e6bddaf93e16972ec6; exit=0; EXPECT=matched; output-sha256=025bb63426e7dd3b6e44a6cf6d21352c2af91d2695ce04e53b63806305316259; output-bytes=12; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G3: a body that keeps arriving is never abandoned for taking longer than the silence limit, and one that stops arriving is abandoned at that limit and fetched again
  CHECK: node dev/verify-steampipe-engine.mjs e2e-slowlink
  EXPECT: OK e2e-slowlink
  EVIDENCE: automatic-evidence=v1; definition-sha256=89cfffafa141262b5b54a954e1fede87b74848d347828e5901129fd9d89e7a42; exit=0; EXPECT=matched; output-sha256=6fd558433df8bcc07bf6288065cff42e7b6a2c97a5bbd204ec90e3cc3cb8c9f1; output-bytes=16; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G4: when the disk fills, the job stops at once with an error that says so, downloads nothing further, and keeps both the resume state and the manifests
  CHECK: node dev/verify-steampipe-engine.mjs e2e-diskfull
  EXPECT: OK e2e-diskfull
  EVIDENCE: automatic-evidence=v1; definition-sha256=79968ed20d9de9dd44cabc3a6f348ac29305fac46ade2f4106ab912c835f7d4d; exit=0; EXPECT=matched; output-sha256=4e75b49986f8f7e405637b77bcefc1967e05bc1b937038f747032f895b684641; output-bytes=16; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G5: a decoder thread that exits without raising an error costs one retried chunk — the download completes byte-exact, on the remaining threads
  CHECK: node dev/verify-steampipe-engine.mjs e2e-workerexit
  EXPECT: OK e2e-workerexit
  EVIDENCE: automatic-evidence=v1; definition-sha256=b881dbf0c80bf0c7e2a9e188fef6b945ebcd02ca260825ea7c03f2bffc88ddc7; exit=0; EXPECT=matched; output-sha256=0550b7edf0b3c181280ff3165467499d9f2c7e1b4505c47f8b4ad32c3639af70; output-bytes=18; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G6: the download rides on two to four mirrors sized to its connections, a single failure does not evict a fast mirror, an untested mirror is tried occasionally and promoted when faster, and a Lancache is asked over plain HTTP with the Steam client's user agent
  CHECK: node dev/verify-steampipe-engine.mjs hostpool
  EXPECT: OK hostpool
  EVIDENCE: automatic-evidence=v1; definition-sha256=4182ad59680d2df1a84508248c3238a8ce5a2c07cc805b63da9901182b8fd08c; exit=0; EXPECT=matched; output-sha256=d5183f0259ed9c8e45aacf548be2de065d81e525e841e9bcdefb11c2c08b5e2d; output-bytes=12; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G7: an update stages the chunks it is about to overwrite several at a time, and still lands byte-exact having downloaded only the new content
  CHECK: node dev/verify-steampipe-engine.mjs e2e-stage-parallel
  EXPECT: OK e2e-stage-parallel
  EVIDENCE: automatic-evidence=v1; definition-sha256=7e18989d5721a806a0be0dca8b75e772d03a7a02c6a48d71114656d37f90be95; exit=0; EXPECT=matched; output-sha256=369b629eecb87b719afd14968cae215ddd8da72f06f67b6425e65ca213f4dd6e; output-bytes=22; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G8: every suite behind the first two rounds' gates still passes against the engine as it is now
  CHECK: node dev/verify-steampipe-engine.mjs all-earlier
  EXPECT: OK all-earlier
  EVIDENCE: automatic-evidence=v1; definition-sha256=61a9f36f8343d826a87b8db93611de73fd9483431e3ca1207c57fcd8452d3984; exit=0; EXPECT=matched; output-sha256=7d110564e2769993a673f2ee672954ec7ccec7317a94c703adeb62d410073caf; output-bytes=15; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

- [x] G9: each new suite fails when the behaviour it checks is broken
  CHECK: node dev/verify-steampipe-engine.mjs self-test-round3
  EXPECT: OK self-test-round3
  EVIDENCE: automatic-evidence=v1; definition-sha256=1f7d7cfaba3f917ee3a71f1bfd486cb88694f71d68f58859344cf50da4fc38c3; exit=0; EXPECT=matched; output-sha256=14230a6598c93024ad6e8c4628e7d3bd9f8c3e23de42d31c86d5d4704d51b4a5; output-bytes=20; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries

<!--
G6's Lancache half runs the real fetch path against a local plain-HTTP server;
no Lancache exists on this network, so behaviour against a real one is not
covered by any gate here. G4 injects the failure at the write call, because a
real full disk cannot be produced on demand. G3 shortens the silence limit in a
sandboxed copy of the engine so the scenario takes seconds, not minutes; the
rule under test is unchanged by the constant.

The measurements that motivated G1 and G6 are reproducible with
dev/bench-disk-patterns.cjs and dev/bench-cdn-strategy.cjs. They are not gates:
the first replays manifests rather than running the engine, and the second
depends on the state of the link at the moment it runs.
-->
