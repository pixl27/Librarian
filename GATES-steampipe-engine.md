# Gates: SteamPipe engine — download, update, speed, resume

OWNS: src/core/steamPipe.js, src/core/chunkCodec.js, src/core/chunkWorker.js,
src/core/lzmaWorker.js, src/core/settingsStore.js, src/index.html,
src/js/app.js, package.json, dev/steampipe-e2e.mjs,
dev/verify-steampipe-engine.mjs, GATES-steampipe-engine.md

Scope: the improvements identified in the SteamPipe audit, implemented — the
three correctness bugs (dead finalisation guard and skipped disk preflight, no
removal of files an update drops, a resume bitmap that trusts unflushed
writes), the chunk pipeline moved off the main thread, Lancache made real,
adaptive concurrency that can back off and recover, mirror health that reacts
to slowness and rate limiting, and an update that stages only what is at risk
and degrades per depot rather than wholesale. No existing behaviour regresses:
downloads, updates, repairs and resumes all still produce byte-exact installs.

The engine is verified by running it. dev/steampipe-e2e.mjs builds synthetic
depots (real Valve chunk framing: ZIP/deflate, VZ/LZMA and VSZ/zstd), serves
them from a local HTTPS origin, drives the real startNativeDownload(), and
compares the bytes on disk against what the manifest declared. It runs under
the shipped Electron runtime via ELECTRON_RUN_AS_NODE, so zstd and the native
LZMA decoder are the ones users actually get.

- [x] G1: A fresh download of a synthetic depot whose chunks span all three Valve container formats produces files byte-identical to the source, with the declared sizes
  CHECK: node dev/verify-steampipe-engine.mjs e2e-fresh
  EXPECT: OK e2e-fresh
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=a0546156c1d83341a55828fead51f64a07fb257fd36de42403b6469efb3cd241; output-bytes=13

- [x] G2: A download stopped mid-flight and restarted finishes byte-exact, and at the moment of the stop the persisted bitmap claims no chunk whose bytes are not already on disk
  CHECK: node dev/verify-steampipe-engine.mjs e2e-resume
  EXPECT: OK e2e-resume
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=f2936a33531f102687387fc8aae4aead2413e617768058c13b812776356be04e; output-bytes=14

- [x] G3: An update produces byte-exact new-build files, deletes the files the new build drops, truncates the ones it shortens, and moves strictly fewer bytes over the wire than installing the new build from scratch
  CHECK: node dev/verify-steampipe-engine.mjs e2e-update
  EXPECT: OK e2e-update
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=53ac43f5ff4becdc2f8654056577c89c6c03e60a5dd52defa0b6e8a9be822689; output-bytes=14

- [x] G4: A repair of an install with corrupted, truncated and deleted files restores every file byte-exact while re-downloading only the damaged chunks
  CHECK: node dev/verify-steampipe-engine.mjs e2e-repair
  EXPECT: OK e2e-repair
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=5001924c42e53fbebad82629d97529c0ec7b61292760d3830ee7c050a2a7d4b9; output-bytes=14

- [x] G5: The disk-space preflight still runs for a fresh install whose directory already holds engine scratch from an earlier attempt, and the finalisation guard refuses to register an install whose payload was deleted under a resume state claiming it is finished
  CHECK: node dev/verify-steampipe-engine.mjs e2e-guards
  EXPECT: OK e2e-guards
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=a5be8a41b2246eaca70a8c7417218a0b34475f67d83d003991ad28c706adf657; output-bytes=14

- [x] G6: Decryption, decompression and hashing happen on worker threads, and a download still completes byte-exact when the worker pool cannot start and the engine falls back to the inline pipeline
  CHECK: node dev/verify-steampipe-engine.mjs e2e-offthread
  EXPECT: OK e2e-offthread
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=7da410f4c2afea4e24441d06e033cd695d19910c2aa758d3b8ed917516fdc893; output-bytes=17

- [x] G7: The concurrency controller adds workers while throughput improves, gives the workers back when throughput gets worse, and keeps probing afterwards instead of stopping for good
  CHECK: node dev/verify-steampipe-engine.mjs ramp
  EXPECT: OK ramp
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=32cb067fce8148847b9bfc7fa328704e7cf63bf2f88b95f48f498fc989868c0a; output-bytes=8

