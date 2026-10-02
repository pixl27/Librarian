# Hook map: enhancement and motion layers

Sources read in full: `src/js/enhance.js` (2712 lines), `src/js/kinetic.js` (467 lines), `src/js/trailer.js` (82 lines).
Static markup read in `src/index.html`: lines 1-190 (top bar, sidebar, Home hero), 250-281 (library toolbar), 412-460 (`#dl-focus`), 700-713 and 1000-1013 (settings), 1187-1308 (palette, shortcut sheet, onboarding, plan, tour, toasts, confetti), 1310-1321 (script order).
Legacy CSS consulted for intent only: `design/legacy-ui/styles/enhance.css` (grepped, plus lines 50-545, 610-660, 795-820, 1336-1350, 1455-1475, 2375-2530, 3040-3110) and `design/legacy-ui/styles/kinetic.css` (lines 1-980 read; 980-1427 grepped, Big Picture only).

Conventions:
- `file:line` means `src/js/enhance.js` unless the file is named.
- "CSS must" lists what the JS relies on. "CSS may" lists hooks that exist only for styling.
- `.hidden` is the global utility (`main.css:1489 .hidden { display:none !important }`). Every show/hide in these files toggles `.hidden`, so the new stylesheet **must** keep `.hidden` as `display:none !important`.
- Script order (index.html 1311-1321): hls, trailer.js, dialogs.js, dlssg*.js, app.js, **enhance.js**, store.js, tuning.js, bigpicture.js, **kinetic.js**. Stylesheet order (index.html 9-18): main, enhance, library, store, bigpicture, tuning, **kinetic** ("deliberately last"), stability, dlssg.

Root (`<html>`) state that the CSS can key on, and who writes it:

| Hook | Values | Written by | Meaning |
|---|---|---|---|
| `html[data-nav]` | `pointer` / `key` / `pad` | app.js:107 (initial `pointer`), enhance.js:108 | Input mode; chooses which focus ring is shown |
| `html[data-tilt]` | `on` / `off` | app.js:106, enhance.js:2655 | Tile 3-D tilt preference |
| `html[data-libview]` | `grid` / `list` | app.js:105, enhance.js:1651 | Library layout |
| `html[data-density]` | `compact` / `cozy` / `large` | app.js:104, enhance.js:1662 | Tile size |
| `html[data-navind]` | `on` | enhance.js:2530 | Sliding nav pill exists; per-tab active styling may be stripped |
| `html[data-kinetic]` | `on` or absent | kinetic.js:51-52 | Motion layer enabled AND document visible AND not reduce-motion |
| `html.reduce-motion` | class | app.js:7041, enhance.js:557 | Reduce motion |
| `html.show-hotkeys` | class | enhance.js:919-921 | Alt held: reveal `.nav-key` badges |
| `html.is-maximized` | class | enhance.js:1826 | Window maximized |

---

## A. enhance.js, module by module

28 modules documented below (A1-A28), plus the wiring section (A29).

### A1. Interface sounds (`Sound`, 42-102)
1. DOM: none. WebAudio oscillator only.
2. Classes/attributes: none. Reads `settings.ui_sounds` and `settings.ui_sound_volume`.
3. Geometry: none.
4. Timers: `move` sounds are throttled to one per 45 ms (70). No CSS coupling.

Voices: `move`, `select`, `back`, `launch`, `error`, `success`, `open`. Click-driven sounds come from A21.

### A2. Input mode / nav mode (107-113)
1. DOM: `<html>`.
2. Sets `html[data-nav]`:
   - `pointer` on any `pointerdown` (capture);
   - `key` on `Tab` / arrow keydown (capture). Spatial nav (A12) keeps `pad` if already `pad`;
   - `pad` when a gamepad direction is pushed (1174). Gamepad `stop()` reverts `pad` to `pointer` (1270).
   - `focusFirstTile()` forces `key` (1025).

   CSS must draw a visible focus ring for `key` and `pad`. Legacy: `pointer` gets a thin outline; `key`/`pad` get outline + glow; `pad` also enlarges `.game-tile:focus-visible` and `.result-card:focus-visible` (translateY(-6px) scale(1.035), z-index 3).
3. Geometry: none.
4. Timers: none.

### A3. Scroll reveals (118-139)
1. DOM: any `.reveal` element inside a `librarian:rendered` container (2631-2633). app.js:616 creates every tile as `class="game-tile reveal"`.
2. Adds `.shown` to a `.reveal` element when an IntersectionObserver reports it (rootMargin `80px 0px`, threshold 0.02). Sets inline `--reveal-delay: <n>ms` on that element: `min(index*28, 260)` ms, where index counts within the batch (124).
   If there is no IntersectionObserver, or reduce-motion is on, every `.reveal` gets `.shown` at once (134-136).

   CSS must: `.reveal` is the parked state (legacy: `opacity:0; transform:translateY(18px)`). `.reveal.shown` is the resting state, with `transition-delay: var(--reveal-delay, 0ms)`. `html.reduce-motion .reveal` must be fully visible.
   **Risk:** `.reveal { opacity: 0 }` gates visibility on the observer. A tile that is never intersected (for example when the observer does not fire in a hidden renderer) stays invisible. kinetic.css also overrides `.reveal` / `.reveal.shown` under `data-kinetic` (kinetic.css:539-546). Both states must be declared at the same specificity, or the parked transform is never released (comment at kinetic.css:531-538).
3. Geometry: none (observer only).
4. Timers: the stagger is `--reveal-delay` (max 260 ms). The CSS duration is free.

### A4. Tile tilt + cursor spotlight (`setupTilt`, 145-191)
1. DOM: delegated over `.game-tile` (any page; `e.target.closest('.game-tile')`).
2. On the hovered `.game-tile`:
   - inline `--mx`, `--my` (pointer position as a `%` of the tile, one decimal) are **always** set while hovered (157-158). They are not removed on leave; the last value stays.
   - when `html[data-tilt="on"]` and not reduce-motion: class `.tilting` (174) plus inline `--ry` (`(px-0.5)*14` deg), `--rx` (`(0.5-py)*9.8` deg) and `--tz: 14px` (162-164). Max ±7° Y, ±4.9° X.
   - reset on tile change, on `pointerleave` (document, capture) and on any `scroll` (capture): removes `.tilting`, `--rx`, `--ry` and `--tz` (185-190).

   CSS must: give `.game-tile` defaults `--rx:0deg; --ry:0deg; --tz:0px; --mx:50%; --my:50%`. Legacy transform: `html[data-tilt="on"] .game-tile.tilting { transform: perspective(900px) rotateX(var(--rx)) rotateY(var(--ry)) translate3d(0,-6px,var(--tz)); transition: transform 80ms linear }`. Spotlight: `.game-tile-img-wrap::before` uses `radial-gradient(... at var(--mx) var(--my) ...)`, shown on hover. Reduce-motion: `.game-tile.tilting` gets `translateY(-6px)` only.
   kinetic.css comment (521-526): "the 3-D tilt owns `transform` on hover"; kinetic adds a fallback lean only for `html[data-kinetic="on"][data-tilt="off"] .game-tile:hover`.
3. Geometry: reads `getBoundingClientRect()` of the tile per frame. Does not write `left/top/width/height`.
4. Timers: one rAF per pointermove. No CSS timing coupling.

### A5. Shelf rails, edge fades, wheel, drag (`setupShelves`, 196-284)
1. DOM: every `.row-scroll` whose ancestor is a `.game-row`. Home markup (index.html 190-226):
   ```
   section.game-row#row-continue|#row-recent|#row-updates|#row-mostplayed|#row-all
     div.row-header
       h2.row-title
       button.row-see-all[data-target="library"]   (not in #row-updates / #row-mostplayed)
     div.row-scroll#row-*-scroll                   (tiles rendered here by app.js renderGameRow)
     button.row-rail.left[aria-label="Scroll left"]    ← appended by JS, content "‹"
     button.row-rail.right[aria-label="Scroll right"]  ← appended by JS, content "›"
   ```
   The rails are appended to the **`.game-row` section**, not to the scroller (218). They are wired once per scroller (marker `data-railed="1"` on the `.row-scroll`, 198-199), and also for any container `librarian:rendered` reports that has class `row-scroll` (280-283).
2. Classes and properties:
   - `.row-rail.left.can` / `.row-rail.right.can`: there is content to scroll toward that side (more than 6 px) (223-224).
   - inline `--fade-l` / `--fade-r` on the `.row-scroll`: `46px` or `0px` (226-227).
   - `.row-scroll.dragging` while click-drag panning (after more than 6 px of movement) (265, 273).

   CSS must: position `.game-row` (relative) and the rails (absolute, vertically centred). Show a rail only when `.can` (legacy: `.game-row:hover .row-rail.can { opacity:1; pointer-events:auto }`). A rail that is visible but cannot scroll is harmless. Fade the scroller edges with `mask-image: linear-gradient(90deg, transparent 0, #000 var(--fade-l,0px), #000 calc(100% - var(--fade-r,0px)), transparent 100%)`. `.row-scroll.dragging`: `scroll-behavior:auto; cursor:grabbing`, and `.row-scroll.dragging .game-tile { pointer-events:none }` so the drag does not click a tile. The scrollbar is hidden in the legacy CSS.
3. Geometry: reads `scrollWidth`, `clientWidth` and `scrollLeft`. Rail click scrolls by `max(240, clientWidth*0.82)` px. The wheel converts vertical `deltaY` to `scrollLeft`, except at either end. Pointer capture is used while dragging. No inline geometry.
4. Timers: rAF on scroll, plus a ResizeObserver. None tied to CSS.

