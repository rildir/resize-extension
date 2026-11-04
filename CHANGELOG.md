# Changelog

All notable changes to PageEraser are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/).

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
