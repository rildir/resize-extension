/**
 * PageEraser — Test Suite
 *
 * Dependency-free checks that run without a browser. Two kinds:
 *
 *   1. Unit tests for shared.js (domain scoping, selector validation,
 *      rule normalisation) — the logic that decides which CSS reaches a page.
 *   2. Static wiring checks — every getElementById() in the popup scripts
 *      resolves to a real element, and every data-i18n key exists in both
 *      languages. A miss here throws at load time and blanks the popup.
 *
 * Usage:  node tests/run.js      (from the project root)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let checks = 0;
// Checks that have to wait for a promise (async functions under test).
const pending = [];

function check(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${label}`);
    console.log(`          expected: ${JSON.stringify(expected)}`);
    console.log(`          actual:   ${JSON.stringify(actual)}`);
  }
}

/* ─── Load shared.js with a minimal document shim ────────── */
// Chrome's querySelector throws SyntaxError on an invalid selector; that is
// the only DOM behaviour PE_isSafeSelector depends on.
global.document = {
  createDocumentFragment: () => ({
    querySelector: (s) => {
      if (!s.trim()) throw new SyntaxError('empty selector');
      if (/[{};]/.test(s)) throw new SyntaxError('invalid selector');
      return null;
    }
  })
};
eval(read('shared.js'));

/* ─── 1. Selector validation ─────────────────────────────── */
console.log('shared.js — PE_isSafeSelector');
const B = String.fromCharCode(92); // backslash, CSS.escape's escape character

[
  ['div > span', true],
  ['#main .ad-slot', true],
  ['a[href^="/news"]', true],
  ['div:nth-child(2)', true],
  ['ul li:not(.keep)', true],
  // CSS.escape() output for real-world class names must survive.
  ['.' + B + '@lg' + B + ':flex', true],
  ['.' + B + '32xl', true],
  // Anything that could terminate `sel { … }` and append rules must not.
  ['x{} body{display:none}', false],
  ['@import url(http://evil.test);a', false],
  ['a; color:red', false],
  ['/*', false],
  ['*/ x', false],
  ['', false],
  ['   ', false],
  ['x'.repeat(2500), false],
  [null, false],
  [42, false]
].forEach(([sel, expected]) => {
  check(`isSafeSelector(${JSON.stringify(String(sel).slice(0, 40))})`, PE_isSafeSelector(sel), expected);
});

/* ─── 2. Domain scoping ──────────────────────────────────── */
console.log('shared.js — PE_getBaseDomain');
[
  // Plain domains
  ['www.example.com', 'example.com'],
  ['example.com', 'example.com'],
  ['a.b.c.example.com', 'example.com'],

  // Country second-level domains. Regression guard: an earlier version
  // collapsed these to the suffix itself, so a rule saved on one Turkish shop
  // applied to every .com.tr site the user visited.
  ['hepsiburada.com.tr', 'hepsiburada.com.tr'],
  ['www.hepsiburada.com.tr', 'hepsiburada.com.tr'],
  ['bbc.co.uk', 'bbc.co.uk'],
  ['news.bbc.co.uk', 'bbc.co.uk'],
  ['a.b.example.co.uk', 'example.co.uk'],
  ['shop.example.com.au', 'example.com.au'],

  // Shared hosting: each subdomain is a different owner and must stay separate.
  ['myproject.github.io', 'myproject.github.io'],
  ['docs.myproject.github.io', 'myproject.github.io'],
  ['myapp.vercel.app', 'myapp.vercel.app'],
  ['someones-blog.blogspot.com', 'someones-blog.blogspot.com'],

  // Normalisation and non-domain hosts
  ['WWW.Example.COM', 'example.com'],
  ['example.com.', 'example.com'],
  ['localhost', 'localhost'],
  ['192.168.1.5', '192.168.1.5'],
  ['', ''],
  [null, '']
].forEach(([input, expected]) => {
  check(`getBaseDomain(${JSON.stringify(input)})`, PE_getBaseDomain(input), expected);
});

/* ─── 3. Rule normalisation ──────────────────────────────── */
console.log('shared.js — PE_normalizeRules');
check('normalizeRules: legacy strings, dupes and unsafe entries', PE_normalizeRules([
  '.ad',                                      // legacy bare string -> hide
  { selector: '#hero', action: 'stretch' },
  { selector: '.ad' },                        // missing action -> hide, duplicate
  { selector: '.ad', action: 'hide' },        // exact duplicate
  'bad{}selector',                            // unsafe
  { selector: '@import url(x)', action: 'hide' },
  null,
  undefined,
  { action: 'hide' }                          // no selector
]), [
  { selector: '.ad', action: 'hide' },
  { selector: '#hero', action: 'stretch' }
]);
check('normalizeRules: non-array input', PE_normalizeRules('nope'), []);

// Deleted-for-good rules keep hiding the element and carry their flag along.
check('normalizeRules: permanent flag survives', PE_normalizeRules([
  { selector: '.ad', action: 'hide', permanent: true },
  { selector: '.promo', action: 'hide', permanent: 'yes' }, // only a real true counts
  { selector: '.nav', action: 'hide', permanent: false }
]), [
  { selector: '.ad', action: 'hide', permanent: true },
  { selector: '.promo', action: 'hide' },
  { selector: '.nav', action: 'hide' }
]);
check('normalizeRules: a permanent duplicate keeps the rule permanent', PE_normalizeRules([
  { selector: '.ad', action: 'hide' },
  { selector: '.ad', action: 'hide', permanent: true }
]), [
  { selector: '.ad', action: 'hide', permanent: true }
]);

/* ─── 4. Popup wiring ────────────────────────────────────── */
console.log('popup — element and locale wiring');
const html = read('popup.html');
const allHtmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const htmlIds = new Set(allHtmlIds);

// Duplicate ids silently shadow each other: getElementById returns the first
// match, so the second element is wired to nothing and never updates.
const duplicateIds = [...new Set(allHtmlIds.filter((id, i) => allHtmlIds.indexOf(id) !== i))];
check('popup.html: no duplicate element ids', duplicateIds, []);

for (const file of ['popup.js', 'audio.js', 'clippy.js', 'tour.js', 'minesweeper.js']) {
  const refs = [...read(file).matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((id) => !htmlIds.has(id));
  check(`${file}: all getElementById targets exist`, missing, []);
}

const locales = read('locales.js');
const enBlock = locales.slice(locales.indexOf('en: {'), locales.indexOf('tr: {'));
const trBlock = locales.slice(locales.indexOf('tr: {'));
const keysOf = (block) => new Set([...block.matchAll(/^\s{4}([a-zA-Z0-9_]+):/gm)].map((m) => m[1]));
const enKeys = keysOf(enBlock);
const trKeys = keysOf(trBlock);

const usedKeys = [...new Set([
  ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/data-i18n-placeholder="([^"]+)"/g)].map((m) => m[1])
])];
check('popup.html: every data-i18n key exists in LOCALES.en', usedKeys.filter((k) => !enKeys.has(k)), []);
check('locales.js: no key missing a Turkish translation', [...enKeys].filter((k) => !trKeys.has(k)), []);
check('locales.js: no key missing an English translation', [...trKeys].filter((k) => !enKeys.has(k)), []);

/* ─── 5. Manifest sanity ─────────────────────────────────── */
console.log('manifest');
const manifest = JSON.parse(read('manifest.json'));
check('manifest_version is 3', manifest.manifest_version, 3);
check('no host_permissions (activeTab covers our use)', manifest.host_permissions, undefined);
check('permissions are minimal', manifest.permissions.slice().sort(), ['activeTab', 'contextMenus', 'storage']);

const referenced = [
  manifest.background.service_worker,
  ...manifest.content_scripts[0].js,
  ...manifest.content_scripts[0].css,
  manifest.action.default_popup
];
const absent = referenced.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('every manifest-referenced file exists', absent, []);

const popupScripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
check('every popup script file exists', popupScripts.filter((f) => !fs.existsSync(path.join(ROOT, f))), []);

// Relative hrefs resolve to chrome-extension:// pages, so the target has to be
// a real file *and* has to be in the shipping list in build.ps1.
const localLinks = [...html.matchAll(/href="(?!https?:|mailto:|#)([^"]+)"/g)].map((m) => m[1]);
check('every relative popup link resolves to a file', localLinks.filter((f) => !fs.existsSync(path.join(ROOT, f))), []);

const buildScript = read('build.ps1');
const shipped = [...buildScript.matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1]);
const notShipped = [...new Set([...popupScripts, ...localLinks])].filter((f) => !shipped.includes(f));
check('every popup asset is listed in build.ps1', notShipped, []);

// External links must not hand the opener over to the target page.
const blankLinks = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((m) => m[0]);
check('every target="_blank" link sets rel=noopener', blankLinks.filter((a) => !/rel="[^"]*noopener/.test(a)), []);

/* ─── 6. Mode manager ────────────────────────────────────── */
console.log('modes/index.js — PE_ModeManager');
const { PE_ModeManager } = require(path.join(ROOT, 'modes/index.js'));

