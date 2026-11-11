/* Bản bot tìm kiếm ở bước 3 – giữ nguyên để làm mốc so sánh trong đấu trường (ẩn khỏi UI). */
/*
 * Bot tìm kiếm: alpha-beta (negamax) + nút may rủi khi lật quân (expectimax, cắt nhánh kiểu Star1)
 * + quiescence (tìm tiếp các nước ăn quân) + đào sâu dần theo thời gian.
 *
 * Tham số (ghi đè được qua spec, vd 'search:depth=3' hoặc 'search:maxTimeMs=500,R.endgame=11'):
 *   depth        >0: tìm đúng độ sâu này (tái lập được, không phụ thuộc máy); 0: theo thời gian
 *   maxDepth     độ sâu tối đa khi tìm theo thời gian
 *   maxTimeMs    trần thời gian mỗi nước (ms)
 *   timeScale    nhân thời gian gợi ý
 *   phaseTime    nhân thời gian theo giai đoạn { opening, middlegame, endgame }
 *   qDepth       số nửa nước tối đa của quiescence
 *   qHiddenPly   quân úp chỉ được ăn trong quiescence ở các nửa nước < giá trị này
 *   qCheckPly    xét đủ nước thoát chiếu trong quiescence ở các nửa nước < giá trị này
 *   deltaMargin  biên của delta pruning trong quiescence
 *   chanceBound  biên điểm dùng ở nút may rủi (điểm con bị kẹp vào [-b, b])
 *   + mọi trọng số của hàm đánh giá (bots/lib/eval.js): 'R.endgame', 'mobility', ...
 */
(function (root) {
  'use strict';
  const Bots = root.JieqiBots;
  const E = Bots.lib.eval;

  const INF = 1e9;
  const TIMEOUT = { timeout: true };
  const ORDER_VALUE = { K: 0, R: 9, C: 4.5, H: 4, A: 2, E: 1, P: 1 };
  const HIDDEN_ORDER_VALUE = 3;

  /**
   * Các kết cục của 1 nước, xác suất giảm dần. Chỉ tách theo quân MÌNH lật ra gì (vì nó quyết định
   * quân đó đi thế nào về sau). Ăn quân úp thì không tách: bàn cờ sau khi ăn như nhau với mọi danh tính,
   * và giữ nguyên pool cho ra đúng xác suất kỳ vọng (captureUnknown).
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
     * Giá trị của nước m theo góc nhìn bên đi. child(next, alpha, beta) trả về giá trị theo góc nhìn bên kia.
     * Nước có lật quân / ăn quân úp là nút may rủi: lấy kỳ vọng, cắt nhánh kiểu Star1.
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
        if (a >= U) return sum + rem * U;   // dù kết cục này tốt nhất cũng không vượt alpha
        if (b <= L) return sum + rem * L;   // dù kết cục này tệ nhất vẫn vượt beta
        const next = J.makeMove(state, m, { ...o.opts, fast: true });
        let v = -child(next, -b, -a);
        v = v > U ? U : v < L ? L : v;
        sum += pr * v; rem -= pr;
        if (v <= a) return sum + rem * U;   // fail-low: cận trên <= alpha
        if (v >= b) return sum + rem * L;   // fail-high: cận dưới >= beta
      }
      return sum;
    }

    function qsearch(state, alpha, beta, ply, qply) {
      checkTime();
      if (state.quietPlies >= 120) return 0;
      const inCheck = J.isInCheck(state);
      let best, moves;
      // chỉ xét đủ nước thoát chiếu ở vài nửa nước đầu (chuỗi chiếu liên tục sẽ làm bùng nổ cây)
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
          // quân úp chỉ được ăn ở qply đầu (mỗi lần lật tách 6 nhánh – tránh bùng nổ)
          if (qply >= p.qHiddenPly && state.board[m.from].hidden) continue;
          // delta pruning: ăn được quân này cũng không đủ vượt alpha
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
      if (!moves.length) return -(WIN - ply);       // bị chiếu bí / hết nước = thua
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

    /** Đào sâu dần. Trả về { move, score, depth, nodes }. */
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
          // nước tốt nhất cũ được tìm đầu tiên; nước nào đã vượt nó ở độ sâu mới thì dùng được
          if (iterBest && searched > 1 && iterBest !== best.move) best = { move: iterBest, score: iterScore, depth: depth - 1, partial: true };
          break;
        }
        best = { move: iterBest, score: iterScore, depth };
        // nước tốt lên đầu cho vòng sau
        rootMoves.sort((a, b) => (b === iterBest) - (a === iterBest) || b._s - a._s);
        if (Math.abs(iterScore) > MATE_ZONE) break;                 // đã thấy chiếu bí
        if (p.depth <= 0 && ctx.now() - t0 > timeMs * 0.45) break;  // vòng sau khó kịp xong
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
    hidden: true, // chỉ dùng làm đối thủ tham chiếu trong đấu trường, không hiện trong UI
    description: '[Tham chiếu] Bản bước 3, giữ lại để đo tiến bộ. Nhìn trước nhiều nước (alpha-beta + kỳ vọng khi lật quân + tìm tiếp khi đổi quân), đào sâu dần theo thời gian.',
    params: {
      depth: 0, maxDepth: 30, maxTimeMs: 2000, timeScale: 1,
      phaseTime: { opening: 1, middlegame: 1, endgame: 1 },
      qDepth: 6, qHiddenPly: 1, qCheckPly: 2, deltaMargin: 2, chanceBound: 30, drawThreshold: -0.5,
    },
    chooseMove(state, J, ctx) {
      const w = E.resolveWeights(ctx.params);
      const p = { ...ctx.params };
      for (const k of ['opening', 'middlegame', 'endgame']) {           // cho phép 'phaseTime.middlegame=2'
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

  // ── Các phong cách dùng chung thuật toán ──
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
})(typeof globalThis !== 'undefined' ? globalThis : this);
