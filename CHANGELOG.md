# Changelog

All notable changes to PageEraser are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/).

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