// A page stand-in that records listeners so we can count and fire them.
function fakeTarget() {
  const map = new Map();
  return {
    addEventListener(type, fn) { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); },
    removeEventListener(type, fn) { if (map.has(type)) map.get(type).delete(fn); },
    count(type) { return map.has(type) ? map.get(type).size : 0; },
    total() { let n = 0; map.forEach((s) => { n += s.size; }); return n; },
    fire(type, e) { (map.get(type) || new Set()).forEach((fn) => fn(e)); }
  };
}
let rafQueue = [];
global.window = fakeTarget();
global.document.addEventListener = (...a) => global.window.__doc.addEventListener(...a);
global.document.removeEventListener = (...a) => global.window.__doc.removeEventListener(...a);
global.requestAnimationFrame = (fn) => { rafQueue.push(fn); };
const flushFrames = () => { const q = rafQueue; rafQueue = []; q.forEach((fn) => fn()); };
function freshPage() {
  global.window = fakeTarget();
  global.window.__doc = fakeTarget();
  rafQueue = [];
  return { win: global.window, doc: global.window.__doc };
}

(function modeManagerTests() {
  let page = freshPage();
  const log = [];
  const plain = (name) => ({ enter: (o) => log.push(`enter:${name}:${JSON.stringify(o)}`), exit: () => log.push(`exit:${name}`) });

  // registration
  let threw = 0;
  try { new PE_ModeManager().register('', plain('x')); } catch (e) { threw++; }
  try { new PE_ModeManager().register('x', { enter() {} }); } catch (e) { threw++; }
  check('register rejects an empty id and a mode without exit()', threw, 2);

  // one mode at a time, in order
  let mm = new PE_ModeManager().register('a', plain('a')).register('b', plain('b'));
  check('activate returns true and reports the mode', [mm.activate('a', { silent: true }), mm.isActive('a'), mm.activeId], [true, true, 'a']);
  check('activating the active mode again is a no-op', mm.activate('a'), false);
  check('activating an unknown mode is a no-op', mm.activate('nope'), false);
  mm.activate('b');
  check('a second mode exits the first before it enters', log, ['enter:a:{"silent":true}', 'exit:a', 'enter:b:undefined']);
  check('only the second mode is active', [mm.isActive('a'), mm.isActive('b'), mm.isActive()], [false, true, true]);
  check('deactivate stops it', [mm.deactivate(), mm.isActive(), mm.deactivate()], [true, false, false]);
  check('toggle starts then stops a mode', [mm.toggle('a'), mm.isActive('a'), mm.toggle('a'), mm.isActive('a')], [true, true, false, false]);

  // listeners: only for the hooks a mode defines, none left behind
  page = freshPage();
  mm = new PE_ModeManager().register('quiet', plain('quiet')).register('picker', {
    enter() {}, exit() {}, onPointerMove() {}, onClick() {}, onModifier() {}
  });
  mm.activate('quiet');
  check('a mode with no hooks gets no listeners', page.win.total() + page.doc.total(), 0);
  mm.activate('picker');
  check('hooks map to listeners (mousemove, click, keydown, keyup)',
    [page.doc.count('mousemove'), page.win.count('click'), page.win.count('keydown'), page.win.count('keyup')], [1, 1, 1, 1]);
  mm.deactivate();
  check('deactivate removes every listener', page.win.total() + page.doc.total(), 0);

  // pointer: one call per frame, never after the mode has ended
  page = freshPage();
  const moves = [];
  mm = new PE_ModeManager().register('p', { enter() {}, exit() {}, onPointerMove: (i) => moves.push(i.target) });
  mm.activate('p');
  page.doc.fire('mousemove', { target: 'A', altKey: false });
  page.doc.fire('mousemove', { target: 'B', altKey: false });
  flushFrames();
  page.doc.fire('mousemove', { target: 'C', altKey: true });
  flushFrames();
  check('pointer moves are throttled to one per frame', moves, ['A', 'C']);
  page.doc.fire('mousemove', { target: 'D', altKey: false });
  mm.deactivate();
  flushFrames();
  check('a frame queued before deactivate does not reach the mode', moves, ['A', 'C']);

  const seen = [];
  const pm = new PE_ModeManager().register('xy', { enter() {}, exit() {}, onPointerMove: (i) => seen.push([i.clientX, i.clientY]) });
  pm.activate('xy');
  page.doc.fire('mousemove', { target: 'A', altKey: false, clientX: 12, clientY: 34 });
  flushFrames();
  check('pointer info carries the cursor position', seen, [[12, 34]]);
  pm.deactivate();

  // keys
  const keys = [];
  mm = new PE_ModeManager()
    .register('k', { enter() {}, exit() {}, onKey: (e) => keys.push(e.key) })
    .register('mute', plain('mute'));
  mm.handleKey({ key: 'x' });
  mm.activate('k');
  mm.handleKey({ key: 'ArrowUp' });
  mm.activate('mute');
  mm.handleKey({ key: 'ArrowDown' }); // a mode without onKey must not throw
  check('handleKey reaches only the active mode', keys, ['ArrowUp']);

  // release() and exit() calling back into the manager (paint ends by itself)
  const calls = [];
  mm = new PE_ModeManager();
  mm.register('self', { enter() {}, exit() { calls.push('exit'); mm.release('self'); } });
  mm.activate('self');
  mm.deactivate();
  check('exit() may call release() without looping', [calls, mm.isActive()], [['exit'], false]);
  mm.activate('self');
  check('release() ends a mode without calling exit()', [mm.release('self'), mm.isActive(), calls.length, mm.release('self')], [true, false, 1, false]);

  // a mode that fails to start leaves nothing behind
  page = freshPage();
  mm = new PE_ModeManager().register('bad', {
    enter() { throw new Error('boom'); }, exit() {}, onClick() {}, onPointerMove() {}
  });
  let message = null;
  try { mm.activate('bad'); } catch (e) { message = e.message; }
  check('a failing enter() rethrows and cleans up', [message, mm.isActive(), page.win.total() + page.doc.total()], ['boom', false, 0]);
})();

/* ─── 7. Content script wiring ───────────────────────────── */
console.log('content scripts — load order, shipping, animation timing');
const csJs = manifest.content_scripts[0].js;
check('content scripts load shared.js, then the modes, then content.js',
  csJs, ['shared.js', 'modes/index.js', 'modes/erase.js', 'modes/xray.js', 'modes/extract-core.js', 'modes/extract.js', 'modes/diff-core.js', 'modes/diff.js', 'content.js']);

const shippedAll = [...buildScript.matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1]);
check('every manifest content script is listed in build.ps1', csJs.filter((f) => !shippedAll.includes(f)), []);

// The wipe is timed twice — JS decides when it is over, CSS plays it.
const contentJs = read('content.js');
const contentCss = read('content.css');
const jsMs = Number((contentJs.match(/const PE_SWEEP_MS = (\d+);/) || [])[1]);
const sweepRule = (contentCss.match(/\.pe-erasing,\s*\.pe-restoring \{[^}]*\}/) || [''])[0];
const cssMs = Number((sweepRule.match(/animation-duration:\s*(\d+)ms/) || [])[1]);
check('sweep length in content.js matches content.css', jsMs, cssMs);
check('sweep is between 300 and 400 ms', jsMs >= 300 && jsMs <= 400, true);
check('sweep honours prefers-reduced-motion', /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.pe-erasing/.test(contentCss), true);
check('JS skips the sweep under prefers-reduced-motion', contentJs.includes("matchMedia('(prefers-reduced-motion: reduce)')"), true);

const popupCss = read('popup.css');
check('popup.css: large text lets rule rows wrap (three buttons no longer fit on one line)',
  /body\.text-large \.selector-item \{[^}]*flex-wrap:\s*wrap/.test(popupCss), true);

const canSweepSrc = contentJs.slice(contentJs.indexOf('_canSweep(element) {'), contentJs.indexOf('_hasOwnMask(element) {'));
check('_canSweep skips elements that have their own mask', canSweepSrc.includes('this._hasOwnMask(element)'), true);
check('_hasOwnMask reads maskImage and webkitMaskImage', /maskImage[^;]*webkitMaskImage|webkitMaskImage[^;]*maskImage/.test(contentJs.slice(contentJs.indexOf('_hasOwnMask(element) {'))), true);
check('_beginRestoreSweeps skips elements that have their own mask', contentJs.includes('this._hasOwnMask(el)'), true);

/* ─── 8. Layout X-Ray ────────────────────────────────────── */
console.log('modes/xray.js — pure helpers and wiring');
const X = require(path.join(ROOT, 'modes/xray.js'));

[
  ['flex', 'flex'], ['inline-flex', 'flex'], ['grid', 'grid'], ['inline-grid', 'grid'],
  ['block', 'block'], ['flow-root', 'block'], ['list-item', 'block'],
  ['inline-block', 'inline-block'], ['inline', 'other'], ['table', 'other'],
  ['contents', 'other'], ['', 'other'], [null, 'other'], ['  FLEX ', 'flex']
].forEach(([display, kind]) => check(`xrayKind(${JSON.stringify(display)})`, X.PE_xrayKind(display), kind));

