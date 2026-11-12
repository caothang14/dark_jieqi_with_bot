/* The step-3 search bot – kept unchanged as a reference for the arena (hidden from the UI). */
/*
 * Search bot: alpha-beta (negamax) + chance nodes for reveals (expectimax, Star1-style pruning)
 * + quiescence (keeps searching captures) + time-based iterative deepening.
 *
 * Params (overridable via the spec, e.g. 'search:depth=3' or 'search:maxTimeMs=500,R.endgame=11'):
 *   depth        >0: search exactly this depth (reproducible, machine-independent); 0: time-based
 *   maxDepth     maximum depth for time-based search
 *   maxTimeMs    time cap per move (ms)
 *   timeScale    multiplier on the suggested time
 *   phaseTime    time multiplier per game phase { opening, middlegame, endgame }
 *   qDepth       maximum quiescence depth in plies
 *   qHiddenPly   hidden pieces may capture in quiescence only at plies < this value
 *   qCheckPly    consider all check evasions in quiescence at plies < this value
 *   deltaMargin  delta-pruning margin in quiescence
 *   chanceBound  score bound used at chance nodes (child scores are clamped to [-b, b])
 *   + every evaluation weight (bots/lib/eval.js): 'R.endgame', 'mobility', ...
 */
JieqiBots.module(function (root) {
  'use strict';
  const Bots = root.JieqiBots;
  const E = Bots.lib.eval;

  const INF = 1e9;
  const TIMEOUT = { timeout: true };
  const ORDER_VALUE = { K: 0, R: 9, C: 4.5, H: 4, A: 2, E: 1, P: 1 };
  const HIDDEN_ORDER_VALUE = 3;

  /**
   * Outcomes of a move, by decreasing probability. Only split on what OUR piece is revealed as (since that decides
   * how it moves afterwards). Capturing a hidden piece does not split: the board after the capture is the same for
   * every identity, and leaving the pool unchanged gives exactly the expected probabilities (captureUnknown).
   */
  function outcomes(state, J, m) {
    const mover = state.board[m.from];
    const target = state.board[m.to];
    const cap = target && target.hidden ? { captureUnknown: true } : null;
    if (!mover.hidden) return [{ prob: 1, opts: cap }];
    const list = Object.entries(J.revealProbabilities(state, mover.side))
      .map(([t, p]) => ({ prob: p, opts: { ...cap, revealAs: t } }));
    return list.sort((a, b) => b.prob - a.prob);
  }

  function createSearcher(J, ctx, w) {
    const p = ctx.params;
    const WIN = w.win;
    const MATE_ZONE = WIN - 500;
    const BOUND = p.chanceBound;
    const history = new Int32Array(90 * 90);
    let nodes = 0;
    let deadline = Infinity;

    const pieceOrderValue = (pc) => (pc.hidden ? HIDDEN_ORDER_VALUE : ORDER_VALUE[pc.type]);

    function orderScore(state, m) {
      const mover = state.board[m.from];
      const target = state.board[m.to];
      if (target) return 100000 + pieceOrderValue(target) * 100 - pieceOrderValue(mover); // MVV-LVA
      return history[m.from * 90 + m.to] + (mover.hidden ? 50 : 0);
    }

    function orderMoves(state, moves) {
      for (const m of moves) m._o = orderScore(state, m);
      return moves.sort((a, b) => b._o - a._o);
    }

    function checkTime() {
      if ((++nodes & 127) === 0 && ctx.now() > deadline) throw TIMEOUT;
    }

    /**
     * Value of move m from the mover's point of view. child(next, alpha, beta) returns the value from the other side's view.
     * A move that reveals / captures a hidden piece is a chance node: take the expectation, Star1-style pruning.
     */
    function moveValue(state, m, alpha, beta, child) {
      const outs = outcomes(state, J, m);
      if (outs.length === 1) {
        const next = J.makeMove(state, m, outs[0].opts ? { ...outs[0].opts, fast: true } : { fast: true });
        return -child(next, -beta, -alpha);
      }
      const U = BOUND, L = -BOUND;
      let sum = 0, rem = 1;
      for (const o of outs) {
        const pr = o.prob;
        const a = Math.max(L, (alpha - sum - (rem - pr) * U) / pr);
        const b = Math.min(U, (beta - sum - (rem - pr) * L) / pr);
        if (a >= U) return sum + rem * U;   // even its best case cannot beat alpha
        if (b <= L) return sum + rem * L;   // even its worst case still beats beta
        const next = J.makeMove(state, m, { ...o.opts, fast: true });
        let v = -child(next, -b, -a);
        v = v > U ? U : v < L ? L : v;
        sum += pr * v; rem -= pr;
        if (v <= a) return sum + rem * U;   // fail-low: upper bound <= alpha
        if (v >= b) return sum + rem * L;   // fail-high: lower bound >= beta
      }
      return sum;
    }

    function qsearch(state, alpha, beta, ply, qply) {
      checkTime();
      if (state.quietPlies >= 120) return 0;
      const inCheck = J.isInCheck(state);
      let best, moves;
      // only consider all check evasions in the first few plies (long chains of checks would blow up the tree)
      const evasion = inCheck && qply < p.qCheckPly;
      if (evasion) {
        moves = J.getLegalMoves(state);
        if (!moves.length) return -(WIN - ply);
        best = -INF;
      } else {
        const stand = E.evaluate(state, J, state.turn, w);
        if (stand >= beta || qply >= p.qDepth) return stand;
        if (stand > alpha) alpha = stand;
        best = stand;
        moves = J.getLegalMoves(state, { capturesOnly: true });
      }
      orderMoves(state, moves);
      const child = (next, a, b) => qsearch(next, a, b, ply + 1, qply + 1);
      for (const m of moves) {
        if (!evasion) {
          // hidden pieces may only capture at the first qply (each reveal splits into 6 branches – avoid blow-up)
          if (qply >= p.qHiddenPly && state.board[m.from].hidden) continue;
          // delta pruning: even winning this piece cannot raise the score above alpha
          const victim = state.board[m.to];
          const gain = victim.hidden ? HIDDEN_ORDER_VALUE : ORDER_VALUE[victim.type];
          if (best + gain + p.deltaMargin < alpha) continue;
        }
        const v = moveValue(state, m, alpha, beta, child);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }

    function search(state, depth, alpha, beta, ply) {
      if (depth <= 0) return qsearch(state, alpha, beta, ply, 0);
      checkTime();
      if (state.quietPlies >= 120) return 0;
      const moves = J.getLegalMoves(state);
      if (!moves.length) return -(WIN - ply);       // checkmated / no moves = loss
      orderMoves(state, moves);
      const child = (next, a, b) => search(next, depth - 1, a, b, ply + 1);
      let best = -INF;
      for (const m of moves) {
        const v = moveValue(state, m, alpha, beta, child);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) {
          if (!state.board[m.to]) history[m.from * 90 + m.to] += depth * depth;
          break;
        }
      }
      return best;
    }

    /** Iterative deepening. Returns { move, score, depth, nodes }. */
    function think(state, timeMs) {
      const t0 = ctx.now();
      deadline = p.depth > 0 ? Infinity : t0 + timeMs;
      const maxDepth = p.depth > 0 ? p.depth : p.maxDepth;
      const rootMoves = orderMoves(state, J.getLegalMoves(state));
      let best = { move: rootMoves[0], score: 0, depth: 0 };
      if (rootMoves.length === 1) return { ...best, nodes };

      for (let depth = 1; depth <= maxDepth; depth++) {
        let alpha = -INF, iterBest = null, iterScore = -INF, searched = 0;
        try {
          const child = (next, a, b) => search(next, depth - 1, a, b, 1);
          for (const m of rootMoves) {
            const v = moveValue(state, m, alpha, INF, child);
            m._s = v;
            searched++;
            if (v > iterScore) { iterScore = v; iterBest = m; }
            if (v > alpha) alpha = v;
          }
        } catch (e) {
          if (e !== TIMEOUT) throw e;
          // the previous best move is searched first; a move that already beat it at the new depth can be used
          if (iterBest && searched > 1 && iterBest !== best.move) best = { move: iterBest, score: iterScore, depth: depth - 1, partial: true };
          break;
        }
        best = { move: iterBest, score: iterScore, depth };
        // best move first for the next iteration
        rootMoves.sort((a, b) => (b === iterBest) - (a === iterBest) || b._s - a._s);
        if (Math.abs(iterScore) > MATE_ZONE) break;                 // mate found
        if (p.depth <= 0 && ctx.now() - t0 > timeMs * 0.45) break;  // next iteration unlikely to finish
      }
      return { ...best, nodes };
    }

    return { think, stats: () => ({ nodes }) };
  }

  function thinkTime(state, ctx, w) {
    const p = ctx.params;
    const phase = E.gamePhase(state, w);
    const base = Math.min(ctx.timeBudgetMs || 1000, p.maxTimeMs);
    return Math.max(20, base * p.timeScale * (p.phaseTime[phase] || 1));
  }

  Bots.register({
    id: 'search-v3',
    name: 'Bot tìm kiếm (bước 3)',
    hidden: true, // only a reference opponent for the arena, not shown in the UI
    description: '[Tham chiếu] Bản bước 3, giữ lại để đo tiến bộ. Nhìn trước nhiều nước (alpha-beta + kỳ vọng khi lật quân + tìm tiếp khi đổi quân), đào sâu dần theo thời gian.',
    params: {
      depth: 0, maxDepth: 30, maxTimeMs: 2000, timeScale: 1,
      phaseTime: { opening: 1, middlegame: 1, endgame: 1 },
      qDepth: 6, qHiddenPly: 1, qCheckPly: 2, deltaMargin: 2, chanceBound: 30, drawThreshold: -0.5,
    },
    chooseMove(state, J, ctx) {
      const w = E.resolveWeights(ctx.params);
      const p = { ...ctx.params };
      for (const k of ['opening', 'middlegame', 'endgame']) {           // allow 'phaseTime.middlegame=2'
        if (p[`phaseTime.${k}`] != null) p.phaseTime = { ...p.phaseTime, [k]: p[`phaseTime.${k}`] };
      }
      const c = { ...ctx, params: p };
      const r = createSearcher(J, c, w).think(state, thinkTime(state, c, w));
      return { move: r.move, info: { score: +r.score.toFixed(2), depth: r.depth, nodes: r.nodes } };
    },
    acceptDraw(state, J, ctx) {
      return E.evaluate(state, J, ctx.side, E.resolveWeights(ctx.params)) <= ctx.params.drawThreshold;
    },
  });

  // ── Styles sharing the same algorithm ──
  if (0) Bots.variant('search', {
    id: 'search-fast', name: 'Bot tìm kiếm (nhanh)',
    description: 'Như Bot tìm kiếm nhưng chỉ nghĩ tối đa 0,3 giây mỗi nước.',
    params: { maxTimeMs: 300 },
  });
  if (0) Bots.variant('search', {
    id: 'search-midgame', name: 'Bot tính lâu trung cuộc',
    description: 'Đi nhanh ở khai cuộc, dành gấp 2,5 lần thời gian cho trung cuộc.',
    params: { phaseTime: { opening: 0.5, middlegame: 2.5, endgame: 1.2 } },
  });
  if (0) Bots.variant('search', {
    id: 'search-endgame', name: 'Bot ưu tiên tàn cuộc',
    description: 'Đánh giá cao Mã, Xe, Tốt qua sông ở tàn cuộc (thích đổi quân để vào tàn cuộc), nghĩ lâu hơn khi vào tàn cuộc.',
    params: { 'H.endgame': 5.5, 'R.endgame': 11, 'P.crossed': 2.5, phaseTime: { opening: 0.8, middlegame: 1, endgame: 2 } },
  });

  Bots.lib.searchV3 = { createSearcher, outcomes };
});
