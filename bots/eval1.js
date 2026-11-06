/*
 * Bot đánh giá 1 nước: thử từng nước, chấm điểm thế cờ SAU nước đó bằng lib/eval.js,
 * lấy kỳ vọng qua mọi khả năng lật quân (quân mình lật ra gì, quân úp bị ăn là gì).
 * Chưa nhìn nước đáp trả của đối thủ – việc đó là của bot tìm kiếm (bước 3).
 */
(function (root) {
  'use strict';
  const E = root.JieqiBots.lib.eval;

  /** Các kết cục có thể của 1 nước: [{ prob, opts }] (opts = revealAs / captureAs cho makeMove). */
  function outcomes(state, J, m) {
    const mover = state.board[m.from];
    const target = state.board[m.to];
    let list = [{ prob: 1, opts: {} }];
    if (mover.hidden) {
      list = Object.entries(J.revealProbabilities(state, mover.side)).map(([t, p]) => ({ prob: p, opts: { revealAs: t } }));
    }
    if (target && target.hidden) {
      const caps = Object.entries(J.revealProbabilities(state, target.side));
      list = list.flatMap((o) => caps.map(([t, p]) => ({ prob: o.prob * p, opts: { ...o.opts, captureAs: t } })));
    }
    return list;
  }

  /** Điểm kỳ vọng (góc nhìn `me`) sau khi đi nước m. */
  function expectedScore(state, J, m, me, w) {
    let score = 0, nodes = 0;
    for (const { prob, opts } of outcomes(state, J, m)) {
      const next = J.makeMove(state, m, { ...opts, trusted: true });
      score += prob * E.evaluate(next, J, me, w);
      nodes++;
    }
    return { score, nodes };
  }

  root.JieqiBots.register({
    id: 'eval-1ply',
    name: 'Bot đánh giá (1 nước)',
    description: 'Chọn nước làm thế cờ tốt nhất theo hàm đánh giá (giá trị quân theo giai đoạn, cơ động, chiếu). Tính kỳ vọng khi lật quân, chưa nhìn nước đáp trả.',
    params: { drawThreshold: 0 },
    chooseMove(state, J, ctx) {
      const w = E.resolveWeights(ctx.params);
      const me = state.turn;
      let best = null, bestScore = -Infinity, nodes = 0;
      for (const m of J.getLegalMoves(state)) {
        const r = expectedScore(state, J, m, me, w);
        nodes += r.nodes;
        const score = r.score + ctx.random() * 1e-3; // phá thế hoà điểm
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return { move: best, info: { score: +bestScore.toFixed(2), depth: 1, nodes } };
    },
    acceptDraw(state, J, ctx) {
      return E.evaluate(state, J, ctx.side, E.resolveWeights(ctx.params)) <= ctx.params.drawThreshold;
    },
  });

  // Biến thể: chỉ tính quân (không cơ động, không chiếu) – để so xem các thành phần phụ có giúp ích không
  root.JieqiBots.variant('eval-1ply', {
    id: 'material-1ply',
    name: 'Bot chỉ đếm quân (1 nước)',
    description: 'Như "Bot đánh giá" nhưng chỉ tính giá trị quân (tắt cơ động và chiếu).',
    params: { mobility: 0, check: 0 },
  });

  root.JieqiBots.lib.search1 = { outcomes, expectedScore };
})(typeof globalThis !== 'undefined' ? globalThis : this);
