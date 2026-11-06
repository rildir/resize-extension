/**
 * PageEraser Chrome Extension — Visual Diff: pure helpers
 *
 * What modes/diff.js needs that does not touch the page: validating settings
 * and images, the arrow-key nudge, the before/after divider geometry, and the
 * pixel comparison itself — per-channel threshold, connected regions, and the
 * heat-map pixels. Everything works on plain numbers and typed arrays, so
 * tests/run.js can run it in Node.
 *
 * Loaded before modes/diff.js as a classic script — see manifest.json.
 */

const PE_DIFF_DEFAULTS = Object.freeze({
  x: 0,
  y: 0,
  scale: 100,
  opacity: 50,
  scrollLock: true,
  invert: false,
  blend: false,
  split: false,
  threshold: 16
});

// An image is remembered per site only while its data URL fits in 5 MB.
const PE_DIFF_MAX_STORED_CHARS = 5 * 1024 * 1024;
// Bigger files are refused outright: decoding them would stall the page.
const PE_DIFF_MAX_FILE_BYTES = 25 * 1024 * 1024;
const PE_DIFF_MAX_SIDE = 16384;
const PE_DIFF_MAX_PIXELS = 40 * 1000 * 1000;
const PE_DIFF_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function PE_diffNum(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/* Whatever was stored (or typed) → a complete, in-range settings object. */
function PE_diffNormalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = PE_DIFF_DEFAULTS;
  return {
    x: Math.round(PE_diffNum(r.x, -20000, 20000, d.x)),
    y: Math.round(PE_diffNum(r.y, -20000, 20000, d.y)),
    scale: Math.round(PE_diffNum(r.scale, 50, 200, d.scale)),
    opacity: Math.round(PE_diffNum(r.opacity, 0, 100, d.opacity)),
    scrollLock: typeof r.scrollLock === 'boolean' ? r.scrollLock : d.scrollLock,
    invert: r.invert === true,
    blend: r.blend === true,
    split: r.split === true,
    threshold: Math.round(PE_diffNum(r.threshold, 0, 128, d.threshold))
  };
}

/* Why an image cannot be used, or null if it can.
 * info: { type, size, width, height } — width/height may be omitted before decoding. */
function PE_diffImageProblem(info) {
  if (PE_DIFF_TYPES.indexOf(info.type) === -1) return 'type';
  if (info.size > PE_DIFF_MAX_FILE_BYTES) return 'size';
  if (info.width !== undefined && info.height !== undefined) {
    if (!(info.width > 0 && info.height > 0)) return 'dimensions';
    if (info.width > PE_DIFF_MAX_SIDE || info.height > PE_DIFF_MAX_SIDE) return 'dimensions';
    if (info.width * info.height > PE_DIFF_MAX_PIXELS) return 'dimensions';
  }
  return null;
}

/* 'data:image/png;base64,AAEC' → { mime, bytes } — null if it is not one. */
function PE_diffParseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,/.exec(String(dataUrl));
  if (!m) return null;
  const bin = atob(String(dataUrl).slice(m[0].length));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1], bytes };
}

/* The arrow keys move the design by 1 px, by 10 px with Shift. */
function PE_diffNudge(key, shift) {
  const step = shift ? 10 : 1;
  switch (key) {
    case 'ArrowLeft': return { dx: -step, dy: 0 };
    case 'ArrowRight': return { dx: step, dy: 0 };
    case 'ArrowUp': return { dx: 0, dy: -step };
    case 'ArrowDown': return { dx: 0, dy: step };
    default: return null;
  }
}

/* The design shows to the left of the divider and the live page to the right:
 * how many px to cut from the design's right edge (clip-path: inset(0 N 0 0)).
 * rectLeft/rectWidth are the design's box in the viewport. */
function PE_diffSplitInset(rectLeft, rectWidth, dividerX) {
  return Math.min(rectWidth, Math.max(0, rectLeft + rectWidth - dividerX));
}

