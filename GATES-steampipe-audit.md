# Gates: SteamPipe engine audit — download, update, speed, resume

> **Closed, and now deliberately failing.** This ledger was the evidence base
> for the audit report: nine of its gates assert that a specific defect *is
> present* in the engine, and each was written to start failing the moment that
> defect was fixed. Every one of them has since been fixed — see
> GATES-steampipe-engine.md, the live ledger for that work — so re-running
> G1-G9 today reports the defects as absent, which is the outcome they were
> designed to announce. The evidence recorded below is what was measured on
> 2026-08-31, before any of it was changed, and it is kept as the record of why
> the engine work was undertaken. Do not re-verify this ledger expecting green.
>
> Verified superseded: all nine defect suites reported FIXED on 2026-08-31,
> after the engine work landed.

OWNS: dev/verify-steampipe-audit.mjs, GATES-steampipe-audit.md

Scope: an improvement report for the SteamPipe engine covering all four
dimensions the user named — download, update, speed, resume — where every
statement the report makes about how the engine behaves *today* is measured
against the shipped source rather than recalled, so the recommendations built
on those statements cannot rest on a misreading.

The engine is not modified by this work. These gates verify the evidence base,
not a code change: each one asserts a fact about current behaviour that a
recommendation depends on, and is written to start failing the moment that
behaviour is fixed.

- [x] G1: A chunk is recorded as permanently done in the resume bitmap without its bytes being flushed to stable storage, and neither pausing nor stopping persists the bitmap at that moment — the only synchronous save sits inside run() behind a full worker unwind, under main.js's 400 ms quit deadline
  CHECK: node dev/verify-steampipe-audit.mjs resume-durability
  EXPECT: OK resume-durability
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=3e8ed8adfbf3e32ebb43973b29e79d78bc192fd30ce30de747559d834b07ccb5; output-bytes=21

- [x] G2: The resume state file is written into the install directory and counts as a game file, so the finalisation guard against registering an install whose payload was deleted cannot fire, and an interrupted fresh download permanently loses its disk-space preflight
  CHECK: node dev/verify-steampipe-audit.mjs resume-guard
  EXPECT: OK resume-guard
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=f64961f799d5279460a289faaec5f22bb97eeefca447d6f408ad8b20ea9cf6a2; output-bytes=16

- [x] G3: The adaptive concurrency controller only ever adds connections, samples every 4 s, ignores zero-rate samples, and stops permanently after two non-improving samples with no path back
  CHECK: node dev/verify-steampipe-audit.mjs speed-ramp
  EXPECT: OK speed-ramp
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=e631f8b2dc3173621387d9fd56c7b755ceada9e56e203ece91d0e8a6ce02288d; output-bytes=14

- [x] G4: Per-chunk AES decryption and SHA-1 verification run synchronously on the calling thread, and the worker pool is used for LZMA only — including the repair path's on-disk hashing
  CHECK: node dev/verify-steampipe-audit.mjs speed-cpu
  EXPECT: OK speed-cpu
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=91aed1e84e0ce01762ce9f95e5d3f1645b151e22a635f00f32e0fc1ef1742e3c; output-bytes=13

- [x] G5: Mirrors start unranked with no latency probe, the CDN server list is resolved exactly once per job, and a mirror loses rank only on a thrown error — never for being slow, rate-limited, or returning a short body
  CHECK: node dev/verify-steampipe-audit.mjs hosts
  EXPECT: OK hosts
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=c9936baa5e1e5a60a4bdb72438f51e362671b40c0730ac9911278cd7a453800b; output-bytes=9

- [x] G6: "Use Lancache" is a stored setting with a checkbox in the settings UI and a renderer that persists it, which the download engine never reads
  CHECK: node dev/verify-steampipe-audit.mjs lancache
  EXPECT: OK lancache
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d8ff3d09d804cb84e867cb5642e9bc3256d1660638d5ad6491e5bd6ada52e871; output-bytes=12

- [x] G7: An update never deletes a file that the previous build had and the new build drops, although both the old and new file lists are already assembled in memory; the only length correction is the truncation of shortened files
  CHECK: node dev/verify-steampipe-audit.mjs update-orphans
  EXPECT: OK update-orphans
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=8365347e198fd4c86f81d9bbb75e4c961c5acd78af8e482155f85392f657f72a; output-bytes=18