### A6. Hero rotation + parallax (`Hero`, 289-398)
1. DOM (index.html 168-187):
   ```
   div#home-scroll                       (scroll container read for parallax)
     section#hero-section
       div#hero-bg
       div#hero-content                  (.has-logo toggled by app.js:388/404)
         div#hero-badge
         img#hero-logo.hidden
         h1#hero-title
         p#hero-subtitle
         div#hero-actions > button.xbox-btn.xbox-btn-primary#hero-play-btn, button.xbox-btn.xbox-btn-secondary#hero-details-btn
         div#hero-hint > kbd…
       div#hero-dots                     ← JS fills it
   ```
   Generated into `#hero-dots` when there are 2 or more candidates (empty otherwise) (301-303):
   ```html
   <button class="active|" aria-label="Show {game name}"></button>   (one per candidate; class "" for inactive)
   ```
2. Classes and properties:
   - `#hero-dots` inline `--hero-interval: 11000ms` (300). The active dot's fill animation must run over `var(--hero-interval)` (legacy `#hero-dots button.active::after { animation: dotFill var(--hero-interval, 11s) linear forwards }`). The dot buttons are re-created on every show, so the fill restarts by itself.
   - `#hero-dots button.active`: the current candidate.
   - `#hero-section.swapping` for 170 ms during a swap (319, 323). Legacy: `#hero-section.swapping #hero-content > * { animation: none }`. Removing the class re-arms the entrance animation on the hero copy.
   - `#hero-content` inline `style.opacity = '0'` during the 170 ms swap, then `''` (320, 324).
   - Parallax (370-383), inline on scroll of `#home-scroll`: `#hero-bg` style `translate: 0 {y*0.26}px`; `#hero-content` style `translate: 0 {y*0.08}px`; `#hero-section` style `opacity` = `1 - fade*0.9`, where fade runs from 0 at 33 % of the hero height scrolled to 1 at 93 %. Stops updating past 1.4× the hero height. Skipped under reduce-motion.

   CSS must not rely on the individual `translate` property of `#hero-bg` / `#hero-content` (inline wins). Using `transform` composes with it. Do not put a CSS `opacity` on `#hero-section` that you expect to win (inline wins).
   - Pointer over `#hero-section` pauses rotation (355-356); nothing visual.
3. Geometry: reads `#home-scroll.scrollTop` and `#hero-section.offsetHeight`. Writes the inline translate/opacity above; no left/top/width/height.
4. Timers: `INTERVAL = 11000` (290) ↔ `--hero-interval` (the CSS reads the variable, so it stays in sync automatically). The swap delay of **170 ms** (321) must be at least the hero-copy fade-out in CSS. The rotation only advances on the Home page, when the document is visible and not paused (337).

Also: kinetic.js re-runs the entrance animation on `#hero-badge`, `#hero-title` and `#hero-subtitle` on every `librarian:hero` (see B5).

### A7. Accent from art (`Accent`, 403-513)
1. DOM: none (off-screen canvas, 48 px wide).
2. Calls `bridge.applyThemeColors(colour, background)` (499, 510). That is app.js, which writes the root theme variables; not in this file. `Accent.sample(url)` is reused by A23 and A28. Normalised output: HSL saturation clamped to 0.42-0.78, lightness to 0.55-0.68, uppercase hex.
3. Geometry: none.
4. Timers: none. Respects `settings.dynamic_accent === false`; defaults `#D2A65C` / `#0C0D10`.

### A8. Command palette (`Palette`, 518-789)
1. Static DOM (index.html 1188-1205):
   ```
   div#palette.hidden[role=dialog][aria-modal=true]      (full-screen scrim; mousedown on it closes, 785)
     div#palette-box
       div#palette-head
         svg
         input#palette-input[role=combobox][aria-controls=palette-list]
         span#palette-mode                                (text: "All" | "Search" | "Commands", 605)
       div#palette-list[role=listbox]                     ← JS fills it
       div#palette-foot > span > kbd…   (5 hints)
   ```
   Generated into `#palette-list` (676-702):
   ```html
   <div class="cmd-empty">Nothing matches. Try <b>&gt;</b> for commands.</div>      (no results)
   <div class="cmd-group">Games|Commands|Store</div>                               (one per group change)
   <button class="cmd-item" role="option" data-index="{i}" aria-selected="true|false">
     <span class="cmd-icon"><img src="{header}" loading="lazy" data-hide-on-error=""></span>   (games)
     <span class="cmd-icon">{glyph}</span>                                                      (commands/store)
     <span class="cmd-body">
       <span class="cmd-title">{title, fuzzy hits wrapped in <mark>}</span>
       <span class="cmd-sub">{e.g. "Running · 3h played · 12.4 GB"}</span>     (optional)
     </span>
     <span class="cmd-hint">{"↵ open · ⇧↵ play" | "1" | "F5" | "?" | "Ctrl ⇧ B" | "↵"}</span>   (optional)
   </button>
   ```
   `bridge.highlight` (app.js:6900) wraps each matched character run in `<mark>` inside `.cmd-title`.
   kinetic.js stamps `--k-i` on each `.cmd-item` (B1).
2. Classes and attributes:
   - `#palette.hidden`: closed. `#palette.closing`: exit animation in progress (753); then `.hidden` is added and `.closing` removed (754-756). On open both are removed (736).
   - `#palette[aria-label]` is set to "Search games and commands" (737).
   - `.cmd-item[aria-selected="true"]` is **the selection state** (714). There is no class. CSS must style `[aria-selected="true"]`.
   - `window.LibrarianDialogs.enter(node, close)` (dialogs.js) sets `role`, `aria-modal` and **`inert` on every sibling branch**. Nothing visual.
   - `<img data-hide-on-error>`: dialogs.js hides a broken image with inline `display:none`.

   CSS must: `#palette` is a fixed full-screen layer above the app (legacy z-index 1800). `#palette.hidden { display:none }`. `#palette-list` must scroll (`overflow:auto`, legacy `max-height: 68vh` on the box) for `scrollIntoView` to work. `.cmd-icon img` is a cover thumbnail.
3. Geometry: `buttons[cursor].scrollIntoView({block:'nearest'})` (715). No inline geometry.
4. Timers:
   - close: `setTimeout(…, reduceMotion() ? 0 : 180)` (754-757). **The CSS exit animation on `#palette.closing` must finish within 180 ms**, or it is cut off by `display:none`. Legacy used `--dur-2` = 220 ms, so its last 40 ms were cut.
   - input debounce: 60 ms (768).

Palette keyboard (on `#palette-input`, 771-783): `↓`/`↑` move, `Home`/`End`, `PageDown`/`PageUp` ±6, `Enter` run (Shift+Enter = `runAlt`, i.e. launch the game), `Escape` close, `Tab`/`Shift+Tab` move. Mouse: `mousemove` over an item selects it; click runs it (Shift-click runs the alt action).
Commands (533-594): Go to Home (hint 1), Go to Library (2), Go to Store (3), Go to Downloads (4), Go to Settings (6), Show favorites, Scan for games (F5), Check for updates, Update all games, Add a custom game, New collection…, Keyboard shortcuts (?), Open Big Picture (Ctrl ⇧ B), Turn on/off animations (toggles `html.reduce-motion` and `#chk-reduce-motion`), Turn the kinetic interface on/off (`#chk-kinetic`, dispatches `librarian:prefs`), Turn interface sounds on/off (`#chk-ui-sounds`, sets `#row-sound-volume` inline `display`), and "Open collection: {name}" per collection. Typing `>` switches to command mode. A term of 2+ characters adds a "Search the store for "{term}"" item.
Open/close entry points: Ctrl/⌘+K (A11), the `librarian:search` event (761), gamepad Y (A13). It refuses to open while a dialog other than `#game-flyout` is active (730-731).

### A9. "New collection" modal (`promptNewCollection`, 791-812)
1. Injected into app.js's modal through `bridge.openModal('New collection', html)`:
   ```html
   <div class="form-group">
     <label>Name</label>
     <input type="text" class="form-input" id="new-coll-name" placeholder="e.g. Friday night co-op" maxlength="60">
   </div>
   <div class="modal-actions">
     <button class="xbox-btn xbox-btn-secondary" id="new-coll-cancel">Cancel</button>
     <button class="xbox-btn xbox-btn-primary" id="new-coll-ok">Create</button>
   </div>
   ```
2-4. No classes or timers. Enter in the field submits. Triggered from `#sidebar-new-collection` (A18) and the palette.

### A10. Shortcut sheet (`Shortcuts`, 817-902)
1. Static DOM (index.html 1208-1217):
   ```
   div#shortcut-sheet.hidden[role=dialog]          (click on the backdrop itself closes, 894)
     div#shortcut-card
       div.shortcut-heading
         h2#shortcut-title                         (used as aria-labelledby, 882)
         button.icon-btn#shortcut-close
       div.sc-lead
       div.sc-grid#shortcut-grid                   ← JS fills it once (data-built="1")
   ```
   Generated (864-872), one column per section:
   ```html
   <div class="sc-col">
     <h3>{Global|Library|Game details|Gamepad|Big Picture}</h3>
     <div class="sc-row">
       <span>{label}</span>
       <span class="keys"><kbd>{key}</kbd><kbd>…</kbd></span>
     </div> …
   </div>
   ```
   Five `.sc-col` children. kinetic.js stamps `--k-i` on each direct child of `#shortcut-grid` (`.sc-col`).
2. `#shortcut-sheet.hidden` toggled (881, 889). There is no closing class, so it hides instantly. `#shortcut-grid[data-built="1"]` marks the one-time build (863). LibrarianDialogs makes the siblings inert.
3. Geometry: none.
4. Timers: none.

