/*
 * Đồng hồ cờ 2 bên (Fischer increment). Không phụ thuộc DOM hay engine.
 *
 *   const clock = new ChessClock({ initialMs: 5 * 60e3, incrementMs: 3e3, onTick, onTimeout });
 *   clock.start('r');          // bắt đầu chạy giờ của Đỏ
 *   clock.press('r');          // Đỏ vừa đi xong: cộng increment cho Đỏ, chuyển sang giờ của Đen
 *   clock.pause(); clock.resume();
 *   clock.snapshot() / clock.restore(snap)   // dùng khi đi lại (undo)
 */
(function (root) {
  'use strict';

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  class ChessClock {
    constructor({ initialMs = 0, incrementMs = 0, onTick = () => {}, onTimeout = () => {} } = {}) {
      this.initialMs = initialMs;
      this.incrementMs = incrementMs;
      this.onTick = onTick;
      this.onTimeout = onTimeout;
      this.remaining = { r: initialMs, b: initialMs };
      this.active = null;   // bên đang chạy giờ
      this.paused = false;
      this.flagged = null;  // bên đã hết giờ
      this._last = 0;
      this._timer = null;
    }

    get enabled() { return this.initialMs > 0; }
    get running() { return this.enabled && !!this.active && !this.paused && !this.flagged; }

    start(side) {
      if (!this.enabled || this.flagged) return;
      this.active = side;
      this._last = now();
      this._ensureTimer();
      this.onTick();
    }

    press(side) {
      if (!this.enabled || this.flagged) return;
      this._update();
      if (this.active === side) this.remaining[side] += this.incrementMs; // nước đầu (đồng hồ chưa chạy) không cộng
      this.start(side === 'r' ? 'b' : 'r');
    }

    pause() {
      if (!this.running) return;
      this._update();
      this.paused = true;
      this.onTick();
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this._last = now();
      this.onTick();
    }

    stop() {
      this._update();
      this.active = null;
      clearInterval(this._timer);
      this._timer = null;
      this.onTick();
    }

    snapshot() {
      this._update();
      return { r: this.remaining.r, b: this.remaining.b };
    }

    restore(snap, activeSide) {
      this.remaining = { r: snap.r, b: snap.b };
      this.flagged = null;
      this.paused = false;
      if (activeSide) this.start(activeSide);
      else { this.active = null; this.onTick(); }
    }

    _update() {
      if (!this.running) return;
      const t = now();
      this.remaining[this.active] -= t - this._last;
      this._last = t;
      if (this.remaining[this.active] <= 0) {
        this.remaining[this.active] = 0;
        this.flagged = this.active;
        const side = this.active;
        this.active = null;
        clearInterval(this._timer);
        this._timer = null;
        this.onTimeout(side);
      }
    }

    _ensureTimer() {
      if (this._timer) return;
      this._timer = setInterval(() => { this._update(); this.onTick(); }, 100);
    }

    /** "05:00", "1:02:03", or "9.4" when under 10 seconds. */
    static format(ms) {
      if (ms < 10000) return (Math.max(0, ms) / 1000).toFixed(1);
      const total = Math.ceil(ms / 1000);
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = ChessClock;
  else root.ChessClock = ChessClock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
