/**
 * PageEraser Chrome Extension — Shared Helpers
 *
 * Loaded by both the popup and the content script. Keeps the domain-scoping
 * rules and the selector validation in one place, so the two sides can never
 * disagree about which rules apply to a site.
 *
 * @version 1.6.1
 */

/* ─── Domain Scope ─────────────────────────────────────────
 * Collapses a hostname to its registrable domain when "Apply to Subdomains"
 * is on. Getting this wrong leaks rules between unrelated sites, so the two
 * failure modes are worth naming:
 *
 *   - Country second-level domains. `hepsiburada.com.tr` must collapse to
 *     itself, not to `com.tr` — otherwise one rule silently applies to every
 *     .com.tr site the user visits.
 *   - Shared hosting suffixes. `github.io`, `vercel.app` and friends hand out
 *     a subdomain per customer, so `alice.github.io` and `bob.github.io` are
 *     different owners and must never share a rule set.
 *
 * A full Public Suffix List is ~15k entries and would have to be kept current;
 * this is the pragmatic subset covering the suffixes real users browse. An
 * unlisted suffix degrades to the last two labels, which is the old behaviour.
 */
const PE_MULTI_PART_SUFFIXES = new Set([
  // Country-code second-level domains
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'bel.tr', 'av.tr', 'k12.tr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve',
  'co.za', 'org.za', 'co.nz', 'net.nz', 'org.nz',
  'co.kr', 'or.kr', 'com.sg', 'com.my', 'com.hk', 'com.tw',
  'com.es', 'com.pl', 'com.ua', 'com.ru', 'com.sa', 'com.eg',
  'co.il', 'com.ng', 'com.pk', 'com.bd', 'com.ph', 'com.vn',
  'co.id', 'or.id', 'com.gr', 'com.pt', 'com.ro',

  // Shared hosting suffixes: one subdomain per customer
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev',
  'vercel.app', 'netlify.app', 'netlify.com', 'herokuapp.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net',
  'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'myshopify.com',
  'squarespace.com', 'wixsite.com', 'weebly.com', 'glitch.me',
  'repl.co', 'replit.dev', 'ngrok.io', 'ngrok-free.app',
  'surge.sh', 'render.com', 'fly.dev', 'onrender.com'
]);