Openers: `?` key, `#btn-show-shortcuts` (settings, index.html 1009), palette command, gamepad START. Closers: `#shortcut-close`, Escape, backdrop click, gamepad B.

### A11. Global keyboard shortcuts (`setupHotkeys`, 904-1014)
1. DOM created: in each `.nav-tab[data-page]` whose page is in `PAGE_KEYS`, appends
   `<span class="nav-key">{n}</span>` (908-916).
   `PAGE_KEYS = {1:'home', 2:'library', 3:'store', 4:'downloads', 5:'crack', 6:'settings'}` (904). **The Tuning tab (`#nav-tuning`, data-page="tuning") gets no badge and has no number key.**
2. `html.show-hotkeys` is added on Alt keydown and removed on Alt keyup and on window blur (919-921). CSS must: `.nav-key` hidden by default and visible under `html.show-hotkeys .nav-tab .nav-key` (legacy uses opacity).
3. Geometry: none.
4. Timers: none.

Full key table (document keydown, **capture phase**, 923-1010). The handler does nothing while the tour or Big Picture is open.

| Key | Condition | Action / target |
|---|---|---|
| Ctrl/⌘+K | always (even in inputs) | toggle the palette `#palette` |
| Escape | shortcut sheet open | hide `#shortcut-sheet` (other Escape handling is app.js's) |
| Ctrl/⌘+F | Library page, no dialog | focus + select `#lib-filter` |
| ← / → | `#game-flyout.flyout-open` | `bridge.stepFlyout(-1/+1)` (previous/next game) |
| P | flyout open | launch `state.flyoutGame` |
| F | flyout open | toggle favorite on `state.flyoutGame` |
| 1-6 | no flyout, not typing | navigate to `PAGE_KEYS[n]` |
| ? | not typing | toggle shortcut sheet |
| / | not typing | go to Store, focus `#search-input` |
| F5 | not typing | `scanAndRender()` + toast "Rescanning…" |
| V | Library page | toggle `html[data-libview]` grid↔list (A17) |
| F | focus inside a `.game-tile` | toggle favorite on that tile's game (`tile.dataset.key`) |
| G | not typing | focus the first `.game-tile` in `.page.active`, set `data-nav="key"` |
| F11 | always (separate listener, A22) | `window.api.maximize()` |
| ↑ ↓ ← → | no palette/sheet/tour, `#modal-overlay.hidden`, flyout closed, not typing | spatial focus move (A12) |
| Tab / arrows | any | `data-nav="key"` (A2) |
| Alt (hold) | any | `html.show-hotkeys` |

Not here: Enter / Shift+Enter on a tile (createGameTile in app.js, 1012-1013), Menu (context menu, app.js), Ctrl+Shift+B (Big Picture, bigpicture.js). Palette keys: A8. Tour keys: A25.
Sheet vs code: the sheet's rows match the code (`1–6`, `V`, `F11`, etc.), except that `G` (focus the first tile) is implemented but not listed on the sheet.

### A12. Spatial focus navigation (1033-1124)
1. DOM: focus candidates when no dialog is active (1033):
   `.game-tile, .result-card, .nav-tab, .sidebar-link, .xbox-btn:not(:disabled), .icon-btn, .queue-card, .dtab, .plate, .row-see-all, .seg button, .loc-row, .store-chip`.
   With an active dialog panel the candidates are `button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])` inside that panel.
   Excluded: disabled; `tabIndex < 0`; inside `.hidden`, `[hidden]` or `[inert]`; computed `visibility:hidden`; boxes smaller than 4×4; anything not on screen (`rect.bottom > 40` and `rect.top < innerHeight-4`, horizontally on screen).
   **Every interactive control in the new layout must use one of these classes, or it is unreachable by arrows/gamepad outside dialogs.** Elements must also be natively focusable or carry `tabindex`. `.game-tile` gets its tabindex from app.js.
2. Classes: none. It calls `el.focus()`; the ring comes from `:focus-visible` together with `html[data-nav]` (A2).
3. Geometry: `getBoundingClientRect()` centres. Cost = along + across×2.6, ignoring candidates less than 6 px along the direction. Scroll-into-view: inside `.row-scroll` it scrolls the shelf so the item clears the edge by 40 px when within 20 px of it (1099-1105), then `scrollIntoView({block:'nearest', inline:'nearest'})`. No inline geometry. The 40 px top exclusion assumes a top bar of at least 40 px; elements under it are ignored.
4. Timers: none.

### A13. Gamepad (`Gamepad`, 1129-1296)
1. DOM: none created. A connect toast: "{pad id} connected".
2. Sets `html[data-nav="pad"]` on any direction (1174) and reverts to `pointer` on stop.
3. Geometry: via A12.
4. Timers: key repeat, first after 420 ms, then every 130 ms (1131-1132). Stick dead zone 0.55. rAF polling loop that stops itself when hidden, in Big Picture, with `gamepad_nav === false`, or with no pads. Nothing tied to CSS.

Mapping (standard layout indices, 1130):

| Button | Index | Action |
|---|---|---|
| D-pad / left stick | 12-15 / axes 0,1 | `act(dir)`: palette open → synthesise ArrowUp/ArrowDown on `#palette-input`; `#game-flyout` active → left/right = `stepFlyout(∓1)`, up/down = spatial move; else spatial move (A12) |
| A | 0 | palette open → synthesise Enter on `#palette-input`; dialog active and focus outside it → focus the panel; else `document.activeElement.click()`, or focus the first tile |
| B | 1 | in order: `LibrarianDialogs.dismiss()` → close palette → hide sheet → `bridge.closeModal()` if `#modal-overlay` is not `.hidden` → `closeFlyout()` if `#game-flyout.flyout-open` → navigate home |
| X | 2 | launch the focused `.game-tile`'s game, or the flyout game |
| Y | 3 | open the palette |
| LB / RB | 4 / 5 | cycle pages through `PAGE_KEYS` order (home, library, store, downloads, crack, settings; **skips Tuning**) |
| START | 9 | show the shortcut sheet |
| BACK | 8 | defined, unused |

All of these do nothing while the tour is open.

### A14. Download HUD (sidebar card + top-bar rail) (`setupDownloadHud`, 1301-1344)
1. Static DOM (index.html 121-134, 73):
   ```
   div#dl-hud.hidden[role=button][tabindex=0]     (click/Enter/Space → navigate to downloads)
     div#dl-hud-top
       div#dl-hud-spin
       span#dl-hud-label          (text "Downloading" | "Paused")
       span#dl-hud-pct            (text "42%" / "42.5%")
     div#dl-hud-name              (game name)
     div#dl-hud-bar > div#dl-hud-fill   (inline width %)
     div#dl-hud-sub
       span#dl-hud-speed · span.sep · span#dl-hud-eta
   header#topbar > div#topbar-progress[aria-hidden] > i   (inline width % on the <i>)
   ```
2. On `librarian:download` (1314-1338):
   - inactive: `#dl-hud.hidden` added; `#topbar-progress` loses `.on` and `.indeterminate`;
   - active: `#dl-hud` loses `.hidden`; `#dl-hud.paused` toggled; `#topbar-progress.on`; `#topbar-progress.indeterminate` while pct ≤ 0; inline `width:{pct}%` on `#topbar-progress > i` and on `#dl-hud-fill`.

   CSS must: `#topbar-progress` is a thin rail (legacy: absolute along the top bar's bottom edge, 2 px, `opacity 0` until `.on`). `.indeterminate > i` has to override the inline width (legacy `width:34% !important` plus a sliding animation). `#dl-hud.paused #dl-hud-spin` should stop. `#dl-hud` needs a visible focus style (it is a tab stop).
3. Geometry: inline `width` only.
4. Timers: none (driven by app.js, about once a second).

### A15. Download focus view (`Focus`, 1354-1582)
1. Static DOM (index.html 413-460):
   ```
   div.page#page-downloads                 (.focus-mode / .show-log toggled)
     section#dl-focus.hidden               (.paused toggled)
       div#dl-focus-bg                     (inline background-image set by JS)
       div#dl-focus-scrim
       div#dl-focus-inner
         div#dl-focus-poster
           div.poster-frame
             div#dl-poster-art             ← JS fills it
             div.poster-sheen
             div.poster-fill#dl-poster-fill   (inline height %)
           div.poster-plinth
         div#dl-focus-main
           div#dl-focus-kicker > span.kicker-dot + span#dl-focus-kicker-text
           h1#dl-focus-title
           div#dl-focus-dest               ← JS fills it
           div#dl-focus-readout
             div#dl-focus-pct > span#dl-focus-pct-num + span.unit("%")
             canvas#dl-focus-chart[width=300][height=64]   (drawn by app.js on librarian:redraw; sized from CSS)
           div#dl-focus-track > div#dl-focus-fill   (inline width %)
           div#dl-focus-stats
             div.fstat > span.fstat-num#fstat-size    + span.fstat-label "Downloaded"
             div.fstat > span.fstat-num#fstat-speed   + span.fstat-label "Download"
             div.fstat.hidden#fstat-disk-wrap > span.fstat-num#fstat-disk + span.fstat-label "To disk"
             div.fstat > span.fstat-num#fstat-eta     + span.fstat-label "Remaining"
             div.fstat > span.fstat-num#fstat-elapsed + span.fstat-label "Elapsed"
           div#dl-focus-actions
             button.xbox-btn.xbox-btn-secondary#dl-focus-pause   (innerHTML "⏸ Pause" | "▶ Resume"; .hidden for csrin jobs)
             button.xbox-btn.xbox-btn-secondary#dl-focus-cancel
             button.xbox-btn.xbox-btn-secondary#dl-focus-logbtn  (text "Show log" | "Hide log")
           div#dl-focus-queue.hidden
             div.fq-label
             div#dl-focus-queue-list       ← JS fills it
     … sibling children: div#drop-zone, queue section with #queue-cards, #btn-pause, #btn-cancel, div#log-area.hidden > #log-output …
   ```
   Generated into `#dl-poster-art`, one of three variants (1374-1390):
   ```html
   <img src="{portrait}" alt="">                                                     (portrait 600x900)
   <div class="poster-blur" style="background-image:url({header})"></div>
   <img class="poster-fit" src="{header}" alt="">                                    (landscape letterboxed over its blurred copy)
   {bridge.artFallbackHtml(name)} = <div class="art-fallback " style="{generated}" aria-hidden="true"><span class="art-mark">{initials}</span><span class="art-name">{name}</span></div>
   ```
   Generated into `#dl-focus-dest` when there is a destination (1508):
   `{lead} <button type="button">{path}</button>`, where lead is "Installing to" | "Into the game at" | "Saving to"; the button opens the path.
   Generated into `#dl-focus-queue-list`, up to 6 items (1532-1536):
   `<span class="fq-item"><img src="{header}" alt="" data-hide-on-error="">{name}</span>`. **This list is rebuilt on every progress tick (about 1 s), so never give `.fq-item` an entrance animation** (kinetic.css:737-743).
2. Classes and properties:
   - `#page-downloads.focus-mode` while a job is active (1456). **Functional:** the CSS must hide every other child of `#page-downloads` (legacy `#page-downloads.focus-mode > *:not(#dl-focus) { display:none !important }`). Otherwise the drop zone, queue and log stay visible below the focus view.
   - `#page-downloads.show-log` toggled by `#dl-focus-logbtn` (1570). CSS must re-show `#log-area` inside focus mode (legacy `#page-downloads.focus-mode.show-log > #log-area { display:flex !important; max-height:34vh }`). Note that `#log-area` carries its own `.hidden` from app.js, hence `!important`.
   - `#dl-focus.hidden` / `#dl-focus.paused` (1455, 1457, 1546). Legacy `.paused` stops `.kicker-dot`, `.poster-sheen` and the fill animation.
   - `#fstat-disk-wrap.hidden` when there is no disk speed (1497); `#dl-focus-pause.hidden` for csrin jobs (1519); `#dl-focus-queue.hidden` when nothing is queued (1530).
   - Inline: `#dl-focus-fill` width %, `#dl-poster-fill` **height** % (fills the poster bottom-up), `#dl-focus-bg` `background-image` (library_hero or a wider fallback, or the generated plate's gradient read through `getComputedStyle(.art-fallback).backgroundImage`).
3. Geometry: none measured. `#dl-focus-chart` has no box while hidden, so the JS fires `librarian:redraw` one rAF after showing (1471), and `resize` 30 ms after entering the Downloads page (2649). The canvas must get its size from CSS.
4. Timers: the elapsed clock ticks every 1000 ms (1467). The pause/cancel buttons proxy to `#btn-pause` / `#btn-cancel` (1558, 1566). Those must stay in the DOM (they may be visually hidden).

### A16. Confetti (`celebrate`, 1587-1645)
1. DOM: `canvas#confetti.hidden[aria-hidden]` (index.html 1308).
2. Removes `.hidden` at start and adds it back at the end. Sets the canvas `width`/`height` **attributes** to the viewport × DPR (max 2). Colours read from the root computed `--primary`, `--brass-2` and `--patina` (fallbacks `#D2A65C`, `#EBCB86`, `#74BBAB`), plus `#ECE7DD`. **Keep those three custom properties defined on `:root`** or the confetti uses the fallbacks.
   CSS must: `#confetti { position:fixed; inset:0; pointer-events:none; z-index above everything }`, and `.hidden` hides it.
3. Geometry: the full viewport. The CSS box must equal the viewport (inset:0) because the drawing assumes `innerWidth × innerHeight`.
4. Timers: 2400 ms of rAF (1636, 1642). Skipped entirely under reduce-motion. Triggered by `librarian:celebrate`.

### A17. Library layout controls (1650-1683)
1. Static DOM (index.html 267-277):
   ```
   div#lib-toolbar-extra
     div.seg#lib-view-seg[role=group]
       button[data-view="grid"].active[aria-pressed]   "▦"
       button[data-view="list"][aria-pressed]          "☰"
     div.seg#lib-density-seg[role=group]
       button[data-density="compact"]  "S"
       button[data-density="cozy"].active "M"
       button[data-density="large"]    "L"
   ```
2. Sets `html[data-libview]` / `html[data-density]`, and `.active` + `aria-pressed` on the matching segment button. Also persisted (`library_view_mode`, `grid_density`).
   CSS must implement: `html[data-libview="list"] #lib-grid …` (list layout, legacy enhance.css:567-599) and `html[data-density=compact|cozy|large]` (legacy sets `--tile-min`, `--tile-shelf`, `--gutter`, consumed by `.game-grid` and `.row-scroll .game-tile`).
3-4. None.

### A18. Collections rail (`renderCollections` / `setupCollections`, 1688-1727)
1. Static: `div#sidebar-collections` + `button#sidebar-new-collection` "＋ New collection" (index.html 110-111).
   Generated into `#sidebar-collections`:
   ```html
   <div class="collection-empty">Right-click any game to file it into a collection.</div>     (none yet)
   <button class="sidebar-link collection-link" data-collection="{name}">
     <span class="coll-dot"></span>
     <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{name}</span>
     <span class="side-count">{n}</span>
   </button>   (sorted A→Z)
   ```
   The name span has **inline** flex/ellipsis styles, so the `.collection-link` must be a flex row for them to work.
2. Click: removes `.active` from **every** `.sidebar-link` and adds `.active` to the clicked collection (1711-1712). Right-click deletes the collection (with a confirm in app.js).
3-4. None. Re-rendered on `librarian:collections`, `librarian:ready` and `librarian:games`.

### A19. Sidebar counts + ledger bump (`refreshSidebarCounts`, 1732-1762)
1. Appends `<span class="side-count">{n}</span>` (created once) to `#sidebar-all-games`, `#sidebar-favorites` and `#sidebar-recent` (index.html 92-103). The links contain an svg plus a text node; the badge goes last. CSS: `.sidebar-link` is a flex row, and `.side-count` uses `margin-left:auto`.
2. `.ledger-num` (index.html 115-117: `#ledger-games`, `#ledger-hours`, `#ledger-size`): when the text differs from `data-prev`, it stores `data-prev`, removes `.bump`, forces a reflow and re-adds `.bump` (1754-1761). `.bump` is never removed afterwards, so CSS must use an `animation` (not a transition) on `.ledger-num.bump`. kinetic.js also counts these up and adds `.k-roll` (B3/B4).
3-4. None.

### A20. Settings section nav (`setupSettingsNav`, 1767-1788)
1. Static: `nav#settings-nav` (inside `div#settings-topbar`, index.html 704-705). Sections: `#page-settings .settings-section[data-sec]` (Interface, Big Picture, Install, Graphics, API, Achievements, Launcher, Downloads, Steam login, CS.RIN.RU, Data). Each section's `data-sec` text becomes its button label.
   Generated: `<button data-index="{i}" class="active|">{data-sec}</button>`, one per section. It is **rebuilt on every visit to the Settings page** (2650), which resets `.active` to the first button.
2. Click: `.active` moves to the clicked button; the section is scrolled into view (`block:'start'`, smooth); the section gets `.flash-target` for 1200 ms (1783-1784).
   CSS: style `#settings-nav button.active` and `#page-settings .settings-section.flash-target` (legacy: border + glow ring; kinetic adds a 1.2 s `kFlash`). `scrollIntoView({block:'start'})` means a sticky `#settings-topbar` would cover the top of the target; use `scroll-margin-top` on `.settings-section` if the nav is sticky.
3. Geometry: `scrollIntoView` only.
4. Timers: **1200 ms** for `.flash-target` (1784). Any flash animation must last at most 1200 ms (kinetic `kFlash` is exactly 1.2 s).

### A21. Button feedback: ripple + click sounds (`setupButtonFeedback`, 1793-1811)
1. Delegated on `.xbox-btn`.
2. On pointerdown: inline `--rx-x` / `--rx-y` (pointer position in px relative to the button), then remove, reflow and re-add `.rippling`. The class is removed after 600 ms (1798-1803). Skipped when disabled or under reduce-motion.
   CSS (legacy): `.xbox-btn { position:relative; overflow:hidden; isolation:isolate }`; `.xbox-btn::after` is a circle at `left:var(--rx-x); top:var(--rx-y)`; `.xbox-btn.rippling::after { animation: ripple 560ms }`. **kinetic.css notes that `.xbox-btn::after` (ripple) and `.xbox-btn.busy::before` (busy spinner) are both taken.** If the new design moves the ripple, keep `--rx-x/--rx-y` (not `--rx`, which is the tilt).
   Click sounds: `.tile-play-btn` → launch; `.game-tile, .result-card` → select; `.xbox-btn, .nav-tab, .sidebar-link, .icon-btn` → move.
3. Geometry: reads the button rect.
4. Timers: **600 ms** class lifetime (1803). The ripple animation must be ≤ 600 ms (legacy 560).

### A22. Window chrome (`setupWindowChrome`, 1816-1841)
1. Static (index.html 77-87): `div#window-controls > button.win-btn#btn-minimize, button.win-btn#btn-maximize, button.win-btn.close-btn#btn-close`. Drag strip `div#topbar-drag`.
2. `#btn-maximize` innerHTML is replaced by one of two 12×12 SVGs (stroke `currentColor`, width 1.2): RESTORE (two overlapping squares) and MAXIMIZE (one square). Its `title` becomes "Restore" | "Maximize". `html.is-maximized` is toggled (1826). CSS may drop window rounding or borders when maximized.
   Double-click on `#topbar-drag` maximizes, unless the target is inside `button, input, .nav-tab, #topbar-search` (1834). Keep interactive parts of the drag strip non-draggable (`-webkit-app-region: no-drag`, owned by main.css) or they will not receive clicks.
3-4. None. F11 → maximize (1839).

### A23. Detail-view tint (`setupFlyoutTint`, 1850-1881)
1. `#game-flyout` (index.html 1020).
2. On `librarian:flyout` open: removes inline `--game-tint`, samples the portrait and then the header, and sets inline `--game-tint: #RRGGBB` on `#game-flyout`. It deliberately **does not clear it on close** (1856-1860: clearing caused a recolour flash during the fade-out).
   CSS must: declare a default `#game-flyout { --game-tint: var(--primary) }` and build the flyout's glow, buttons, tabs and borders from `color-mix(... var(--game-tint) ...)`.
3-4. None.

### A24. First-run setup banner (`setupSetupBanner`, 1890-1991)
1. Static (index.html 155-165):
   ```
   div#home-setup.hidden[role=status]
     div#home-setup-row
       div#home-setup-spin            (textContent "" | "✓" | "!")
       div#home-setup-body > div#home-setup-title + div#home-setup-sub
       button.xbox-btn.xbox-btn-secondary.btn-sm.hidden#home-setup-action   "Retry"
     div#home-setup-bar > i           (indeterminate bar, no width set by JS)
   ```
2. Classes on `#home-setup`: `.hidden`, `.leaving`, `.done`, `.failed`. `show()` removes all four (1903). Done: `.done`, spinner text "✓", auto-dismiss after 5 s. Failed: `.failed`, spinner text "!", `#home-setup-action` loses `.hidden`.
   CSS must: `#home-setup-spin` is a spinner while neither `.done` nor `.failed`, and a glyph holder otherwise (the JS writes the glyph as text). `#home-setup-bar > i` must animate on its own (no progress value exists). `.done` / `.failed` hide the bar.
3. Geometry: none.
4. Timers: dismiss `setTimeout(…, 5000)` → `.leaving` → **`.hidden` 340 ms later** (1910-1912). **The CSS `.leaving` exit must finish within 340 ms** (legacy `setupOut` used `--dur-3` = 360 ms: 20 ms clipped).

### A25. Guided tour (`Tour`, 2000-2466)
1. Static DOM (index.html 1286-1304):
   ```
   div#tour.hidden[role=dialog]                 (click on #tour itself or on #tour-mask → next step)
     div#tour-mask                              (inline left/top/width/height; .lit)
     div#tour-card[role=document]               (inline left/top; .jump)
       div#tour-head > span#tour-chapter + span#tour-count ("3 / 25")
       h3#tour-title
       div#tour-body                            ← innerHTML from the step: <p>, <ul><li>, <b>, <i>, <code>
       div#tour-foot
         div#tour-dots[aria-hidden]             ← JS: one <i></i> per step (25)
         div#tour-nav
           button.tour-btn.ghost#tour-skip
           button.tour-btn.ghost#tour-back     (disabled on step 1)
           button.tour-btn.primary#tour-next   (text "Next" | "Finish")
   ```
   The tour does **not** use LibrarianDialogs, so nothing is made inert. It owns the keyboard through a capture listener.
2. Classes and properties:
   - `#tour.hidden`; `#tour.closing` for 220 ms on finish, then `.hidden` (2419-2420).
   - `#tour-dots i.now` (current) and `i.done` (before current) (2284-2285).
   - `#tour-card.jump`: removed, reflowed and re-added on every step (2370-2372). Legacy `tourPop` is transform-only. **Legacy rule: no opacity-0 keyframe on `#tour`, `#tour-card` or `#tour-mask`.** A frozen animation in a hidden renderer would leave the tour invisible (enhance.css:2375-2379).
   - `#tour-mask.lit` when there is a target. Without a target: `.lit` is removed and the inline style becomes `width:0; height:0; left:50%; top:50%` (2328-2332).
3. Geometry (all inline px, rounded):
   - **Mask** (2324-2351): target `getBoundingClientRect()` padded by 8 px → `left, top, width, height`. **CSS must** make `#tour-mask` `position:fixed`, and draw the dimming as the mask's own giant spread (legacy `box-shadow: 0 0 0 9999px rgba(6,7,9,.8)` with `border-radius:14px`), so the mask's box is the hole. `pointer-events:none` on the mask itself (the click handler still checks `e.target === mask()`, which only fires if pointer events are on; with `none` the click lands on `#tour`, which is also accepted). Legacy transitions `top/left/width/height` over 360 ms.
   - **Card** (2290-2322): measures its own box (so it **must be `position:fixed` with a definite width**, legacy `min(430px, 100vw - 40px)`), and sets `left/top`. Placement: below the target (gap 18) if it fits, else above, else clamped vertically. Centred horizontally on the target; if it would overlap the target, placed right of it, else left. Kept 12 px inside the viewport. With no target: centred in the viewport. The card must not get a `transform` that changes its measured size at measure time (`.jump` scales to .965 at start, so it is measured mid-animation; harmless at that magnitude).
   - Target resolution (2262-2274): a checkbox/radio target → closest `.toggle-row`, else `parentElement`; any target smaller than 2×2 → closest `.toggle-row, .form-group, .settings-section`. Before lighting, the target is scrolled with `scrollIntoView({block:'center', inline:'nearest'})`.
   - Re-measured on window resize (debounced 140 ms) and 60 ms after the window becomes visible again.
4. Timers: after navigating to the step's page, wait **320 ms** (40 ms under reduce-motion) (2377); after scrollIntoView, wait **330 ms** (30) (2383); then `setTimeout 0` and position. The page entrance animation and smooth scroll must have settled within those windows, or the spotlight measures a moving target (kinetic `kPageIn` is 440 ms with a translate of 46 px: **the legacy page entrance outlasts the 320 ms wait**, but the following 330 ms scroll wait applies only when there is a target, so the total is 650 ms). Finish: `.closing` → `.hidden` after **220 ms** (2420); the CSS exit must be ≤ 220 ms. Resize 140 ms, visibility 60 ms.
   Keyboard (capture, `stopImmediatePropagation`): `Esc` finish; `→`, `Enter` and `Space` next; `←` back. Gamepad is ignored while the tour is open. Finish sets `onboarded`, refreshes settings and navigates Home. Entry points: `#onboard-go` (A26), `#btn-replay-tour` (settings, index.html 1008).

**Step table** (2007-2248; 25 steps). Pages are `bridge.navigateTo` ids.

| # | Chapter | Page | Target selector | Title | Resolves to (current markup) |
|---|---|---|---|---|---|
| 1 | Welcome | — | — | Let me show you around | centred, no spotlight |
| 2 | Getting around | home | `#topbar-nav` | Six places | nav (7 tabs incl. Tuning; copy says six) |
| 3 | Getting around | home | `#topbar-search` | One shortcut worth learning | top-bar search pill |
| 4 | Getting around | home | `#sidebar-all-games` | The catalog rail | sidebar link |
| 5 | Getting around | home | `#sidebar-new-collection` | Collections are your own shelves | button |
| 6 | Getting around | home | `#sidebar-ledger` | The ledger | ledger block |
| 7 | Your library | library | `#lib-toolbar-extra` | Grid or list, three sizes | the two `.seg` groups |
| 8 | Your library | library | `#lib-scan-btn` | Filling the shelves | Scan button |
| 9 | Finding games | store | `#search-input` | What a manifest actually is | store search input |
| 10 | Finding games | settings | `#inp-api-key` | The key that makes manifests work | input (API section) |
| 11 | Downloading | settings | `#install-locations` | Where games land | list container (Install section) |
| 12 | Downloading | settings | `#chk-ask-destination` | Ask, or just go | checkbox → its `.toggle-row` |
| 13 | Downloading | downloads | `#drop-zone` | Already have a manifest? | drop zone (**hidden by `.focus-mode` while a job runs**: rect 0×0, so resolveTarget falls back to the node itself, the mask becomes a 16×16 box at (-8,-8) and the card is clamped to about (12,26) in the top-left) |
| 14 | Download options | settings | `#sel-max-downloads` | How hard to pull | select |
| 15 | Download options | settings | `#chk-adaptive` | Let it find the right number | checkbox; **not inside a `.toggle-row`** → `parentElement` = `div.setting-row` |
| 16 | Download options | settings | `#chk-validate-fresh` | Verification and caching | `.toggle-row` |
| 17 | Download options | settings | `#chk-sls` | Running through the Steam client | `.toggle-row` |
| 18 | Download options | settings | `#chk-auto-crack` | What happens after the bytes land | `.toggle-row` |
| 19 | Download options | settings | `#inp-steam-username` | Steam login (optional) | input |
| 20 | Cracking | crack | `#crack-goldberg-status` | What Goldberg is | status chips container |
| 21 | Cracking | crack | `#crack-browse` | Point it at a game | Browse button |
| 22 | Cracking | crack | `#crack-apply` | Apply, and undo | Apply button |
| 23 | Making it yours | settings | `#chk-dynamic-accent` | How it looks and feels | `.toggle-row` (Interface section) |
| 24 | Making it yours | settings | `#btn-replay-tour` | Where to find help later | button (Data section) |
| 25 | Done | home | — | That's everything | centred, no spotlight |

When re-pointing steps: a target that is `display:none` at step time has a 0×0 rect, so resolveTarget climbs to `.toggle-row, .form-group, .settings-section`. If none of those exist either, the spotlight collapses to a 16×16 box at (-8,-8) and the card sits in the top-left corner. Keep checkbox targets inside `label.toggle-row`.

### A26. First-run onboarding (`setupOnboarding`, 2471-2491)
1. Static (index.html 1220-1236):
   ```
   div#onboard.hidden[role=dialog]
     div#onboard-card
       img (logo)
       h2, p
       div#onboard-steps
         div.ob-step > span.ob-num + span.ob-text > b + text     (×3)
       div#onboard-actions
         button.xbox-btn.xbox-btn-secondary#onboard-skip
         button.xbox-btn.xbox-btn-primary#onboard-go
       div#onboard-note
   ```
2. `#onboard.hidden` removed **600 ms after `librarian:ready`** when `settings.onboarded` is falsy (2489). It is added back instantly on skip/go (no exit class). kinetic stamps `--k-i` on `.ob-step`. No LibrarianDialogs (no inert, no focus trap).
3. Geometry: none.
4. Timers: 600 ms show delay; tour starts 260 ms after "Show me around" (2482). Any `#onboard` exit animation would never be seen (instant `.hidden`).

### A27. Motion: nav indicator + FLIP lists (`Motion`, 2501-2602)
1. Creates `<span id="nav-ind" aria-hidden="true"></span>` appended inside `nav#topbar-nav` (2523-2526), **after** the `.nav-tab` buttons. Then sets `html[data-navind="on"]` (2530).
2. Nav indicator:
   - inline `--nx` = active tab `offsetLeft` px and `--nw` = active tab `offsetWidth` px on `#nav-ind` (2511-2512);
   - `#nav-ind.on` when a `.nav-tab.active` exists (removed otherwise);
   - `#nav-ind.placing` while positioning without animation (first paint and every window resize), removed after 60 ms.

   CSS must: `#topbar-nav { position:relative }`, `#nav-ind { position:absolute; left:0; width:var(--nw); transform:translate3d(var(--nx),0,0); pointer-events:none }`, under the tabs (`.nav-tab` with a higher z-index), with `opacity:0` until `.on`, and `#nav-ind.placing { transition:none }`. Under `html[data-navind="on"]`, strip the per-tab active background (otherwise there are two active indicators). `offsetLeft` is relative to the offsetParent, so `#topbar-nav` must be the positioned ancestor, and **must not scroll horizontally** (offsetLeft ignores scroll). Legacy `#topbar-nav { overflow:hidden }`.
   Updated on `librarian:page` and window resize.
   FLIP (2561-2599), wired only for `#queue-cards` / `.queue-card` (2628): row identity = `data-job-id` || `data-appid` || `id`. A moved row gets inline `transition:none; transform:translate3d(dx,dy,0)`; after 20 ms `.flip-move` is added and the inline styles are cleared, and `.flip-move` is removed after 420 ms.
   CSS must: `.flip-move { transition: transform ≤420ms }`. Without the transition the cards just snap, which is harmless. Do not put a CSS `transform` on `.queue-card` that must survive this (the inline transform wins for 20 ms). `.flip-leaving` exists in legacy CSS but **no JS sets it**.
3. Geometry: `offsetLeft/offsetTop/offsetWidth`. Writes inline transform/transition on queue cards.
4. Timers: 60 ms `.placing` guard (2517); FLIP 20 ms + **420 ms** (2586-2590). Page direction is not here: app.js:209 sets `.page[data-dir="fwd"|"back"]` before adding `.active`.

### A28. Borrowed light: per-tile tint (2669-2693)
1. Delegated `pointerover` on `.game-tile` **inside `#lib-grid` only**, when `dynamic_accent !== false`.
2. Samples the tile's header art once and sets inline `--tile-tint: #RRGGBB` on the `.game-tile`. Marks it `data-tinted="1"` (also when there is no colour).
   CSS: library.css builds the hover shadow from `--tile-tint`, with a brass fallback (`var(--tile-tint, <brass>)`). kinetic.css deliberately does not override that shadow.
3-4. None.

### A29. Wiring and app events (2607-2708)
- `librarian:rendered` → A3 reveals in `detail.container`; A5 rails if the container is a `.row-scroll`.
- `librarian:games` → A19 + A18. `librarian:hero` → A6 `setCandidates` + A7. `librarian:page` → A27 indicator; if the page is downloads, a `resize` event after 30 ms; if settings, A20 rebuild.
- `librarian:prefs` → `html[data-tilt]`, gamepad sync, hero restart, accent re-apply. `librarian:celebrate` → A16. `librarian:ready` → counts, collections, library controls.
- Any window resize → `librarian:redraw` after 120 ms (sparkline redraw by app.js).

### A30. trailer.js (no CSS hooks)
`window.LibrarianTrailer.attach(video, movie)` / `.detach(video)`. It only touches the `<video>` passed in: appends `<source src>` children (webm, mp4, mp4_hd) or attaches hls.js; stores `video._librarianHls`; `detach` pauses, destroys, `replaceChildren()`, removes `src` and calls `load()`. No classes or attributes. A `false` return means nothing is playable, so the caller (app.js / bigpicture.js) keeps its still image. Any "video ready" reveal styling belongs to the callers, not to this file.

---

## B. kinetic.js

### B1. Cascade indices (`--k-i`)
`stamp()` sets inline `--k-i: 0..63` (`INDEX_LIMIT = 64`) on each matching child, in document order (kinetic.js:153-161). Each container gets a MutationObserver (`childList` only, so direct children replaced) and is restamped on change. Containers are (re)looked up on init, `librarian:page`, `ready`, `rendered`, `queue`, `collections`, `prefs` and `bigpicture` (+200 ms when opening), on `#sf-rails` childList, and on `document.body` childList (debounced 80 ms).

Single-container table (`CASCADES`, first match only, 83-132):

| Container | Children stamped | Legacy kinetic.css consumer |
|---|---|---|
| `#palette-list` | `.cmd-item` | `.cmd-item` kSlideL, delay `min(k-i*20ms, 240ms)` |
| `#context-menu` | `.ctx-item` | `.ctx-item` delay `min(k-i*16ms,180ms)` |
| `#search-recent` | `.store-chip` | `.store-chip` kPop `min(k-i*26ms,300ms)` |
| `#plan-legend` | `:scope > *` | `#plan:not(.hidden) #plan-legend > *` |
| `#plan-groups` | `:scope > *` | `#plan-groups > *` |
| `#shortcut-grid` | `:scope > *` (`.sc-col`) | `.sc-grid > *` kPop |
| `#install-locations` | `:scope > *` | `.loc-row` (if the children are `.loc-row`) |
| `#crack-scan-results` | `:scope > *` | `#crack-scan-results > *` |
| `#settings-nav` | `button` | none (only `button.active` kPop; the index is unused) |
| `#sf-rails` | `.sf-rail` | `.sf-rail` kRailIn |
| `#sd-facts` | `.sd-fact` | `.sd-fact` |
| `#sd-tag-list` | `.sd-tag` | `.sd-tag` |
| `#sd-depot-list` | `.sd-depot` | `.sd-depot` |
| `#sd-strip` | `.sd-shot` | `.sd-shot` |
| `#page-settings .settings-panel` | `.settings-section` | `.settings-section` kRise `min(k-i*45ms,360ms)` |
| `#page-tuning .settings-panel` | `.settings-section` | same (markup: `div.settings-panel.tn-panel`) |
| `#tn-tiles` | `.tn-tile` | none found in kinetic.css |
| `#onboard-steps` | `.ob-step` | none: `.ob-step` uses `:nth-child` delays instead |
| `#bp-rail-list` | `.bp-rail-item` | BP |
| `#bp-menu-rows`, `#bp-system-rows`, `#bp-filter-rows` | `.bp-row` | BP `:not(#bp-dl-rows) > .bp-row` |
| `#bp-det-actions` | `.bp-act` | BP |
| `#bp-det-shots` | `.bp-shot` | BP |
| `#bp-det-tags` | `:scope > *` | BP |
| `#bp-keys` | `.bp-key` | BP |
| `#bp-results` | `.bp-card` | BP |
| `#bp-meta` | `.bp-pill` | BP |
| `#bp-ach-list` | `:scope > *` | BP |
| `#bp-news-list` | `:scope > *` | BP |
| `#bp-det-news .bp-detnews-list` | `:scope > *` | BP |
| `#bp-empty-actions` | `:scope > *` | BP |
| `#bp-sf-meta` | `.bp-sf-pill` | BP |
| `#bp-store-tags` | `.bp-store-tag` | BP |
| `#bp-store-shots` | `img` | BP |

Multi-container table (`MULTI`, every match, each counted from 0, 144-147): `.sf-rail-scroll` → `.sf-card`; `#bp-sf-rails .bp-sf-strip` → `.bp-sf-card`.
Deliberately **not** stamped: the Big Picture shelf/grid (bigpicture.js uses its own `--d`), library tiles (they use `--reveal-delay`), `.fq-item`, and the toast stack.
**Inheritance trap (comments at 127-143):** `--k-i` is a custom property and inherits. Never stamp a container whose descendants also read `--k-i`; consumers should read it only on the stamped element itself.

### B2. Impact bursts (`.k-burst`, 190-237)
- Trigger: `pointerdown` (capture, primary button) whose target is inside one of:
  `.xbox-btn, .tour-btn, .nav-tab, .sidebar-link, .seg button, .store-chip, .cmd-item, .ctx-item, .dtab, .row-see-all, .toggle-row, #settings-nav button, .queue-card-remove, .tile-play-btn, .tile-fav-btn, .result-card-add, #dl-hud, .collection-link, #window-controls button`.
  Only when `html[data-kinetic="on"]`; at most 5 live bursts.
- Creates `<div class="k-burst">` appended to `document.body`, with inline `left:{clientX}px; top:{clientY}px; --k-burst-size:{64..260}px` (1.15 × the source's diagonal).
- Removed on its **`animationend`** (`once`), or by a **900 ms fallback timer** (227).
- CSS must: `.k-burst { position:fixed; width/height: var(--k-burst-size); transform: translate(-50%,-50%) …; pointer-events:none; high z-index }`, with an animation shorter than 900 ms (legacy `kBurst 460ms forwards`). Reduce-motion: `display:none` (JS already skips bursts then, because `data-kinetic` is removed).

### B3. Value reactions (`.k-roll`, 252-286)
- Targets: `#plan-size-num`, `#plan-size`, `#ledger-games`, `#ledger-hours`, `#ledger-size`. Each gets `data-k-pop="1"` (observer installed) and a MutationObserver on its text.
- On a text change (not during a count-up, at most once per 220 ms, only when `data-kinetic="on"`): remove, reflow and add `.k-roll`; it is removed after **400 ms** (280). CSS: an animation ≤ 400 ms (legacy `kBump` 280 ms, with `display:inline-block; transform-origin:50% 60%`). Download readouts are deliberately excluded.

### B4. Count-ups (318-368): text rewriting
- Elements: **`#ledger-games`, `#ledger-hours`, `#ledger-size`** only (364).
- When: `librarian:ready`, and `librarian:games` via `setTimeout 0` (425). Only when `data-kinetic="on"`.
- Logic: parse `textContent` with `/^(\D*?)([\d.,]+)(.*)$/s` into prefix, digits and suffix (e.g. "128", "42h", "1,204.5 GB"). Skip if the value is not finite or ≤ 0. Keep the decimals count and thousands grouping. Sets `data-k-counting="1"`; every **32 ms** writes `prefix + format(end × easeOutCubic(t)) + suffix` over **620 ms**; a hard `finish` at **740 ms** (620+120) restores the exact original text and deletes `data-k-counting`.
- CSS expectation: tabular figures plus `display:inline-block` on `.ledger-num`, so the ledger labels do not move while digits change (legacy kinetic.css:353). That is purely visual; the final text is always correct.

### B5. Hero entrance replay (442-445)
On `librarian:hero` with kinetic on: for `#hero-badge`, `#hero-title` and `#hero-subtitle`, sets inline `style.animation='none'`, reflows, then `style.animation=''`. This restarts whatever CSS animation those elements have. It requires that the hero entrance be a CSS `animation` on those three ids (a transition would not replay). It runs alongside the enhance.js 170 ms `.swapping` window (A6).

### B6. Store search busy (296-308)
`#page-store[data-busy="1"]` while `#search-results` contains any `.result-skeleton` (MutationObserver on `#search-results` childList). Styling only (legacy speeds up `#store-aurora i`).

### B7. Root switch (`html[data-kinetic]`, 43-53, 395-406, 463)
- `data-kinetic="on"` iff `settings.ui_kinetic !== false` (undefined counts as on) **and** not reduce-motion (`html.reduce-motion` or the OS media query) **and** `document.visibilityState !== 'hidden'`. Otherwise the attribute is **deleted** (not set to `off`).
- Re-evaluated: immediately when the script is evaluated (end of body, before first paint), on DOMContentLoaded init, `visibilitychange`, any `class` attribute change on `<html>` (MutationObserver), the media-query change, and `librarian:prefs`.
- **This is the safety mechanism:** kinetic.css may use `animation-fill-mode: backwards` entrances from opacity 0 only because every rule is scoped under `html[data-kinetic="on"]`, which disappears while the renderer is hidden (no frames, so an entrance would freeze on its transparent first keyframe).

### B8. What kinetic.js expects kinetic.css to provide
- Everything is scoped under `html[data-kinetic="on"]`.
- Entrances read `var(--k-i, 0)` for stagger, with a `min()` ceiling.
- `.k-burst` (fixed ring, animation < 900 ms, `pointer-events:none`).
- `.k-roll` (animation ≤ 400 ms on inline-block).
- `#hero-badge`, `#hero-title`, `#hero-subtitle` entrance **animations** (for B5 to replay).
- Tabular, inline-block `.ledger-num` (for B4 stability).
- Entrances end at the element's resting state and use `backwards`, never `both`/`forwards`. Otherwise they keep overriding hover/selection transforms (`.cmd-item[aria-selected="true"]` lean, tilt, etc.; kinetic.css:67-79).

**Dead hooks in legacy kinetic.css (nothing in `src/**/*.js|html` sets them; verified by grep):** `[data-k-cascade]` and its variants (`slide`, `slide-r`, `pop`, `drop`, `flip`, `cut`), `[data-k-dense]`, `.k-bump`, `.k-nudge`, `.k-shake`, `.k-enter`, `.k-burst.is-square`, `--k-burst-ink`, `#hero-content[data-k-swap]` (kinetic.js uses inline replay instead). `.is-square` exists only on `.bp-glyph` in bigpicture.js:379, an unrelated element. Do not port these as if they were live.

### B9. What breaks functionally if kinetic.css is removed or replaced
**Nothing functional.** kinetic.js never waits on CSS to change application state:
- bursts are removed by the 900 ms timer even without `animationend`. Without kinetic.css, `.k-burst` is an empty, unpositioned `div` at the end of `<body>` for up to 900 ms, zero-height and invisible, with the inline `left/top` inert. Harmless, but a new stylesheet that styles `.k-burst` must also give it `position:fixed` and `pointer-events:none`, or the ring would block clicks for up to 900 ms;
- `.k-roll` and `data-k-counting` are timer-cleared;
- count-ups always end on the exact app-written text;
- `data-busy` and `data-kinetic` are styling-only.

Visual regressions only: ledger digits shift their labels during the 620 ms count-up (no tabular/inline-block), hero rotation copy has no re-entrance, and all entrances, idle loops and press feedback disappear.

What a **replacement** motion stylesheet can break:
1. Unscoped `opacity:0` entrances: any entrance not under `html[data-kinetic="on"]` loses the hidden-renderer switch and can leave content blank after alt-tab.
2. `both`/`forwards` fills on elements that have hover/selection transforms: they freeze the transform and break the tilt (`.game-tile`), the palette selection lean, and focus lifts.
3. A transform/scale on `#flyout-panel` or its contents (kinetic.css:791-805: it re-rasterises a 44 px blur and changes the scroll overflow).
4. A `.reveal` rule without a matching `.reveal.shown` at equal specificity (tiles stuck offset/soft).
5. Exit animations longer than the JS timers: `#palette.closing` > 180 ms, `#tour.closing` > 220 ms, `#home-setup.leaving` > 340 ms, `.flip-move` > 420 ms, `.k-roll` > 400 ms, `.k-burst` > 900 ms, `.flash-target` > 1200 ms, `.xbox-btn.rippling` > 600 ms. Each gets cut off or snaps.
6. An entrance on a list rebuilt every tick (`#dl-focus-queue-list .fq-item`, `#bp-dl-rows .bp-row`, download readouts): it replays every second.

### B10. Timers vs CSS, consolidated

| Where | Line | Value | CSS that must fit |
|---|---|---|---|
| enhance reveal stagger | 124 | `min(i*28,260)ms` → `--reveal-delay` | `.reveal.shown` transition-delay |
| hero interval | 290, 300 | 11000 ms → `--hero-interval` | active dot fill duration |
| hero swap | 321-325 | 170 ms | hero copy hide while `.swapping` |
| palette close | 754-757 | 180 ms (0 under reduce-motion) | `#palette.closing` exit ≤ 180 ms |
| palette debounce | 768 | 60 ms | — |
| gamepad repeat | 1131-1132 | 420 / 130 ms | — |
| focus elapsed | 1467 | 1000 ms | — |
| confetti | 1636, 1642 | 2400 ms | — |
| settings flash | 1784 | 1200 ms | `.flash-target` ≤ 1200 ms |
| ripple | 1803 | 600 ms | `.rippling::after` ≤ 600 ms |
| setup banner | 1948, 1910-1912 | 5000 ms then 340 ms | `#home-setup.leaving` ≤ 340 ms |
| tour page wait | 2377 | 320 ms (40) | page entrance should settle |
| tour scroll wait | 2383 | 330 ms (30) | smooth scroll + mask transition |
| tour close | 2420 | 220 ms | `#tour.closing` ≤ 220 ms |
| tour resize / visibility | 2452, 2458 | 140 / 60 ms | — |
| onboarding | 2482, 2489 | 260 ms / 600 ms | — |
| nav indicator guard | 2517 | 60 ms | `#nav-ind.placing` no transition |
| FLIP | 2586-2590 | 20 ms + 420 ms | `.flip-move` transition ≤ 420 ms |
| downloads resize | 2649 | 30 ms | — |
| redraw debounce | 2706 | 120 ms | — |
| kinetic burst | kinetic.js:227 | 900 ms fallback | `.k-burst` animation < 900 ms |
| kinetic pop | kinetic.js:275, 280 | 220 ms cooldown, 400 ms class | `.k-roll` ≤ 400 ms |
| kinetic count-up | kinetic.js:320, 358-359 | 620 ms, 32 ms tick, 740 ms hard stop | — |
| kinetic reattach | kinetic.js:389, 450 | 80 ms, 200 ms | — |

---

## C. Flat alphabetical list

### C1. IDs referenced by enhance.js / kinetic.js (selectors, created ids, aria ids, tour targets)
`bp-ach-list`, `bp-det-actions`, `bp-det-news`, `bp-det-shots`, `bp-det-tags`, `bp-empty-actions`, `bp-filter-rows`, `bp-keys`, `bp-menu-rows`, `bp-meta`, `bp-news-list`, `bp-rail-list`, `bp-results`, `bp-sf-meta`, `bp-sf-rails`, `bp-store-shots`, `bp-store-tags`, `bp-system-rows`,
`btn-cancel`, `btn-maximize`, `btn-pause`, `btn-replay-tour`, `btn-show-shortcuts`,
`chk-adaptive`, `chk-ask-destination`, `chk-auto-crack`, `chk-dynamic-accent`, `chk-kinetic`, `chk-reduce-motion`, `chk-sls`, `chk-ui-sounds`, `chk-validate-fresh`,
`confetti`, `context-menu`, `crack-apply`, `crack-browse`, `crack-goldberg-status`, `crack-scan-results`,
`dl-focus`, `dl-focus-bg`, `dl-focus-cancel`, `dl-focus-dest`, `dl-focus-fill`, `dl-focus-kicker-text`, `dl-focus-logbtn`, `dl-focus-pause`, `dl-focus-pct-num`, `dl-focus-queue`, `dl-focus-queue-list`, `dl-focus-title`, `dl-hud`, `dl-hud-eta`, `dl-hud-fill`, `dl-hud-label`, `dl-hud-name`, `dl-hud-pct`, `dl-hud-speed`, `dl-poster-art`, `dl-poster-fill`, `drop-zone`,
`fstat-disk`, `fstat-disk-wrap`, `fstat-elapsed`, `fstat-eta`, `fstat-size`, `fstat-speed`,
`game-flyout`,
`hero-badge`, `hero-bg`, `hero-content`, `hero-dots`, `hero-section`, `hero-subtitle`, `hero-title`, `home-scroll`, `home-setup`, `home-setup-action`, `home-setup-spin`, `home-setup-sub`, `home-setup-title`,
`inp-api-key`, `inp-steam-username`, `install-locations`,
`ledger-games`, `ledger-hours`, `ledger-size`, `lib-density-seg`, `lib-filter`, `lib-grid`, `lib-scan-btn`, `lib-toolbar-extra`, `lib-view-seg`, `log-output`,
`modal-overlay`,
`nav-ind` (created), `new-coll-cancel`, `new-coll-name`, `new-coll-ok`,
`onboard`, `onboard-go`, `onboard-skip`, `onboard-steps`,
`page-downloads`, `page-settings`, `page-store`, `page-tuning`, `palette`, `palette-input`, `palette-list`, `palette-mode`, `plan-groups`, `plan-legend`, `plan-size`, `plan-size-num`,
`queue-cards`,
`row-sound-volume`,
`sd-depot-list`, `sd-facts`, `sd-strip`, `sd-tag-list`, `search-input`, `search-recent`, `search-results`, `sel-max-downloads`, `settings-nav`, `sf-rails`, `shortcut-close`, `shortcut-grid`, `shortcut-sheet`, `shortcut-title`, `sidebar-all-games`, `sidebar-collections`, `sidebar-favorites`, `sidebar-ledger`, `sidebar-new-collection`, `sidebar-recent`,
`tn-tiles`, `topbar-drag`, `topbar-nav`, `topbar-progress`, `topbar-search`, `tour`, `tour-back`, `tour-body`, `tour-card`, `tour-chapter`, `tour-count`, `tour-dots`, `tour-mask`, `tour-next`, `tour-skip`, `tour-title`,
`window-controls`.

### C2. Additional IDs in the static markup regions in scope (styled, not touched by JS)
`dl-focus-actions`, `dl-focus-chart`, `dl-focus-inner`, `dl-focus-kicker`, `dl-focus-main`, `dl-focus-pct`, `dl-focus-poster`, `dl-focus-readout`, `dl-focus-scrim`, `dl-focus-stats`, `dl-focus-track`, `dl-hud-bar`, `dl-hud-spin`, `dl-hud-sub`, `dl-hud-top`, `hero-actions`, `hero-hint`, `hero-logo`, `home-setup-bar`, `home-setup-body`, `home-setup-row`, `onboard-actions`, `onboard-card`, `onboard-note`, `palette-box`, `palette-foot`, `palette-head`, `shortcut-card`, `toast-stack`, `tour-foot`, `tour-head`, `tour-nav`.

### C3. Classes referenced by enhance.js / kinetic.js (selectors, toggled or generated)
`active`, `art-fallback`, `bp-act`, `bp-card`, `bp-detnews-list`, `bp-key`, `bp-pill`, `bp-rail-item`, `bp-row`, `bp-sf-card`, `bp-sf-pill`, `bp-sf-strip`, `bp-shot`, `bp-store-tag`, `bump`, `can`, `closing`, `cmd-body`, `cmd-empty`, `cmd-group`, `cmd-hint`, `cmd-icon`, `cmd-item`, `cmd-sub`, `cmd-title`, `coll-dot`, `collection-empty`, `collection-link`, `ctx-item`, `done`, `dragging`, `dtab`, `failed`, `flash-target`, `flip-move`, `flyout-open`, `focus-mode`, `form-group`, `form-input`, `fq-item`, `game-row`, `game-tile`, `hidden`, `icon-btn`, `indeterminate`, `is-maximized`, `jump`, `k-burst`, `k-roll`, `keys`, `leaving`, `left`, `ledger-num`, `lit`, `loc-row`, `modal-actions`, `nav-key`, `nav-tab`, `now`, `ob-step`, `on`, `page`, `paused`, `placing`, `plate`, `poster-blur`, `poster-fit`, `queue-card`, `queue-card-remove`, `reduce-motion`, `result-card`, `result-card-add`, `result-skeleton`, `reveal`, `right`, `rippling`, `row-rail`, `row-scroll`, `row-see-all`, `sc-col`, `sc-row`, `sd-depot`, `sd-fact`, `sd-shot`, `sd-tag`, `seg`, `settings-panel`, `settings-section`, `sf-card`, `sf-rail`, `sf-rail-scroll`, `show-hotkeys`, `show-log`, `shown`, `side-count`, `sidebar-link`, `store-chip`, `swapping`, `tile-fav-btn`, `tile-play-btn`, `tilting`, `tn-tile`, `toggle-row`, `tour-btn`, `xbox-btn`, `xbox-btn-primary`, `xbox-btn-secondary`.

### C4. Additional classes in the static markup regions in scope
`btn-sm`, `close-btn`, `fq-label`, `fstat`, `fstat-label`, `fstat-num`, `game-grid`, `kicker-dot`, `ledger-label`, `ledger-row`, `nav-badge`, `ob-num`, `ob-text`, `poster-fill`, `poster-frame`, `poster-plinth`, `poster-sheen`, `primary` / `ghost` (on `.tour-btn`), `row-header`, `row-title`, `sc-grid`, `sc-lead`, `sep`, `shortcut-heading`, `sidebar-section-label`, `tn-panel`, `topbar-logo`, `topbar-name`, `unit`, `win-btn`.

### C5. Data attributes and ARIA used as hooks
On `<html>`: `data-density`, `data-kinetic`, `data-libview`, `data-nav`, `data-navind`, `data-tilt`.
Elsewhere:
- `aria-pressed` (seg buttons); `aria-selected` (`.cmd-item`, the selection state);
- `data-built` (`#shortcut-grid`); `data-busy` (`#page-store`); `data-collection` (`.collection-link`);
- `data-density` / `data-view` (seg buttons); `data-dir` (`.page`, set by app.js);
- `data-hide-on-error` (generated `<img>`); `data-index` (`.cmd-item`, `#settings-nav button`);
- `data-job-id` / `data-appid` (`.queue-card` FLIP key); `data-k-counting` / `data-k-pop` (ledger/plan readouts);
- `data-key` / `data-tinted` (`.game-tile`); `data-page` (`.nav-tab`); `data-prev` (`.ledger-num`);
- `data-railed` (`.row-scroll`); `data-sec` (`.settings-section`);
- `[hidden]` / `[inert]` (excluded from spatial nav).

### C6. Custom properties written by JS
`--fade-l`, `--fade-r` (`.row-scroll`); `--game-tint` (`#game-flyout`); `--hero-interval` (`#hero-dots`); `--k-burst-size` (`.k-burst`); `--k-i` (cascade children); `--mx`, `--my`, `--rx`, `--ry`, `--tz` (`.game-tile`); `--nw`, `--nx` (`#nav-ind`); `--reveal-delay` (`.reveal`); `--rx-x`, `--rx-y` (`.xbox-btn`); `--tile-tint` (`.game-tile` in `#lib-grid`).
Read from `:root` by JS: `--primary`, `--brass-2`, `--patina` (confetti).

### C7. Inline styles written by JS (they win over the stylesheet)
- `#hero-bg` `translate`; `#hero-content` `translate` and `opacity`; `#hero-section` `opacity`;
- `#topbar-progress > i`, `#dl-hud-fill` and `#dl-focus-fill` `width`; `#dl-poster-fill` `height`;
- `#dl-focus-bg` `background-image`; `.poster-blur` `background-image`;
- `#tour-mask` `left/top/width/height`; `#tour-card` `left/top`;
- `#confetti` width/height attributes; `.k-burst` `left/top`;
- `.queue-card` `transition` / `transform` (FLIP, transient); `#hero-badge`, `#hero-title` and `#hero-subtitle` `animation` (transient);
- `#row-sound-volume` `display`; the collection name `<span>` (flex/ellipsis).