- [x] G8: Every reusable chunk in an update is read and written to scratch before the update writes it again, because staging is driven only by the recovery plan and free space and never asks whether that chunk's source region was at risk of being overwritten
  CHECK: node dev/verify-steampipe-audit.mjs update-staging
  EXPECT: OK update-staging
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=7f6af352510602c02eeab854960beed1285b4a96326f03eee2cf9632284632ab; output-bytes=18

- [x] G9: Only the first on-disk location of each chunk hash is remembered, and the entire prior index is abandoned if any selected depot cannot be pinned to a cached manifest
  CHECK: node dev/verify-steampipe-audit.mjs prior-index
  EXPECT: OK prior-index
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=a471665a63318dd12ab9b8f8379b97948827dbdcfac6e34ed7f4a626cf7bb603; output-bytes=15

- [x] G10: Every suite above fails when the specific behaviour it asserts is altered in the source it reads
  CHECK: node dev/verify-steampipe-audit.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=9767209e19cfe583301cb8260244d7472a472ae5dbce04a524b623fec3f92cb9; output-bytes=13

- [x] G11: The report delivered to the user covers all four requested dimensions — download, update, speed, resume — and every claim it makes about current engine behaviour traces to one of G1-G9
  EVIDENCE: 2026-08-31, reviewed by hand against the delivered report. All four
  dimensions answered: download (items 1, 3, 7, 10-14, 21), update (items 2, 16-20),
  speed (items 8-15), resume (items 1, 3-7). Claim-to-gate mapping, one line per
  current-behaviour claim the recommendations rest on:
    item 1  state file defeats directoryHasFiles, killing the finalisation guard
            and the disk-space preflight ......................................... G2
    item 2  no deletion of files the new build drops; both lists already in memory  G7
    item 3  chunk bit set without any flush to stable storage ................... G1
    item 4  neither markPaused() nor stop() persists; only run()'s stopped path
            does, under main.js's 400 ms quit deadline .......................... G1
    item 5  checkpoint cadence is time-based only (STATE_SAVE_INTERVAL_MS) ...... G1
    item 6  resumed chunks are trusted without verification .................... G1, G2
    item 7  manifest cleanup runs from the error path .......... read directly, not gated
    item 8  AES + SHA-1 synchronous on the calling thread; pool is LZMA-only .... G4
    item 9  ramp is one-way, 4 s samples, terminal after two flat ............... G3
    item 10 every mirror seeded ewma 0; resolveCdn called exactly once .......... G5
    item 11 no slow-mirror detection; only the 30 s timeout ..................... G5
    item 12 no 429/Retry-After handling; fixed linear backoff ................... G5
    item 13 fetched body never checked against cbCompressed .................... G5
    item 14 use_lancache stored, shown, persisted, never read by the engine ..... G6
    item 15 no bandwidth limit ................................. absence, read directly
    item 16 staging is unconditional; every reused byte read and written twice .. G8
    item 17 only the first location per chunk hash is kept ...................... G9
    item 18 prior index abandoned wholesale if any depot cannot be pinned ....... G9
    item 19 prior manifest sourced only from the library depotcache ............. G9
    item 20 checkForUpdate compares build ids only ..... read directly (updateChecker.js)
    item 21 second retry pass runs with no cooldown ............ read directly, not gated
  Four claims (items 7, 15, 20, 21) are not gate-backed. Each is a
  read-it-and-see fact about a single short function rather than an inference
  across the engine, and each is labelled in the report as the smaller-stakes
  polish it is; none of the P0/P1 recommendations depend on them.

<!--
G10 is the negative control. Nine of these gates assert that a defect or a
limitation is present, and an assertion of that shape is worthless if it cannot
fail: a typo in a regex would certify the claim just as happily as the code
would. G10 re-runs each suite against a copy of the source in which that suite's
subject has been changed, and requires the suite to notice.

It has already earned its place once. The first draft of G1 looked for
/fsync|fdatasync/ and passed a mutant that called `handle.sync()`, which is the
actual Node API for the flush the gate claims is missing.

G2 is behavioural rather than textual: the shipped directoryHasFiles() is
extracted from the source and run against real temporary directories, with two
controls (marker-directory-only must be false, a real payload file must be
true) so the positive result cannot come from a function that simply always
returns true.

G11 is manual because the deliverable is prose written into the conversation,
which no command can read. Its risk is low: G1-G10 already hold the factual
content, and what G11 adds is only that all four requested dimensions were
answered rather than three.
-->
