# Changelog

All notable changes to PageEraser are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/).

## [1.11.1] — 2026-11-06

### Fixed

- On a browser set to Turkish, the right-click entries ("PageEraser: Erase Element" and
  "Stretch Element") stayed English until the popup had been opened once. The background
  script assumed English when no language had been saved yet, while the popup and the page
  tools already follow the browser. It now does the same, and a language the user chose
  still wins. Existing installs are not affected: their choice is already saved.
- **The popup's menus work from the keyboard.** File, Actions, Options and Help could not be
  reached without a mouse (Tab skipped them, Enter did nothing), which left export and import,
  copy as code, language, theme and the tour out of reach. The titles now take focus with Tab and
  open with Enter, Space or ↓; ↑ ↓ Home End move through the entries, ← → hop between menus, Esc
  closes, and Alt plus the underlined letter opens a menu (the letter follows the language).
  Screen readers get a menu bar with menu items, check boxes and radio buttons. Choosing an
  entry that opens a dialog hands focus back to the menu title when the dialog closes.
- **About and Minesweeper are proper dialogs:** named, modal, Tab stays inside, Esc closes them
  and focus returns to where it came from.
- **A full browser storage is no longer silent.** Erasing with `chrome.storage.local` full said
  "Element Erased" and saved nothing, so the element came back on the next load. It now says
  "Hidden for now, but not saved: browser storage is full." Visual Diff shares that 10 MB with
  your rules, so it no longer remembers a design image when less than 1 MB would be left for
  them (it says so and the image keeps working until you leave the page).
- **Two tabs of one site erasing at the same moment** no longer lose a rule: the writes take
  turns (Web Locks, https pages; where the browser has none they run as before).
- **Editing a rule** in a tab that does not answer (opened before an update) no longer leaves
  the old rule next to the new one: the popup swaps the rule in storage itself. Pressing Save
  without changing the selector (or only its spaces) just closes the editor; before this fix it
  deleted the rule it had just written.
- A page that holds the extension's lock for good can no longer keep a rule from being saved:
  the wait is capped at 2 seconds, after which the write goes ahead as it did before locks.
- The **Soundboard** is a named, modal dialog like About and Minesweeper (Tab stays inside,
  Esc closes it, focus comes back), and a minimised window re-titles itself when the language
  changes.
- Visual Diff's "not remembered" message states what is really stored: images up to about
  3.5 MB (a 5 MB limit was written before, but the stored copy is about a third larger than the
  file). The privacy policy and the README say the same.
- The in-page hint calls the ↓ key "Next" ("Sonraki"), as the popup does.
- Hovering the extension's own toast in selection mode no longer selects it.
- The toast's Undo and ✕ ignore a click a web page makes on its own, like every other control.
- Rules are now applied in SVG and XML documents too (the stylesheet was created without a
  namespace there, so "Element Erased" hid nothing).
- Two right-click menu rebuilds at the same moment (install or start-up plus a language change)
  no longer collide on "duplicate id"; they take turns.
- **Language:** the Close / Minimize / Maximize labels and the Recycle Bin hint follow the
  language (they were English for a screen reader in Turkish), "[Minimized]" is translated, the
  ✕ of toasts and the Paint toolbox follows the language, English reads "1 rule", "1 element ·
  1 font" instead of "1 rules", and the ↓ shortcut is described as what it does: "Select Next
  Element Down" (it walks the page in document order).

### Security

- **A shared code can no longer blank a page with a longer spelling of `body`.** The old check
  knew a few exact forms; `#a, body`, `html, body`, `:not(.x)`, `body *`, `html:is(*)`, `*|*`
  and about a dozen more got through. A selector is now judged by what it is made of: it is
  refused when no part of it names anything specific (an id, a class, an attribute, or a tag
  other than html, body and head), every comma-separated part is judged, escapes such as
  `\62 ody` are decoded first, and anything that cannot be read counts as too broad.
  `.sidebar *` and `body > .banner` still pass. As a second layer, a rule that is still marked
  *imported* is held back if it matches `<html>` or `<body>` on the real page; *Keep* is the
  user's own decision and lifts that.
- **Backup files are capped:** 2 MB, 5,000 rules per site, 20,000 rules in all. A 120,000-rule
  file used to freeze the popup for about 26 seconds, be saved, and make every page load heavier.
  Over the limit the usual "invalid backup" message appears and nothing is saved.

### Known limitations

- The picker runs on the top page only: elements inside an `<iframe>` (an ad slot, for
  instance) cannot be selected, the frame shows no highlight, and a click goes to the frame.
  Pick the frame itself with the arrow keys instead.
- Clicking to erase does not work inside an SVG or XML document opened on its own (rules you
  already have still apply there).
- A rule saved in one tab shows in other open tabs of the same site after they reload.
- A shared code with only a tag as selector (`main`, `div`) passes the safety check, because it
  names something; Remove undoes it. Whole-page selectors are still refused.