function PE_getBaseDomain(hostname) {
  if (typeof hostname !== 'string') return '';

  // Normalise: hosts are case-insensitive and may carry a trailing root dot.
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return '';

  // An IP address has no registrable parent — collapsing 192.168.1.5 to
  // "1.5" would be nonsense.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  if (host.includes(':')) return host; // IPv6 literal

  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');
  if (PE_MULTI_PART_SUFFIXES.has(lastTwo)) {
    // Keep one more label so the registrable domain survives.
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/* ─── Selector Validation ──────────────────────────────────
 * Every stored selector is interpolated into a stylesheet as `${sel} { … }`.
 * A selector containing `{`, `}`, `;`, `@` or a comment could close that block
 * early and append rules of its own — which matters because rules arrive from
 * an imported backup file and from the inline editor, not only from our own
 * element picker. Reject those, then let the CSS parser confirm the rest.
 */
const PE_SELECTOR_MAX_LENGTH = 2000;

function PE_isSafeSelector(sel) {
  if (typeof sel !== 'string') return false;
  const s = sel.trim();
  if (!s || s.length > PE_SELECTOR_MAX_LENGTH) return false;

  // Drop backslash escapes first. Our own picker runs class names through
  // CSS.escape(), which turns a Tailwind-style `@lg:flex` into `\@lg\:flex` —
  // an escaped literal that is harmless. Only an *unescaped* `@`, `;`, brace
  // or comment can terminate the `sel { … }` block we are about to build.
  const unescaped = s.replace(/\\./g, '');
  if (/[{};@]/.test(unescaped)) return false;
  if (unescaped.includes('/*') || unescaped.includes('*/')) return false;

  try {
    // Parses the selector without touching the live document.
    document.createDocumentFragment().querySelector(s);
    return true;
  } catch (err) {
    return false;
  }
}

/* ─── Rule Normalisation ───────────────────────────────────
 * Rules are stored either as a bare selector string (legacy) or as
 * { selector, action }. Normalise to the object form and drop anything
 * malformed or unsafe.
 *
 * A rule may also carry `permanent: true`: the user deleted it from the
 * Recycle Bin for good. It keeps hiding the element, but is no longer listed
 * for restoring and Ctrl+Z skips it. Restore All Layout still clears it.
 *
 * It may also carry `imported: true`: the rule came from someone else's code
 * (see PE_parseShare). The popup lists those under their own heading so they
 * can be kept or removed in one click. A rule of your own wins over an imported
 * copy of the same rule.
 */
function PE_normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Map();
  const out = [];
  for (const item of list) {
    const isString = typeof item === 'string';
    const selector = isString ? item : (item && item.selector);
    // Legacy entries are bare strings, and early object entries were written
    // without an action — both mean "hide".
    const action = (!isString && item && item.action === 'stretch') ? 'stretch' : 'hide';
    if (!PE_isSafeSelector(selector)) continue;
    const trimmed = selector.trim();
    const permanent = !isString && item && item.permanent === true;
    const imported = !isString && item && item.imported === true;
    const dedupeKey = `${action}::${trimmed}`;
    if (seen.has(dedupeKey)) {
      // The same rule twice: if either copy was deleted for good, it stays so;
      // if either copy is your own, the rule is yours, not an imported one.
      const kept = out[seen.get(dedupeKey)];
      if (permanent) kept.permanent = true;
      if (!imported) delete kept.imported;
      continue;
    }
    seen.set(dedupeKey, out.length);
    const rule = { selector: trimmed, action };
    if (permanent) rule.permanent = true;
    if (imported) rule.imported = true;
    out.push(rule);
  }
  return out;
}

/* A backup file comes from wherever the user got it. These caps keep a hostile
 * or broken one from freezing the popup and from bloating every page load. */
const PE_BACKUP_MAX_BYTES = 2 * 1024 * 1024;
const PE_BACKUP_MAX_RULES_PER_SITE = 5000;
const PE_BACKUP_MAX_RULES_TOTAL = 20000;

/* ─── Whole-page selectors ─────────────────────────────────
 * A shared code must not be able to blank a page. Listing the few exact forms
 * (`body`, `html`, `*` …) is not enough: `#a, body`, `:not(.x)`, `body *` or
 * `html:is(*)` all reach the same elements. So a selector is judged by what it
 * is built from: it is "too broad" when no part of it says anything specific
 * about an element: no id, class, attribute, or tag other than html, body and
 * head. Negations, :has() and the other pseudo-classes do not count as
 * specific, and neither does a :is() / :where() list with even one broad entry.
 * Every comma-separated part is judged on its own, escapes are decoded first
 * (`\62 ody` is `body`), and anything the reader cannot make sense of counts as
 * too broad. The content script repeats the check against the real page for
 * rules that are still marked imported (see _hidesWholePage), which also
 * covers what a reader of selector text can miss.
 */
const PE_BROAD_TAGS = new Set(['html', 'body', 'head']);
const PE_LIST_PSEUDOS = new Set(['is', 'where', 'matches', 'any', '-webkit-any', '-moz-any']);

/* Splits text where isSeparator(char) is true, but not inside (), [], quotes or
 * an escape (`\62 ` is one unit: hex digits plus the space that ends them). */
function PE_splitTopLevel(text, isSeparator) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      let end = i + 1;
      if (/[0-9a-fA-F]/.test(text[end] || '')) {
        let digits = 0;
        while (digits < 6 && /[0-9a-fA-F]/.test(text[end] || '')) { end++; digits++; }
        if (/\s/.test(text[end] || '')) end++;
      } else if (end < text.length) {
        end++;
      }
      current += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0 && isSeparator(ch)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/* Index of the ")" that closes the "(" at `open`, or text.length when unclosed. */
function PE_closingParen(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return text.length;
}

function PE_unescapeIdent(text) {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (match, hex, other) => {
    if (other !== undefined) return other;
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
  });
}

