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

/* ─── Result ─────────────────────────────────────────────── */
console.log('');
if (failures === 0) {
  console.log(`All ${checks} checks passed.`);
  process.exit(0);
} else {
  console.log(`${failures} of ${checks} checks FAILED.`);
  process.exit(1);
}