- Pages opened from disk (`file://`) share one rule list.
- Minesweeper is played with the mouse only, and the first-run tour is not a keyboard dialog yet.
- The BSOD easter egg is English only, and the *Tokens* tab of Extract to Code keeps its name
  in Turkish, like *HTML* and *CSS*.

## [1.11.0] — 2026-11-05

### Added

- **Share rules as a code.** *File → Copy Rules as Code* puts the current site's
  rules on the clipboard as one line of text, `pageeraser:1:<base64url of the rules>`.
  *File → Import from Code…* takes a pasted code, shows which site it is for, how
  many rules it holds and the first few selectors, and adds them only when you press
  *Add rules*. It is only text: no server, no link, no account, no new permission,
  no network. The format is versioned (`1`), so a later format can be told apart; an
  older extension says "this code comes from a newer PageEraser".
- **Imported rules** carry an `imported` mark and are listed last, under their own
  heading: *Keep* makes them your own, *Remove* deletes all of them in one click and
  the elements come back. A rule you already had stays yours (it is never relabelled),
  and editing or deleting an imported rule makes it yours too.
- `PE_buildShare`, `PE_parseShare` (with `PE_isValidHostname`, `PE_b64urlEncode`,
  `PE_b64urlDecode`) in `shared.js`.

### Security

- A pasted code is untrusted input and is checked as hard as a backup file, and a
  little harder: every selector goes through `PE_isSafeSelector`; a code is capped at
  200,000 characters and 500 rules; the text must be strict UTF-8; the site must be a
  valid hostname; and rules that would hide the whole page (`*`, `html`, `body`,
  `head`, `:root`, `html > body`) are left out. What a code held and what was left
  out is shown before anything is saved, and everything from the code is put in the
  popup as text, never as HTML.

### Changed

- The store summary (manifest `description`) names what the extension does today:
  erase, X-Ray, Extract to Code and Visual Diff.
- The privacy policy covers the clipboard use of the sharing code.

### Known limitations

- A code carries the site name as the sender stored it. With *all subdomains* on, the
  importing side keeps the rules under the base domain (so `www.example.com` becomes
  `example.com`); with it off, a code made for `example.com` applies on `example.com`
  only, not on `www.example.com`. The dialog names the site the rules are added for.

## [1.10.0] — 2026-11-05

### Added

- **Visual Diff** (`modes/diff.js`, `modes/diff-core.js`). Load a design image —
  drop it on the window, choose a file, or paste it — and it is laid over the page
  on a canvas that ignores the pointer. Controls: opacity (0–100), X/Y offset
  (arrow keys move 1 px, `Shift` 10 px), scale (50–200 %), *scroll with the page*
  (the design is absolutely positioned and scrolls with the document; off, it
  stays fixed in the window), *Invert*, a *Difference* blend (`mix-blend-mode:
  difference`) and a *Before / after* divider (design on the left, live page on the
  right) that you drag.
- **Compare.** Captures the visible tab with the extension's own layers hidden,
  draws the design at its place on a canvas of the same size, and compares them
  pixel by pixel: a pixel differs when any of R, G, B is further apart than the
  threshold (0–128, default 16). Differing pixels are painted as a translucent red
  heat map that stays with the page; the toolbar shows the percentage of compared
  pixels that differ and the number of separate regions (differing cells of 8×8
  px, at least 4 pixels each, touching cells — diagonals too — are one region).
  Moving, scaling or replacing the design clears the heat map.
- **Remembered per site**: offset, scale, opacity and the other settings, and the
  image itself when its data URL fits in 5 MB (bigger images work until you leave
  the page, and the toolbar says so). Kept in `chrome.storage.local`, nothing is
  sent anywhere; the toolbar says "Your image stays on this computer."
- The design is drawn from a decoded bitmap on a canvas, not shown through an
  `<img>`, so a page's Content-Security-Policy cannot block it. Files are limited
  to PNG/JPG/WebP, 25 MB, 16384 px per side and 40 megapixels.
