/**
 * PageEraser Chrome Extension — Mode Manager
 *
 * Every interactive tool on the page (erase, paint, and the ones that follow)
 * is a "mode". The manager guarantees that only one mode is active at a time
 * and owns the page-level event listeners a mode needs, so that switching
 * modes can never leave a stale handler behind.
 *
 * A mode is a plain object. Only enter() and exit() are required:
 *
 *   enter(opts)          start the mode; opts is whatever activate() received
 *   exit()               stop the mode and remove everything it put on the page
 *   onPointerMove(info)  { target, altKey, clientX, clientY } — at most one
 *                        call per frame
 *   onClick(event)       click, window capture phase (a mode may preventDefault)
 *   onKey(event)         keydown, forwarded after the global shortcuts ran and
 *                        only when focus is not in a text field
 *   onModifier(event)    keydown/keyup, window capture phase (used for Alt)
 *
 * The manager attaches a listener only for the hooks a mode defines, and only
 * while that mode is active. A mode that manages its own events (paint)
 * defines none and gets none.
 *
 * Loaded before content.js as a classic script — see manifest.json.
 */
class PE_ModeManager {
  constructor() {
    this._modes = new Map();
    this._activeId = null;
    this._listeners = [];
    this._ticking = false;
  }

  register(id, mode) {
    if (typeof id !== 'string' || !id) {
      throw new TypeError('A mode needs a non-empty string id');
    }
    if (!mode || typeof mode.enter !== 'function' || typeof mode.exit !== 'function') {
      throw new TypeError(`Mode "${id}" must define enter() and exit()`);
    }
    this._modes.set(id, mode);
    return this;
  }

  get activeId() {
    return this._activeId;
  }

  /* isActive('erase') — is that mode running? isActive() — is any? */
  isActive(id) {
    return id === undefined ? this._activeId !== null : this._activeId === id;
  }

  /* Start a mode, first stopping whichever one is running. Returns false when
   * the mode is unknown or already active. */
  activate(id, opts) {
    const mode = this._modes.get(id);
    if (!mode || this._activeId === id) return false;
    if (this._activeId !== null) this.deactivate();

    this._activeId = id;
    this._attach(id, mode);
    try {
      mode.enter(opts);
    } catch (err) {
      // A mode that failed to start must not leave listeners or state behind.
      this._detach();
      this._activeId = null;
      try { mode.exit(); } catch (e) { /* best effort */ }
      throw err;
    }
    return true;
  }

  /* Stop the active mode. Returns false when nothing was running. */
  deactivate() {
    const id = this._activeId;
    if (id === null) return false;
    const mode = this._modes.get(id);
    // Clear our own state first: exit() may call back into release().
    this._activeId = null;
    this._detach();
    mode.exit();
    return true;
  }

  toggle(id, opts) {
    if (this.isActive(id)) {
      this.deactivate();
      return false;
    }
    return this.activate(id, opts);
  }

  /* For a mode that can end on its own (paint's close button): tell the
   * manager it is over without calling exit() a second time. */
  release(id) {
    if (this._activeId !== id) return false;
    this._activeId = null;
    this._detach();
    return true;
  }

  /* Forward a keydown to the active mode's onKey(). */
  handleKey(event) {
    const mode = this._activeId === null ? null : this._modes.get(this._activeId);
    if (mode && typeof mode.onKey === 'function') mode.onKey(event);
  }

  /* ─── Listener plumbing ─────────────────────────────────── */

  _listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this._listeners.push([target, type, fn, options]);
  }

  _attach(id, mode) {
    if (typeof mode.onPointerMove === 'function') {
      this._listen(document, 'mousemove', (e) => {
        if (e.isTrusted === false) return; // a page can dispatch its own events
        if (this._activeId !== id || this._ticking) return;
        this._ticking = true;
        const info = { target: e.target, altKey: e.altKey, clientX: e.clientX, clientY: e.clientY };
        requestAnimationFrame(() => {
          try {
            if (this._activeId === id) mode.onPointerMove(info);
          } finally {
            this._ticking = false;
          }
        });
      }, { passive: true });
    }

    if (typeof mode.onClick === 'function') {
      this._listen(window, 'click', (e) => {
        if (e.isTrusted === false) return; // a page-made click must not erase, pick or extract anything
        if (this._activeId === id) mode.onClick(e);
      }, true);
    }

    if (typeof mode.onModifier === 'function') {
      const onModifier = (e) => {
        if (e.isTrusted === false) return;
        if (this._activeId === id) mode.onModifier(e);
      };
      this._listen(window, 'keydown', onModifier, true);
      this._listen(window, 'keyup', onModifier, true);
    }
  }

  _detach() {
    this._listeners.forEach(([target, type, fn, options]) => {
      target.removeEventListener(type, fn, options);
    });
    this._listeners = [];
    this._ticking = false;
  }
}

// Lets tests/run.js load the manager in Node; a no-op inside the extension.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PE_ModeManager };
}