check('xrayPx reads px and nothing else',
  [X.PE_xrayPx('12px'), X.PE_xrayPx('-3.5px'), X.PE_xrayPx('normal'), X.PE_xrayPx('10%'), X.PE_xrayPx(''), X.PE_xrayPx(null)],
  [12, -3.5, 0, 0, 0, 0]);

check('parseTracks: resolved px, line names ignored', X.PE_xrayParseTracks('[a] 100px [b] 200.5px'), [100, 200.5]);
check('parseTracks: unresolved values give no tracks',
  [X.PE_xrayParseTracks('1fr 1fr'), X.PE_xrayParseTracks('100px 50%'), X.PE_xrayParseTracks('none'),
   X.PE_xrayParseTracks('subgrid'), X.PE_xrayParseTracks('')], [[], [], [], [], []]);

check('gapPositions: both edges when wide, the middle when narrow',
  [X.PE_xrayGapPositions(100, 16), X.PE_xrayGapPositions(100, 4)], [[100, 116], [102]]);

// Grid: 3 columns with a narrow column gap, 2 rows with a wide row gap.
const gridBox = { left: 10, top: 20, width: 310, height: 100 };
check('grid gap lines', X.PE_xrayGridGapLines(gridBox, [100, 100, 100], [50, 50], 5, 10), [
  { x1: 112.5, y1: 20, x2: 112.5, y2: 120 },
  { x1: 217.5, y1: 20, x2: 217.5, y2: 120 },
  { x1: 10, y1: 70, x2: 320, y2: 70 },
  { x1: 10, y1: 80, x2: 320, y2: 80 }
]);
check('grid without gaps or a single track draws nothing',
  [X.PE_xrayGridGapLines(gridBox, [100, 100], [50], 0, 0), X.PE_xrayGridGapLines(gridBox, [310], [100], 8, 8)], [[], []]);

const flexBox = { left: 0, top: 0, width: 300, height: 50 };
const a = { left: 0, top: 0, right: 100, bottom: 50 };
const b = { left: 116, top: 0, right: 216, bottom: 50 };
check('flex row: a gap that matches the declared size is drawn',
  X.PE_xrayFlexGapLines(flexBox, 'row', [a, b], 16, 0),
  [{ x1: 100, y1: 0, x2: 100, y2: 50 }, { x1: 116, y1: 0, x2: 116, y2: 50 }]);
check('flex row: spacing that is not the gap (margins, justify-content) is not drawn',
  X.PE_xrayFlexGapLines(flexBox, 'row', [a, { left: 140, top: 0, right: 240, bottom: 50 }], 16, 0), []);
check('flex row-reverse: the children are in reverse visual order',
  X.PE_xrayFlexGapLines(flexBox, 'row-reverse', [b, a], 16, 0),
  [{ x1: 100, y1: 0, x2: 100, y2: 50 }, { x1: 116, y1: 0, x2: 116, y2: 50 }]);
check('flex column: row gap between stacked children',
  X.PE_xrayFlexGapLines({ left: 0, top: 0, width: 100, height: 200 }, 'column',
    [{ left: 0, top: 0, right: 100, bottom: 40 }, { left: 0, top: 48, right: 100, bottom: 88 }], 0, 8),
  [{ x1: 0, y1: 40, x2: 100, y2: 40 }, { x1: 0, y1: 48, x2: 100, y2: 48 }]);
check('flex wrap: the gap between two lines spans the container',
  X.PE_xrayFlexGapLines({ left: 0, top: 0, width: 300, height: 100 }, 'row',
    [{ left: 0, top: 0, right: 100, bottom: 40 }, { left: 0, top: 46, right: 100, bottom: 86 }], 10, 6),
  [{ x1: 0, y1: 40, x2: 300, y2: 40 }, { x1: 0, y1: 46, x2: 300, y2: 46 }]);

check('label: grid with columns, rows and both gaps', X.PE_xrayLabelText({
  tag: 'DIV', id: 'hero', classes: ['card', 'wide'], width: 320.04, height: 180, display: 'grid',
  cols: 3, rows: 2, colGap: 16, rowGap: 8
}), 'div#hero.card.wide · 320 × 180 · grid · 3 cols · 2 rows · gap 8px 16px');
check('label: flex with one gap value', X.PE_xrayLabelText({
  tag: 'ul', id: '', classes: [], width: 100, height: 20.26, display: 'flex', cols: 0, rows: 0, colGap: 12, rowGap: 12
}), 'ul · 100 × 20.3 · flex · gap 12px');
check('label: plain block shows no gap or columns', X.PE_xrayLabelText({
  tag: 'p', classes: ['a', 'b', 'c', 'd'], width: 5, height: 5, display: 'block'
}), 'p.a.b.c · 5 × 5 · block');
check('label: a very long name is cut',
  X.PE_xrayLabelText({ tag: 'div', classes: ['x'.repeat(80)], width: 1, height: 1, display: 'block' }).split(' · ')[0].length, 48);

// Wiring
const xrayJs = read('modes/xray.js');
const bgJs = read('background.js');
check('manifest has the Alt+Shift+X command',
  manifest.commands['toggle-xray'] && manifest.commands['toggle-xray'].suggested_key.default, 'Alt+Shift+X');
check('background forwards the command and answers CAPTURE_TAB',
  ["'toggle-xray': 'TOGGLE_XRAY'", "'CAPTURE_TAB'", 'captureVisibleTab'].filter((s) => !bgJs.includes(s)), []);
check('content.js handles TOGGLE_XRAY, the fallback shortcut and Esc',
  ["case 'TOGGLE_XRAY'", "keyUpper === 'X'", "this.modes.isActive('xray')"].filter((s) => !contentJs.includes(s)), []);
