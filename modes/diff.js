/**
 * PageEraser Chrome Extension — Visual Diff Mode
 *
 * Lay a design image (a Figma export, a screenshot) over the live page, line
 * it up with opacity, offset and scale, and see where the two disagree:
 *
 *   - the overlay can be inverted or blended with `difference`, and a
 *     before/after divider shows the design on one side and the page on the other;
 *   - Compare captures the visible tab (with our own layers hidden), lays the
 *     design on the same pixel grid and marks every pixel that differs by more
 *     than a per-channel threshold as a translucent red heat map, with the
 *     percentage and the number of separate regions.
 *
 * The design is drawn on a <canvas> from a decoded bitmap, not shown through an
 * <img>: it never goes through the page's image-loading rules, so a strict
 * Content-Security-Policy cannot block it. It lives in memory and, per site, in
 * chrome.storage.local (at most 5 MB). It is never sent anywhere.
 *
 * Page elements are only measured. Leaving the mode removes every node, listener
 * and timer this file created. The pure logic is in modes/diff-core.js.
 */

const PE_DIFF_LAYER_ID = 'pe-diff-layer';
const PE_DIFF_HEAT_ID = 'pe-diff-heat';
const PE_DIFF_DIVIDER_ID = 'pe-diff-divider';
const PE_DIFF_TOOLBAR_ID = 'pe-diff-toolbar';
const PE_DIFF_SAVE_DELAY = 300;

