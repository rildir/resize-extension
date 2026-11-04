# Changelog

All notable changes to PageEraser are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/).

## [1.9.0] — 2026-11-04

### Added

- **Extract to Code** (`modes/extract.js`, `modes/extract-core.js`). Click an
  element — with the eraser's hover highlight and ↑/↓ parent/child walk — to
  open a window with three tabs:
  - **HTML**: the element and its subtree, cleaned up. Removed: `script`,
    `iframe`, `style`, `link`, `noscript`, `object`, `embed`, `template`,
    `data-*`, inline event handlers (`on*`), `style` attributes (the CSS tab
    replaces them), `nonce`/`integrity`, and every `id` nothing inside the
    extract refers to (`label for`, `aria-*`, `#anchor` links, SVG `url(#…)`
    keep theirs). Class names are kept, links and image sources are made
    absolute, an `<img>` uses its resolved `currentSrc`. Indentation goes only
    between block-level children, so the markup renders the way it did.
  - **CSS**: for each element only the computed properties that differ from the
    browser's defaults for that tag, measured on an empty element in a
    throwaway blank iframe (so a site's CSS resets are not counted as defaults).
    An inherited property is written only where it differs from the parent.
    Four-sided properties fold into `margin`, `padding`, `border`,
    `border-radius`, `gap`, `flex` and `overflow`. `::before`/`::after` are
    included. Each element that needs styles gets a `.pe-N` class next to its
    own classes.
  - **Tokens**: the fonts used (each stack, and the `@font-face` file URLs found —
    listed, never downloaded) and the colours as a `:root { --pe-color-N }` block.
  - **Copy** on every tab, and **Copy as single HTML file** (HTML + `<style>`).
  - Syntax colouring is a small built-in tokenizer; page text reaches the
    window only through `textContent`, never `innerHTML`. A subtree of more than
    500 elements is cut to the first 500 with a warning.
- `Alt+Shift+C` command (to be assigned at `chrome://extensions/shortcuts`), in-page fallback (`Alt+Shift+C` only — `Ctrl+Shift+C`
  belongs to the browser's inspector), toolbar button and *Actions* menu entry.
- Nothing is added to the manifest: no permission, no host access.

### Changed

- The element picker's tooltip and highlight take their wording and colour from
  the active picker (violet for Extract), the eraser's are unchanged.

### Fixed

- **The extension did not load at all.** The fifth command carried a
  `suggested_key`, and Chrome refuses a manifest with more than four ('Too many
  shortcuts specified for commands: the maximum is 4'). `toggle-extract` no longer
  suggests a key; assign one at `chrome://extensions/shortcuts`. The in-page
  `Alt+Shift+C` works regardless.
- **The picker's own crosshair ended up in the extracted CSS** (`cursor: crosshair`,
  inherited by every element), and `<body style="">` was left behind when the mode
  ended. The cursor is lifted while the styles are read and the empty attribute is
  removed.
- **Links lost their look.** The browser-default reference for `<a>` was measured
  without an `href`, so `text-decoration: none` and the link colour never made it
  out, and a value equal to the parent's was skipped even where the browser has a
  rule of its own for that tag (the link colour) that would win again elsewhere.
  The reference link now has an `href`, and such values are written.
- **Icons, spacers, buttons and flex/grid items collapsed.** Descendant `width` /
  `height` are still left out, except for boxes with nothing inside, buttons,
  shrink-wrapped `inline-*` boxes and flex/grid items, whose size cannot be
  recovered from the parent. A product card, a navbar and a form now render
  pixel-identical (0 %, 0.06 %, 0 % of pixels differ) in a blank page.
- Noise left out of the CSS: the logical twins of `border-*-radius`, and
  `row-rule-color` / `-webkit-text-stroke-color` where there is no rule or stroke.
- Copying on a page whose `Permissions-Policy` forbids `clipboard-write` logged a
  policy violation in the page console before falling back; the policy is now
  asked first.

### Known limitations

- The `width` and `height` of most descendants are not written (they are the
  current layout, not a design value); the root, images and other replaced
  elements, buttons, positioned, floated and shrink-wrapped boxes, empty boxes and
  flex/grid items keep theirs. The root's margins are not written either: they
  belong to the page it was on, and `margin: auto` is written as the pixels it
  resolved to, so a centred block no longer re-centres in a different width.
- Animations (`@keyframes`) and media queries are not exported: the result is
  the element as it looks at the current window size.
- Pseudo-elements other than `::before`/`::after`, shadow DOM contents and
  `<canvas>`/`<video>` frames are not extracted.
- Cross-origin style sheets (Google Fonts, CDNs) do not let an extension read
  their `@font-face` rules, and Chrome does not list the font files such a style
  sheet pulls in (they are absent from Resource Timing). The Tokens tab then says
  so and shows the families and load state from `document.fonts`, without URLs.
- The *Extract to Code* command has no default key (Chrome allows four suggested
  keys per extension and they are taken); assign one at
  `chrome://extensions/shortcuts`. The in-page `Alt+Shift+C` works regardless.
- The computed styles are read while the pointer is over the element, so a
  `:hover` rule that applies to it at that moment (an underlined headline in a
  card, say) is captured too.
- The ids and `aria-hidden`: ids are kept only when referenced, `aria-*`
  attributes (including `aria-hidden`) are kept as they are.

## [1.8.0] — 2026-11-04

### Added

- **Layout X-Ray** (`modes/xray.js`). One click — the toolbar button, the
  *Actions* menu or `Alt+Shift+X` — draws every visible element's box on a
  single fixed canvas that ignores the pointer: flex orange, grid purple, block
  blue, inline-block green; margin shaded orange and padding green; flex and
  grid gaps as dashed lines. Hovering an element shows `tag.class`, its size,
  its `display` value and its columns and gap. A 1–10 depth slider (default 4,
  remembered) keeps large pages readable. Redraws are coalesced to one per
  frame; elements outside the viewport are not drawn; at most 5000 elements are
  collected and 3000 drawn per frame.
- **Capture.** The overlay's toolbar saves the visible tab, overlay included, as
  a PNG. The screenshot comes from the service worker (`captureVisibleTab`, which
  `activeTab` already covers) and is saved from the page through a blob link, so
  no permission is added and nothing is sent anywhere.
- The mode leaves nothing behind: leaving it removes the canvas, label and
  toolbar, every listener and the observers it used. The page's own elements are
  only ever read, never modified.

### Changed

- Mode pointer hooks now receive the cursor position (`clientX`, `clientY`).

### Fixed

- **X-Ray toolbar could not be dragged sideways on right-to-left pages.** It was
  pinned with `right` in the stylesheet while dragging only sets `left`; an RTL
  page honours `right`. The toolbar is now anchored by `left` from the start.
- **X-Ray scrolling cost on very large pages.** Every frame read the bounding
  box of every collected element (up to 5000) although about a hundred are on
  screen, causing long tasks while scrolling a 5000-element page. Only the
  elements within a few viewports of the screen are now re-read each frame; the
  list is rebuilt after a viewport of scrolling, once a second, and whenever
  the layout may have moved.

### Known limitations

- Capture only works once the extension has been invoked on the tab (toolbar
  button, keyboard command or right-click menu) — that is what grants
  `activeTab`. If X-Ray was started by the in-page fallback shortcut instead,
  the toolbar says so.
- Chrome only auto-assigns a handful of suggested shortcuts per extension (the
  limit is around four), and this version uses all four. A further command would
  have to be assigned by the user at `chrome://extensions/shortcuts`; the in-page
  fallback (`Ctrl+Shift+X` / `Alt+Shift+X`) keeps working in the meantime.
- Gaps given as percentages are not drawn, and flex gaps are inferred from the
  children's positions, so unusual `justify-content` layouts can miss a line.
- An element clipped by an ancestor's `overflow` is still outlined in full.

## [1.7.0] — 2026-11-04

### Added

- **Eraser wipe.** An erased element is scraped away left to right over 350 ms
  instead of vanishing, and *Restore* plays the same wipe backwards. It is a CSS
  `mask-image` on the element itself — no canvas, no clone. It is skipped under
  `prefers-reduced-motion`, for elements that are off-screen, zero-sized,
  `display: contents` or SVG, when more than six wipes are already running, and
  on a bulk restore of more than six elements. Clippy's chomp animation is
  unchanged and still takes over while Clippy is on screen.
- **Win95 Recycle Bin.** The bin is now a pixel-style icon that shows *empty* or
  *full* according to whether anything is left to restore. Each rule has a ✕
  button (Win95-style Yes/No confirmation, focus on *No*) that deletes it
  permanently: the element stays hidden, but the rule leaves the bin and
  Ctrl+Z no longer brings it back. *Restore All Layout* still clears every rule,
  permanent or not.
- **Mode manager** (`modes/index.js`). Interactive tools are now modes with a
  common `enter / exit / onPointerMove / onClick / onKey` interface, and only
  one runs at a time. The element picker moved to `modes/erase.js` unchanged
  in behaviour; Paintbrush 95 is registered as a mode too. This is the base the
  next features build on.

### Changed

- Starting Paintbrush 95 while the element picker is active now ends the picker
  first (they could previously both run at once).
- Dragging a rule onto the Recycle Bin no longer flashes the icon to *full* for
  1.5 s; the icon follows the actual contents instead.
- Stored rules may carry `permanent: true`. Older versions ignore the flag, so a
  downgrade simply lists those rules in the bin again.
- `build.ps1` now keeps relative paths when staging, so the `modes/` folder
  survives packaging.

### Fixed

- **Large-text popup.** With *Large text* on, the new ✕ button left the selector
  text no width at all and pushed the Edit / Restore / ✕ buttons out of the
  list row. Rows now wrap, with the buttons on their own line.

### Known limitations

- Elements whose children overflow their box (dropdown menus, tooltips) lose
  those children the moment the erase wipe starts, because a mask clips to the
  element's border box. The element itself still wipes normally.
- A page reload briefly shows an erased element for one or two frames before
  its rule applies (storage is read asynchronously). Unchanged from 1.6.1;
  fixing it needs additional permissions and is tracked separately.

## [1.6.1] — 2026-08-07

### Fixed

- **Rules could leak across unrelated sites.** With *Apply to Subdomains*
  enabled, hostnames with a country second-level domain or a shared hosting
  suffix collapsed to the suffix itself — `hepsiburada.com.tr` became `com.tr`,
  `bbc.co.uk` became `co.uk`, `myproject.github.io` became `github.io`. A rule
  saved on one site then applied to every site under that suffix. Domain
  scoping now uses an explicit suffix list.
  See [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md).
- **Badge count reset when switching tabs.** Counts were held in a `Map` inside
  the MV3 service worker, which is torn down after ~30s idle. Moved to
  `chrome.storage.session`.
- **Context menus could fail to register.** `contextMenus.create()` ran only in
  `onInstalled`, without `removeAll()` — it throws on a duplicate id when the
  handler re-fires on update — and there was no `onStartup` handler, so menus
  did not survive a browser restart.
- **Buttons rendered with rounded corners on other machines.** No form control
  declared `appearance: none` or `border-radius: 0`, so the popup fell back to
  the browser's native button rendering, and the on-page toolbar could be
  restyled by the host site's own CSS.
- **Orphaned content scripts threw on every storage call.** After an extension
  reload or update, scripts in open tabs lost their context and emitted uncaught
  rejections for the life of the tab. Storage now degrades instead of throwing,
  and the on-page UI is removed.
- Version number was hardcoded in three places and had drifted; it is now read
  from the manifest.

### Added

- **Import / Export rules.** The menu entries, file input and translations
  existed but were never wired to any code. Export writes a versioned JSON
  backup; import validates it and **merges** rather than replacing, so sites
  absent from the backup keep their rules.
- **Selector validation** (`shared.js`). Stored rules are interpolated into a
  stylesheet, and they can arrive from an imported file or the inline editor.
  Selectors that could terminate the CSS rule and append their own are rejected
  on save *and* re-validated on load. Escaped literals from `CSS.escape()`
  (e.g. Tailwind's `@lg:flex`) are correctly allowed through.
- **Test suite** (`node tests/run.js`) — 55 checks, no browser or dependencies:
  unit tests for domain scoping, selector validation and rule normalisation,
  plus static checks that every element id, translation key and referenced file
  actually resolves.
- **CI** (GitHub Actions): syntax check, test suite, package build, ZIP uploaded
  as a build artifact.
- **`build.ps1`** — produces a store-ready package from an explicit allowlist,
  runs the tests first, and fails if the manifest or popup references a file it
  does not ship. Development files no longer end up in the upload.
- **`docs/ARCHITECTURE.md`** — threat model, MV3 lifetime notes, and the
  trade-offs that were deliberately not taken.
- Privacy policy is now reachable from the About dialog.
- Context menu labels follow the language chosen in Options (were English-only).

### Changed

- **Removed `host_permissions: ["<all_urls>"]`.** Its only consumer was
  `tab.url` in the popup, which `activeTab` already covers. Declared permissions
  are now exactly `storage`, `activeTab`, `contextMenus`. The install prompt is
  unchanged — the `<all_urls>` content script produces that on its own.
- `minimum_chrome_version` set to 102 (`chrome.storage.session`).
- External links in the About dialog now set `rel="noopener noreferrer"`.
- Alert dialog is keyboard-operable: Escape and Enter dismiss it, Tab is
  trapped, and focus returns to where it was.

### Known issues

- Rules saved before 1.6.1 under a truncated domain key (see the scoping fix
  above) are unreachable. They are left in storage rather than deleted — the
  original site cannot be recovered from the key, and discarding user data
  silently is worse than leaving it orphaned.

---

## [1.6.0] — earlier

- Privacy policy page, keyboard shortcut updates.

## [1.5.0] — earlier

- Paint mode ESC handling and shortcut fixes.
