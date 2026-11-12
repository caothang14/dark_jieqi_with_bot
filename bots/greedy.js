JieqiBots.module(function (root) {
  'use strict';
  const E = root.JieqiBots.lib.eval;

  root.JieqiBots.register({
    id: 'greedy',
    name: 'Bot tham ăn',
    description: 'Ăn quân giá trị nhất có thể (theo bảng giá trị quân), ưu tiên lật quân, không nhìn trước nước đối thủ.',
    params: {
      revealBonus: 0.3,     // bonus for a move that reveals a hidden piece
      drawThreshold: 0,     // accept a draw when the material difference is <= this threshold
    },
    chooseMove(state, J, ctx) {
      const w = E.resolveWeights(ctx.params);
      const phase = E.gamePhase(state, w);
      const moves = J.getLegalMoves(state);
      let best = null, bestScore = -Infinity;
      for (const m of moves) {
        let score = ctx.random() * 0.1; // tie-breaker
        if (state.board[m.to]) score += E.pieceValue(state, J, m.to, w, phase);
        if (state.board[m.from].hidden) score += ctx.params.revealBonus;
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return { move: best, info: { score: +bestScore.toFixed(2), depth: 1, nodes: moves.length } };
    },
    acceptDraw(state, J, ctx) {
      const w = E.resolveWeights(ctx.params);
      return E.material(state, J, ctx.side, w) - E.material(state, J, J.opp(ctx.side), w) <= ctx.params.drawThreshold;
    },
  });
});
