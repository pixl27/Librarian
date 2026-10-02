# Gates: store display correctness, search parity, Big Picture polish

OWNS: src/**, dev/**, PLAN.md, GATES.md

Scope: hovered and highlighted store covers are no longer clipped by their
shelf in either mode; store search results are presented in the store's own
visual language in both modes and route to the store page; the Big Picture
store gains substantive improvements beyond those fixes; nothing that already
worked regresses.

- [x] G1: The desktop shelf scroller reserves cross-axis room for the hover lift and its shadow instead of clipping them
  CHECK: node dev/verify-store.mjs desktop-clip
  EXPECT: OK desktop-clip
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=aba10b112c81b5a00fc317fb29071636830fde181bd4799e6741829863fa7f9b; output-bytes=16

- [x] G2: The Big Picture shelf strip reserves cross-axis room for the selected cover's scale, outline and bloom in padding, and states its cross-axis overflow
  CHECK: node dev/verify-store.mjs bp-clip
  EXPECT: OK bp-clip
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=c452f9e08f4497a0a931b23339523d1d7ad4f6ea676d0cefccdd88b17ade7a67; output-bytes=11

- [x] G3: Desktop search results are built from the store card component, not the old result-card component
  CHECK: node dev/verify-store.mjs desktop-search-cards
  EXPECT: OK desktop-search-cards
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d496c294ae10387a7dd8b7ec616e3a7325cd1c8f320388b7dd313788804dd4c4; output-bytes=24

- [x] G4: Big Picture store search results are built from the store cover component, not the library card component
  CHECK: node dev/verify-store.mjs bp-search-cards
  EXPECT: OK bp-search-cards
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=9117f9e94b18d5b34161d0918de11c047c0176ea8ede8bc48fd6494fae1eb602; output-bytes=19

- [x] G5: Every search entry point reachable from a store view routes through the store-search door
  CHECK: node dev/verify-store.mjs search-routing
  EXPECT: OK search-routing
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=736a8577ff0f6cb4f0121298412c6b17d28d4d1065c0f1d59e095104e49096fb; output-bytes=18

- [x] G6: The Big Picture store front carries the improvements claimed for it, each present in the shipped source
  CHECK: node dev/verify-store.mjs bp-front-improvements
  EXPECT: OK bp-front-improvements
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=25a2a3f0dfef3b392ca7220c1dedda014946436bf6c3b6311adf26159b5c121b; output-bytes=25

- [x] G7: The Big Picture store page carries the improvements claimed for it, each present in the shipped source
  CHECK: node dev/verify-store.mjs bp-page-improvements
  EXPECT: OK bp-page-improvements
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d39d27a4e85d14d0da4ffb2f2fa97632b4604545e200761dfd6ea94569764a0e; output-bytes=24

- [x] G8: Every renderer and main-process file parses, every CSS file is balanced, and no selector in the store stylesheets addresses markup that does not exist
  CHECK: node dev/verify-store.mjs integrity
  EXPECT: OK integrity
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=283ac8ca26755dffa8830b4a6231614bad473af63f22bf9e5309390dd1c7d258; output-bytes=13

- [x] G9: The verifier itself fails when the defect it checks for is reintroduced
  CHECK: node dev/verify-store.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=9767209e19cfe583301cb8260244d7472a472ae5dbce04a524b623fec3f92cb9; output-bytes=13

- [x] G10: The portable executable builds and the packaged asar contains this round's work
  CHECK: node dev/verify-store.mjs packaged
  EXPECT: OK packaged
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=e4be6a92ad1a903bd9d1ec4189c87b88bc21c446d48dc4bfd99d12dc7c93908e; output-bytes=12

- [x] G11: The Big Picture shelf scroller keeps a scrolled-to shelf away from its own clip edges, and the strips no longer push their reserved room outside the scrollable area
  CHECK: node dev/verify-store.mjs bp-scroll-clip
  EXPECT: OK bp-scroll-clip
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=e40232a16c7619fd10cf52fb78b1a8b1ab2983e2ed1beae42db5d2b846a22703; output-bytes=18

<!--
G9 is the negative control the skill asks for: verify-store.mjs re-runs each
structural assertion against a deliberately broken copy held in memory and
requires that it reports a failure. Without it, an assertion that can never
fail would certify itself.

G10 depends on a build having been run after the last source change; the check
compares the asar's modification time against the newest source file, so a
stale executable fails rather than passing quietly.
-->