- [x] G8: A Lancache that resolves to a private address is preferred over every CDN mirror; one that does not resolve, or resolves to a public address, is ignored
  CHECK: node dev/verify-steampipe-engine.mjs lancache
  EXPECT: OK lancache
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d8ff3d09d804cb84e867cb5642e9bc3256d1660638d5ad6491e5bd6ada52e871; output-bytes=12

- [x] G9: A mirror that answers slowly rather than failing is abandoned mid-request and benched, and a 429 carrying Retry-After pauses the whole pool instead of burning that chunk's retries
  CHECK: node dev/verify-steampipe-engine.mjs e2e-mirrors
  EXPECT: OK e2e-mirrors
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=79db581caa6df23398e70b05cfb479445df5e4621b117d4c968dfb6c19a5992e; output-bytes=15

- [x] G10: Update staging copies a chunk only when its source region is actually overlapped by a planned write, and the update still succeeds byte-exact when staging is skipped
  CHECK: node dev/verify-steampipe-engine.mjs e2e-staging
  EXPECT: OK e2e-staging
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=26d28ebc71a5ca7ccfa59dea480128e9007e758492ddf2a7f42809715fa4d9c9; output-bytes=15

- [x] G11: When one depot's prior manifest is missing, that depot alone falls back to on-disk validation while the others still patch from their prior build
  CHECK: node dev/verify-steampipe-engine.mjs e2e-perdepot
  EXPECT: OK e2e-perdepot
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=cdc4f1155b758f6ddff0f2d599f1844e1260496df51dd07701df858377a66c15; output-bytes=16

- [x] G12: A chunk whose first recorded prior location has been altered is still recovered locally from another location holding the same content
  CHECK: node dev/verify-steampipe-engine.mjs e2e-multiloc
  EXPECT: OK e2e-multiloc
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=6cdb476daa69f3b6cf86238cd31dd02faab223c3ddbf5fb274c532e46bdfdd89; output-bytes=16

- [x] G13: Pausing and cancelling each persist the resume state at that moment, without waiting for workers to unwind
  CHECK: node dev/verify-steampipe-engine.mjs e2e-persist
  EXPECT: OK e2e-persist
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=8eceaa4b205ca4aeeeea37eda55974385874cc3b631cec6b862022f0528ba831; output-bytes=15

- [x] G14: A download that completes many chunks inside one checkpoint interval still persists progress, because checkpoints also fire on chunk count
  CHECK: node dev/verify-steampipe-engine.mjs e2e-checkpoint
  EXPECT: OK e2e-checkpoint
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=fbbbc0c7f3255d6534e64188de4cecea9efdb9495c2a65c49c08ee3a6e713ec5; output-bytes=18

- [x] G15: Every changed source file parses, the new worker is unpacked by the packager the same way the existing one is, and no setting the UI writes is left unread by the engine
  CHECK: node dev/verify-steampipe-engine.mjs integrity
  EXPECT: OK integrity
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=283ac8ca26755dffa8830b4a6231614bad473af63f22bf9e5309390dd1c7d258; output-bytes=13

- [x] G16: Each suite above fails when the behaviour it checks is broken
  CHECK: node dev/verify-steampipe-engine.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=9767209e19cfe583301cb8260244d7472a472ae5dbce04a524b623fec3f92cb9; output-bytes=13

<!--
G1-G6 and G9-G14 drive the real engine against a real HTTPS origin. They are
end-to-end because the failure mode that matters for a downloader is a corrupt
install, and no amount of structural assertion detects that. Byte-comparison
against the source content is the oracle throughout.

G16 is the negative control. Every e2e suite is re-run against an engine whose
relevant behaviour has been sabotaged in a copied working tree, and must fail.
An e2e test that passes against a broken engine is measuring nothing.

The harness runs under ELECTRON_RUN_AS_NODE against node_modules/electron so
zstd and @napi-rs/lzma resolve exactly as they do in the shipped app; the
system Node on this machine is v20 and has neither. verify-steampipe-engine.mjs
re-executes itself under that runtime, so the CHECK lines stay plain `node`.
-->