check('X-Ray never talks to a server or the downloads API',
  /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|chrome\.downloads|https?:\/\//.test(xrayJs), false);
check('X-Ray does not touch the page elements it measures',
  /\.(classList\.(add|remove|toggle)|setAttribute|removeAttribute)\(|\.style\.[a-zA-Z]+\s*=/.test(
    // only the lines that work on the measured elements, not our own nodes
    xrayJs.split('\n').filter((l) => /(?:^|[^a-zA-Z])(el|child|target|hovered)\.(classList|setAttribute|removeAttribute|style)/.test(l)).join('\n')
  ), false);
check('X-Ray adds no new permission', manifest.permissions.slice().sort(), ['activeTab', 'contextMenus', 'storage']);

// The chip colours in content.css are the same ones the canvas draws with.
const missingColors = Object.entries(X.PE_XRAY_COLORS)
  .filter(([kind, hex]) => kind !== 'other' && !contentCss.toLowerCase().includes(hex.toLowerCase()))
  .map(([kind]) => kind);
check('legend colours in content.css match PE_XRAY_COLORS', missingColors, []);
check('X-Ray default depth is 4 and the slider range is 1-10', [X.PE_XRAY_DEFAULT_DEPTH, X.PE_XRAY_MAX_DEPTH], [4, 10]);

check('xray: near zone covers the viewport and one viewport of scroll in every direction', [
  X.PE_xrayInNearZone({ left: 0, top: 0, right: 10, bottom: 10 }, 1000, 800),
  X.PE_xrayInNearZone({ left: 0, top: 2399, right: 10, bottom: 2500 }, 1000, 800),
  X.PE_xrayInNearZone({ left: 0, top: 2401, right: 10, bottom: 2500 }, 1000, 800),
  X.PE_xrayInNearZone({ left: 0, top: -1700, right: 10, bottom: -1599 }, 1000, 800),
  X.PE_xrayInNearZone({ left: 0, top: -1800, right: 10, bottom: -1601 }, 1000, 800),
  X.PE_xrayInNearZone({ left: 3001, top: 0, right: 3100, bottom: 10 }, 1000, 800)
], [true, true, false, true, false, false]);
const xraySrc = read('modes/xray.js');
check('xray: toolbar is anchored by left (draggable on RTL pages)', /toolbar\.style\.setProperty\('right', 'auto', 'important'\)/.test(xraySrc), true);

/* ─── 9. Extract to Code ─────────────────────────────────── */
console.log('modes/extract-core.js — pure helpers');
const E = require(path.join(ROOT, 'modes/extract-core.js'));

// Test doubles for DOM nodes: just the properties the helpers read.
function fakeEl(tag, attrs, children, ns) {
  const kids = children || [];
  const node = {
    nodeType: 1,
    localName: tag,
    namespaceURI: ns,
    attributes: Object.entries(attrs || {}).map(([name, value]) => ({ name, value })),
    childNodes: kids,
    children: kids.filter((k) => k.nodeType === 1),
    parentElement: null
  };
  kids.forEach((k) => { if (k.nodeType === 1) k.parentElement = node; });
  return node;
}
const fakeText = (data) => ({ nodeType: 3, data });
const mapGetter = (obj) => (name) => obj[name];

// escaping
check('escapeText escapes & < > and non-breaking spaces',
  E.PE_extractEscapeText('a & b <i> ' + String.fromCharCode(160)), 'a &amp; b &lt;i&gt; &nbsp;');
check('escapeAttr escapes & and quotes', E.PE_extractEscapeAttr('say "hi" & go'), 'say &quot;hi&quot; &amp; go');

// which properties count
check('isInherited: text and font properties inherit, box properties do not',
  ['color', 'font-size', 'font-variant-caps', 'line-height', 'list-style-type', 'visibility', 'margin-top', 'display', 'text-decoration-line', 'background-color']
    .map(E.PE_extractIsInherited),
  [true, true, true, true, true, true, false, false, false, false]);
check('skipProp: vendor, animation, logical and size-dependent geometry are skipped',
  ['-webkit-font-smoothing', 'animation-name', 'margin-inline-start', 'inline-size', 'border-block-end-color', 'transform-origin', 'd', 'cx',
   '-webkit-line-clamp', 'margin-top', 'transition-duration', 'overflow-x', 'padding-left']
    .map(E.PE_extractSkipProp),
  [true, true, true, true, true, true, true, true, false, false, false, false, false]);

// diffing against the browser default and the parent
(function diffTests() {
  const names = ['color', 'font-weight', 'display', 'margin-top', 'width', 'height', 'border-top-color', 'border-top-style',
    'outline-color', 'outline-style', 'animation-name', 'margin-inline-start', '-webkit-font-smoothing'];
  const base = {
    color: 'rgb(51, 51, 51)', 'font-weight': '400', display: 'flex', 'margin-top': '8px', width: '300px', height: '40px',
    'border-top-color': 'rgb(51, 51, 51)', 'border-top-style': 'none', 'outline-color': 'rgb(51, 51, 51)', 'outline-style': 'none',
    'animation-name': 'spin', 'margin-inline-start': '4px', '-webkit-font-smoothing': 'auto'
  };
  const ref = { color: 'rgb(0, 0, 0)', 'font-weight': '400', display: 'block', 'margin-top': '0px', 'border-top-color': 'rgb(0, 0, 0)', 'border-top-style': 'none', 'outline-color': 'rgb(0, 0, 0)', 'outline-style': 'none' };
  const parentSame = { color: 'rgb(51, 51, 51)', 'font-weight': '400' };
  const names2 = (r) => r.map((d) => d[0]);

  check('child: inherits colour from its parent (not repeated), writes box properties that differ, drops width/height and noise',
    names2(E.PE_extractDiffStyles(names, mapGetter(base), mapGetter(ref), mapGetter(parentSame), { isRoot: false, keepSize: false })),
    ['display', 'margin-top']);
  check('child: a reset to the default is written when the parent differs',
    names2(E.PE_extractDiffStyles(['font-weight'], mapGetter({ 'font-weight': '400' }), mapGetter({ 'font-weight': '400' }), mapGetter({ 'font-weight': '700' }), { isRoot: false })),
    ['font-weight']);
  check('root: inherited properties are compared with the default, margins are dropped, size is kept on request',
    names2(E.PE_extractDiffStyles(names, mapGetter(base), mapGetter(ref), null, { isRoot: true, keepSize: true })),
    ['color', 'display', 'width', 'height']);
  check('colours that merely follow currentcolor are skipped until the border/outline is on',
    names2(E.PE_extractDiffStyles(['border-top-color', 'border-top-style'],
      mapGetter({ 'border-top-color': 'rgb(9, 9, 9)', 'border-top-style': 'solid' }), mapGetter({ 'border-top-color': 'rgb(0, 0, 0)', 'border-top-style': 'none' }), null, { isRoot: true })),
    ['border-top-color', 'border-top-style']);
})();

// shorthands
(function condenseTests() {
  const get = mapGetter({
    'margin-top': '8px', 'margin-right': '0px', 'margin-bottom': '8px', 'margin-left': '0px',
    'padding-top': '4px', 'padding-right': '4px', 'padding-bottom': '4px', 'padding-left': '4px',
    'border-top-style': 'solid', 'border-top-width': '1px', 'border-top-color': 'rgb(1, 2, 3)',
    'border-right-style': 'solid', 'border-right-width': '1px', 'border-right-color': 'rgb(1, 2, 3)',
    'border-bottom-style': 'solid', 'border-bottom-width': '1px', 'border-bottom-color': 'rgb(1, 2, 3)',
    'border-left-style': 'solid', 'border-left-width': '1px', 'border-left-color': 'rgb(1, 2, 3)',
    'border-top-left-radius': '6px', 'border-top-right-radius': '6px', 'border-bottom-right-radius': '6px', 'border-bottom-left-radius': '6px',
    'row-gap': '8px', 'column-gap': '16px', 'flex-grow': '1', 'flex-shrink': '0', 'flex-basis': '0%',
    'overflow-x': 'hidden', 'overflow-y': 'auto', color: 'rgb(1, 2, 3)'
  });
  const none = () => 'none';
  const decl = (...n) => n.map((x) => [x, get(x)]);

  check('margin and padding fold to 1-4 value shorthands',
    E.PE_extractCondense(decl('margin-top', 'padding-left', 'color'), get, none),
    [['margin', '8px 0px'], ['padding', '4px'], ['color', 'rgb(1, 2, 3)']]);
  check('border: four equal sides become one declaration',
    E.PE_extractCondense(decl('border-top-width'), get, none), [['border', '1px solid rgb(1, 2, 3)']]);
  check('border: a side that is off is left out when the default is off too',
    E.PE_extractCondense([['border-bottom-width', '1px']], mapGetter({
      'border-top-style': 'none', 'border-right-style': 'none', 'border-left-style': 'none',
      'border-bottom-style': 'solid', 'border-bottom-width': '1px', 'border-bottom-color': 'rgb(9, 9, 9)'
    }), () => 'none'), [['border-bottom', '1px solid rgb(9, 9, 9)']]);
  check('border: switching off a border the browser would draw (fieldset) is written',
    E.PE_extractCondense([['border-top-width', '0px']], mapGetter({
      'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none'
    }), () => 'groove'), [['border', 'none']]);
  check('border-radius folds, an elliptical corner stays as longhands',
    [E.PE_extractCondense(decl('border-top-left-radius'), get, none),
     E.PE_extractCondense([['border-top-left-radius', '8px 4px']], mapGetter({
       'border-top-left-radius': '8px 4px', 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px'
     }), none)],
    [[['border-radius', '6px']], [['border-top-left-radius', '8px 4px']]]);
  check('gap, flex and overflow fold',
    E.PE_extractCondense(decl('row-gap', 'flex-grow', 'overflow-x'), get, none),
    [['gap', '8px 16px'], ['flex', '1 0 0%'], ['overflow', 'hidden auto']]);
})();

check('buildCss writes one rule per element and skips empty ones',
  E.PE_extractBuildCss([
    { selector: '.pe-1', decls: [['display', 'flex'], ['gap', '8px']] },
    { selector: '.pe-2', decls: [] },
    { selector: '.pe-3::before', decls: [['content', '"x"']] }
  ]),
  '.pe-1 {\n  display: flex;\n  gap: 8px;\n}\n\n.pe-3::before {\n  content: "x";\n}');

// which elements, which attributes
(function htmlTests() {
  const img = fakeEl('img', { src: 'a.png', srcset: 'a.png 1x, b.png 2x', 'data-lazy': '1', onerror: 'x()' });
  const picture = fakeEl('picture', {}, [fakeEl('source', { srcset: 'a.webp' }), img]);
  const tree = fakeEl('div', { id: 'root', class: 'card' }, [
    fakeEl('script', {}, [fakeText('alert(1)')]),
    fakeEl('style', {}, [fakeText('.a{}')]),
    fakeEl('iframe', { src: 'https://x.test' }),
    fakeEl('p', {}, [fakeText('one')]),
    picture,
    fakeEl('p', {}, [fakeText('two')])
  ]);

  const all = E.PE_extractCollect(tree, 500);
  check('collect: script/style/iframe and <picture><source> are dropped, document order kept',
    all.list.map((n) => n.localName), ['div', 'p', 'picture', 'img', 'p']);
  check('collect: total counts everything kept', [all.total, all.truncated], [5, false]);
  const cut = E.PE_extractCollect(tree, 3);
  check('collect: a cap keeps a prefix of document order and reports the truncation',
    [cut.list.map((n) => n.localName), cut.total, cut.truncated], [['div', 'p', 'picture'], 5, true]);
  const svgNs = E.PE_EXTRACT_SVG_NS;
  check('collect: an SVG <title> is content, an SVG <script> is not',
    E.PE_extractCollect(fakeEl('svg', {}, [fakeEl('title', {}, [], svgNs), fakeEl('script', {}, [], svgNs), fakeEl('path', {}, [], svgNs)], svgNs), 500)
      .list.map((n) => n.localName), ['svg', 'title', 'path']);

  const refs = E.PE_extractReferencedIds([
    fakeEl('label', { for: 'email' }),
    fakeEl('input', { 'aria-describedby': 'hint err' }),
    fakeEl('a', { href: '#top%20x' }),
    fakeEl('rect', { fill: 'url(#grad)', 'clip-path': "url('#clip')" }),
    fakeEl('a', { href: 'https://x.test/#nope' })
  ]);
  check('referencedIds: label for, aria-*, in-page links and SVG url(#…)',
    Array.from(refs).sort(), ['clip', 'email', 'err', 'grad', 'hint', 'top x']);

  const attrs = E.PE_extractAttributes(
    fakeEl('div', { 'data-x': '1', onclick: 'go()', style: 'color:red', nonce: 'abc', id: 'gone', class: 'a b', title: 'hi', 'aria-hidden': 'true' }),
    { keepIds: new Set(['kept']), classTokens: ['a', 'b', 'pe-1'] });
  check('attributes: data-*, handlers, style, nonce and unreferenced ids go; class, title and aria stay',
    attrs, [['class', 'a b pe-1'], ['title', 'hi'], ['aria-hidden', 'true']]);
  check('attributes: a referenced id stays and comes first',
    E.PE_extractAttributes(fakeEl('input', { type: 'text', id: 'email', class: 'f' }), { keepIds: new Set(['email']), classTokens: ['f'] }),
    [['id', 'email'], ['class', 'f'], ['type', 'text']]);
  check('attributes: img uses its resolved source and loses srcset; links are made absolute',
    [E.PE_extractAttributes(img, { imgSrc: 'https://x.test/b.png' }),
     E.PE_extractAttributes(fakeEl('a', { href: '/p?x=1' }), { resolveUrl: (n, v) => 'https://x.test' + v })],
    [[['src', 'https://x.test/b.png']], [['href', 'https://x.test/p?x=1']]]);
  check('attributes: an <img> with no src gets one from currentSrc',
    E.PE_extractAttributes(fakeEl('img', { alt: 'x' }), { imgSrc: 'https://x.test/c.png' }), [['alt', 'x'], ['src', 'https://x.test/c.png']]);
  check('classTokens drops our animation classes and appends the generated one',
    E.PE_extractClassTokens('card pe-erasing  wide', 'pe-4'), ['card', 'wide', 'pe-4']);
  check('resolveUrl',
    ['/a.png', '#frag', 'javascript:alert(1)', 'mailto:a@b.c', 'data:image/gif;base64,AA', 'rel/x']
      .map((u) => E.PE_extractResolveUrl(u, 'https://site.test/dir/page')),
    ['https://site.test/a.png', '#frag', '#', 'mailto:a@b.c', 'data:image/gif;base64,AA', 'https://site.test/dir/rel/x']);
})();

// printing
(function serializeTests() {
  const display = { div: 'block', ul: 'block', li: 'list-item', span: 'inline', b: 'inline', button: 'inline-block', pre: 'block', p: 'block' };
  const make = (included) => ({
    included,
    attributes: (el) => el.attributes.map((a) => [a.name, a.value]),
    displayOf: (el) => display[el.localName] || 'block',
    preserves: (el) => el.localName === 'pre'
  });
  const run = (root) => {
    const inc = new Set();
    (function walk(n) { inc.add(n); n.children.forEach(walk); })(root);
    return E.PE_extractSerialize(root, make(inc));
  };

  check('serialize: block-level children go on their own indented lines',
    run(fakeEl('ul', { class: 'nav' }, [
      fakeText('\n  '), fakeEl('li', {}, [fakeText('Home')]), fakeText('\n  '), fakeEl('li', {}, [fakeText('About')]), fakeText('\n')
    ])),
    '<ul class="nav">\n  <li>Home</li>\n  <li>About</li>\n</ul>');
  check('serialize: text with inline children stays on one line, whitespace collapsed, edges trimmed',
    run(fakeEl('p', {}, [fakeText('\n  Hello  '), fakeEl('b', {}, [fakeText('big')]), fakeText('  world\n')])),
    '<p>Hello <b>big</b> world</p>');
  check('serialize: whitespace between inline elements is kept as one space (it is visible)',
    run(fakeEl('div', {}, [fakeEl('button', {}, [fakeText('A')]), fakeText('\n   '), fakeEl('button', {}, [fakeText('B')])])),
    '<div><button>A</button> <button>B</button></div>');
  check('serialize: the edge spaces of an inline element are kept',
    run(fakeEl('div', {}, [fakeText('x'), fakeEl('span', {}, [fakeText(' pad ')]), fakeText('y')])),
    '<div>x<span> pad </span>y</div>');
  check('serialize: void tags have no closing tag, empty elements close on the same line',
    run(fakeEl('div', {}, [fakeEl('hr', {}), fakeEl('div', {}, [])])),
    '<div>\n  <hr>\n  <div></div>\n</div>');
  check('serialize: <pre> keeps its text exactly',
    run(fakeEl('pre', {}, [fakeText('a\n  b')])), '<pre>a\n  b</pre>');
  check('serialize: text and attribute values are escaped',
    run(fakeEl('p', { title: 'a "b" & c' }, [fakeText('1 < 2 & 3')])),
    '<p title="a &quot;b&quot; &amp; c">1 &lt; 2 &amp; 3</p>');
  check('serialize: boolean attributes have no value',
    run(fakeEl('div', {}, [fakeEl('button', { disabled: '' }, [fakeText('x')])])),
    '<div><button disabled>x</button></div>');
  const keep = fakeEl('p', {}, [fakeText('keep')]);
  const dropped = fakeEl('p', {}, [fakeText('dropped')]);
  const root = fakeEl('div', {}, [keep, dropped]);
  check('serialize: an element outside the extract (cut off by the cap) is not printed',
    E.PE_extractSerialize(root, make(new Set([root, keep]))), '<div>\n  <p>keep</p>\n</div>');
  const svgNs = E.PE_EXTRACT_SVG_NS;
  const svg = fakeEl('svg', { viewBox: '0 0 10 10' }, [fakeEl('g', {}, [fakeEl('path', { d: 'M0 0' }, [], svgNs)], svgNs)], svgNs);
  check('serialize: SVG structure is indented and attribute case is kept',
    run(svg), '<svg viewBox="0 0 10 10">\n  <g>\n    <path d="M0 0"></path>\n  </g>\n</svg>');
})();

// colours
check('rgbToHex',
  ['rgb(26, 43, 60)', 'rgba(0, 0, 0, 0.5)', 'rgba(255, 0, 0, 1)', 'rgb(26 43 60 / 50%)', 'red', 'rgba(1,2,3,0)']
    .map(E.PE_extractRgbToHex),
  ['#1a2b3c', '#00000080', '#ff0000', '#1a2b3c80', null, '#01020300']);
check('collectColors: distinct, counted, most used first, transparent ignored', E.PE_extractCollectColors([
  'rgb(1, 1, 1)', '1px solid rgb(1, 1, 1)', 'rgb(2, 2, 2)', 'rgba(0, 0, 0, 0)', 'linear-gradient(rgb(2, 2, 2), rgba(9, 9, 9, 0.5))', 'none'
]), [{ hex: '#010101', count: 2 }, { hex: '#020202', count: 2 }, { hex: '#09090980', count: 1 }]);

// fonts
check('parseFontFamily handles quotes, commas inside quotes and generics',
  E.PE_extractParseFontFamily('Inter, "Helvetica Neue", \'Comma, Sans\', sans-serif'),
  ['Inter', 'Helvetica Neue', 'Comma, Sans', 'sans-serif']);
check('parseFontSrc finds urls and formats and makes them absolute',
  E.PE_extractParseFontSrc('url("/f/a.woff2") format("woff2"), url(b.ttf) format(\'truetype\'), local(Arial)', 'https://site.test/css/main.css'),
  [{ url: 'https://site.test/f/a.woff2', format: 'woff2' }, { url: 'https://site.test/css/b.ttf', format: 'truetype' }]);
check('tokensText: fonts as comments, colours as a :root block, notes last',
  E.PE_extractTokensText(
    [{ family: 'Inter', stack: 'Inter, sans-serif', count: 3, web: true, faces: [{ weight: '400', style: 'normal', status: 'loaded', urls: [{ url: 'https://x.test/i.woff2', format: 'woff2' }] }] },
     { family: 'sans-serif', stack: 'sans-serif', count: 1, web: false, faces: [] }],
    [{ hex: '#111111', count: 4 }], ['a note']),
  ['/* Fonts */', '/* Inter, sans-serif — 3 elements */', '/*   Inter 400 normal · loaded */', '/*   https://x.test/i.woff2 (woff2) */',
   '/* sans-serif — 1 element */', '/*   no @font-face found: a system or generic font */', '',
   '/* Colors */', ':root {', '  --pe-color-1: #111111; /* 4× */', '}', '', '/* a note */'].join('\n'));
check('wrapDocument builds a standalone file and cannot be broken out of by </style>',
  (() => {
    const doc = E.PE_extractWrapDocument('A & B', '<p class="pe-1">x</p>', '.pe-1{content:"</style>"}');
    return [doc.startsWith('<!DOCTYPE html>'), doc.includes('<title>A &amp; B</title>'), doc.includes('<body>\n<p class="pe-1">x</p>\n</body>'),
            (doc.match(/<\/style>/g) || []).length];
  })(), [true, true, true, 1]);

// highlighting
(function highlightTests() {
  const html = '<div class="a b" hidden>\n  <p title=\'x "y"\'>He said "hi" &amp; left</p><img src=a.png />\n</div>';
  const css = '/* c */\n.pe-1 {\n  color: rgb(1, 2, 3);\n  --x: #fff;\n  content: "a;b";\n  margin: -4px 0 1.5em;\n}\n.pe-1::before { content: "}" }';
  const join = (tokens) => tokens.map((t) => t.s).join('');
  check('highlightHtml is lossless', join(E.PE_highlightHtml(html)), html);
  check('highlightCss is lossless', join(E.PE_highlightCss(css)), css);
  const kinds = (tokens, want) => tokens.filter((t) => t.t === want).map((t) => t.s);
  const h = E.PE_highlightHtml(html);
  check('highlightHtml: tags, attributes and quoted values',
    [kinds(h, 'tag'), kinds(h, 'attr'), kinds(h, 'string')],
    [['div', 'p', 'p', 'img', 'div'], ['class', 'hidden', 'title', 'src'], ['"a b"', '\'x "y"\'', 'a.png']]);
  check('highlightHtml: quotes in text content are plain text', h.some((t) => t.t !== 'text' && t.s.indexOf('said') >= 0), false);
  const c = E.PE_highlightCss(css);
  check('highlightCss: selectors, properties, custom properties, colours, numbers, strings, comments',
    [kinds(c, 'selector').map((s) => s.trim()), kinds(c, 'prop'), kinds(c, 'var'), kinds(c, 'color'), kinds(c, 'string'), kinds(c, 'comment'), kinds(c, 'func'), kinds(c, 'number')],
    [['.pe-1', '.pe-1::before'], ['color', 'content', 'margin', 'content'], ['--x'], ['#fff'], ['"a;b"', '"}"'], ['/* c */'], ['rgb'], ['1', '2', '3', '-4px', '0', '1.5em']]);
  check('highlighters survive broken input without hanging or losing text',
    ['<', '<a', '<a href="x', '<a b=', '</', '<!-- x'].map((s) => join(E.PE_highlightHtml(s)) === s)
      .concat(['{', '.a {', '.a { color:', '.a { color: "x', '/* open', '}}'].map((s) => join(E.PE_highlightCss(s)) === s)),
    new Array(12).fill(true));
})();

check('diff: colour longhands that only resolve currentcolor (row-rule, text-stroke) are not written without a rule or stroke',
  E.PE_extractDiffStyles(['row-rule-color', 'row-rule-style', '-webkit-text-stroke-color', '-webkit-text-stroke-width'],
    mapGetter({ 'row-rule-color': 'rgb(170, 0, 0)', 'row-rule-style': 'none', '-webkit-text-stroke-color': 'rgb(170, 0, 0)', '-webkit-text-stroke-width': '0px' }),
    mapGetter({ 'row-rule-color': 'rgb(0, 0, 0)', 'row-rule-style': 'none', '-webkit-text-stroke-color': 'rgb(0, 0, 0)', '-webkit-text-stroke-width': '0px' }),
    null, { isRoot: true, keepSize: true }), []);
// wiring
const extractJs = read('modes/extract.js');
const extractCoreJs = read('modes/extract-core.js');
check('manifest has the Alt+Shift+C command, background forwards it, content.js handles it',
  [!!manifest.commands['toggle-extract'] && !manifest.commands['toggle-extract'].suggested_key,
   bgJs.includes("'toggle-extract': 'TOGGLE_EXTRACT'"), contentJs.includes("case 'TOGGLE_EXTRACT'"),
   contentJs.includes("keyUpper === 'C' && e.altKey"), contentJs.includes("modes.register('extract'")],
  [true, true, true, true, true]);
check('manifest: at most 4 commands carry a suggested_key (Chrome refuses to load the extension otherwise)',
  Object.values(manifest.commands).filter((c) => c.suggested_key).length <= 4, true);
check('extractFrom hides the pickers own body cursor while measuring and puts it back',
  /removeProperty\('cursor'\);[\s\S]*?PE_extractRun\(el[\s\S]*?finally \{\s*if \(cursor\) body\.style\.setProperty\('cursor'/.test(extractJs), true);
check('extract exit() removes the empty style attribute the cursor reset leaves on <body>',
  /getAttribute\('style'\) === ''\) document\.body\.removeAttribute\('style'\)/.test(extractJs), true);
check('diff: an inherited value equal to the parent is still written when the browser has its own rule for the tag (a:any-link colour)',
  E.PE_extractDiffStyles(['color'], mapGetter({ color: 'rgb(255, 255, 255)' }), mapGetter({ color: 'rgb(0, 0, 238)' }),
    mapGetter({ color: 'rgb(255, 255, 255)' }), { isRoot: false, keepSize: false, base: mapGetter({ color: 'rgb(0, 0, 0)' }) }).map((d) => d[0]), ['color']);
check('diff: ...but not when the tag has no rule of its own (ref equals the div baseline)',
  E.PE_extractDiffStyles(['color'], mapGetter({ color: 'rgb(255, 255, 255)' }), mapGetter({ color: 'rgb(0, 0, 0)' }),
    mapGetter({ color: 'rgb(255, 255, 255)' }), { isRoot: false, keepSize: false, base: mapGetter({ color: 'rgb(0, 0, 0)' }) }), []);
check('logical corner radii (border-end-end-radius…) are not written next to border-radius',
  [E.PE_extractSkipProp('border-end-end-radius'), E.PE_extractSkipProp('border-start-start-radius'), E.PE_extractSkipProp('border-top-left-radius')], [true, true, false]);
check('extract.js: link probes get an href, buttons and shrink-wrapped / empty / flex-grid-item boxes keep their size',
  [extractJs.includes("probe.setAttribute('href', '#')"), /PE_EXTRACT_REPLACED = new Set\(\[[^\]]*'button'/.test(extractJs),
   extractJs.includes('!hasContent || PE_EXTRACT_SHRINK_DISPLAYS.has(cs.display)'), extractJs.includes('PE_EXTRACT_ITEM_PARENTS.test(parentCs.display)')],
  [true, true, true, true]);
check('copy asks the permissions policy before navigator.clipboard (no violation noise in the page console)',
  extractJs.includes("policy.allowsFeature('clipboard-write')"), true);
check('Extract never talks to a server or the downloads API and adds no permission',
  [/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|chrome\.downloads|chrome\.runtime|chrome\.storage/.test(extractJs + extractCoreJs),
   manifest.permissions.slice().sort()],
  [false, ['activeTab', 'contextMenus', 'storage']]);
check('Extract puts page text on screen only through textContent: the single innerHTML is the static window template',
  [extractJs, extractCoreJs].map((src) =>
    (src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').match(/innerHTML/g) || []).length),
  [1, 0]);
check('Extract leaves the page\'s own elements alone (no writes to measured elements)',
  /\b(el|root|child|target)\.(setAttribute|removeAttribute|classList\.(add|remove|toggle))\(|\b(el|root|child)\.style\.[a-zA-Z]+\s*=/.test(
    extractJs.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')),
  false);
check('extract colours in content.css exist for the picker and the window',
  ['.pe-highlighter.pe-extract-mode', '.pe-extract-panel', '.pe-extract-code', '.pe-tok-tag'].filter((s) => !contentCss.includes(s)), []);

/* ─── 10. Visual Diff ────────────────────────────────────── */
console.log('modes/diff-core.js — pure helpers');
const D = require(path.join(ROOT, 'modes/diff-core.js'));

check('normalizeSettings: no input gives the defaults',
  D.PE_diffNormalizeSettings(undefined),
  { x: 0, y: 0, scale: 100, opacity: 50, scrollLock: true, invert: false, blend: false, split: false, threshold: 16 });
check('normalizeSettings: values are clamped, rounded and typed',
  D.PE_diffNormalizeSettings({ x: '12.6', y: -99999, scale: 999, opacity: -5, scrollLock: false, invert: true, blend: 'yes', split: 1, threshold: 500 }),
  { x: 13, y: -20000, scale: 200, opacity: 0, scrollLock: false, invert: true, blend: false, split: false, threshold: 128 });
check('normalizeSettings: junk falls back to the defaults',
  D.PE_diffNormalizeSettings({ x: 'abc', scale: null, opacity: NaN, scrollLock: 'no', threshold: undefined }),
  { x: 0, y: 0, scale: 50, opacity: 50, scrollLock: true, invert: false, blend: false, split: false, threshold: 16 });

check('imageProblem: type, size and dimensions',
  [D.PE_diffImageProblem({ type: 'image/png', size: 100 }),
   D.PE_diffImageProblem({ type: 'image/gif', size: 100 }),
   D.PE_diffImageProblem({ type: 'image/webp', size: 30 * 1024 * 1024 }),
   D.PE_diffImageProblem({ type: 'image/jpeg', size: 100, width: 1920, height: 1080 }),
   D.PE_diffImageProblem({ type: 'image/jpeg', size: 100, width: 20000, height: 100 }),
   D.PE_diffImageProblem({ type: 'image/jpeg', size: 100, width: 9000, height: 9000 }),
   D.PE_diffImageProblem({ type: 'image/png', size: 100, width: 0, height: 10 })],
  [null, 'type', 'size', null, 'dimensions', 'dimensions', 'dimensions']);

check('parseDataUrl decodes base64 and rejects anything else',
  [JSON.stringify(Array.from(D.PE_diffParseDataUrl('data:image/png;base64,AAEC').bytes)), D.PE_diffParseDataUrl('data:image/png;base64,AAEC').mime,
   D.PE_diffParseDataUrl('http://x.test/a.png'), D.PE_diffParseDataUrl('data:text/plain,hello')],
  ['[0,1,2]', 'image/png', null, null]);

check('nudge: arrows move 1 px, Shift moves 10, other keys do nothing',
  [D.PE_diffNudge('ArrowLeft', false), D.PE_diffNudge('ArrowDown', true), D.PE_diffNudge('ArrowUp', false), D.PE_diffNudge('a', false)],
  [{ dx: -1, dy: 0 }, { dx: 0, dy: 10 }, { dx: 0, dy: -1 }, null]);

check('splitInset: how much of the design is cut on the right',
  [D.PE_diffSplitInset(100, 400, 300), D.PE_diffSplitInset(100, 400, 50), D.PE_diffSplitInset(100, 400, 900)],
  [200, 400, 0]);

// comparison
(function compareTests() {
  const w = 4, h = 2;
  const page = new Uint8ClampedArray(w * h * 4).fill(100);
  const design = new Uint8ClampedArray(w * h * 4).fill(100);
  for (let p = 0; p < w * h; p++) design[p * 4 + 3] = 255;
  design[0] = 117;            // pixel 0: red is 17 away  -> differs at threshold 16
  design[4 + 1] = 116;        // pixel 1: green is 16 away -> does not (not above)
  design[2 * 4 + 2] = 40;     // pixel 2: blue is 60 away  -> differs
  design[3 * 4 + 3] = 0;      // pixel 3: the design does not cover it
  design[4 * 4 + 3] = 127;    // pixel 4: barely transparent -> not covered

  const r = D.PE_diffCompare(page, design, w, h, 16);
  check('compare: strictly above the threshold per channel, uncovered pixels ignored',
    [r.compared, r.different, Array.from(r.mask).join('')], [6, 2, '10100000']);
  check('compare: percentage of the compared pixels', Math.round(r.percent * 100) / 100, 33.33);
  check('compare: a stricter threshold finds more, a looser one less',
    [D.PE_diffCompare(page, design, w, h, 0).different, D.PE_diffCompare(page, design, w, h, 100).different], [3, 0]);
  check('compare: nothing covered means nothing compared',
    [D.PE_diffCompare(page, new Uint8ClampedArray(w * h * 4), w, h, 16).compared, D.PE_diffCompare(page, new Uint8ClampedArray(w * h * 4), w, h, 16).percent], [0, 0]);
})();

// comparison with a pixel of tolerance (fractional display scales)
(function toleranceTests() {
  const w = 8, h = 1;
  const gray = (vals, alphas) => {
    const a = new Uint8ClampedArray(w * 4);
    for (let x = 0; x < w; x++) { a[x * 4] = a[x * 4 + 1] = a[x * 4 + 2] = vals[x]; a[x * 4 + 3] = alphas ? alphas[x] : 255; }
    return a;
  };
  const design = gray([0, 0, 0, 0, 255, 255, 255, 255]);          // an edge at x = 4
  const edgeAt = (n) => gray(Array.from({ length: w }, (_, x) => (x < n ? 0 : 255)));
  const diff = (page, d, r) => { const c = D.PE_diffCompare(page, d, w, h, 16, r); return [c.different, Array.from(c.mask).join('')]; };

  check('tolerance: radius 0 (and no radius at all) is the exact comparison',
    [diff(edgeAt(5), design, 0), diff(edgeAt(5), design, undefined)], [[1, '00001000'], [1, '00001000']]);
  check('tolerance: an edge one pixel off is forgiven at radius 1', diff(edgeAt(5), design, 1), [0, '00000000']);
  check('tolerance: a shift of three pixels is not hidden; only the pixel next to the right value is forgiven',
    [diff(edgeAt(7), design, 0)[0], diff(edgeAt(7), design, 1)], [3, [2, '00000110']]);
  check('tolerance: a flat area that is simply the wrong colour is still different',
    D.PE_diffCompare(gray(Array(w).fill(100)), gray(Array(w).fill(200)), w, h, 16, 1).different, 8);

  // The pixel that would match is one the design does not cover: it must not be used.
  const holes = gray([255, 255, 255, 0, 255, 255, 255, 255], [255, 255, 255, 0, 255, 255, 255, 255]);
  const zeros = gray(Array(w).fill(0));
  const noHole = D.PE_diffCompare(zeros, holes, w, h, 16, 1);
  check('tolerance: design pixels that are not covered are not used as a match', [noHole.compared, noHole.different], [7, 7]);
  const covered = gray([255, 255, 255, 0, 255, 255, 255, 255]);
  const withHole = D.PE_diffCompare(zeros, covered, w, h, 16, 1);
  check('tolerance: the same pixel, covered, forgives its two neighbours (and matches itself)',
    [withHole.compared, withHole.different, Array.from(withHole.mask).join('')], [8, 5, '11000111']);
  check('tolerance: near-matching stays inside the image',
    [D.PE_diffNearMatch(zeros, design, w, h, 0, 0, 1, 16), D.PE_diffNearMatch(zeros, design, w, h, 7, 0, 1, 16)], [true, false]);
})();

// regions
(function regionTests() {
  const w = 64, h = 32;
  const mask = new Uint8Array(w * h);
  const fill = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = 1; };
  fill(0, 0, 8, 8);          // one cell
  fill(24, 0, 32, 8);        // another, not touching
  fill(8, 8, 16, 16);        // touches the first diagonally -> same region
  fill(40, 20, 41, 21);      // a single stray pixel: noise
  const r = D.PE_diffRegions(mask, w, h);
  check('regions: touching cells (diagonals too) are one region, a stray pixel is none',
    [r.count, r.boxes.length], [2, 2]);
  check('regions: bounding boxes in px',
    r.boxes.map((b) => [b.x, b.y, b.w, b.h]).sort(), [[0, 0, 16, 16], [24, 0, 8, 8]].sort());
  check('regions: an empty mask has none', D.PE_diffRegions(new Uint8Array(w * h), w, h).count, 0);
  check('regions: a size that is not a multiple of the cell still works',
    D.PE_diffRegions((() => { const m = new Uint8Array(10 * 10); m.fill(1); return m; })(), 10, 10).boxes, [{ x: 0, y: 0, w: 10, h: 10 }]);
})();

check('heatPixels: translucent red where the mask is set',
  Array.from(D.PE_diffHeatPixels(new Uint8Array([1, 0]), 2, 1)), [255, 0, 0, 140, 0, 0, 0, 0]);

// wiring
const diffJs = read('modes/diff.js');
const diffCoreJs = read('modes/diff-core.js');
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('manifest has the toggle-diff command with no default key (all four are taken); background and content.js handle it',
  [!!manifest.commands['toggle-diff'] && !manifest.commands['toggle-diff'].suggested_key,
   bgJs.includes("'toggle-diff': 'TOGGLE_DIFF'"), contentJs.includes("case 'TOGGLE_DIFF'"),
   contentJs.includes("keyUpper === 'V' && e.altKey"), contentJs.includes("modes.register('diff'")],
  [true, true, true, true, true]);
check('Visual Diff never talks to a server or the downloads API and adds no permission',
  [/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|chrome\.downloads|chrome\.runtime|chrome\.storage/.test(codeOnly(diffJs + diffCoreJs)),
   manifest.permissions.slice().sort()],
  [false, ['activeTab', 'contextMenus', 'storage']]);
check('the design is drawn from a decoded bitmap on a canvas, never an <img> the page\'s CSP could block',
  [/new Image\(|createElement\('img'\)|<img/.test(codeOnly(diffJs)), codeOnly(diffJs).includes('createImageBitmap')], [false, true]);
check('Visual Diff: one innerHTML (the static toolbar), the privacy line is in the toolbar, storage is capped at 5 MB',
  [(codeOnly(diffJs).match(/innerHTML/g) || []).length, diffJs.includes('${t.local}'), D.PE_DIFF_MAX_STORED_CHARS], [2, true, 5 * 1024 * 1024]);
check('Visual Diff colours and layers exist in content.css',
  ['.pe-diff-layer', '.pe-diff-heat', '.pe-diff-divider', '.pe-diff-toolbar', '.pe-diff-drop'].filter((s) => !contentCss.includes(s)), []);
check('a failed storage write (quota) must not be treated as a lost extension',
  (contentJs.match(/if \(!isContextAlive\(\)\) noteContextLost\(\);/g) || []).length, 3);
check('Compare keeps every extension overlay out of the capture: layers, toolbar, toast container and Clippy are hidden',
  [diffJs.includes('[layer, heat, divider, toolbar, '), diffJs.includes("getElementById('pe-toast-container')"), diffJs.includes("getElementById('pe-clippy-buddy')")], [true, true, true]);
(function untrustedInputTests() {
  // Events a page script dispatches itself (isTrusted === false) must not drive the modes.
  const page = freshPage(); const calls = [];
  const mm = new PE_ModeManager().register('m', { enter() {}, exit() {}, onClick: (e) => calls.push('click'), onModifier: () => calls.push('mod'), onPointerMove: () => calls.push('move') });
  mm.activate('m');
  page.win.fire('click', { isTrusted: false }); page.win.fire('keydown', { isTrusted: false }); page.doc.fire('mousemove', { isTrusted: false, target: {}, clientX: 1, clientY: 1 }); flushFrames();
  const forged = calls.slice();
  page.win.fire('click', { isTrusted: true }); page.win.fire('keydown', { isTrusted: true }); page.doc.fire('mousemove', { isTrusted: true, target: {}, clientX: 1, clientY: 1 }); flushFrames();
  check('mode manager: page-made click/keydown/mousemove (isTrusted false) never reach the mode; real ones do', [forged, calls.slice(forged.length).sort()], [[], ['click', 'mod', 'move']]);
  mm.deactivate();
})();
check('shortcuts (incl. Ctrl+Z and Alt+Shift+D, which deletes the site\'s rules) and the Diff paste/drop ignore isTrusted === false events',
  [/document\.addEventListener\('keydown', \(e\) => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(e\.isTrusted === false\) return;/.test(contentJs), /function onPaste\(e\) \{\s*if \(e\.isTrusted === false\) return;/.test(diffJs), /e\.isTrusted === false \|\| !overDrop\(e\)/.test(diffJs)], [true, true, true]);
check('Compare takes the design and the heat map out of layout (display:none) for the capture, not just visibility:hidden, and puts their display back afterwards',
  [diffJs.includes('const inLayout = [layer, heat];'), diffJs.includes("n.style.setProperty('display', 'none', 'important')"),
   diffJs.includes("n.style.removeProperty('display');"), diffJs.includes('if (displays[i]) n.style.display = displays[i];')], [true, true, true, true]);
check('paste, drag-over and drop are listened for on window in the capture phase, so a page that stops them on its own capture listener cannot block them',
  [diffJs.includes("listen(window, 'paste', onPaste, true)"), diffJs.includes("listen(window, 'drop'"), diffJs.includes("listen(window, 'dragover'"),
   /listen\(document, 'paste'/.test(diffJs), /ui\.drop\.addEventListener\('drop'/.test(diffJs)], [true, true, true, false, false]);

// Content scripts share one global scope. A second top-level const/class/function
// with the same name in another file is a SyntaxError that stops the whole
// script from loading — on every page.
(function globalNameTests() {
  const seen = new Map();
  const dupes = [];
  for (const file of csJs.filter((f) => f !== 'content.js')) {
    for (const m of read(file).matchAll(/^(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1])) dupes.push(`${m[1]} (${seen.get(m[1])} and ${file})`);
      else seen.set(m[1], file);
    }
  }
  check('no two content-script files declare the same top-level name', dupes, []);
})();

/* ─── Review fixes: tolerance wiring, synthetic clicks, popup notice ─── */
console.log('release-candidate fixes');
(function rcFixTests() {
  check('Compare snaps the design to device pixels, forgives 1 px only when the scale is fractional, and says so',
    [diffJs.includes('Number.isInteger(sx) && Number.isInteger(sy) ? 0 : 1'),
     diffJs.includes('Math.round(rect.left * sx)'), diffJs.includes('Math.round((rect.left + rect.width) * sx) - dx'),
     diffJs.includes('designCtx.drawImage(image.bitmap, dx, dy, dw, dh)'),
     diffJs.includes('settings.threshold, radius)'),
     (diffJs.match(/tolerance: '/g) || []).length, diffJs.includes('${summary} · ${t.tolerance}')],
    [true, true, true, true, true, 2, true]);
  check('Compare, Clear, Remove image and X-Ray Capture ignore clicks the page made up',
    [/ui\.compare\.addEventListener\('click', \(e\) => \{ if \(e\.isTrusted !== false\) compare\(\); \}\)/.test(diffJs),
     /ui\.clear\.addEventListener\('click', \(e\) => \{ if \(e\.isTrusted !== false\) clearHeat\(false\); \}\)/.test(diffJs),
     /ui\.remove\.addEventListener\('click', \(e\) => \{ if \(e\.isTrusted !== false\) removeImage\(\); \}\)/.test(diffJs),
     /captureBtn\.addEventListener\('click', \(e\) => \{ if \(e\.isTrusted !== false\) capture\(\); \}\)/.test(xrayJs)],
    [true, true, true, true]);

  // content script: listening starts before the first storage round trip
  const initBody = ((/async _init\(\) \{([\s\S]*?)\n    \}\n/.exec(contentJs.replace(/\r/g, '')) || [])[1] || '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const firstAwait = initBody.indexOf('await ');
  check('content.js _init registers the message and shortcut listeners before its first await, once each',
    [initBody.length > 200, firstAwait > 0,
     initBody.indexOf('this._setupMessageListener()') >= 0 && initBody.indexOf('this._setupMessageListener()') < firstAwait,
     initBody.indexOf('this._setupKeyListeners()') >= 0 && initBody.indexOf('this._setupKeyListeners()') < firstAwait,
     (contentJs.match(/this\._setupMessageListener\(\)/g) || []).length, (contentJs.match(/this\._setupKeyListeners\(\)/g) || []).length],
    [true, true, true, true, 1, 1]);
  check('no shipped document links the repository name that returns 404; README and policy link the real one',
    [['README.md', 'privacy-policy.html', 'popup.html', 'CHANGELOG.md', 'docs/ARCHITECTURE.md'].filter((f) => /github\.com\/rildir\/PageEraser/i.test(read(f))),
     /github\.com\/rildir\/resize-extension\/issues/.test(read('privacy-policy.html')), /github\.com\/rildir\/resize-extension\/actions\/workflows\/ci\.yml/.test(read('README.md'))],
    [[], true, true]);

  // popup: a tab nothing answers on
  const popupSrc = read('popup.js').replace(/\r/g, '');
  const popupHtmlSrc = read('popup.html');
  const popupStyle = read('popup.css');
  check('popup.html has the notice element, hidden until needed and announced to screen readers; both languages have the text',
    [/<div class="reach-notice" id="reach-notice" role="alert" hidden><\/div>/.test(popupHtmlSrc), enKeys.has('reachNotice'), trKeys.has('reachNotice'),
     /\.reach-notice\[hidden\]\s*\{\s*display:\s*none/.test(popupStyle), /theme-high-contrast \.reach-notice/.test(popupStyle)],
    [true, true, true, true, true]);
  check('the popup lists every global shortcut the content script handles, and the policy page keeps its tables inside a narrow window',
    [['E', 'D', 'W', 'X', 'C', 'V'].filter((k) => !popupHtmlSrc.includes(`<span class="key-label">Alt+Shift+${k}</span>`)),
     /table\s*\{[^}]*table-layout:\s*fixed/.test(read('privacy-policy.html')), /th,\s*td\s*\{[^}]*overflow-wrap:\s*anywhere/.test(read('privacy-policy.html'))],
    [[], true, true]);
  check('every mode launcher goes through launchOnTab; none of them sends its start message directly any more',
    [(popupSrc.match(/await launchOnTab\(\{/g) || []).length,
     (popupSrc.match(/sendMessageToTab\(\{ type: '(?:START_SELECTION|START_PAINT|TOGGLE_XRAY|TOGGLE_EXTRACT|TOGGLE_DIFF)'/g) || []).length],
    [6, 0]);
  const grab = (name) => {
    const m = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`).exec(popupSrc);
    return m ? m[0] : '';
  };
  const tabChange = grab('handleActiveTabChange');
  check('the popup treats the Web Store pages as unreachable and clears the notice when the tab changes',
    [tabChange.includes('&& !isRestrictedPage(urlObj)'), tabChange.includes('hideReachNotice();'), tabChange.length > 200], [true, true, true]);
  const isRestricted = new Function(`${grab('isRestrictedPage')}\nreturn isRestrictedPage;`)();
  check('isRestrictedPage: the Chrome Web Store (both hosts) and Edge Add-ons, nothing that merely looks like them',
    ['https://chromewebstore.google.com/detail/x/abc', 'https://chrome.google.com/webstore/detail/x', 'https://microsoftedge.microsoft.com/addons/detail/x',
     'https://chrome.google.com/', 'https://example.com/webstore', 'https://notchromewebstore.google.com/', 'https://microsoftedge.microsoft.com/']
      .map((u) => isRestricted(new URL(u))),
    [true, true, true, false, false, false, false]);

  const launch = async (answer) => {
    const log = [];
    const fn = new Function('sendMessageToTab', 'showReachNotice', 'hideReachNotice', 'window', `${grab('launchOnTab')}\nreturn launchOnTab;`)(
      async () => answer, () => log.push('notice'), () => log.push('clear'), { close: () => log.push('close') });
    return [await fn({ type: 'TOGGLE_DIFF' }), log];
  };
  pending.push((async () => {
    check('launchOnTab: nothing answered -> the notice is shown and the popup stays open',
      await launch(null), [false, ['notice']]);
    check('launchOnTab: the page answered -> notice cleared, popup closes',
      await launch({ success: true }), [true, ['clear', 'close']]);
  })());
})();

/* ─── Result ─────────────────────────────────────────────── */
Promise.all(pending).then(() => {
  console.log('');
  if (failures === 0) {
    console.log(`All ${checks} checks passed.`);
    process.exit(0);
  } else {
    console.log(`${failures} of ${checks} checks FAILED.`);
    process.exit(1);
  }
});
