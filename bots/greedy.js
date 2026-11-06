(function (root) {
  'use strict';
  const { VALUE, expectedHiddenValue, materialDiff } = root.JieqiBots.lib.common;

  root.JieqiBots.register({
    id: 'greedy',
    name: 'Bot tham ăn',
    description: 'Ăn quân giá trị nhất có thể, ưu tiên lật quân, không nhìn trước nước đối thủ.',
    params: {
      revealBonus: 0.3,     // điểm cộng cho nước lật quân úp
      drawThreshold: 0,     // nhận hoà khi chênh lệch quân <= ngưỡng này
    },
    chooseMove(state, J, ctx) {
      const moves = J.getLegalMoves(state);
      const hidden = expectedHiddenValue(state, J, J.opp(state.turn));
      let best = null, bestScore = -Infinity;
      for (const m of moves) {
        const target = state.board[m.to];
        let score = ctx.random() * 0.1; // phá thế hoà điểm
        if (target) score += target.hidden ? hidden : VALUE[target.type];
        if (state.board[m.from].hidden) score += ctx.params.revealBonus;
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return { move: best, info: { score: +bestScore.toFixed(2), depth: 1, nodes: moves.length } };
    },
    acceptDraw(state, J, ctx) {
      return materialDiff(state, J, ctx.side) <= ctx.params.drawThreshold;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