function PE_createDiffMode(host) {
  const siteKey = () => (location.hostname || 'page');
  const settingsKey = () => 'pe_diff_settings_' + siteKey();
  const imageKey = () => 'pe_diff_image_' + siteKey();

  let layer = null;       // the design, a canvas
  let heat = null;        // the heat map, a canvas
  let divider = null;     // before/after handle
  let toolbar = null;
  let ui = {};            // toolbar elements
  let session = null;     // identifies one enter→exit, so late async work can tell it is stale

  let settings = PE_diffNormalizeSettings(null);
  let image = null;       // { name, size, type, dataUrl, bitmap, width, height }
  let splitX = 0;
  let heatState = null;   // where the heat map was captured: { lock, scrollX, scrollY }
  let comparing = false;
  let rafId = 0;
  let saveTimer = 0;
  let cleanups = [];

  const T = () => (host.isTr
    ? {
        title: 'Görsel Fark', close: 'Kapat',
        drop: 'Bir görsel bırakın, seçmek için tıklayın veya yapıştırın (Ctrl+V)',
        opacity: 'Saydamlık', scale: 'Ölçek', threshold: 'Eşik (kanal başına)',
        lock: 'Sayfayla birlikte kaydır', invert: 'Ters çevir', blend: 'Fark karışımı', split: 'Önce/sonra',
        compare: 'Karşılaştır', clear: 'Temizle', remove: 'Görseli kaldır',
        local: 'Görseliniz yalnızca bu bilgisayarda kalır.',
        loading: 'Yükleniyor…', comparing: 'Karşılaştırılıyor…',
        different: (p, r) => `%${p} farklı · ${r} bölge`,
        tolerance: '±1 px tolerans',
        identical: 'Eşiğin üstünde fark yok.',
        outOfView: 'Tasarım görünür alanda değil: kaydırın veya görseli sayfanın görünen kısmına taşıyın.',
        needGesture: 'Karşılaştırma için PageEraser\'ı araç çubuğu düğmesi, kısayol veya sağ tık menüsünden başlatın.',
        failed: 'Karşılaştırılamadı',
        notStored: 'Bu görsel hatırlanamadı (en çok 5 MB saklanır); bu sayfadan çıkana kadar kullanılabilir.',
        storeFailed: 'Görsel saklanamadı; bu sayfadan çıkana kadar kullanılabilir.',
        badType: 'Yalnızca PNG, JPG veya WebP kabul edilir.',
        badSize: 'Dosya çok büyük (en çok 25 MB).',
        badDimensions: 'Görselin boyutu desteklenmiyor (en çok 16384 px ve 40 milyon piksel).',
        decodeFailed: 'Görsel okunamadı.'
      }
    : {
        title: 'Visual Diff', close: 'Close',
        drop: 'Drop an image here, click to choose, or paste (Ctrl+V)',
        opacity: 'Opacity', scale: 'Scale', threshold: 'Threshold (per channel)',
        lock: 'Scroll with the page', invert: 'Invert', blend: 'Difference blend', split: 'Before / after',
        compare: 'Compare', clear: 'Clear', remove: 'Remove image',
        local: 'Your image stays on this computer.',
        loading: 'Loading…', comparing: 'Comparing…',
        different: (p, r) => `${p}% different · ${r} region${r === 1 ? '' : 's'}`,
        tolerance: '±1 px tolerance',
        identical: 'No differences above the threshold.',
        outOfView: 'The design is not in view: scroll, or move it onto the visible part of the page.',
        needGesture: 'To compare, start PageEraser from the toolbar button, a shortcut or the right-click menu.',
        failed: 'Compare failed',
        notStored: 'This image will not be remembered (at most 5 MB is stored); it works until you leave the page.',
        storeFailed: 'The image could not be stored; it works until you leave the page.',
        badType: 'Only PNG, JPG or WebP images are accepted.',
        badSize: 'The file is too large (25 MB at most).',
        badDimensions: 'The image size is not supported (16384 px and 40 megapixels at most).',
        decodeFailed: 'The image could not be read.'
      });

  const problemText = (code) => {
    const t = T();
    return code === 'type' ? t.badType : code === 'size' ? t.badSize : t.badDimensions;
  };

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  const nextFrames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

  /* ─── Layout of the layers ─────────────────────────────── */

  function setNote(text) {
    if (ui.message) ui.message.textContent = text || '';
  }

  function setResult(text) {
    if (ui.result) ui.result.textContent = text || '';
  }

  function clearHeat(keepText) {
    heatState = null;
    if (heat) heat.style.display = 'none';
    if (!keepText) setResult('');
  }

  /* Anything that moves, resizes or replaces the design makes the last heat map
   * describe something that is no longer there. */
  function invalidate() {
    clearHeat(false);
  }

  function updateSplit() {
    if (!layer || !divider) return;
    const on = !!image && settings.split;
    divider.style.display = on ? 'block' : 'none';
    if (!on) {
      layer.style.removeProperty('clip-path');
      return;
    }
    const vw = document.documentElement.clientWidth;
    if (!splitX) splitX = Math.round(vw / 2);
    splitX = Math.min(vw, Math.max(0, splitX));
    divider.style.left = splitX + 'px';
    const r = layer.getBoundingClientRect();
    layer.style.setProperty('clip-path', `inset(0 ${PE_diffSplitInset(r.left, r.width, splitX)}px 0 0)`, 'important');
  }

  function layout() {
    rafId = 0;
    if (!layer) return;
    const set = (el, prop, value) => el.style.setProperty(prop, value, 'important');

    if (image) {
      layer.style.display = 'block';
      set(layer, 'position', settings.scrollLock ? 'absolute' : 'fixed');
      set(layer, 'left', settings.x + 'px');
      set(layer, 'top', settings.y + 'px');
      set(layer, 'width', (image.width * settings.scale / 100) + 'px');
      set(layer, 'height', (image.height * settings.scale / 100) + 'px');
      set(layer, 'opacity', String(settings.opacity / 100));
      set(layer, 'mix-blend-mode', settings.blend ? 'difference' : 'normal');
      set(layer, 'filter', settings.invert ? 'invert(1)' : 'none');
    } else {
      layer.style.display = 'none';
    }

    if (heat && heatState) {
      heat.style.display = 'block';
      set(heat, 'position', heatState.lock ? 'absolute' : 'fixed');
      set(heat, 'left', (heatState.lock ? heatState.scrollX : 0) + 'px');
      set(heat, 'top', (heatState.lock ? heatState.scrollY : 0) + 'px');
    }
    updateSplit();
  }

  function schedule() {
    if (!rafId && layer) rafId = requestAnimationFrame(layout);
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      host._saveSetting(settingsKey(), settings);
    }, PE_DIFF_SAVE_DELAY);
  }

  /* Reflect `settings` in the toolbar controls. The X/Y field being typed in is
   * left alone (`except`), otherwise a lone "-" would be turned into 0 under the
   * user's fingers. */
  function syncInputs(except) {
    if (!toolbar) return;
    ui.opacity.value = String(settings.opacity);
    ui.opacityVal.textContent = settings.opacity + '%';
    ui.scale.value = String(settings.scale);
    ui.scaleVal.textContent = settings.scale + '%';
    if (except !== ui.x) ui.x.value = String(settings.x);
    if (except !== ui.y) ui.y.value = String(settings.y);
    ui.lock.checked = settings.scrollLock;
    ui.invert.checked = settings.invert;
    ui.blend.checked = settings.blend;
    ui.split.checked = settings.split;
    ui.threshold.value = String(settings.threshold);
    ui.thresholdVal.textContent = String(settings.threshold);
  }

  /* A control changed: take its value, forget the heat map, redraw, remember. */
  function changed(patch, source) {
    settings = PE_diffNormalizeSettings(Object.assign({}, settings, patch));
    syncInputs(source);
    invalidate();
    schedule();
    saveSoon();
  }

  /* ─── The design image ─────────────────────────────────── */

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function describeImage() {
    if (!ui.fileinfo) return;
    ui.fileinfo.textContent = image
      ? `${image.name} · ${image.width} × ${image.height} px · ${(image.size / 1024).toFixed(image.size < 102400 ? 1 : 0)} KB`
      : '';
    ui.remove.disabled = !image;
    ui.compare.disabled = !image || comparing;
  }

  /* Decode a data URL into a bitmap and put it on the page. Returns false (and
   * says why in the toolbar) when it cannot be used. `stored` is true when the
   * data came from storage, so it is not written back. */
  async function useImage(info, stored) {
    const mine = session;
    const parsed = PE_diffParseDataUrl(info.dataUrl);
    if (!parsed) { setNote(T().decodeFailed); return false; }

    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([parsed.bytes], { type: parsed.mime }));
    } catch (e) {
      if (session === mine) setNote(T().decodeFailed);
      return false;
    }
    if (session !== mine) { bitmap.close(); return false; } // the mode ended while decoding

    const problem = PE_diffImageProblem({ type: info.type, size: info.size, width: bitmap.width, height: bitmap.height });
    if (problem) {
      bitmap.close();
      setNote(problemText(problem));
      return false;
    }

    if (image && image.bitmap) image.bitmap.close();
    image = { name: info.name, size: info.size, type: info.type, dataUrl: info.dataUrl, bitmap, width: bitmap.width, height: bitmap.height };

    layer.width = bitmap.width;
    layer.height = bitmap.height;
    layer.getContext('2d').drawImage(bitmap, 0, 0);

    setNote('');
    invalidate();
    describeImage();
    schedule();

    if (!stored) {
      if (info.dataUrl.length <= PE_DIFF_MAX_STORED_CHARS) {
        const ok = await host._saveSetting(imageKey(), { name: info.name, size: info.size, type: info.type, dataUrl: info.dataUrl });
        if (session === mine && !ok) setNote(T().storeFailed);
      } else {
        // Do not leave an older image behind that would come back instead.
        await host._removeSetting(imageKey());
        if (session === mine) setNote(T().notStored);
      }
    }
    return true;
  }

  async function loadFile(file) {
    if (!file) return;
    const mine = session;
    const early = PE_diffImageProblem({ type: file.type, size: file.size });
    if (early) { setNote(problemText(early)); return; }
    setNote(T().loading);
    let dataUrl;
    try {
      dataUrl = await readAsDataUrl(file);
    } catch (e) {
      if (session === mine) setNote(T().decodeFailed);
      return;
    }
    if (session !== mine) return;
    await useImage({ name: file.name || 'pasted-image', size: file.size, type: file.type, dataUrl }, false);
  }

  async function removeImage() {
    if (!image) return;
    if (image.bitmap) image.bitmap.close();
    image = null;
    layer.width = 1;
    layer.height = 1;
    invalidate();
    describeImage();
    setNote('');
    schedule();
    await host._removeSetting(imageKey());
  }

  /* ─── Compare ──────────────────────────────────────────── */

  async function compare() {
    if (!image || comparing || !layer) return;
    const mine = session;
    const t = T();
    comparing = true;
    describeImage();
    clearHeat(true);
    setResult(t.comparing);

    // Where the design sits in the viewport right now.
    const rect = layer.getBoundingClientRect();
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;

    // Our own layers stay out of the picture: it is the page we compare.
    const hidden = [layer, heat, divider, toolbar, document.getElementById('pe-toast-container'), document.getElementById('pe-clippy-buddy')].filter(Boolean);
    hidden.forEach((n) => n.style.setProperty('visibility', 'hidden', 'important'));
    // The design and the heat map are also part of the page's layout: only
    // hidden, they would still widen it (a horizontal scrollbar the page itself
    // does not have) and that scrollbar would be in the capture.
    const inLayout = [layer, heat];
    const displays = inLayout.map((n) => n.style.display);
    inLayout.forEach((n) => n.style.setProperty('display', 'none', 'important'));
    await nextFrames(2);

    let shot;
    try {
      shot = await host._captureTab();
    } catch (err) {
      shot = { error: String((err && err.message) || err) };
    }
    hidden.forEach((n) => n.style.removeProperty('visibility'));
    inLayout.forEach((n, i) => {
      n.style.removeProperty('display');
      if (displays[i]) n.style.display = displays[i];
    });
    if (session !== mine) return;
    comparing = false;
    describeImage();

    if (!shot || !shot.dataUrl) {
      const text = String((shot && shot.error) || '');
      setResult(/activeTab|all_urls|permission/i.test(text) ? t.needGesture : t.failed);
      return;
    }

    try {
      const parsed = PE_diffParseDataUrl(shot.dataUrl);
      const bitmap = await createImageBitmap(new Blob([parsed.bytes], { type: parsed.mime }));
      if (session !== mine) { bitmap.close(); return; }
      const W = bitmap.width;
      const H = bitmap.height;
      // Device pixels per CSS pixel in this capture. A whole number (100 %,
      // 200 %) lines the page and the design up exactly. At 125 % or 150 % — or
      // when the capture is a pixel off the window size — the browser rounds
      // every box to whole device pixels and the design, resampled onto the same
      // grid, can sit a pixel off along its edges: allow ±1 px there, and say so.
      const sx = W / innerW;
      const sy = H / innerH;
      const radius = Number.isInteger(sx) && Number.isInteger(sy) ? 0 : 1;

      // Page and design on one pixel grid: the captured viewport, and the
      // design drawn where the overlay sits, at the overlay's size.
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = W;
      pageCanvas.height = H;
      const pageCtx = pageCanvas.getContext('2d', { willReadFrequently: true });
      pageCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pageData = pageCtx.getImageData(0, 0, W, H).data;

      const designCanvas = document.createElement('canvas');
      designCanvas.width = W;
      designCanvas.height = H;
      const designCtx = designCanvas.getContext('2d', { willReadFrequently: true });
      designCtx.imageSmoothingQuality = 'high';
      // The browser snaps a box's edges to whole device pixels when it paints
      // it; place the design the same way.
      const dx = Math.round(rect.left * sx);
      const dy = Math.round(rect.top * sy);
      const dw = Math.round((rect.left + rect.width) * sx) - dx;
      const dh = Math.round((rect.top + rect.height) * sy) - dy;
      designCtx.drawImage(image.bitmap, dx, dy, dw, dh);
      const designData = designCtx.getImageData(0, 0, W, H).data;

      const cmp = PE_diffCompare(pageData, designData, W, H, settings.threshold, radius);
      if (cmp.compared === 0) { setResult(t.outOfView); return; }
      const regions = PE_diffRegions(cmp.mask, W, H);

      heat.width = W;
      heat.height = H;
      heat.getContext('2d').putImageData(new ImageData(PE_diffHeatPixels(cmp.mask, W, H), W, H), 0, 0);
      heat.style.setProperty('width', innerW + 'px', 'important');
      heat.style.setProperty('height', innerH + 'px', 'important');
      heatState = { lock: settings.scrollLock, scrollX: window.scrollX, scrollY: window.scrollY };
      schedule();

      const pct = cmp.percent > 0 && cmp.percent < 0.05 ? '<0.1' : cmp.percent.toFixed(1);
      const summary = cmp.different === 0 ? t.identical : t.different(pct, regions.count);
      setResult(radius > 0 ? `${summary} · ${t.tolerance}` : summary);
    } catch (err) {
      if (session === mine) setResult(`${t.failed}: ${(err && err.message) || err}`);
    }
  }

  /* ─── Toolbar ──────────────────────────────────────────── */

  function placeToolbar() {
    if (!toolbar) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const r = toolbar.getBoundingClientRect();
    if (!toolbar.style.left) {
      toolbar.style.setProperty('left', Math.max(8, vw - r.width - 16) + 'px', 'important');
      return;
    }
    if (r.right > vw) toolbar.style.setProperty('left', Math.max(0, vw - r.width - 8) + 'px', 'important');
    if (r.bottom > vh) toolbar.style.setProperty('top', Math.max(0, vh - r.height - 8) + 'px', 'important');
  }

  function buildToolbar() {
    const t = T();
    toolbar = document.createElement('div');
    toolbar.id = PE_DIFF_TOOLBAR_ID;
    toolbar.className = 'pe-paint-toolbox pe-diff-toolbar';
    toolbar.innerHTML = `
      <div class="pe-paint-toolbox-titlebar">
        <span class="pe-paint-toolbox-title">${t.title}</span>
        <button class="pe-paint-toolbox-close" type="button" aria-label="${t.close}"></button>
      </div>
      <div class="pe-paint-toolbox-body">
        <div class="pe-diff-drop" tabindex="0" role="button">${t.drop}</div>
        <input class="pe-diff-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
        <div class="pe-diff-fileinfo"></div>
        <div class="pe-diff-row"><label>${t.opacity}</label><input class="pe-paint-slider pe-diff-opacity" type="range" min="0" max="100"><span class="pe-diff-val pe-diff-opacity-val"></span></div>
        <div class="pe-diff-row"><label>${t.scale}</label><input class="pe-paint-slider pe-diff-scale" type="range" min="50" max="200"><span class="pe-diff-val pe-diff-scale-val"></span></div>
        <div class="pe-diff-row"><label>X</label><input class="pe-diff-num pe-diff-x" type="number" step="1"><label>Y</label><input class="pe-diff-num pe-diff-y" type="number" step="1"></div>
        <label class="pe-diff-check"><input class="pe-diff-lock" type="checkbox"> ${t.lock}</label>
        <label class="pe-diff-check"><input class="pe-diff-invert" type="checkbox"> ${t.invert}</label>
        <label class="pe-diff-check"><input class="pe-diff-blend" type="checkbox"> ${t.blend}</label>
        <label class="pe-diff-check"><input class="pe-diff-split" type="checkbox"> ${t.split}</label>
        <div class="pe-diff-row"><label>${t.threshold}</label><input class="pe-paint-slider pe-diff-threshold" type="range" min="0" max="128"><span class="pe-diff-val pe-diff-threshold-val"></span></div>
        <div class="pe-paint-actions-row" style="display: flex !important; gap: 4px !important;">
          <button class="win-btn pe-diff-compare" type="button" style="flex: 2 !important; font-size: 11px; font-weight: bold;">${t.compare}</button>
          <button class="win-btn pe-diff-clear" type="button" style="flex: 1 !important; font-size: 11px;">${t.clear}</button>
        </div>
        <button class="win-btn pe-diff-remove" type="button" style="width: 100% !important; font-size: 11px;">${t.remove}</button>
        <div class="pe-diff-message"></div>
        <div class="pe-diff-result"></div>
        <div class="pe-diff-note">${t.local}</div>
      </div>
    `;
    document.documentElement.appendChild(toolbar);

    const q = (s) => toolbar.querySelector(s);
    ui = {
      drop: q('.pe-diff-drop'), file: q('.pe-diff-file'), fileinfo: q('.pe-diff-fileinfo'),
      opacity: q('.pe-diff-opacity'), opacityVal: q('.pe-diff-opacity-val'),
      scale: q('.pe-diff-scale'), scaleVal: q('.pe-diff-scale-val'),
      x: q('.pe-diff-x'), y: q('.pe-diff-y'),
      lock: q('.pe-diff-lock'), invert: q('.pe-diff-invert'), blend: q('.pe-diff-blend'), split: q('.pe-diff-split'),
      threshold: q('.pe-diff-threshold'), thresholdVal: q('.pe-diff-threshold-val'),
      compare: q('.pe-diff-compare'), clear: q('.pe-diff-clear'), remove: q('.pe-diff-remove'),
      message: q('.pe-diff-message'),
      result: q('.pe-diff-result')
    };

    ui.opacity.addEventListener('input', () => changed({ opacity: ui.opacity.value }));
    ui.scale.addEventListener('input', () => changed({ scale: ui.scale.value }));
    ui.x.addEventListener('input', () => changed({ x: ui.x.value }, ui.x));
    ui.y.addEventListener('input', () => changed({ y: ui.y.value }, ui.y));
    // Leaving the field shows the value that was actually taken (clamped).
    ui.x.addEventListener('change', () => syncInputs());
    ui.y.addEventListener('change', () => syncInputs());
    ui.lock.addEventListener('change', () => changed({ scrollLock: ui.lock.checked }));
    ui.invert.addEventListener('change', () => changed({ invert: ui.invert.checked }));
    ui.blend.addEventListener('change', () => changed({ blend: ui.blend.checked }));
    ui.split.addEventListener('change', () => changed({ split: ui.split.checked }));
    ui.threshold.addEventListener('input', () => changed({ threshold: ui.threshold.value }));
    // A page can click our buttons with element.click(); only real clicks count.
    ui.compare.addEventListener('click', (e) => { if (e.isTrusted !== false) compare(); });
    ui.clear.addEventListener('click', (e) => { if (e.isTrusted !== false) clearHeat(false); });
    ui.remove.addEventListener('click', (e) => { if (e.isTrusted !== false) removeImage(); });

    // Choose, drop, paste
    ui.drop.addEventListener('click', () => ui.file.click());
    ui.drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.file.click(); }
    });
    ui.file.addEventListener('change', () => {
      const f = ui.file.files && ui.file.files[0];
      ui.file.value = '';
      loadFile(f);
    });
    // Window, capture phase: a page that stops these events higher up (on its
    // own capture listener) would otherwise never let them reach the drop zone.
    const overDrop = (e) => !!(ui.drop && e.target && (e.target === ui.drop || ui.drop.contains(e.target)));
    listen(window, 'dragover', (e) => {
      if (!overDrop(e)) return;
      e.preventDefault();
      ui.drop.classList.add('pe-over');
    }, true);
    listen(window, 'dragleave', (e) => {
      if (overDrop(e)) ui.drop.classList.remove('pe-over');
    }, true);
    listen(window, 'drop', (e) => {
      if (e.isTrusted === false || !overDrop(e)) return;
      e.preventDefault();
      ui.drop.classList.remove('pe-over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      loadFile(f);
    }, true);

    toolbar.querySelector('.pe-paint-toolbox-close').addEventListener('click', () => host.modes.deactivate());
    host._makeElementDraggable(toolbar, toolbar.querySelector('.pe-paint-toolbox-titlebar'));
    syncInputs();
    describeImage();
    placeToolbar();
  }

  function onPaste(e) {
    if (e.isTrusted === false) return; // a page cannot hand the extension an image
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    const f = Array.from(files).find((x) => /^image\//.test(x.type));
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    loadFile(f);
  }

  function buildDivider() {
    divider = document.createElement('div');
    divider.id = PE_DIFF_DIVIDER_ID;
    divider.className = 'pe-diff-divider';
    divider.style.display = 'none';
    divider.innerHTML = '<div class="pe-diff-grip"></div>';
    document.documentElement.appendChild(divider);

    let dragging = false;
    divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      splitX = e.clientX;
      schedule();
    });
    const stop = () => { dragging = false; };
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  }

  /* ─── Mode interface ───────────────────────────────────── */

  return {
    enter() {
      if (!document.body) {
        host.modes.release('diff');
        return;
      }
      const mine = {};
      session = mine;

      layer = document.createElement('canvas');
      layer.id = PE_DIFF_LAYER_ID;
      layer.className = 'pe-diff-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.width = 1;
      layer.height = 1;
      layer.style.display = 'none';
      heat = document.createElement('canvas');
      heat.id = PE_DIFF_HEAT_ID;
      heat.className = 'pe-diff-heat';
      heat.setAttribute('aria-hidden', 'true');
      heat.style.display = 'none';
      // On <html>, not <body>: the design is positioned against the page itself.
      document.documentElement.appendChild(layer);
      document.documentElement.appendChild(heat);
      buildDivider();
      buildToolbar();

      listen(window, 'paste', onPaste, true);
      listen(window, 'scroll', () => {
        // A heat map that is fixed to the window no longer matches a scrolled page.
        if (heatState && !heatState.lock) invalidate();
        schedule();
      }, { capture: true, passive: true });
      listen(window, 'resize', () => { invalidate(); placeToolbar(); schedule(); });

      // What this site remembers: settings first, then the image.
      host._getSetting(settingsKey(), null).then((saved) => {
        if (session !== mine || !saved) return;
        settings = PE_diffNormalizeSettings(saved);
        syncInputs();
        schedule();
      }).then(() => host._getSetting(imageKey(), null)).then((saved) => {
        if (session !== mine || !saved || typeof saved.dataUrl !== 'string') return;
        return useImage({ name: String(saved.name || 'design'), size: Number(saved.size) || saved.dataUrl.length, type: String(saved.type || ''), dataUrl: saved.dataUrl }, true);
      }).catch(() => { /* a stored image that cannot be read is simply not shown */ });
    },

    exit() {
      // Keep the last tweak: a pending save would otherwise be lost.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
        host._saveSetting(settingsKey(), settings);
      }
      session = null;
      cleanups.forEach((fn) => fn());
      cleanups = [];
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (toolbar && toolbar._cleanupDrag) toolbar._cleanupDrag();
      if (image && image.bitmap) image.bitmap.close();
      [layer, heat, divider, toolbar].forEach((n) => { if (n) n.remove(); });
      layer = heat = divider = toolbar = null;
      ui = {};
      image = null;
      heatState = null;
      comparing = false;
      splitX = 0;
      settings = PE_diffNormalizeSettings(null);
    },

    /* Arrow keys move the design by 1 px (10 with Shift) once there is one. */
    onKey(e) {
      if (!image || e.ctrlKey || e.altKey || e.metaKey) return;
      const n = PE_diffNudge(e.key, e.shiftKey);
      if (!n) return;
      e.preventDefault();
      changed({ x: settings.x + n.dx, y: settings.y + n.dy });
    }
  };
}
