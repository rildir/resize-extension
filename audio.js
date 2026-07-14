/**
 * PageEraser Chrome Extension — Sound Synthesizer (Web Audio API)
 *
 * Provides nostalgic 8-bit sound effects.
 */
const RetroAudio = {
  ctx: null,
  storage: chrome.storage.local || chrome.storage.sync,
  getOrCreateCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.ctx;
  },
  async isEnabled() {
    try {
      const data = await this.storage.get('pe_sounds');
      return data.pe_sounds !== false; // defaults to true
    } catch {
      return true;
    }
  },
  async playSelection() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(523.25, now, 0.08, 'square'); // C5
    this._playNote(659.25, now + 0.08, 0.08, 'square'); // E5
    this._playNote(783.99, now + 0.16, 0.16, 'square'); // G5
  },
  async playReset() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(523.25, now, 0.06, 'sawtooth');
    this._playNote(392.00, now + 0.06, 0.06, 'sawtooth');
    this._playNote(261.63, now + 0.12, 0.12, 'sawtooth');
  },
  async playError() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(150, now, 0.15, 'sawtooth');
  },
  async playMinesweeperClick() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(800, now, 0.02, 'sine');
  },
  async playMinesweeperExplosion() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.linearRampToValueAtTime(40, now + 0.5);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.5);
    } catch (e) {}
  },
  async playMinesweeperWin() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(523.25, now, 0.1, 'square');
    this._playNote(659.25, now + 0.1, 0.1, 'square');
    this._playNote(783.99, now + 0.2, 0.1, 'square');
    this._playNote(1046.50, now + 0.3, 0.2, 'square');
  },
  async playStartup() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    // Windows 95 "ta-da!" startup jingle (synthesized)
    this._playNote(523.25, now, 0.12, 'square');        // C5
    this._playNote(659.25, now + 0.12, 0.12, 'square');  // E5
    this._playNote(783.99, now + 0.24, 0.12, 'square');  // G5
    this._playNote(1046.50, now + 0.36, 0.25, 'square'); // C6
    this._playNote(783.99, now + 0.48, 0.08, 'triangle'); // G5 grace
    this._playNote(1046.50, now + 0.56, 0.35, 'square'); // C6 finale
  },
  _playNote(freq, start, duration, type = 'sine') {
    try {
      const ctx = this.getOrCreateCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.04, start); // low volume
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start(start);
      osc.stop(start + duration);
    } catch (e) {
      // AudioContext blocker fallback
    }
  },
  async playShutdown() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    // Windows 95 shutdown jingle (descending)
    this._playNote(1046.50, now, 0.12, 'square');        // C6
    this._playNote(783.99, now + 0.12, 0.12, 'square');  // G5
    this._playNote(659.25, now + 0.24, 0.12, 'square');  // E5
    this._playNote(523.25, now + 0.36, 0.3, 'triangle'); // C5 finale
  },
  async playMinimize() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(600, now, 0.04, 'square');
    this._playNote(400, now + 0.04, 0.06, 'square');
  },
  async playMaximizeDeny() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(300, now, 0.06, 'sawtooth');
    this._playNote(250, now + 0.08, 0.06, 'sawtooth');
  },
  async playErrorTone() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(500, now, 0.2, 'sine');
  },
  async playChord() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    try {
      const frequencies = [130.81, 164.81, 196.00, 261.63]; // C3, E3, G3, C4
      frequencies.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(idx === 0 ? 0.03 : 0.015, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.35);
      });
    } catch(e) {}
  },
  async playChomp() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    this._playNote(120, now, 0.05, 'sawtooth');
    this._playNote(90, now + 0.08, 0.08, 'sawtooth');
  },
  async playTrash() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      const start = now + (i * 0.04);
      const pitch = 100 + Math.random() * 200;
      this._playNote(pitch, start, 0.03, 'triangle');
    }
  },
  async playSwish() {
    if (!await this.isEnabled()) return;
    const ctx = this.getOrCreateCtx();
    const now = ctx.currentTime;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(1500, now + 0.15);
      gain.gain.setValueAtTime(0.02, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);
    } catch(e) {}
  }
};