- `toggle-diff` command (no default key), in-page fallback `Alt+Shift+V` (Alt only:
  `Ctrl+Shift+V` is the browser's "paste as plain text"), toolbar button, *Actions*
  menu entry. No new permission.

### Fixed

- A storage write that fails for a reason other than a lost extension — over
  quota, typically — was treated as "extension context lost", which stripped the
  extension's UI from the page and silently disabled it until reload. It now only
  does that when the context really is gone. This matters more with images in
  storage, but it affected saving rules too.
- **A page could drive the extension with events it dispatches itself.** The
  in-page shortcuts, the modes' click/modifier/mouse-move handlers and Visual
  Diff's paste and drop all accepted `isTrusted === false` events, so a page
  script could start a mode, erase an element and save a rule, undo it, or send
  `Alt+Shift+D` and delete the user's saved rules for that site — and by repeating
  that, fill the shared storage quota. They now ignore events the page made up;
  real keyboard, mouse, paste and drop input is unchanged.
- Compare could report phantom differences: the "Visual Diff Active" toast (and
  Clippy, when enabled) was still on screen when the tab was captured, so a
  comparison started within a few seconds of opening the mode counted the toast's
  pixels as a region. The toast container and Clippy are now hidden for the
  capture together with the design layers and the toolbar.
- Pasting or dropping a design did nothing on a page that stops `paste` or
  `drop` events with its own capture-phase listener on `window` or `document`.
  The mode now listens on `window` in the capture phase, so such a page can no
  longer block it (the file chooser always worked).
- Compare reported differences along the bottom edge (about 1 % on react.dev,
  17 % on a page with a modal) when the design was as wide as the window: the
  design layer is wider than the page's layout width (the window minus its
  vertical scrollbar), so it adds a horizontal scrollbar while the mode is open,
  and hiding the layer with `visibility` left that scrollbar — and the 15 px it
  takes from the viewport — in the capture. The design and the heat map are now
  taken out of layout (`display: none`) for the capture, so the page is compared
  as it is without the overlay.

- The popup closed without a word when nothing on the tab could answer — tabs
  that were already open when the extension was installed or updated (Chrome adds
  no content script to them), and the Chrome Web Store, where extensions do not
  run — so the buttons looked dead. It now stays open, says to reload the page, and
  treats the Web Store and Edge Add-ons as restricted pages like `chrome://`.
- Compare could report differences on an identical page at fractional display
  scales (about 2 % at 125 %, 4 % at 150 %) and where a capture was a pixel off
  the window size. The design is now placed with its edges snapped to device pixels
  the way the browser paints them, and ±1 px is forgiven when the capture is not a
  whole multiple of the layout; the result then ends with "±1 px tolerance".
- A page could click the toolbar's Compare, Clear and Remove image buttons and
  X-Ray's Capture with `element.click()`. They now ignore clicks the page made up.
- The popup's shortcut list left out `Alt+Shift+W` (Paintbrush), and the privacy
  policy's tables were wider than a 375 px window, so the page scrolled sideways.
  Both fixed.
- The content script began listening for popup messages and keyboard shortcuts only
  after a storage round trip. On very large pages that opened a window, up to about a
  second in some runs, in which the page was still loading and nothing was listening.
  Both listeners are now registered first.
- The README (CI badge, clone command, project tree) and the privacy policy (source
  and issue links) pointed at a repository name that returns 404. They now point at
  `rildir/resize-extension`.

### Changed

- The privacy policy matches what the extension does now: it lists the Visual Diff
  settings and image kept on the device, the toolbar badge count in session storage,
  what each tool reads from a page (X-Ray's Capture PNG, Extract's clipboard copy,
  Compare's in-memory screenshot), and the one-time move from `storage.sync` to local
  storage. It no longer says the data sits in an "encrypted profile directory" — the
  extension does not encrypt it — and it notes that Visual Diff's image is drawn on
  the page while the mode is active.
- The keyboard shortcut table in the README lists the real keys (`Alt+Shift+E`, `D`,
  `W`, `X`, `C`, `V`) and which of them work without the page in focus.

### Known limitations

- Compare needs the extension to have been invoked on the tab (toolbar button,
  keyboard command or right-click menu): that is what grants `activeTab`. Started by
  the in-page fallback shortcut, the toolbar says so.
- Only the visible part of the page is compared; scroll and compare again for the
  rest. The comparison is on the page's own pixels at the capture's resolution, so
  a design exported at 2× should be set to 50 % scale.
- The overlay is a layer of the page: with *scroll with the page* on, a design
  taller than the page makes the page scrollable further while the mode is open.
  A design wider than the page's layout width likewise shows a horizontal scrollbar
  while the mode is open (it is left out of the picture when comparing).
- Four commands already hold a default key, which is Chrome's limit, so this one
  (like Extract to Code) has none until you assign it.
- Recent Chrome versions (seen on 140 and 153) leave `Alt+Shift+W` and `Alt+Shift+X`
  unassigned when the extension is installed, although the manifest suggests them
  (older ones assign them). They work while the page has focus either way; for a
  browser-wide key assign them at `chrome://extensions/shortcuts`. The README says so.
- Even with that tolerance, a text-heavy page can still show a little noise at a
  fractional scale when the design is a screenshot of the page itself (measured about
  0.6 % at 125 %, 2.3 % at 150 %; flat content reports no difference). The design's
  scale is a whole percent, and 150 % would need 66.67 %.
- At a fractional display scale (125 %, 150 %) Compare allows ±1 px: the browser
  snaps boxes to whole device pixels and the design is resampled onto that grid, so
  a one-pixel misalignment cannot be told from rounding there. At 100 % and 200 %
  the comparison is exact.

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
