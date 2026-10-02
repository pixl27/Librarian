# Gates: a depot-key catalog and the request-code mirror

OWNS: src/core/steamCatalog.js, src/core/steamManifest.js, src/core/depotKeys.js,
src/core/settingsStore.js, main.js, preload.js, src/index.html, src/js/app.js,
dev/verify-keycatalog.mjs, dev/run-regression.cjs, GATES-keycatalog.md

Scope: two live services, reverse-engineered on 2026-09-12, make paid games
work where an anonymous Steam session cannot. `api.993499094.xyz/depotkeys.json`
is a flat catalog of 221k depot decryption keys (`{depotId: hex64}`, ~17 MB, no
per-depot route); Librarian downloads it once, caches it in userData on a
time-to-live, and consults it for a depot whose key no local source knows —
after the Steam client's own config, an earlier Hubcap package and the project's
key file, before giving up. `20770407.xyz/manifest/<depot>/<manifest>` returns
not manifest bytes but a Steam manifest *request code* (a uint64), which works
for depots the anonymous session is refused a code for; the manifest itself
still comes from the Steam CDN, fetched with that code. Both are third-party and
untrusted: every catalog key is taken only if it is 64 hex characters, and every
manifest the code produces is checked by depot and manifest id after decoding, so
a hostile or wrong answer is dropped rather than written. Both are behind
settings and both default on; either can be turned off by clearing its URL. The
existing steammanifest source, its ledger and the app's other suites keep
passing.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:\Users\One\.claude\skills\unlazy\scripts\gate-lint.mjs GATES-keycatalog.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] G1: the catalog module downloads a `{depotId: hex64}` document to a userData cache, looks up only the depots asked for, refreshes when the cache is older than its time-to-live and not before, keeps the cache when the source is unreachable, and takes nothing that is not a 64-hex key from an untrusted body
  CHECK: node dev/verify-keycatalog.mjs catalog
  EXPECT: OK catalog
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=bdfd7f1c5947612a919ef706cad3d8e9c46300ee0c654ae94993d53a6c233b3a; output-bytes=11

- [x] G2: assembling a package consults the sources in order — a key already known locally is used without touching the catalog; a depot Steam hands out a key for never reaches the catalog; a paid depot with no local key and no Steam key is filled from the catalog and packaged, its key remembered; a depot no source can key is still left out with the key message
  CHECK: node dev/verify-keycatalog.mjs keyorder
  EXPECT: OK keyorder
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=b9f7688c0a3db044ea6fc7689830244f7045ca7c904121f42b4799d20e8d9685; output-bytes=12

- [x] G3: the request-code mirror is used correctly: when Steam refuses a request code for a depot, a code is fetched from the mirror and the manifest is downloaded from the Steam CDN with it and validated; the mirror is never asked to return manifest bytes; a mirror answer that is not a bare uint64, or that yields a manifest for the wrong depot, is rejected
  CHECK: node dev/verify-keycatalog.mjs reqcode
  EXPECT: OK reqcode
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=2f32a7d303398f9aa4f82cc4bf12b6f20e95f512b7bceb30f77b1f6ca6c7fcd2; output-bytes=11

- [x] G4: offline, the catalog and the request-code mirror together package a paid app that anonymous Steam refuses on both counts — no depot key and no request code — against mock servers, producing a ZIP inspectArchiveAppId accepts whose manifest bytes match the fixture
  CHECK: node dev/verify-keycatalog.mjs paid
  EXPECT: OK paid
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=028055d63fe98ecf9c5aeddbc40a7c4f3aeddab79044b4d154afada22ae383d0; output-bytes=8

- [x] G5: the sources agree: settings declare the catalog URL and the mirror, preload and main expose the catalog status channel, the markup carries the catalog control the renderer reads and writes, and the catalog is off when its URL is cleared
  CHECK: node dev/verify-keycatalog.mjs wiring
  EXPECT: OK wiring
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=cda507d2dc6289431c953d13aee1e4866932c4875977a970ec7f876ffba9b194; output-bytes=10

- [x] G6: the request-code mirror is behind a rotating proxy pool that fights its per-IP 401: pinned proxies parse to valid http(s) URLs (SOCKS and junk dropped) with a usable agent each; a request refused direct succeeds once a proxy is tried; an all-refused pool insists across direct and each proxy over two rounds then fails; a 200 that is not a code is a hard refusal that does not insist; and when no proxy is pinned a live pool is auto-sourced from a GitHub-published list (proxifly), ranked (https-capable and higher score first), probed, and reduced to the responders fastest-first — verbatim for an explicit list, off without a source, and never auto-sourced on a run with an injected client
  CHECK: node dev/verify-keycatalog.mjs proxy
  EXPECT: OK proxy
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=ad9417776a6d31c2038e9f1fd543de1f5e26b0d97da2d55f89a58102d103991f; output-bytes=9

- [x] G7: every touched file parses, and the verifier fails when each defect it checks for is reintroduced
  CHECK: node dev/verify-keycatalog.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=fdf331c9a33df1999f4c300412a3fc736dc521656ffadfb3645edc8851e854b0; output-bytes=1138

- [x] G8: the steammanifest ledger still passes with the mirror reframed as a request-code service, and the reliability suite and Electron smoke still pass with the catalog, proxy pool and request-code mirror wired in
  CHECK: node dev/verify-keycatalog.mjs regressions
  EXPECT: OK regressions
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=27ded8ca649bfa49e9ef88add5b875cd79d4698d338400c8a482317e15b60fba; output-bytes=90

- [x] G9: against the live services, the depot-key catalog supplies a known paid depot's key matching its public value, and a Steam-issued request code for the free depot downloads and decodes that depot's manifest from the Steam CDN through cdnFetchWithCode; the proxy pool and mirror are exercised best-effort (free proxies and the mirror's inbox vary, so not gated). Captured live this session: the proxy pool sourced 5 responding proxies from proxifly in ~5.5s and obtained a request code for the paid depot 2062431 (12465864444654640740) through the pool after direct access had been 401'd — the per-IP rate limit defeated by proxy rotation, exactly the fix intended; and earlier, direct request codes 17801934568731242833 / 14922275181498095012 for that depot downloaded and decoded its paid manifest (86 files) from steampipe.akamaized.net
  CHECK: node dev/verify-keycatalog.mjs live
  EXPECT: OK live
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=32349979f186b7cc6c0edea433c518037d114465f4ed1e0ed64e19b1f6904eda; output-bytes=471
