/*
 * Tree search of the search bot on the fast mutable position (bots/lib/fastpos.js): JieqiBots.lib.fastsearch
 *
 * A faithful port of search() / qsearch() / qProbe() / moveValue() / repetitionScore() and the move ordering of
 * bots/search.js – same algorithm, same visiting order, same scores and node counts – but with make()/unmake() on one
 * position instead of a new engine state per node. The root (iterative deepening, root pruning, style rules) stays in
 * search.js and calls rootValue() for each root move.
 *
 * Moves are integers from * 90 + to.
 */
JieqiBots.module(function (root) {
  'use strict';
  const Bots = root.JieqiBots;

  const INF = 1e9;
  const NULL_WINDOW = 0.01;
  const EXACT = 0, LOWER = 1, UPPER = 2;
  // ORDER_VALUE of search.js by kind (index = kind: 1 K, 2 A, 3 E, 4 H, 5 R, 6 C, 7 P)
  const ORDER_VALUE = [0, 0, 2, 1, 4, 9, 4.5, 1];
  const HIDDEN_ORDER_VALUE = 3;
  const HID = 8, BLK = 16;
  const A = 2, E = 3, H = 4, R = 5, C = 6, P = 7;

  /** Params the fast tree does not implement (search.js then keeps the engine-state search). */
  function unsupportedParams(p) {
    return !!(p.qRevealUnknown || p.ttKeep || (p.revealSkipRoles && p.revealSkipRoles.length));
  }

  /**
   * J: engine, ctx: bot ctx (params, now), w: evaluation weights, state: root engine state, TIMEOUT: the object thrown
   * when the deadline passes (the root catches it).
   */
  function createFastTree(J, ctx, w, state, TIMEOUT) {
    const FP = Bots.lib.fastpos;
    const p = ctx.params;
    const WIN = w.win;
    const MATE_ZONE = WIN - 500;
    const BOUND = p.chanceBound;
    const history = new Int32Array(90 * 90);
    const killers = [];
    const TT = new Map();
    const repCache = new Map();
    let pos = new FP.Position(J, state, w);
    const SX = FP.SX, SY = FP.SY;
    let nodes = 0;
    let deadline = Infinity;
    const limit = (state.rules && state.rules.naturalLimit) || 120;
    const repetitionOff = !!(state.rules && state.rules.repetition === 'none');

    function checkTime() {
      if ((++nodes & 127) === 0 && ctx.now() > deadline) throw TIMEOUT;
    }

    // ── Move ordering (search.js orderScore / orderMoves) ──
    const pov = (c) => (c & HID ? HIDDEN_ORDER_VALUE : ORDER_VALUE[c & 7]);
    function revealRank(from, to, c) {
      const fx = SX[from], tx = SX[to], fy = SY[from], ty = SY[to];
      switch (c & 7) {
        case P: {
          const edge = fx === 0 || fx === 8, c37 = fx === 2 || fx === 6;
          if (p.pawnOrder === 'c37') return c37 ? 1 : edge ? 2 : 3;
          return edge ? 1 : c37 ? 2 : 3;
        }
        case A: return 4;
        case E: return tx === 4 ? 4 : 6;
        case H: return 5;
        case C: {
          const forward = c < BLK ? ty < fy : ty > fy;
          return tx === fx && forward ? 7 : 8;
        }
        case R: return 9;
      }
      return 9;
    }
    const OPENING = !!(p.openingOrder && Bots.lib.opening);
    function orderScore(m, ply) {
      const b = pos.b, from = (m / 90) | 0, to = m - from * 90;
      const mover = b[from], target = b[to];
      if (target) return 100000 + pov(target) * 100 - pov(mover);
      const k = killers[ply];
      if (k && (k[0] === m || k[1] === m)) return 90000 - (k[0] === m ? 0 : 1);
      if ((mover & HID) && OPENING) return 60000 - revealRank(from, to, mover) * 5000 + Math.min(4000, history[m]);
      return Math.min(80000, history[m]) + (mover & HID ? 50 : 0);
    }
    // per-ply buffers (one node per ply is active at a time): moves, their order scores, reveal outcomes
    const MAXPLY = 160;
    const MOVES = [], SCORES = [], OKINDS = [], OPROBS = [], OUPPER = [];
    for (let i = 0; i < MAXPLY; i++) {
      MOVES.push(new Int32Array(256)); SCORES.push(new Float64Array(256));
      OKINDS.push(new Int8Array(8)); OPROBS.push(new Float64Array(8)); OUPPER.push(new Float64Array(8));
    }

    /** Stable sort of moves[0..n) by decreasing order score (same order as Array.prototype.sort in search.js). */
    function orderMoves(moves, n, ttMove, ply, bufPly) {
      const sc = SCORES[bufPly];
      for (let i = 0; i < n; i++) sc[i] = ttMove && moves[i] === ttMove ? 1e9 : orderScore(moves[i], ply);
      for (let i = 1; i < n; i++) {        // insertion sort (stable); move lists are short
        const m = moves[i], s = sc[i];
        let j = i - 1;
        while (j >= 0 && sc[j] < s) { moves[j + 1] = moves[j]; sc[j + 1] = sc[j]; j--; }
        moves[j + 1] = m; sc[j + 1] = s;
      }
    }

    /**
     * Reveal outcomes of `side` (search.js outcomes) into the buffers of ply `bp`: kinds by decreasing probability,
     * ties in pool key order. Returns their number.
     */
    function outcomes(side, bp) {
      const o = pos.poolOrder[side], total = pos.poolTotal(side);
      const kinds = OKINDS[bp], probs = OPROBS[bp];
      let n = 0;
      for (let k = 0; k < o.length; k++) {
        const c = pos.pool[side * 8 + o[k]];
        if (c > 0) {
          const pr = c / total;
          let j = n++;
          while (j > 0 && probs[j - 1] < pr) { kinds[j] = kinds[j - 1]; probs[j] = probs[j - 1]; j--; }
          kinds[j] = o[k]; probs[j] = pr;
        }
      }
      return n;
    }

    /**
     * The child searches of search.js, without closures. cd = child depth:
     *   cd < 0  (quiescence node): child = qsearch(ply + 1, qply + 1), probe = qProbe(qply + 1)
     *   cd >= 0 (search node):     child = search(cd, ply + 1), probe = cd <= 0 ? qProbe(0) : probing search(cd)
     * They act on the position after the move.
     */
    function childValue(cd, alpha, beta, ply, qply) {
      return cd < 0 ? qsearch(alpha, beta, ply + 1, qply + 1) : search(cd, alpha, beta, ply + 1, false);
    }
    function probeValue(cd, ply, qply) {
      return cd < 0 ? qProbe(qply + 1) : cd <= 0 ? qProbe(0) : search(cd, -INF, INF, ply + 1, true);
    }

    /** Value of move m for the mover (search.js moveValue) at a node of ply `ply`. */
    function moveValue(m, alpha, beta, cd, ply, qply) {
      const from = (m / 90) | 0, to = m - from * 90;
      const mover = pos.b[from];
      if (!(mover & HID)) {
        pos.make(from, to, 0);
        try { return -childValue(cd, -beta, -alpha, ply, qply); } finally { pos.unmake(); }
      }
      const n = outcomes(mover >> 4, ply);
      const kinds = OKINDS[ply], probs = OPROBS[ply];
      if (n === 1) {
        pos.make(from, to, kinds[0]);
        try { return -childValue(cd, -beta, -alpha, ply, qply); } finally { pos.unmake(); }
      }
      const L = -BOUND;
      const U = OUPPER[ply];
      let remU = 0;
      for (let i = 0; i < n; i++) {
        let lb = -INF;
        if (p.probe) {
          pos.make(from, to, kinds[i]);
          try { lb = probeValue(cd, ply, qply); } finally { pos.unmake(); }
        }
        U[i] = lb > -INF ? Math.min(BOUND, Math.max(L, -lb)) : BOUND;
        remU += probs[i] * U[i];
      }
      if (remU <= alpha) return remU;
      let sum = 0, remP = 1;
      for (let i = 0; i < n; i++) {
        const pr = probs[i];
        remU -= pr * U[i]; remP -= pr;
        const aRaw = (alpha - sum - remU) / pr;
        const bRaw = (beta - sum - remP * L) / pr;
        if (aRaw >= U[i]) return sum + pr * U[i] + remU;
        if (bRaw <= L) return sum + pr * L + remP * L;
        const a = Math.max(L, aRaw), b = Math.min(U[i], bRaw);
        pos.make(from, to, kinds[i]);
        let v;
        try { v = -childValue(cd, -b, -a, ply, qply); } finally { pos.unmake(); }
        v = v > U[i] ? U[i] : v < L ? L : v;
        sum += pr * v;
        if (v <= aRaw) return sum + remU;
        if (v >= bRaw) return sum + remP * L;
      }
      return sum;
    }

    /** search.js repetitionScore on the current position. */
    function repetitionScore(ply) {
      const sp = pos.sp, len = pos.cLen[sp];
      if (len < 5 || repetitionOff) return null;
      const key = pos.cKey[sp];
      let seen = false;
      for (let d = 2; d < len; d += 2) if (pos.cKey[sp - d] === key) { seen = true; break; }
      if (!seen) return null;
      let res = repCache.get(key);
      if (res === undefined) { const st = J.repetitionStatus(pos.toState()); res = st ? st.result : null; repCache.set(key, res); }
      if (!res) return null;
      if (!res.winner) return 0;
      return res.winner === (pos.turn === 0 ? 'r' : 'b') ? WIN - ply : -(WIN - ply);
    }

    function qProbe(qply) {
      if (pos.quiet >= limit) return -INF;
      if (p.repetition && qply === 0 && repetitionScore(0) !== null) return -INF;
      if (qply < p.qCheckPly && pos.inCheck()) return -INF;
      return pos.evaluate(pos.turn);
    }

    function qsearch(alpha, beta, ply, qply) {
      checkTime();
      if (pos.quiet >= limit) return 0;
      if (p.repetition && qply === 0) { const rv = repetitionScore(ply); if (rv !== null) return rv; }
      const inCheck = pos.inCheck();
      const moves = MOVES[ply];
      let best, n;
      const evasion = inCheck && qply < p.qCheckPly;
      if (evasion) {
        n = pos.legalMoves(moves, false);
        if (!n) return -(WIN - ply);
        best = -INF;
      } else {
        const stand = pos.evaluate(pos.turn);
        if (stand >= beta || qply >= p.qDepth) return stand;
        if (stand > alpha) alpha = stand;
        best = stand;
        n = pos.legalMoves(moves, true);
      }
      orderMoves(moves, n, 0, 0, ply);
      for (let i = 0; i < n; i++) {
        const m = moves[i];
        if (!evasion) {
          const from = (m / 90) | 0, to = m - from * 90;
          if (qply >= p.qHiddenPly && (pos.b[from] & HID)) continue;
          const victim = pos.b[to];
          const gain = victim & HID ? HIDDEN_ORDER_VALUE : ORDER_VALUE[victim & 7];
          if (best + gain + p.deltaMargin < alpha) continue;
        }
        const v = moveValue(m, alpha, beta, -1, ply, qply);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }

    // ── helpers of search() ──
    function hasPieces(side) {
      const b = pos.b;
      for (let i = 0; i < 90; i++) {
        const c = b[i];
        if (c && (c >> 4) === side && ((c & HID) || ((c & 7) !== 1 && (c & 7) !== P))) return true;
      }
      return false;
    }
    const poolBig = (side) => pos.pool[side * 8 + R] + pos.pool[side * 8 + C] + pos.pool[side * 8 + H];
    function bigPiecesOut(side) {
      let n = 0;
      for (let i = 0; i < 90; i++) {
        const c = pos.b[i];
        if (c && (c >> 4) === side && !(c & HID) && ((c & 7) === R || (c & 7) === C || (c & 7) === H)) n++;
      }
      return n;
    }
    const isThreatened = (sq) => {
      const side = pos.b[sq] >> 4;
      return pos.attacked(sq, side ^ 1) && !pos.attacked(sq, side);
    };
    const ttStore = (key, depth, value, flag, move, ply) => {
      if (TT.size > p.ttSize) TT.clear();
      if (value > MATE_ZONE) value += ply; else if (value < -MATE_ZONE) value -= ply;
      const old = TT.get(key);
      if (!old || old.depth <= depth) TT.set(key, { depth, value, flag, move });
    };
    const ttValue = (e, ply) => (e.value > MATE_ZONE ? e.value - ply : e.value < -MATE_ZONE ? e.value + ply : e.value);

    function search(depth, alpha, beta, ply, probeOnly) {
      if (depth <= 0) return qsearch(alpha, beta, ply, 0);
      checkTime();
      if (pos.quiet >= limit) return 0;
      if (p.repetition) { const rv = repetitionScore(ply); if (rv !== null) return rv; }
      const key = p.tt ? pos.key() : 0;
      const e = p.tt ? TT.get(key) : null;
      if (e && e.depth >= depth) {
        const v = ttValue(e, ply);
        if (e.flag === EXACT) return v;
        if (e.flag === LOWER && (v >= beta || probeOnly)) return v;
        if (e.flag === UPPER && v <= alpha && !probeOnly) return v;
      }
      const moves = MOVES[ply];
      const n = pos.legalMoves(moves, false);
      if (!n) return -(WIN - ply);
      const inCheck = pos.inCheck();
      const side = pos.turn;

      if (p.nullMove && !probeOnly && !inCheck && depth >= p.nullMinDepth && beta < MATE_ZONE && beta > -MATE_ZONE
          && hasPieces(side)) {
        pos.makeNull();
        let v;
        try { v = -search(depth - 1 - p.nullR, -beta, -beta + NULL_WINDOW, ply + 1, false); } finally { pos.unmake(); }
        if (v >= beta) return v;
      }

      orderMoves(moves, n, e && e.move, ply, ply);
      if (probeOnly) return moveValue(moves[0], -INF, INF, depth - 1, ply, 0);
      const alpha0 = alpha;
      let best = -INF, bestMove = 0;
      let revealsSeen = 0;
      let revealK = p.revealTopK;
      const keepThreatenedHere = p.keepThreatened && poolBig(side) >= p.keepThreatenedMinBig;
      if (revealK > 0 && p.revealTopKDeveloped > 0 && bigPiecesOut(side) >= p.developedCount) {
        revealK = Math.min(revealK, p.revealTopKDeveloped);
      }
      for (let i = 0; i < n; i++) {
        const m = moves[i];
        const from = (m / 90) | 0, to = m - from * 90;
        const quiet = !pos.b[to];
        if (quiet && !inCheck && (pos.b[from] & HID)) {
          if (revealK > 0 && ++revealsSeen > revealK && best > -INF
              && !(keepThreatenedHere && isThreatened(from))) continue;
        }
        let v;
        if (p.lmr && depth >= p.lmrMinDepth && i >= p.lmrAfter && quiet && !inCheck) {
          v = moveValue(m, alpha, alpha + NULL_WINDOW, depth - 2, ply, 0);
          if (v > alpha) v = moveValue(m, alpha, beta, depth - 1, ply, 0);
        } else if (p.pvs && i > 0 && beta - alpha > NULL_WINDOW) {
          v = moveValue(m, alpha, alpha + NULL_WINDOW, depth - 1, ply, 0);
          if (v > alpha && v < beta) v = moveValue(m, alpha, beta, depth - 1, ply, 0);
        } else {
          v = moveValue(m, alpha, beta, depth - 1, ply, 0);
        }
        if (v > best) { best = v; bestMove = m; }
        if (v > alpha) alpha = v;
        if (alpha >= beta) {
          if (quiet) {
            history[bestMove] += depth * depth;
            const k = killers[ply] || (killers[ply] = [0, 0]);
            if (k[0] !== bestMove) { k[1] = k[0]; k[0] = bestMove; }
          }
          break;
        }
      }
      if (p.tt) ttStore(key, depth, best, best >= beta ? LOWER : best <= alpha0 ? UPPER : EXACT, bestMove, ply);
      return best;
    }

    /**
     * Value of root move m ({from, to}) searched to `depth` (the root's moveValue with child = search(depth - 1)
     * and probe = qProbe / probing search).
     */
    function rootValue(m, alpha, beta, depth) {
      try {
        return moveValue(m.from * 90 + m.to, alpha, beta, depth - 1, 0, 0);
      } catch (err) {
        // the position is restored by the finally blocks; rebuild it anyway in case an error came from inside make()
        if (pos.sp !== pos.sp0) pos = new FP.Position(J, state, w);
        throw err;
      }
    }

    return {
      rootValue,
      setDeadline: (d) => { deadline = d; },
      nodes: () => nodes,
    };
  }

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.fastsearch = { createFastTree, unsupportedParams };
});
