/*
 * Fast mutable position for the search bot: JieqiBots.lib.fastpos
 *
 * The engine (engine.js) keeps an immutable state of piece objects – simple and safe for the UI, but every node of
 * the search then copies the board and re-reads strings. Here the search works on ONE position that it changes in
 * place: make() / unmake() on an Int8Array board, the position key and the repetition chain updated incrementally.
 *
 * It reproduces the engine and the evaluation (bots/lib/eval.js) EXACTLY: same legal moves in the same order, same
 * position keys (engine Zobrist tables), same evaluation scores bit for bit (same terms summed in the same order).
 * test/fastpos.test.js cross-checks this on random positions, and test/search.test.js checks that the search gives
 * the same moves, scores and node counts with and without it.
 *
 * Piece code (Int8): 0 = empty, else kind | HID (8, hidden) | BLK (16, Black).
 *   kind = 1 K, 2 A, 3 E, 4 H, 5 R, 6 C, 7 P – the role of a hidden piece (how it moves), the type of a revealed one.
 * Sides are 0 (Red) and 1 (Black).
 */
JieqiBots.module(function (root) {
  'use strict';

  const K = 1, A = 2, E = 3, H = 4, R = 5, C = 6, P = 7;
  const HID = 8, BLK = 16;
  const KIND = { K, A, E, H, R, C, P };
  const KCHAR = ['', 'K', 'A', 'E', 'H', 'R', 'C', 'P'];
  const SIDE_CH = ['r', 'b'];
  const MAXSP = 1024;                                   // repetition chain (game) + search depth
  const EVAL_MASK = (1 << 17) - 1;                      // evaluation cache slots

  // ── Geometry tables (same direction order as engine.js genTargets, so moves come out in the same order) ──
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const on = (x, y) => x >= 0 && x < 9 && y >= 0 && y < 10;
  const inPalace = (s, x, y) => x >= 3 && x <= 5 && (s === 0 ? y >= 7 : y <= 2);
  const ownHalf = (s, y) => (s === 0 ? y >= 5 : y <= 4);
  const crossed = (s, y) => (s === 0 ? y <= 4 : y >= 5);

  const SX = new Int8Array(90), SY = new Int8Array(90);
  for (let i = 0; i < 90; i++) { SX[i] = i % 9; SY[i] = (i / 9) | 0; }
  const RAY = [];             // RAY[i*4+d] = squares from i in direction d (nearest first)
  const KING_T = [[], []];    // [side][i] = King targets (inside the palace)
  const ADV_ALL = [], ADV_PAL = [[], []];   // revealed Advisor / hidden Advisor (palace) targets
  const ELE_ALL = [], ELE_OWN = [[], []];   // flat [eye, target, ...]
  const HORSE_T = [];         // flat [leg, target, ...]
  const PAWN_T = [[], []];    // [side][i] = Pawn targets (forward, then sideways once across the river)
  const HORSE_ATT = [];       // flat [horseSquare, legSquare, ...] – Horses that would attack square i
  const DIAG_ATT = [];        // flat [adjacentDiag, elephantSquare or -1, ...]
  for (let i = 0; i < 90; i++) {
    const x = SX[i], y = SY[i];
    for (let d = 0; d < 4; d++) {
      const r = [];
      for (let nx = x + ORTH[d][0], ny = y + ORTH[d][1]; on(nx, ny); nx += ORTH[d][0], ny += ORTH[d][1]) r.push(ny * 9 + nx);
      RAY.push(r);
    }
    for (let s = 0; s < 2; s++) {
      const kt = [];
      for (const [dx, dy] of ORTH) { const nx = x + dx, ny = y + dy; if (ny >= 0 && ny < 10 && inPalace(s, nx, ny)) kt.push(ny * 9 + nx); }
      KING_T[s].push(kt);
      const at = [];
      for (const [dx, dy] of DIAG) { const nx = x + dx, ny = y + dy; if (on(nx, ny) && inPalace(s, nx, ny)) at.push(ny * 9 + nx); }
      ADV_PAL[s].push(at);
      const et = [];
      for (const [dx, dy] of DIAG) {
        const nx = x + 2 * dx, ny = y + 2 * dy;
        if (on(nx, ny) && ownHalf(s, ny)) et.push((y + dy) * 9 + x + dx, ny * 9 + nx);
      }
      ELE_OWN[s].push(et);
      const pt = [];
      const fy = y + (s === 0 ? -1 : 1);
      if (fy >= 0 && fy < 10) pt.push(fy * 9 + x);
      if (crossed(s, y)) { if (x - 1 >= 0) pt.push(y * 9 + x - 1); if (x + 1 < 9) pt.push(y * 9 + x + 1); }
      PAWN_T[s].push(pt);
    }
    const aa = [], ea = [], ht = [], ha = [], da = [];
    for (const [dx, dy] of DIAG) {
      const nx = x + dx, ny = y + dy;
      if (on(nx, ny)) aa.push(ny * 9 + nx);
      const ex = x + 2 * dx, ey = y + 2 * dy;
      if (on(ex, ey)) ea.push((y + dy) * 9 + x + dx, ey * 9 + ex);
      if (on(nx, ny)) da.push(ny * 9 + nx, on(ex, ey) ? ey * 9 + ex : -1);
    }
    for (const [dx, dy] of ORTH) {
      const lx = x + dx, ly = y + dy;
      if (!on(lx, ly)) continue;
      for (let s2 = -1; s2 <= 1; s2 += 2) {
        const nx = dx !== 0 ? x + 2 * dx : x + s2, ny = dx !== 0 ? y + s2 : y + 2 * dy;
        if (on(nx, ny)) ht.push(ly * 9 + lx, ny * 9 + nx);
      }
    }
    // [dx, dy] from the attacked square to the Horse, plus the leg offset (engine.js HORSE_ATTACKS)
    for (const a of [[2, 1, 1, 1], [2, -1, 1, -1], [-2, 1, -1, 1], [-2, -1, -1, -1], [1, 2, 1, 1], [-1, 2, -1, 1], [1, -2, 1, -1], [-1, -2, -1, -1]]) {
      const hx = x + a[0], hy = y + a[1];
      if (!on(hx, hy)) continue;
      const lx = Math.abs(a[0]) === 2 ? hx - a[2] : hx, ly = Math.abs(a[1]) === 2 ? hy - a[3] : hy;
      ha.push(hy * 9 + hx, ly * 9 + lx);
    }
    ADV_ALL.push(aa); ELE_ALL.push(ea); HORSE_T.push(ht); HORSE_ATT.push(ha); DIAG_ATT.push(da);
  }
  const HORSE_JUMPS = [[1, 2], [-1, 2], [1, -2], [-1, -2], [2, 1], [-2, 1], [2, -1], [-2, -1]];

  // ── Evaluation weights in flat form (phase index 0 opening, 1 middlegame, 2 endgame) ──
  const PHASES = ['opening', 'middlegame', 'endgame'];
  function flatWeights(w) {
    return {
      w,
      H: PHASES.map((ph) => w.H[ph]), C: PHASES.map((ph) => w.C[ph]), R: PHASES.map((ph) => w.R[ph]),
      // value by kind per phase for E/H/C/R when it does not depend on the square (crossedAE off)
      simple: PHASES.map((ph) => (w.crossedAE ? null : [0, 0, 0, w.E, w.H[ph], w.R[ph], w.C[ph], 0])),
      kingSafety: !!(w.horseCheckThreat || w.cannonFacingKing || w.cannonEmptyFile || w.centralCannon || w.bottomCannon
        || w.cannonFacingKingAway || w.cannonFile2 || w.palaceCenterControlled),
      cannonFile: !!(w.cannonFacingKingAway || w.cannonFile2 || w.palaceCenterControlled),
    };
  }
  /** Evaluation terms the fast position does not implement (the search then uses the engine states). */
  const unsupportedWeights = (w) => !!(w.horseReach || w.bottomCannon || w.development);

  class Position {
    /** state: an engine state (not modified). */
    constructor(J, state, w) {
      this.J = J;
      this.Z = J._zobrist.ZOB;
      this.rules = state.rules || J.DEFAULT_RULES;
      this.fw = flatWeights(w);
      this.b = new Int8Array(90);
      this.pool = new Int8Array(16);                     // [side * 8 + kind]
      this.kingSq = new Int16Array(2);
      // key order of the pools in the state: probabilities are summed in that order (exact same floats)
      this.poolOrder = [0, 1].map((s) => Object.keys(state.pools[SIDE_CH[s]]).map((t) => KIND[t]).filter((k) => k >= A));
      this.count = 0;
      this.kingSq[0] = this.kingSq[1] = -1;
      for (let i = 0; i < 90; i++) {
        const pc = state.board[i];
        if (!pc) continue;
        const code = (pc.side === 'r' ? 0 : BLK) | (pc.hidden ? HID | KIND[pc.role] : KIND[pc.type]);
        this.b[i] = code;
        this.count++;
        if (!pc.hidden && pc.type === 'K') this.kingSq[pc.side === 'r' ? 0 : 1] = i;
      }
      for (let s = 0; s < 2; s++) {
        const pl = state.pools[SIDE_CH[s]];
        for (const t in pl) if (KIND[t] >= A) this.pool[s * 8 + KIND[t]] = pl[t] || 0;
      }
      this.turn = state.turn === 'r' ? 0 : 1;
      this.quiet = state.quietPlies || 0;
      const [h1, h2] = J._zobrist.positionKeyParts(state);
      this.h1 = h1 | 0; this.h2 = h2 | 0;
      // undo stack + repetition chain (frames 0..sp; a chain = consecutive frames, chainLen[sp] = its length, 0 = none)
      this.uFrom = new Int16Array(MAXSP); this.uTo = new Int16Array(MAXSP);
      this.uMoved = new Int8Array(MAXSP); this.uCap = new Int8Array(MAXSP); this.uRev = new Int8Array(MAXSP);
      this.uQuiet = new Int16Array(MAXSP); this.uH1 = new Int32Array(MAXSP); this.uH2 = new Int32Array(MAXSP);
      this.uNull = new Uint8Array(MAXSP);
      this.cKey = new Float64Array(MAXSP); this.cLen = new Int16Array(MAXSP);
      const chain = [];
      for (let node = state.rep; node && chain.length < MAXSP / 2; node = node.prev) chain.push(node);
      chain.reverse();
      if (!chain.length) { this.sp = 0; this.cLen[0] = 0; this.cKey[0] = this.key(); }
      else {
        // the oldest kept frame starts a chain of its own length (it may continue a longer, truncated chain)
        for (let i = 0; i < chain.length; i++) {
          this.cKey[i] = chain[i].key; this.uFrom[i] = chain[i].from; this.uTo[i] = chain[i].to; this.cLen[i] = chain[i].len;
        }
        this.sp = chain.length - 1;
      }
      this.sp0 = this.sp;
      this.pv = new Float64Array(180);                   // Pawn value of side s on square i
      for (let s2 = 0; s2 < 2; s2++) for (let i = 0; i < 90; i++) this.pv[s2 * 90 + i] = this.pawnValue(s2, i);
      this.attR = new Uint8Array(90); this.attB = new Uint8Array(90);
      this.evalKeys = new Float64Array(EVAL_MASK + 1).fill(-1); this.evalVals = new Float64Array(EVAL_MASK + 1);
      this.buf = new Int16Array(64);
    }

    key() { return (this.h1 >>> 0) * 2097152 + (this.h2 & 0x1fffff); }

    // ── Hash helpers ──
    zPiece(i, code) {
      const k = i * 28 + (code & BLK ? 14 : 0) + (code & HID ? 7 : 0) + (code & 7) - 1;
      this.h1 ^= this.Z.a[k]; this.h2 ^= this.Z.b[k];
    }
    zPool(s, kind, c) {
      if (!c) return;
      const k = (s * 6 + kind - 2) * 16 + Math.min(15, c);
      this.h1 ^= this.Z.poolA[k]; this.h2 ^= this.Z.poolB[k];
    }

    /**
     * Plays from → to. revealKind: identity of a moving hidden piece (0 = it is not hidden). Capturing a hidden piece
     * never draws from the pool (engine's captureUnknown – the search's expectation). Same key/rep as engine makeMove.
     */
    make(from, to, revealKind) {
      const b = this.b;
      const sp = ++this.sp;
      let pc = b[from];
      const cap = b[to];
      this.uFrom[sp] = from; this.uTo[sp] = to; this.uMoved[sp] = pc; this.uCap[sp] = cap; this.uRev[sp] = 0;
      this.uQuiet[sp] = this.quiet; this.uH1[sp] = this.h1; this.uH2[sp] = this.h2; this.uNull[sp] = 0;
      this.zPiece(from, pc);
      if (cap) {
        this.zPiece(to, cap);
        this.count--;
        if ((cap & 15) === K) this.kingSq[cap >> 4] = -1;
      }
      let revealed = false;
      if (pc & HID) {
        const s = pc >> 4, pi = s * 8 + revealKind, c = this.pool[pi];
        this.zPool(s, revealKind, c); this.zPool(s, revealKind, c - 1);
        this.pool[pi] = c - 1;
        pc = (pc & BLK) | revealKind;
        this.uRev[sp] = revealKind;
        revealed = true;
      }
      b[to] = pc; b[from] = 0;
      this.zPiece(to, pc);
      if ((pc & 15) === K) this.kingSq[pc >> 4] = to;
      this.turn ^= 1;
      this.h1 ^= this.Z.turnA; this.h2 ^= this.Z.turnB;
      this.quiet = cap || revealed ? 0 : this.quiet + 1;
      const prevLen = this.cLen[sp - 1];
      this.cLen[sp] = cap || revealed || prevLen === 0 ? 1 : prevLen + 1;
      this.cKey[sp] = this.key();
    }

    unmake() {
      const sp = this.sp--;
      if (this.uNull[sp]) { this.turn ^= 1; this.quiet = this.uQuiet[sp]; this.h1 = this.uH1[sp]; this.h2 = this.uH2[sp]; return; }
      const from = this.uFrom[sp], to = this.uTo[sp], moved = this.uMoved[sp], cap = this.uCap[sp], rev = this.uRev[sp];
      const b = this.b;
      b[from] = moved; b[to] = cap;
      if (cap) { this.count++; if ((cap & 15) === K) this.kingSq[cap >> 4] = to; }
      if ((moved & 15) === K) this.kingSq[moved >> 4] = from;
      if (rev) this.pool[(moved >> 4) * 8 + rev]++;
      this.turn ^= 1;
      this.quiet = this.uQuiet[sp]; this.h1 = this.uH1[sp]; this.h2 = this.uH2[sp];
    }

    /** Null move (the side to move passes): no repetition chain afterwards, like the old search's null-move state. */
    makeNull() {
      const sp = ++this.sp;
      this.uNull[sp] = 1; this.uQuiet[sp] = this.quiet; this.uH1[sp] = this.h1; this.uH2[sp] = this.h2;
      this.turn ^= 1;
      this.h1 ^= this.Z.turnA; this.h2 ^= this.Z.turnB;
      this.quiet++;
      this.cLen[sp] = 0; this.cKey[sp] = 0;
    }

    // ── Move generation (engine.js genTargets) ──
    /** Writes the pseudo-legal targets of the piece on i into out from n; returns the new end. */
    gen(i, out, n) {
      const b = this.b, pc = b[i], s = pc >> 4, hid = pc & HID;
      let t, q, list;
      switch (pc & 7) {
        case K:
          list = KING_T[s][i];
          for (let k = 0; k < list.length; k++) { t = list[k]; q = b[t]; if (!q || (q >> 4) !== s) out[n++] = t; }
          break;
        case A:
          list = hid ? ADV_PAL[s][i] : ADV_ALL[i];
          for (let k = 0; k < list.length; k++) { t = list[k]; q = b[t]; if (!q || (q >> 4) !== s) out[n++] = t; }
          break;
        case E:
          list = hid ? ELE_OWN[s][i] : ELE_ALL[i];
          for (let k = 0; k < list.length; k += 2) {
            if (b[list[k]]) continue;
            t = list[k + 1]; q = b[t];
            if (!q || (q >> 4) !== s) out[n++] = t;
          }
          break;
        case H:
          list = HORSE_T[i];
          for (let k = 0; k < list.length; k += 2) {
            if (b[list[k]]) continue;
            t = list[k + 1]; q = b[t];
            if (!q || (q >> 4) !== s) out[n++] = t;
          }
          break;
        case R:
          for (let d = 0; d < 4; d++) {
            list = RAY[i * 4 + d];
            for (let k = 0; k < list.length; k++) {
              t = list[k]; q = b[t];
              if (!q) out[n++] = t;
              else { if ((q >> 4) !== s) out[n++] = t; break; }
            }
          }
          break;
        case C:
          for (let d = 0; d < 4; d++) {
            list = RAY[i * 4 + d];
            let k = 0;
            for (; k < list.length; k++) { t = list[k]; if (b[t]) break; out[n++] = t; }
            for (k++; k < list.length; k++) { q = b[list[k]]; if (q) { if ((q >> 4) !== s) out[n++] = list[k]; break; } }
          }
          break;
        case P:
          list = PAWN_T[s][i];
          for (let k = 0; k < list.length; k++) { t = list[k]; q = b[t]; if (!q || (q >> 4) !== s) out[n++] = t; }
          break;
      }
      return n;
    }

    /** engine.js isSquareAttacked: is square sq attacked by side `by` (hidden pieces by role, with their limits)? */
    attacked(sq, by) {
      const b = this.b, x = SX[sq], y = SY[sq];
      for (let d = 0; d < 4; d++) {
        const list = RAY[sq * 4 + d];
        let k = 0;
        for (; k < list.length; k++) {
          const q = b[list[k]];
          if (!q) continue;
          if ((q >> 4) === by) {
            const t = q & 7;
            if (t === R) return true;
            if (t === K) {
              if (k === 0 && inPalace(by, x, y)) return true;
              if (d >= 2 && (b[sq] & 15) === K) return true;          // flying general (same file)
            }
            if (t === P && k === 0) {
              const dy = ORTH[d][1];
              if (dy === (by === 0 ? 1 : -1)) return true;              // Pawn right behind the square
              if (dy === 0 && crossed(by, SY[list[k]])) return true;
            }
          }
          break;
        }
        for (k++; k < list.length; k++) {
          const q = b[list[k]];
          if (q) { if ((q >> 4) === by && (q & 7) === C) return true; break; }
        }
      }
      const ha = HORSE_ATT[sq];
      for (let k = 0; k < ha.length; k += 2) {
        const q = b[ha[k]];
        if (q && (q >> 4) === by && (q & 7) === H && !b[ha[k + 1]]) return true;
      }
      const da = DIAG_ATT[sq];
      for (let k = 0; k < da.length; k += 2) {
        const q = b[da[k]];
        if (q) {
          if ((q >> 4) === by && (q & 7) === A && (!(q & HID) || inPalace(by, x, y))) return true;
          continue;
        }
        const e = da[k + 1];
        if (e < 0) continue;
        const qe = b[e];
        if (qe && (qe >> 4) === by && (qe & 7) === E && (!(qe & HID) || ownHalf(by, y))) return true;
      }
      return false;
    }

    inCheck(s = this.turn) {
      const k = this.kingSq[s];
      return k < 0 || this.attacked(k, s ^ 1);
    }

    /**
     * Number of pseudo-legal moves of the piece on i (= gen's count) and marks the squares it attacks in `map`
     * (= its part of attackMap) – both in one walk.
     */
    countMark(i, map) {
      const b = this.b, pc = b[i], s = pc >> 4, hid = pc & HID;
      let n = 0, t, q, list;
      switch (pc & 7) {
        case K:
          list = KING_T[s][i];
          for (let k = 0; k < list.length; k++) { t = list[k]; map[t] = 1; q = b[t]; if (!q || (q >> 4) !== s) n++; }
          for (let d = 2; d < 4; d++) {
            list = RAY[i * 4 + d];
            for (let k = 0; k < list.length; k++) { t = list[k]; if (b[t]) { if ((b[t] & 15) === K) map[t] = 1; break; } }
          }
          break;
        case A:
          list = hid ? ADV_PAL[s][i] : ADV_ALL[i];
          for (let k = 0; k < list.length; k++) { t = list[k]; map[t] = 1; q = b[t]; if (!q || (q >> 4) !== s) n++; }
          break;
        case E:
          list = hid ? ELE_OWN[s][i] : ELE_ALL[i];
          for (let k = 0; k < list.length; k += 2) {
            if (b[list[k]]) continue;
            t = list[k + 1]; map[t] = 1; q = b[t];
            if (!q || (q >> 4) !== s) n++;
          }
          break;
        case H:
          list = HORSE_T[i];
          for (let k = 0; k < list.length; k += 2) {
            if (b[list[k]]) continue;
            t = list[k + 1]; map[t] = 1; q = b[t];
            if (!q || (q >> 4) !== s) n++;
          }
          break;
        case R:
          for (let d = 0; d < 4; d++) {
            list = RAY[i * 4 + d];
            for (let k = 0; k < list.length; k++) {
              t = list[k]; map[t] = 1; q = b[t];
              if (!q) n++;
              else { if ((q >> 4) !== s) n++; break; }
            }
          }
          break;
        case C:
          for (let d = 0; d < 4; d++) {
            list = RAY[i * 4 + d];
            let k = 0;
            for (; k < list.length; k++) { if (b[list[k]]) break; n++; }
            for (k++; k < list.length; k++) {
              t = list[k]; map[t] = 1; q = b[t];
              if (q) { if ((q >> 4) !== s) n++; break; }
            }
          }
          break;
        case P:
          list = PAWN_T[s][i];
          for (let k = 0; k < list.length; k++) { t = list[k]; map[t] = 1; q = b[t]; if (!q || (q >> 4) !== s) n++; }
          break;
      }
      return n;
    }

    /** The hidden piece on i has pseudo-legal moves and every target is marked in `em` (stops at the first safe one). */
    trapped(i, em) {
      const b = this.b, pc = b[i], s = pc >> 4;
      let any = false, t, q, list;
      switch (pc & 7) {
        case A:
          list = ADV_PAL[s][i];
          for (let k = 0; k < list.length; k++) { t = list[k]; q = b[t]; if (!q || (q >> 4) !== s) { if (!em[t]) return false; any = true; } }
          break;
        case E:
          list = ELE_OWN[s][i];
          for (let k = 0; k < list.length; k += 2) {
            if (b[list[k]]) continue;
            t = list[k + 1]; q = b[t];
            if (!q || (q >> 4) !== s) { if (!em[t]) return false; any = true; }
          }
          break;
        case H:
          list = HORSE_T[i];
          for (let k = 0; k < list.length; k += 2) {
            if (b[list[k]]) continue;
            t = list[k + 1]; q = b[t];
            if (!q || (q >> 4) !== s) { if (!em[t]) return false; any = true; }
          }
          break;
        case R:
          for (let d = 0; d < 4; d++) {
            list = RAY[i * 4 + d];
            for (let k = 0; k < list.length; k++) {
              t = list[k]; q = b[t];
              if (q && (q >> 4) === s) break;
              if (!em[t]) return false;
              any = true;
              if (q) break;
            }
          }
          break;
        case C:
          for (let d = 0; d < 4; d++) {
            list = RAY[i * 4 + d];
            let k = 0;
            for (; k < list.length; k++) { t = list[k]; if (b[t]) break; if (!em[t]) return false; any = true; }
            for (k++; k < list.length; k++) {
              q = b[list[k]];
              if (q) { if ((q >> 4) !== s) { if (!em[list[k]]) return false; any = true; } break; }
            }
          }
          break;
        case P:
          list = PAWN_T[s][i];
          for (let k = 0; k < list.length; k++) { t = list[k]; q = b[t]; if (!q || (q >> 4) !== s) { if (!em[t]) return false; any = true; } }
          break;
        default: {     // (a hidden King does not exist; keep the generic path)
          const buf = this.buf, n = this.gen(i, buf, 0);
          for (let k = 0; k < n; k++) if (!em[buf[k]]) return false;
          return n > 0;
        }
      }
      return any;
    }

    /** engine.js attackMap: out[sq] = 1 for every square attacked by `by`. */
    attackMap(by, out) {
      out.fill(0);
      const b = this.b;
      for (let i = 0; i < 90; i++) {
        const q = b[i];
        if (!q || (q >> 4) !== by) continue;
        let list;
        switch (q & 7) {
          case R:
            for (let d = 0; d < 4; d++) {
              list = RAY[i * 4 + d];
              for (let k = 0; k < list.length; k++) { out[list[k]] = 1; if (b[list[k]]) break; }
            }
            break;
          case C:
            for (let d = 0; d < 4; d++) {
              list = RAY[i * 4 + d];
              let k = 0;
              while (k < list.length && !b[list[k]]) k++;
              for (k++; k < list.length; k++) { out[list[k]] = 1; if (b[list[k]]) break; }
            }
            break;
          case K:
            list = KING_T[by][i];
            for (let k = 0; k < list.length; k++) out[list[k]] = 1;
            for (let d = 2; d < 4; d++) {
              list = RAY[i * 4 + d];
              for (let k = 0; k < list.length; k++) { const t = list[k]; if (b[t]) { if ((b[t] & 15) === K) out[t] = 1; break; } }
            }
            break;
          case P:
            list = PAWN_T[by][i];
            for (let k = 0; k < list.length; k++) out[list[k]] = 1;
            break;
          case H:
            list = HORSE_T[i];
            for (let k = 0; k < list.length; k += 2) if (!b[list[k]]) out[list[k + 1]] = 1;
            break;
          case A:
            list = q & HID ? ADV_PAL[by][i] : ADV_ALL[i];
            for (let k = 0; k < list.length; k++) out[list[k]] = 1;
            break;
          case E:
            list = q & HID ? ELE_OWN[by][i] : ELE_ALL[i];
            for (let k = 0; k < list.length; k += 2) if (!b[list[k]]) out[list[k + 1]] = 1;
            break;
        }
      }
      return out;
    }

    /**
     * Geometrically legal moves of the side to move, in engine order, as move codes from * 90 + to written into
     * `moves` (an Int32Array); returns their number. Same shortcut as engine.js getGeometricMoves (exact): only moves that can expose the King are tested.
     */
    geometricMoves(moves, capturesOnly) {
      const b = this.b, side = this.turn, enemy = side ^ 1, myKing = this.kingSq[side], buf = this.buf;
      const kx = myKing % 9, ky = (myKing / 9) | 0;
      const safeKnown = myKing >= 0 && !this.attacked(myKing, enemy);
      let nm = 0;
      for (let from = 0; from < 90; from++) {
        const pc = b[from];
        if (!pc || (pc >> 4) !== side) continue;
        const n = this.gen(from, buf, 0);
        const fx = SX[from], fy = SY[from], isKing = (pc & 15) === K;
        const fromRisky = !safeKnown || isKing || fx === kx || fy === ky || (Math.abs(fx - kx) === 1 && Math.abs(fy - ky) === 1);
        for (let k = 0; k < n; k++) {
          const to = buf[k], cap = b[to];
          if (capturesOnly && !cap) continue;
          if (!fromRisky && SX[to] !== kx && SY[to] !== ky) { moves[nm++] = from * 90 + to; continue; }
          b[to] = pc; b[from] = 0;
          const illegal = this.attacked(isKing ? to : myKing, enemy);
          b[from] = pc; b[to] = cap;
          if (!illegal) moves[nm++] = from * 90 + to;
        }
      }
      return nm;
    }

    // ── Repetition (only reached when a position repeats – rare) ──
    /** Engine state equivalent to the current position (for the engine's repetition rules). */
    toState() {
      const board = new Array(90).fill(null);
      for (let i = 0; i < 90; i++) {
        const c = this.b[i];
        if (!c) continue;
        const kind = KCHAR[c & 7];
        board[i] = c & HID ? { side: SIDE_CH[c >> 4], type: null, hidden: true, role: kind }
          : { side: SIDE_CH[c >> 4], type: kind, hidden: false, role: kind };
      }
      const pools = { r: {}, b: {} };
      for (let s = 0; s < 2; s++) {
        for (const k of this.poolOrder[s]) pools[SIDE_CH[s]][KCHAR[k]] = this.pool[s * 8 + k];
      }
      let rep = null;
      const len = this.cLen[this.sp];
      if (len > 0) {
        // build the linked list oldest first
        for (let i = this.sp - len + 1; i <= this.sp; i++) {
          const l = this.cLen[i];
          rep = { key: this.cKey[i], from: l === 1 ? -1 : this.uFrom[i], to: l === 1 ? -1 : this.uTo[i], prev: l === 1 ? null : rep, len: l };
        }
      }
      return { board, turn: SIDE_CH[this.turn], pools, rules: this.rules, rep, quietPlies: this.quiet, result: null, ply: 0 };
    }

    /** Chinese "must deviate" rule (engine.js filterRepetition) applied to the first n move codes, in place → new n. */
    filterRepetition(moves, n) {
      const rules = this.rules, sp = this.sp, len = this.cLen[sp];
      if (!rules || rules.repetition === 'none' || len === 0) return n;
      const need = rules.repetitionCount - 1;
      if (len < need * 4) return n;
      const counts = new Map();
      let maxCount = 0;
      for (let d = 1; d < len; d += 2) {
        const key = this.cKey[sp - d];
        const c = (counts.get(key) || 0) + 1;
        counts.set(key, c);
        if (c > maxCount) maxCount = c;
      }
      if (maxCount < need) return n;
      const mover = this.turn;
      let w = 0;
      for (let k = 0; k < n; k++) {
        const m = moves[k], from = (m / 90) | 0, to = m % 90;
        let keep = true;
        if (!this.b[to] && !(this.b[from] & HID)) {
          this.make(from, to, 0);
          if ((counts.get(this.cKey[this.sp]) || 0) >= need) {
            const st = this.J.repetitionStatus(this.toState());
            if (st && st.result.winner === SIDE_CH[mover ^ 1]) keep = false;
          }
          this.unmake();
        }
        if (keep) moves[w++] = m;
      }
      return w;
    }

    /** engine.js getLegalMoves (with the repetition filter unless capturesOnly) into `moves`; returns the count. */
    legalMoves(moves, capturesOnly) {
      const n = this.geometricMoves(moves, capturesOnly);
      return capturesOnly ? n : this.filterRepetition(moves, n);
    }

    /** Legal moves as a plain array of codes (tests / tools). */
    legalMoveList(capturesOnly) {
      const buf = new Int32Array(256);
      return Array.from(buf.subarray(0, this.legalMoves(buf, capturesOnly)));
    }

    // ── Pool ──
    poolTotal(s) {
      let t = 0;
      const o = this.poolOrder[s];
      for (let k = 0; k < o.length; k++) t += this.pool[s * 8 + o[k]];
      return t;
    }

    // ── Evaluation (bots/lib/eval.js evaluate, same floats) ──
    phase() {
      const ratio = this.count / 32, ph = this.fw.w.phase;
      return ratio > ph.openingAbove ? 0 : ratio > ph.middlegameAbove ? 1 : 2;
    }

    pawnValue(s, i) {
      const P_ = this.fw.w.P, x = SX[i], y = SY[i];
      if (x === 4 && y === (s === 0 ? 8 : 1)) return P_.palaceCenter;
      if (y === (s === 0 ? 0 : 9)) return P_.bottom;
      return crossed(s, y) ? P_.crossed : P_.home;
    }

    typeValue(kind, s, i, phase) {
      const w = this.fw.w;
      switch (kind) {
        case P: return this.pawnValue(s, i);
        case E: return w.E + (w.crossedAE && crossed(s, SY[i]) ? w.crossedAE : 0);
        case A: {
          let paired = false;
          const list = ADV_ALL[i], want = (s << 4) | A;
          for (let k = 0; k < list.length; k++) if (this.b[list[k]] === want) { paired = true; break; }
          return (paired ? w.A.paired : w.A.single) + (w.crossedAE && crossed(s, SY[i]) ? w.crossedAE : 0);
        }
        case H: return this.fw.H[phase];
        case C: return this.fw.C[phase];
        case R: return this.fw.R[phase];
      }
      return 0;
    }

    /** eval.js hiddenStats → [base, pawnProb] in out[s*2], out[s*2+1]. */
    hiddenStats(s, phase, out) {
      const w = this.fw.w, o = this.poolOrder[s], total = this.poolTotal(s);
      let base = w.hiddenBonus, pawnProb = 0;
      for (let k = 0; k < o.length; k++) {
        const kind = o[k], c = this.pool[s * 8 + kind];
        if (c <= 0) continue;
        const prob = c / total;
        if (kind === P) pawnProb = prob;
        else base += prob * (kind === A ? w.A.single : kind === E ? w.E : kind === H ? this.fw.H[phase] : kind === C ? this.fw.C[phase] : this.fw.R[phase]);
      }
      out[s * 2] = base; out[s * 2 + 1] = pawnProb;
    }

    /**
     * Score from side `side`'s point of view (0 Red / 1 Black). For the side to move the result is cached by position
     * key (the evaluation depends only on the position, and the search evaluates many positions twice: the Star2 probe
     * of a chance node, then the stand-pat of the same child).
     */
    evaluate(side) {
      if (side !== this.turn) return this.evaluateFull(side);
      const key = this.key(), slot = this.h2 & EVAL_MASK;
      if (this.evalKeys[slot] === key) return this.evalVals[slot];
      const v = this.evaluateFull(side);
      this.evalKeys[slot] = key; this.evalVals[slot] = v;
      return v;
    }

    evaluateFull(side) {
      const b = this.b, fw = this.fw, w = fw.w;
      const phase = this.phase();
      const hs = HS; HS_DONE[0] = HS_DONE[1] = 0;
      const pv = this.pv, simple = fw.simple[phase];
      const scan = w.mobility || w.check || w.hiddenTrapped;
      const attR = this.attR, attB = this.attB;
      if (scan) { attR.fill(0); attB.fill(0); }
      let mat = 0, kR = -1, kB = -1, nhR = 0, nhB = 0;
      let mobR = 0, mobB = 0, trapR = 0, trapB = 0, anyHidden = false;
      // one pass: material (summed in square order, like eval.js), move counts and attack maps of both sides
      for (let i = 0; i < 90; i++) {
        const c = b[i];
        if (!c) continue;
        const s = c >> 4, kind = c & 7;
        if (scan) { if (s === 0) mobR += this.countMark(i, attR); else mobB += this.countMark(i, attB); }
        let v;
        if (c & HID) {
          anyHidden = true;
          if (!HS_DONE[s]) { this.hiddenStats(s, phase, hs); HS_DONE[s] = 1; }
          const pp = hs[s * 2 + 1];
          v = hs[s * 2] + (pp ? pp * pv[s * 90 + i] : 0);
        } else {
          if (kind === K) { if (s === 0) kR = i; else kB = i; continue; }
          if (kind === H) { if (s === 0) HORSES_R[nhR++] = i; else HORSES_B[nhB++] = i; }
          v = kind === P ? pv[s * 90 + i] : simple && kind !== A ? simple[kind] : this.typeValue(kind, s, i, phase);
        }
        mat += s === side ? v : -v;
      }
      let score = mat;
      if (scan) {
        // hidden pieces whose every target square is attacked (engine countTrappedHidden)
        if (anyHidden) {
          for (let i = 0; i < 90; i++) {
            const c = b[i];
            if (!(c & HID)) continue;
            if (c < BLK) { if (this.trapped(i, attB)) trapR++; } else if (this.trapped(i, attR)) trapB++;
          }
        }
        const checkR = kR < 0 || attB[kR] === 1, checkB = kB < 0 || attR[kB] === 1;
        const red = side === 0;
        if (w.mobility) score += w.mobility * (red ? mobR - mobB : mobB - mobR);
        if (w.check) {
          if (red ? checkB : checkR) score += w.check;
          if (red ? checkR : checkB) score -= w.check;
        }
        if (w.hiddenTrapped) score += w.hiddenTrapped * (red ? trapB - trapR : trapR - trapB);
      }
      if (fw.kingSafety) {
        const opp = side ^ 1;
        const kS = side === 0 ? kR : kB, kO = side === 0 ? kB : kR;
        const hS = side === 0 ? HORSES_R : HORSES_B, nS = side === 0 ? nhR : nhB;
        const hO = side === 0 ? HORSES_B : HORSES_R, nO = side === 0 ? nhB : nhR;
        let s = 0;
        if (w.horseCheckThreat) s += w.horseCheckThreat * (this.horseCheckThreats(opp, kO, hS, nS) - this.horseCheckThreats(side, kS, hO, nO));
        if (w.cannonFacingKing) s += w.cannonFacingKing * (this.cannonFacing(opp, kO) - this.cannonFacing(side, kS));
        if (w.cannonEmptyFile) s += w.cannonEmptyFile * (this.cannonEmpty(opp, kO) - this.cannonEmpty(side, kS));
        if (w.centralCannon) s += w.centralCannon * (this.centralCannons(side, phase) - this.centralCannons(opp, phase));
        if (fw.cannonFile) {
          // step 16 (eval.js cannonFileTerms) – same order of operations
          this.cannonFileTerms(opp, kO, CF_O);
          this.cannonFileTerms(side, kS, CF_S);
          if (w.cannonFacingKingAway) s += w.cannonFacingKingAway * (CF_O[0] - CF_S[0]);
          if (w.cannonFile2) s += w.cannonFile2 * (CF_O[1] - CF_S[1]);
          if (w.palaceCenterControlled) s += w.palaceCenterControlled * (CF_O[2] - CF_S[2]);
        }
        score += s;
      }
      return score;
    }

    horseHits(from, to) {
      const dx = SX[to] - SX[from], dy = SY[to] - SY[from];
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (!((ax === 1 && ay === 2) || (ax === 2 && ay === 1))) return false;
      const lx = SX[from] + (ax === 2 ? Math.sign(dx) : 0), ly = SY[from] + (ay === 2 ? Math.sign(dy) : 0);
      return !this.b[ly * 9 + lx];
    }

    /** eval.js horseCheckThreats: squares the enemy Horses (list) can jump to and check side's King from, unguarded. */
    horseCheckThreats(side, k, horses, nh) {
      if (k < 0) return 0;
      const b = this.b, kx = SX[k], ky = SY[k], cap = this.fw.w.horseCheckCap;
      let total = 0;
      for (let hi = 0; hi < nh; hi++) {
        const i = horses[hi], h = b[i];
        const hx = SX[i], hy = SY[i];
        if (Math.abs(hx - kx) > 4 || Math.abs(hy - ky) > 4) continue;
        let n = 0;
        for (let j = 0; j < 8; j++) {
          const cx = kx - HORSE_JUMPS[j][0], cy = ky - HORSE_JUMPS[j][1];
          if (cx < 0 || cx > 8 || cy < 0 || cy > 9) continue;
          const c = cy * 9 + cx;
          if (b[c] || !this.horseHits(i, c)) continue;
          b[c] = h; b[i] = 0;
          const ok = this.horseHits(c, k) && !this.attacked(c, side);
          b[i] = h; b[c] = 0;
          if (ok) n++;
        }
        total += Math.min(n, cap);
      }
      return total;
    }

    cannonOnKingFile(side, k) {
      const b = this.b, x = SX[k], dir = side === 0 ? -1 : 1;
      let between = 0;
      for (let y = SY[k] + dir; y >= 0 && y < 10; y += dir) {
        const c = b[y * 9 + x];
        if (!c) continue;
        if ((c >> 4) !== side && !(c & HID) && (c & 7) === C) return between;
        between++;
        if (between > 1) return -1;
      }
      return -1;
    }
    /** eval.js cannonScreens: pieces between side's King and the nearest enemy revealed Cannon on its file (0..2) or -1. */
    cannonScreens(side, k) {
      if (k < 0) return -1;
      const b = this.b, x = SX[k], dir = side === 0 ? -1 : 1;
      let between = 0;
      for (let y = SY[k] + dir; y >= 0 && y < 10; y += dir) {
        const c = b[y * 9 + x];
        if (!c) continue;
        if ((c >> 4) !== side && !(c & HID) && (c & 7) === C) return between;
        between++;
        if (between > 2) return -1;
      }
      return -1;
    }
    cannonFileTerms(side, k, out) {
      out[0] = out[1] = out[2] = 0;
      const n = this.cannonScreens(side, k);
      if (n < 0) return out;
      if (n === 1 && k !== (side === 0 ? 85 : 4)) out[0] = 1;
      if (n === 2) out[1] = 1;
      if (this.fw.w.palaceCenterControlled) {
        const front = k + (side === 0 ? -9 : 9), fy = SY[front];
        const inPalace = side === 0 ? fy >= 7 : fy <= 2;
        if (inPalace && !this.b[front] && this.attacked(front, side ^ 1)) out[2] = 1;
      }
      return out;
    }
    cannonFacing(side, k) {
      if (k !== (side === 0 ? 85 : 4)) return 0;
      return this.cannonOnKingFile(side, k) === 1 ? 1 : 0;
    }
    cannonEmpty(side, k) { return k >= 0 && this.cannonOnKingFile(side, k) === 0 ? 1 : 0; }
    centralCannons(side, phase) {
      const b = this.b, opp = side ^ 1, y = opp === 0 ? 9 : 0;
      if (phase !== 0) return 0;
      let hidden = 0;
      for (const x of [2, 3, 5, 6]) { const c = b[y * 9 + x]; if (c && (c & HID) && (c >> 4) === opp) hidden++; }
      if (hidden < 2) return 0;
      let n = 0;
      const want = (side << 4) | C;
      for (let yy = 0; yy < 10; yy++) if (b[yy * 9 + 4] === want) n++;
      return n;
    }
  }
  const HS = new Float64Array(4), HS_DONE = new Uint8Array(2);
  const CF_S = new Int8Array(3), CF_O = new Int8Array(3);
  const HORSES_R = new Int16Array(16), HORSES_B = new Int16Array(16);

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.fastpos = { Position, unsupportedWeights, KIND, KCHAR, HID, BLK, SX, SY };
});