/* Compare two same-size RGBA buffers (the page as captured, the design drawn
 * at its place on a canvas of the same size). Only pixels the design covers
 * (alpha ≥ 128) count; a pixel differs when any of R, G, B is further apart
 * than `threshold`.
 *
 * `radius` (default 0: exact) forgives a shift of up to that many px: a page
 * pixel that differs from the design pixel at the same place still counts as
 * equal when it matches one of the design pixels around it. That is for
 * captures that cannot be 1:1 with the layout (125 % / 150 % display scale,
 * where the browser snaps boxes to device pixels and the design is resampled
 * onto the same grid) and would otherwise show a ghost along every edge. */
function PE_diffCompare(page, design, w, h, threshold, radius) {
  const total = w * h;
  const mask = new Uint8Array(total);
  const r = radius > 0 ? Math.floor(radius) : 0;
  let compared = 0;
  let different = 0;
  const t = threshold;
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const i = p * 4;
      if (design[i + 3] < 128) continue;
      compared++;
      const dr = page[i] - design[i];
      const dg = page[i + 1] - design[i + 1];
      const db = page[i + 2] - design[i + 2];
      if (!(dr > t || dr < -t || dg > t || dg < -t || db > t || db < -t)) continue;
      if (r > 0 && PE_diffNearMatch(page, design, w, h, x, y, r, t)) continue;
      mask[p] = 1;
      different++;
    }
  }
  return { mask, compared, different, percent: compared ? (different * 100) / compared : 0 };
}

/* True when the page pixel at (x, y) is within `t` per channel of a design
 * pixel — one the design covers — at most `r` px away (not counting its own place). */
function PE_diffNearMatch(page, design, w, h, x, y, r, t) {
  const i = (y * w + x) * 4;
  const pr = page[i];
  const pg = page[i + 1];
  const pb = page[i + 2];
  for (let oy = -r; oy <= r; oy++) {
    const ny = y + oy;
    if (ny < 0 || ny >= h) continue;
    for (let ox = -r; ox <= r; ox++) {
      if (ox === 0 && oy === 0) continue;
      const nx = x + ox;
      if (nx < 0 || nx >= w) continue;
      const j = (ny * w + nx) * 4;
      if (design[j + 3] < 128) continue;
      const dr = pr - design[j];
      const dg = pg - design[j + 1];
      const db = pb - design[j + 2];
      if (dr <= t && dr >= -t && dg <= t && dg >= -t && db <= t && db >= -t) return true;
    }
  }
  return false;
}

/* Group differing pixels into regions. The mask is cut into block×block cells;
 * a cell counts when at least `minPixels` of its pixels differ (so one stray
 * pixel is noise, not a region); touching cells — diagonals too — form one
 * region. Returns { count, boxes } with up to 100 bounding boxes in px. */
function PE_diffRegions(mask, w, h, opts) {
  const o = opts || {};
  const B = o.block || 8;
  const minPixels = o.minPixels || 4;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const counts = new Uint16Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const row = ((y / B) | 0) * bw;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[base + x]) counts[row + ((x / B) | 0)]++;
    }
  }

  const seen = new Uint8Array(bw * bh);
  const boxes = [];
  let count = 0;
  const stack = [];
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || counts[start] < minPixels) continue;
    count++;
    let minX = bw, minY = bh, maxX = 0, maxY = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop();
      const cx = c % bw;
      const cy = (c / bw) | 0;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const n = ny * bw + nx;
          if (!seen[n] && counts[n] >= minPixels) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (boxes.length < 100) {
      boxes.push({
        x: minX * B,
        y: minY * B,
        w: Math.min(w, (maxX + 1) * B) - minX * B,
        h: Math.min(h, (maxY + 1) * B) - minY * B
      });
    }
  }
  return { count, boxes };
}

/* The heat map: translucent red where the mask is set, transparent elsewhere. */
function PE_diffHeatPixels(mask, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (mask[p]) {
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 140;
    }
  }
  return out;
}

// Lets tests/run.js load these in Node; a no-op inside the extension.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PE_DIFF_DEFAULTS, PE_DIFF_MAX_STORED_CHARS, PE_DIFF_MAX_FILE_BYTES,
    PE_DIFF_MAX_SIDE, PE_DIFF_MAX_PIXELS, PE_DIFF_TYPES,
    PE_diffNormalizeSettings, PE_diffImageProblem, PE_diffParseDataUrl,
    PE_diffNudge, PE_diffSplitInset, PE_diffCompare, PE_diffNearMatch, PE_diffRegions, PE_diffHeatPixels
  };
}