/* True when one compound selector (no combinators) names something specific. */
function PE_compoundIsSpecific(compound) {
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === '#' || ch === '.' || ch === '[') return true;
    if (ch === ':') {
      let j = i;
      while (compound[j] === ':') j++;
      const doubleColon = j - i > 1;
      let k = j;
      while (k < compound.length && !'(:#.['.includes(compound[k])) k += compound[k] === '\\' ? 2 : 1;
      const name = compound.slice(j, k).toLowerCase();
      let end = k;
      let args = null;
      if (compound[k] === '(') {
        const close = PE_closingParen(compound, k);
        args = compound.slice(k + 1, close);
        end = Math.min(close + 1, compound.length);
      }
      if (!doubleColon && args !== null && PE_LIST_PSEUDOS.has(name)) {
        const entries = PE_splitTopLevel(args, (c) => c === ',');
        if (entries.every((entry) => entry.trim() && !PE_partIsBroad(entry))) return true;
      }
      i = end > i ? end : i + 1;
      continue;
    }
    // A type selector, `*`, or `ns|name`, up to the next simple selector.
    let j = i;
    while (j < compound.length && !'#.[:'.includes(compound[j])) j += compound[j] === '\\' ? 2 : 1;
    const token = PE_unescapeIdent(compound.slice(i, j));
    const name = token.slice(token.lastIndexOf('|') + 1).toLowerCase();
    if (name && name !== '*' && !PE_BROAD_TAGS.has(name)) return true;
    i = j > i ? j : i + 1;
  }
  return false;
}

/* One complex selector (no top-level comma): broad when no compound in it,
 * ancestors included, is specific. `body *` and `html > body` are broad;
 * `.sidebar *` is not. */
function PE_partIsBroad(part) {
  const compounds = PE_splitTopLevel(part, (c) => /[\s>+~]/.test(c)).filter((c) => c.trim());
  if (compounds.length === 0) return true;
  return !compounds.some(PE_compoundIsSpecific);
}

function PE_isTooBroad(selector) {
  try {
    if (typeof selector !== 'string') return true;
    return PE_splitTopLevel(selector, (c) => c === ',').some((part) => PE_partIsBroad(part));
  } catch (err) {
    return true;
  }
}

/* ─── Rule Sharing Codes ───────────────────────────────────
 * "Copy Rules as Code" turns the rules of one site into a single line of text
 * that can be sent in a chat or an email; "Import from Code" reads it back.
 * Nothing here touches the network or any extension API: a code is only text
 * that moves through the clipboard.
 *
 *   pageeraser:1:<base64url of {"d":"example.com","r":[{"s":".ad"},{"s":".wide","a":"stretch"}]}>
 *
 * d = the site the rules belong to, r = the rules (a = "stretch"; hide when
 * left out). The "1" is the format version: a future format gets a new number
 * and an older extension says so instead of guessing.
 *
 * A code comes from someone else, so everything in it is checked the way an
 * imported backup file is (PE_isSafeSelector, PE_normalizeRules) and a little
 * more: selectors that would blank a whole page are left out, sizes are
 * capped, and every rule is marked `imported`.
 */
const PE_SHARE_PREFIX = 'pageeraser:1:';
const PE_SHARE_MAX_CHARS = 200000;
const PE_SHARE_MAX_RULES = 500;
// A code is not allowed to carry a rule that hides the whole page: see PE_isTooBroad.
// What chat apps put around a pasted code: quotes, brackets, a full stop.
const PE_SHARE_WRAP_START = new Set(['`', '"', "'", '\u201c', '\u201d', '\u2018', '\u2019', '<', '(', '[']);
const PE_SHARE_WRAP_END = new Set(['`', '"', "'", '\u201c', '\u201d', '\u2018', '\u2019', '>', ')', ']', '.', ',', ';', ':', '!']);

