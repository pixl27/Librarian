# UI rewrite ledger

Direction validated by the user on 2026-10-02 from `design/proposal/shots/*.png`
(Home, Library, Game page, Downloads kept on the user's own layout).

Approach: every stylesheet for the desktop UI is rewritten from scratch and the
markup is rebuilt around a new shell (sidebar, top strip, dock). The JavaScript
logic and the element ids it binds to are kept, so no feature is lost; render
templates are rewritten where the new design needs different markup.
The previous UI is backed up in `design/legacy-ui/`.

Tick an item only after a screenshot from `dev/ui-shots.cjs` shows it right.
The pictures are in `design/shots/` (1440x900) and `design/shots-narrow/`
(1024x640). `[x]` = seen right on a capture of the real renderer. `[~]` = part
seen, the rest listed. `[ ]` = not seen.

## Foundation
- [x] Tokens, base, components (`src/styles/main.css`)
- [x] Shell: sidebar nav, top strip with search and window controls, dock
- [x] Accent taken from the game in focus (home.png: coral for CONTROL Resonant).
      It was silently off for every recent Steam app: their legacy `header.jpg`
      fails to load, so nothing was sampled. Now falls back to the resolved art.

## Screens
- [~] Home: hero, update notice, shelves seen. Not seen: the empty library and
      the first-run setup banner (both need a profile with no games).
- [~] Library: chips, sort, view and density, grid tiles, list view, empty
      Favorites seen. Pagination is covered by the UI audit (160 per page), not
      by a picture.
- [~] Game page: hero, play bar, tabs, overview with achievements, online mode
      (off), DLC, patch notes, media, files, graphics (DLSS FG) seen. Not seen:
      online mode switched on, the emulator panel, the friend-join panels
      (PEAK / Photon), which only appear for specific games.
- [x] Downloads: focus view and idle view, both widths
- [x] Store: search hero, results, front page, store detail page
- [x] Tools: Steam emulator page, Tuning page
- [x] Settings: section nav and all eleven sections (settings-1 … settings-11)

## Overlays
- [~] Modal shell, confirm, exe picker, collection picker, add custom game
      seen. Not seen: the custom update association form.
- [~] Install plan sheet seen (plan.png). Not seen: the destination picker.
- [~] News dialog seen. Not seen: CS.RIN.RU picker and the auth prompt (opening
      them queries the forum with the saved account; left for a real session).
- [x] Command palette, shortcut sheet, context menu, lightbox, toasts
- [~] Onboarding seen; guided tour seen at steps 1 and 7 of 25 only.

## Motion
- [~] `kinetic.css` is the new motion layer, scoped under `data-kinetic="on"`,
      and no capture shows an element stuck on its first keyframe. Stills
      cannot judge how it moves: to be looked at in the real window.

## Big Picture
- [x] Type and colour aligned on the new system (bigpicture.png, bp-details,
      bp-menu, bp-search, bp-grid). Geometry, transforms and its own accent
      setting untouched. Rail icons that filled in as blobs (clock, disc, news,
      Steam) fixed with the even-odd rule.
- [ ] In grid layout the hint bar sits over the last visible row of covers
      (bp-grid.png). Not checked against the previous UI, not changed.

## Verification
- [x] `run-electron-check.cjs smoke`: 37 checks, 0 errors.
      `run-electron-check.cjs ui`: 47 checks, 0 failed.
      verify-emucompat, verify-store (integrity + self-test), verify-tuning,
      verify-csrin, verify-news, verify-dlssg (38/38), verify-reliability
      (20/20) pass. Results in `audits/2026-10-02/ui-rewrite/`.
- [~] Packaged build: `dist\Librarian 1.1.0.exe` rebuilt 2026-10-02 12:15
      (exit 0), 15 UI files in `app.asar` identical to the sources (SHA-256).
      The previous build is kept as `dist\Librarian 1.1.0 (previous UI).exe`.
      Not done: the packaged exe has not been launched. Real launch by the user.

## Fixed while reviewing the captures (second session)
- Back was dead under the mouse on the game page (with previous / next) and on
  a store page: the top strip's window-drag region lay over the buttons. They
  worked from code, so no capture and no DOM click showed it; the user found
  it in the real window. The drag strip now starts after the buttons, and
  `dev/ui-hit-audit.js` asks the hit test for every control on eleven screens
  (0 findings at 1440x900 and 1024x640). Exe rebuilt at 12:57.
- Install plan: optional cards collapsed to 40x24 because the generic
  `[role="switch"]` toggle rule also matched them. Rule now targets buttons.
- Settings: clicking a section tab scrolled the whole page under the top strip
  (`scrollIntoView` scrolls `overflow: hidden` ancestors). The panel is scrolled
  directly, and `body` / `.page` use `overflow: clip` so no other call can do it.
- Top strip: scrolled text ran behind the search field on Home, the game page
  and a store page. Each of those pages now lays a ground under the strip.
- Store page: broken picture in the corner, thumbnails over the description.
- Command palette, dock, up-next and context-menu thumbnails for recent apps.
- Patch notes showed `[/*]` and `[p]` tags (`src/core/steamNews.js`).
- Sidebar count pushed inwards by the hidden hotkey hint; Tools page capped at
  900 px with its scrollbar mid-window; old mascot on the onboarding card;
  "What's new" Denuvo card too narrow; path wrapping mid-name; a bare checkbox
  among the switches; "Favourites" / "Favorites" mixed; download figures
  truncated at 1024 px.
