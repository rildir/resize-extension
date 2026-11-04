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
    const dedupeKey = `${action}::${trimmed}`;
    if (seen.has(dedupeKey)) {
      // The same rule twice: if either copy was deleted for good, it stays so.
      if (permanent) out[seen.get(dedupeKey)].permanent = true;
      continue;
    }
    seen.set(dedupeKey, out.length);
    out.push(permanent ? { selector: trimmed, action, permanent: true } : { selector: trimmed, action });
  }
  return out;
}
