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
 *   chanceBound  biên điểm ở nút may rủi (điểm con bị kẹp vào [-b, b])
 *   probe        thăm dò trước ở nút may rủi (Star2) – tắt để so sánh
 *   tt, ttSize   bảng ghi nhớ thế cờ đã tính (bật/tắt, số mục tối đa)
 *   nullMove, nullR, nullMinDepth   cắt nhánh bằng nước trống (cho đối thủ đi 2 lần)
 *   lmr, lmrMinDepth, lmrAfter      giảm 1 nước độ sâu cho các nước thường xếp sau
 *   pvs          tìm các nước sau nước đầu bằng cửa sổ hẹp (Principal Variation Search)
 *   repetition   hiểu luật lặp nước Trung Quốc (tránh chiếu dai/đuổi dai khi mình là bên phạm luật)
 *   openingOrder sắp xếp nước lật quân theo bảng ưu tiên (lib/opening.js)
 *   revealTopK   >0: dưới gốc chỉ xét K nước lật quân đứng đầu bảng ưu tiên (nước ăn quân luôn xét đủ)
 *   revealTopKRoot >0: ở gốc chỉ xét K nước lật quân đứng đầu bảng ưu tiên
 *   development  (trọng số hàm đánh giá) thưởng lật quân đúng thứ tự ưu tiên
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

  // ── Zobrist hashing: mỗi (ô, quân) một số ngẫu nhiên, XOR lại; 2 số 32-bit ghép thành khoá 53-bit ──
  const PIECE_CODE = { K: 0, A: 1, E: 2, H: 3, R: 4, C: 5, P: 6 };
  const POOL_TYPES = ['A', 'E', 'H', 'R', 'C', 'P'];
  const Z = (() => {
    const rnd = Bots.seededRandom(0x5eed);
    const r32 = () => (rnd() * 4294967296) >>> 0;
    const mk = (n) => { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = r32(); return a; };
    // piece key: side(2) × [7 loại đã lật + 7 role úp] = 28
    return { a: mk(90 * 28), b: mk(90 * 28), turnA: r32(), turnB: r32(), poolA: mk(2 * 6 * 16), poolB: mk(2 * 6 * 16) };
  })();
  function hashState(state) {
    let h1 = 0, h2 = 0;
    const board = state.board;
    for (let i = 0; i < 90; i++) {
      const pc = board[i];
      if (!pc) continue;
      const k = i * 28 + (pc.side === 'r' ? 0 : 14) + (pc.hidden ? 7 + PIECE_CODE[pc.role] : PIECE_CODE[pc.type]);
      h1 ^= Z.a[k]; h2 ^= Z.b[k];
    }
    if (state.turn === 'b') { h1 ^= Z.turnA; h2 ^= Z.turnB; }
    for (let s2 = 0; s2 < 2; s2++) {
      const pool = state.pools[s2 === 0 ? 'r' : 'b'];
      for (let t = 0; t < 6; t++) {
        const c = Math.min(15, pool[POOL_TYPES[t]] || 0);
        if (c) { const k = (s2 * 6 + t) * 16 + c; h1 ^= Z.poolA[k]; h2 ^= Z.poolB[k]; }
      }
    }
    return (h1 >>> 0) * 2097152 + (h2 & 0x1fffff);
  }

  const NULL_WINDOW = 0.01;
  const naturalLimit = (state) => (state.rules && state.rules.naturalLimit) || 120;
  /** Còn quân ngoài Tướng và Tốt (tránh null move ở tàn cuộc chỉ còn Tốt – dễ "zugzwang"). */
  function hasPieces(state, side) {
    for (const pc of state.board) if (pc && pc.side === side && (pc.hidden || (pc.type !== 'K' && pc.type !== 'P'))) return true;
    return false;
  }

  function createSearcher(J, ctx, w) {
    const p = ctx.params;
    const WIN = w.win;
    const MATE_ZONE = WIN - 500;
    const BOUND = p.chanceBound;
    const history = new Int32Array(90 * 90);
    const killers = [];                                   // killers[ply] = [m1, m2] (from*90+to)
    let nodes = 0;
    let deadline = Infinity;

    const pieceOrderValue = (pc) => (pc.hidden ? HIDDEN_ORDER_VALUE : ORDER_VALUE[pc.type]);

    const OP = Bots.lib.opening;
    function orderScore(state, m, ply) {
      const mover = state.board[m.from];
      const target = state.board[m.to];
      if (target) return 100000 + pieceOrderValue(target) * 100 - pieceOrderValue(mover); // MVV-LVA
      const k = killers[ply], code = m.from * 90 + m.to;
      if (k && (k[0] === code || k[1] === code)) return 90000 - (k[0] === code ? 0 : 1);
      if (mover.hidden && p.openingOrder && OP) {
        // nước lật quân: xếp theo bảng ưu tiên (hạng 1 trước), rồi mới đến history
        return 60000 - OP.revealRank(state, J, m) * 5000 + Math.min(4000, history[code]);
      }
      return Math.min(80000, history[code]) + (mover.hidden ? 50 : 0);
    }

    function orderMoves(state, moves, ttMove, ply = 0) {
      for (const m of moves) m._o = ttMove && m.from * 90 + m.to === ttMove ? 1e9 : orderScore(state, m, ply);
      return moves.sort((a, b) => b._o - a._o);
    }

    function checkTime() {
      if ((++nodes & 127) === 0 && ctx.now() > deadline) throw TIMEOUT;
    }

    // ── Bảng ghi nhớ (transposition table) ─────────────────────────────
    // Lưu kết quả các thế cờ đã tính: dùng lại khi gặp lại (qua thứ tự nước khác) và để
    // thử nước tốt nhất cũ trước ở vòng đào sâu sau.
    const TT = new Map();
    const EXACT = 0, LOWER = 1, UPPER = 2;
    const ttStore = (key, depth, value, flag, move, ply) => {
      if (TT.size > p.ttSize) TT.clear();
      // điểm chiếu bí lưu theo khoảng cách tới nút hiện tại
      if (value > MATE_ZONE) value += ply; else if (value < -MATE_ZONE) value -= ply;
      const old = TT.get(key);
      if (!old || old.depth <= depth) TT.set(key, { depth, value, flag, move });
    };
    const ttValue = (e, ply) => (e.value > MATE_ZONE ? e.value - ply : e.value < -MATE_ZONE ? e.value + ply : e.value);

    /**
     * Giá trị của nước m theo góc nhìn bên đi.
     *   child(next, alpha, beta) – giá trị theo góc nhìn bên kia (tìm đầy đủ)
     *   probe(next)              – cận DƯỚI rẻ cho bên kia (vd điểm đứng yên ở quiescence)
     * Nước có lật quân là nút may rủi: lấy kỳ vọng theo xác suất, cắt nhánh kiểu Star2:
     * thăm dò trước để có cận trên U_i cho từng kết cục, rồi tìm kỹ với cửa sổ hẹp.
     */
    function moveValue(state, m, alpha, beta, child, probe) {
      const outs = outcomes(state, J, m);
      if (outs.length === 1) {
        const next = J.makeMove(state, m, outs[0].opts ? { ...outs[0].opts, fast: true } : { fast: true });
        return -child(next, -beta, -alpha);
      }
      const L = -BOUND;
      const n = outs.length;
      const nexts = new Array(n), U = new Array(n);
      let remU = 0;
      for (let i = 0; i < n; i++) {
        nexts[i] = J.makeMove(state, m, { ...outs[i].opts, fast: true });
        const lb = p.probe ? probe(nexts[i]) : -INF;     // cận dưới cho đối thủ → cận trên cho mình
        U[i] = lb > -INF ? Math.min(BOUND, Math.max(L, -lb)) : BOUND;
        remU += outs[i].prob * U[i];
      }
      if (remU <= alpha) return remU;                    // thăm dò đã đủ chứng minh nước này kém
      let sum = 0, remP = 1;
      for (let i = 0; i < n; i++) {
        const pr = outs[i].prob;
        remU -= pr * U[i]; remP -= pr;
        // ngưỡng mà kết cục này phải vượt để tổng có thể > alpha / >= beta
        const aRaw = (alpha - sum - remU) / pr;
        const bRaw = (beta - sum - remP * L) / pr;
        if (aRaw >= U[i]) return sum + pr * U[i] + remU;  // kết cục này tốt nhất cũng không cứu được
        if (bRaw <= L) return sum + pr * L + remP * L;
        // cửa sổ cho nút con bị kẹp trong [L, U_i]; chạm biên KHÔNG có nghĩa là cắt nhánh
        const a = Math.max(L, aRaw), b = Math.min(U[i], bRaw);
        let v = -child(nexts[i], -b, -a);
        v = v > U[i] ? U[i] : v < L ? L : v;
        sum += pr * v;
        if (v <= aRaw) return sum + remU;                // fail-low: tổng chắc chắn <= alpha
        if (v >= bRaw) return sum + remP * L;            // fail-high: tổng chắc chắn >= beta
      }
      return sum;
    }

    /** Cận dưới rẻ cho bên đi ở nút quiescence: điểm đứng yên (trừ khi phải thoát chiếu). */
    function qProbe(state, qply) {
      if (state.quietPlies >= naturalLimit(state)) return -INF;
      // thế cờ lặp: điểm thật là điểm phân xử, không phải điểm đứng yên → không dùng làm cận
      if (p.repetition && qply === 0 && repetitionScore(state, 0) !== null) return -INF;
      if (qply < p.qCheckPly && J.isInCheck(state)) return -INF;
      return E.evaluate(state, J, state.turn, w);
    }

    function qsearch(state, alpha, beta, ply, qply) {
      checkTime();
      if (state.quietPlies >= naturalLimit(state)) return 0;
      if (p.repetition && qply === 0) { const rv = repetitionScore(state, ply); if (rv !== null) return rv; }
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
      const probe = (next) => qProbe(next, qply + 1);
      for (const m of moves) {
        if (!evasion) {
          // quân úp chỉ được ăn ở qply đầu (mỗi lần lật tách 6 nhánh – tránh bùng nổ)
          if (qply >= p.qHiddenPly && state.board[m.from].hidden) continue;
          // delta pruning: ăn được quân này cũng không đủ vượt alpha
          const victim = state.board[m.to];
          const gain = victim.hidden ? HIDDEN_ORDER_VALUE : ORDER_VALUE[victim.type];
          if (best + gain + p.deltaMargin < alpha) continue;
        }
        const v = moveValue(state, m, alpha, beta, child, probe);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }

    /**
     * Nút quyết định. probeOnly = chỉ tính nước đầu tiên (theo thứ tự) → trả về cận DƯỚI của nút,
     * dùng làm thăm dò cho nút may rủi phía trên.
     */
    /**
     * Lặp nước (luật Trung Quốc): thế cờ đã xuất hiện trước đó (trong ván hoặc trên nhánh đang tìm)
     * → phân xử luôn như khi lặp đủ số lần: bên phạm luật (chiếu dai, đuổi bắt dai…) thua, còn lại hoà.
     * Trả về điểm theo góc nhìn bên đi, hoặc null nếu không lặp.
     */
    const repCache = new Map();
    function repetitionScore(state, ply) {
      const head = state.rep;
      if (!head || head.len < 5 || (state.rules && state.rules.repetition === 'none')) return null;
      let node = head.prev, d = 1, seen = false;
      while (node) { if (d % 2 === 0 && node.key === head.key) { seen = true; break; } node = node.prev; d++; }
      if (!seen) return null;
      let res = repCache.get(head.key);
      if (res === undefined) { const st = J.repetitionStatus(state); res = st ? st.result : null; repCache.set(head.key, res); }
      if (!res) return null;
      if (!res.winner) return 0;
      return res.winner === state.turn ? WIN - ply : -(WIN - ply);
    }

    function search(state, depth, alpha, beta, ply, probeOnly) {
      if (depth <= 0) return qsearch(state, alpha, beta, ply, 0);
      checkTime();
      if (state.quietPlies >= naturalLimit(state)) return 0;
      if (p.repetition) { const rv = repetitionScore(state, ply); if (rv !== null) return rv; }
      const key = p.tt ? hashState(state) : 0;
      const e = p.tt ? TT.get(key) : null;
      if (e && e.depth >= depth) {
        const v = ttValue(e, ply);
        if (e.flag === EXACT) return v;
        if (e.flag === LOWER && (v >= beta || probeOnly)) return v;
        if (e.flag === UPPER && v <= alpha && !probeOnly) return v;
      }
      const moves = J.getLegalMoves(state);
      if (!moves.length) return -(WIN - ply);       // bị chiếu bí / hết nước = thua
      const inCheck = J.isInCheck(state);

      // Nước trống (null move): cho đối thủ đi 2 lần liền mà mình vẫn >= beta → cắt.
      if (p.nullMove && !probeOnly && !inCheck && depth >= p.nullMinDepth && beta < MATE_ZONE && beta > -MATE_ZONE
          && hasPieces(state, state.turn)) {
        const ns = { ...state, turn: J.opp(state.turn), quietPlies: state.quietPlies + 1, lastMove: null, rep: null };
        const v = -search(ns, depth - 1 - p.nullR, -beta, -beta + NULL_WINDOW, ply + 1, false);
        if (v >= beta) return v;
      }

      orderMoves(state, moves, e && e.move, ply);
      const child = (next, a, b) => search(next, depth - 1, a, b, ply + 1, false);
      const probe = depth - 1 <= 0
        ? (next) => qProbe(next, 0)
        : (next) => search(next, depth - 1, -INF, INF, ply + 1, true);
      if (probeOnly) return moveValue(state, moves[0], -INF, INF, child, probe);
      const childR = (next, a, b) => search(next, depth - 2, a, b, ply + 1, false);
      const probeR = depth - 2 <= 0
        ? (next) => qProbe(next, 0)
        : (next) => search(next, depth - 2, -INF, INF, ply + 1, true);
      const alpha0 = alpha;
      let best = -INF, bestMove = 0;
      let revealsSeen = 0;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const quiet = !state.board[m.to];
        // Bỏ bớt nước lật quân: ở các tầng dưới gốc chỉ xét revealTopK nước lật (không ăn quân) đứng đầu bảng
        // ưu tiên. Nước ăn quân, nước của quân đã lật và khi đang bị chiếu: luôn xét đủ.
        if (p.revealTopK > 0 && quiet && !inCheck && state.board[m.from].hidden && ++revealsSeen > p.revealTopK
            && best > -INF) continue;
        let v;
        // LMR: nước thường xếp sau → tìm nông hơn 1 nước với cửa sổ hẹp; tốt bất ngờ thì tìm lại đủ sâu
        if (p.lmr && depth >= p.lmrMinDepth && i >= p.lmrAfter && quiet && !inCheck) {
          v = moveValue(state, m, alpha, alpha + NULL_WINDOW, childR, probeR);
          if (v > alpha) v = moveValue(state, m, alpha, beta, child, probe);
        } else if (p.pvs && i > 0 && beta - alpha > NULL_WINDOW) {
          // PVS: chỉ cần chứng minh "không tốt hơn alpha" bằng cửa sổ hẹp; vượt thì tìm lại đầy đủ
          v = moveValue(state, m, alpha, alpha + NULL_WINDOW, child, probe);
          if (v > alpha && v < beta) v = moveValue(state, m, alpha, beta, child, probe);
        } else {
          v = moveValue(state, m, alpha, beta, child, probe);
        }
        if (v > best) { best = v; bestMove = m.from * 90 + m.to; }
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

    /** Đào sâu dần. Trả về { move, score, depth, nodes }. */
    function think(state, timeMs) {
      const t0 = ctx.now();
      deadline = p.depth > 0 ? Infinity : t0 + timeMs;
      const maxDepth = p.depth > 0 ? p.depth : p.maxDepth;
      let rootMoves = orderMoves(state, J.getLegalMoves(state));
      // Bỏ bớt ở gốc: chỉ giữ revealTopKRoot nước lật quân (không ăn quân) đứng đầu bảng ưu tiên
      if (p.revealTopKRoot > 0 && !J.isInCheck(state)) {
        let seen = 0;
        const kept = rootMoves.filter((m) => state.board[m.to] || !state.board[m.from].hidden || ++seen <= p.revealTopKRoot);
        if (kept.length) rootMoves = kept;
      }
      let best = { move: rootMoves[0], score: 0, depth: 0 };
      if (rootMoves.length === 1) return { ...best, nodes };

      for (let depth = 1; depth <= maxDepth; depth++) {
        let alpha = -INF, iterBest = null, iterScore = -INF, searched = 0;
        try {
          const child = (next, a, b) => search(next, depth - 1, a, b, 1, false);
          const probe = depth - 1 <= 0
            ? (next) => qProbe(next, 0)
            : (next) => search(next, depth - 1, -INF, INF, 1, true);
          for (const m of rootMoves) {
            let v;
            if (p.pvs && searched > 0) {
              v = moveValue(state, m, alpha, alpha + NULL_WINDOW, child, probe);
              if (v > alpha) v = moveValue(state, m, alpha, INF, child, probe);
            } else {
              v = moveValue(state, m, alpha, INF, child, probe);
            }
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
    id: 'search',
    name: 'Bot tìm kiếm',
    description: 'Nhìn trước nhiều nước (alpha-beta + kỳ vọng khi lật quân + tìm tiếp khi đổi quân), đào sâu dần theo thời gian.',
    params: {
      depth: 0, maxDepth: 30, maxTimeMs: 2000, timeScale: 1,
      phaseTime: { opening: 1, middlegame: 1, endgame: 1 },
      qDepth: 6, qHiddenPly: 1, qCheckPly: 2, deltaMargin: 2, chanceBound: 30, probe: true, tt: true, ttSize: 500000,
      nullMove: true, nullR: 2, nullMinDepth: 3, lmr: true, lmrMinDepth: 2, lmrAfter: 4, pvs: false, repetition: true,
      openingOrder: true, revealTopK: 4, revealTopKRoot: 8, drawThreshold: -0.5,
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
  Bots.variant('search', {
    id: 'search-v4', name: 'Bot tìm kiếm (bước 4)', hidden: true,
    description: '[Tham chiếu] Bản trước khi có ưu tiên lật quân – giữ lại để đo tiến bộ.',
    params: { openingOrder: false, revealTopK: 0, revealTopKRoot: 0 },
  });
  Bots.variant('search', {
    id: 'search-fast', name: 'Bot tìm kiếm (nhanh)',
    description: 'Như Bot tìm kiếm nhưng chỉ nghĩ tối đa 0,3 giây mỗi nước.',
    params: { maxTimeMs: 300 },
  });
  Bots.variant('search', {
    id: 'search-midgame', name: 'Bot tính lâu trung cuộc',
    description: 'Đi nhanh ở khai cuộc, dành gấp 2,5 lần thời gian cho trung cuộc.',
    params: { phaseTime: { opening: 0.5, middlegame: 2.5, endgame: 1.2 } },
  });
  Bots.variant('search', {
    id: 'search-endgame', name: 'Bot ưu tiên tàn cuộc',
    description: 'Đánh giá cao Mã, Xe, Tốt qua sông ở tàn cuộc (thích đổi quân để vào tàn cuộc), nghĩ lâu hơn khi vào tàn cuộc.',
    params: { 'H.endgame': 5.5, 'R.endgame': 11, 'P.crossed': 2.5, phaseTime: { opening: 0.8, middlegame: 1, endgame: 2 } },
  });

  Bots.lib.search = { createSearcher, outcomes, hashState };
})(typeof globalThis !== 'undefined' ? globalThis : this);