function PE_isValidHostname(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 253) return false;
  return name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function PE_b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Throws on anything that is not base64url of valid UTF-8. */
function PE_b64urlDecode(payload) {
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/* The code for a site's rules, or null when there is nothing to share, the
 * site name is not a hostname, or the rules do not fit in one code. */
function PE_buildShare(domain, rules) {
  const site = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  if (!PE_isValidHostname(site)) return null;
  const clean = PE_normalizeRules(rules);
  if (clean.length === 0 || clean.length > PE_SHARE_MAX_RULES) return null;
  const payload = {
    d: site,
    r: clean.map((rule) => (rule.action === 'stretch' ? { s: rule.selector, a: 'stretch' } : { s: rule.selector }))
  };
  const code = PE_SHARE_PREFIX + PE_b64urlEncode(JSON.stringify(payload));
  return code.length <= PE_SHARE_MAX_CHARS ? code : null;
}

/* Reads a pasted code. Returns { ok: true, domain, rules, skipped } — rules are
 * normalised and marked imported, skipped counts what was left out — or
 * { ok: false, reason } with reason one of: empty, size, format, version,
 * decode, domain, too-many, rules. */
function PE_parseShare(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'format' };
  // Room for the line breaks a chat app adds, but nothing like a pasted file:
  // this runs on every keystroke, on text somebody else wrote.
  if (text.length > PE_SHARE_MAX_CHARS * 2) return { ok: false, reason: 'size' };
  // Chat apps wrap long lines and put quotes or a full stop around what you copy.
  // Trimmed with loops, not a regex: a trailing-run pattern is quadratic on a
  // long run of such characters followed by something else.
  const flat = text.replace(/\s+/g, '');
  let from = 0;
  let to = flat.length;
  while (from < to && PE_SHARE_WRAP_START.has(flat[from])) from++;
  while (to > from && PE_SHARE_WRAP_END.has(flat[to - 1])) to--;
  const cleaned = flat.slice(from, to);
  if (!cleaned) return { ok: false, reason: 'empty' };
  if (cleaned.length > PE_SHARE_MAX_CHARS) return { ok: false, reason: 'size' };

  const head = /^pageeraser:(\d{1,3}):(.*)$/i.exec(cleaned);
  if (!head) return { ok: false, reason: 'format' };
  if (head[1] !== '1') return { ok: false, reason: 'version' };
  if (!/^[A-Za-z0-9_-]+$/.test(head[2])) return { ok: false, reason: 'decode' };

  let data;
  try {
    data = JSON.parse(PE_b64urlDecode(head[2]));
  } catch (err) {
    return { ok: false, reason: 'decode' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'decode' };

  const domain = typeof data.d === 'string' ? data.d.trim().toLowerCase() : '';
  if (!PE_isValidHostname(domain)) return { ok: false, reason: 'domain' };
  if (!Array.isArray(data.r)) return { ok: false, reason: 'rules' };
  if (data.r.length > PE_SHARE_MAX_RULES) return { ok: false, reason: 'too-many' };

  const candidates = [];
  for (const item of data.r) {
    if (!item || typeof item !== 'object' || typeof item.s !== 'string') continue;
    if (item.a !== undefined && item.a !== 'hide' && item.a !== 'stretch') continue;
    if (item.s.length > PE_SELECTOR_MAX_LENGTH * 2) continue; // before any pattern work on it
    const selector = item.s.trim();
    if (PE_isTooBroad(selector)) continue;
    candidates.push({ selector, action: item.a === 'stretch' ? 'stretch' : 'hide', imported: true });
  }
  const rules = PE_normalizeRules(candidates);
  if (rules.length === 0) return { ok: false, reason: 'rules' };
  return { ok: true, domain, rules, skipped: data.r.length - rules.length };
}
