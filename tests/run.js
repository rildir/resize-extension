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
  csJs, ['shared.js', 'modes/index.js', 'modes/erase.js', 'content.js']);

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

/* ─── Result ─────────────────────────────────────────────── */
console.log('');
if (failures === 0) {
  console.log(`All ${checks} checks passed.`);
  process.exit(0);
} else {
  console.log(`${failures} of ${checks} checks FAILED.`);
  process.exit(1);
}
