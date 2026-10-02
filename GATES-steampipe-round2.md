# Gates: SteamPipe engine, round two — second-pass fixes and optimisations

OWNS: src/core/steamPipe.js, src/core/chunkCodec.js, src/core/chunkWorker.js,
src/core/updateChecker.js, src/core/gameManager.js, src/js/app.js,
dev/steampipe-e2e.mjs, dev/verify-steampipe-engine.mjs,
GATES-steampipe-round2.md

Scope: the ten items from the second audit of the engine, implemented — the
ACF size written after an update, mirrors that serve corrupt bodies, a
disk-space check that covers updates and repairs, on-disk hashing moved to the
worker pool, file preallocation, CDN list refresh mid-download, staged data
reused across a resume, no empty folders for excluded content, sampler and
flush tuning, and an update check that can fall back to manifest ids — with
every gate from the first round still met.

Verified the same way as round one: dev/steampipe-e2e.mjs drives the real
engine against a local HTTPS origin under the shipped Electron runtime, the
unit-level pieces are exercised through the engine's own exports, and every
suite is re-run against a sabotaged clone that must make it fail.

- [x] G1: After an update, the ACF records the size of the whole install rather than the size of the patch, and the library reads that figure
  CHECK: node dev/verify-steampipe-engine.mjs e2e-acfsize
  EXPECT: OK e2e-acfsize
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d0a8836e98c630721f912873a2ad2767e77cbcdc77ea4b3f28a1bccbbbbcb3da; output-bytes=15

- [x] G2: A mirror whose bodies fail verification is benched after repeated failures, and the download completes byte-exact from the others
  CHECK: node dev/verify-steampipe-engine.mjs e2e-corrupt
  EXPECT: OK e2e-corrupt
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=bc12107583fe63f488ba97a80516f733c1c85241777e95383ebae0d89e1dc5fa; output-bytes=15

- [x] G3: The disk-space check runs for updates and repairs, counting a new file in full, a grown file by its growth, a shrunk file as nothing, and the staging area when one is needed; an update that fits reports the check, one that does not is refused before a byte is written
  CHECK: node dev/verify-steampipe-engine.mjs e2e-growth
  EXPECT: OK e2e-growth
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=26d31659d5c9f5a4f70f98a0d19ac9df4ee5b8b8ffedfb985fc2edd5f6d6a70a; output-bytes=14

- [x] G4: Every on-disk verification a repair performs, and every local recovery an update performs, hashes on a worker thread rather than the calling thread
  CHECK: node dev/verify-steampipe-engine.mjs e2e-offthread-hash
  EXPECT: OK e2e-offthread-hash
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d2dce6f86d11a93bbb339ac18dc0e68b9797a1fb92c2214432228b0fda16d744; output-bytes=22

- [x] G5: A file the download has begun is already at its declared length, so space is reserved up front and running out of it is reported at open rather than mid-write
  CHECK: node dev/verify-steampipe-engine.mjs e2e-prealloc
  EXPECT: OK e2e-prealloc
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=7faa7d77f03b5778e065941c3f1f004430cd63feacbed367fd94c1cd0af488e4; output-bytes=16

- [x] G6: When the healthy mirror count collapses, the engine asks the directory service again, merges what it learns, and finishes the download from a mirror that was not in the first answer
  CHECK: node dev/verify-steampipe-engine.mjs e2e-cdnrefresh
  EXPECT: OK e2e-cdnrefresh
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=90047a00da175b4a3b406b01cc02ceb7e75818ef60f9214f3998ebc7d47592f0; output-bytes=18

- [x] G7: An interrupted update, resumed, reuses the data it staged the first time instead of reading and hashing its sources again, and still lands byte-exact
  CHECK: node dev/verify-steampipe-engine.mjs e2e-stagereuse
  EXPECT: OK e2e-stagereuse
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=fab5c4908c0e77a571d77be5e93c2959d8af243cc6d0ec52a4d2d07ba00e437f; output-bytes=18

- [x] G8: A download with an excluded content group creates no directory whose only contents were excluded, while directories with anything left in them are still created
  CHECK: node dev/verify-steampipe-engine.mjs e2e-excludedirs
  EXPECT: OK e2e-excludedirs
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=c9851bd147bdd67bdd8a097420700f5dc3f8686af84e8d42108f4e7cf535fc1a; output-bytes=19

- [x] G9: The speed sampler keeps a bounded number of samples however many chunks complete, and the checkpoint interval backs off after a flush that ran long and recovers when flushes are quick again
  CHECK: node dev/verify-steampipe-engine.mjs tuning
  EXPECT: OK tuning
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=12f3fb41d44aac023eab3e3bcdfe0f8b83703b29f2aa1fbd00c9d316b107ab91; output-bytes=10

- [x] G10: With no local build id, the update check compares installed manifest ids against the public ones — differing means an update, matching means up to date, absent means unknown — and when both build ids exist they still decide
  CHECK: node dev/verify-steampipe-engine.mjs updatecheck
  EXPECT: OK updatecheck
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=ccd44759a75b0f65acef69e0502857978228c21ba69853a38cf7dc30764d8e0e; output-bytes=15

- [x] G11: Every runnable suite behind the sixteen round-one gates still passes against the engine as it is now
  CHECK: node dev/verify-steampipe-engine.mjs all-round1
  EXPECT: OK all-round1
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=fed2f382cdaa5a34a43feda43808c45b91342a64a4c42013d2ecd9cd7afdac28; output-bytes=14

- [x] G12: Each new suite fails when the behaviour it checks is broken
  CHECK: node dev/verify-steampipe-engine.mjs self-test-round2
  EXPECT: OK self-test-round2
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=38b54cd6a97b8ea65c370d1b3ff80caf2a3907ebe9ef4dc0d1a5614be3b115d4; output-bytes=20

<!--
G3's refusal branch cannot be produced end to end without a full disk, so the
arithmetic is exercised directly through the engine's exported estimator with
every case the gate names, and the e2e half proves the check is actually wired
into the update path. G6 uses a directory-service URL override so the real
resolution code runs against a local server; the override is a legitimate
setting in its own right (a directory mirror) and not a test-only branch.

G12 is the negative control, as in round one; G11 is the regression control
and re-runs the round-one harness rather than trusting its recorded evidence.
-->
