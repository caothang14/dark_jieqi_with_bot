/*
 * 1-ply evaluation bot: tries every move, scores the position AFTER it with lib/eval.js,
 * taking the expectation over every reveal outcome (what our piece turns out to be, what a captured hidden piece was).
 * Does not look at the opponent's reply – that is the search bot's job (step 3).
 */
(function (root) {
  'use strict';
  const E = root.JieqiBots.lib.eval;

  /** Possible outcomes of a move: [{ prob, opts }] (opts = revealAs / captureAs for makeMove). */
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

  /** Expected score (from `me`'s point of view) after playing move m. */
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
        const score = r.score + ctx.random() * 1e-3; // tie-breaker
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return { move: best, info: { score: +bestScore.toFixed(2), depth: 1, nodes } };
    },
    acceptDraw(state, J, ctx) {
      return E.evaluate(state, J, ctx.side, E.resolveWeights(ctx.params)) <= ctx.params.drawThreshold;
    },
  });

  // Variant: material only (no mobility, no check) – to see whether the extra terms help
  root.JieqiBots.variant('eval-1ply', {
    id: 'material-1ply',
    name: 'Bot chỉ đếm quân (1 nước)',
    description: 'Như "Bot đánh giá" nhưng chỉ tính giá trị quân (tắt cơ động và chiếu).',
    params: { mobility: 0, check: 0 },
  });

  root.JieqiBots.lib.search1 = { outcomes, expectedScore };
})(typeof globalThis !== 'undefined' ? globalThis : this);
