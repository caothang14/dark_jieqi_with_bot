(function (root) {
  'use strict';
  const { pick } = root.JieqiBots.lib.common;

  root.JieqiBots.register({
    id: 'random',
    name: 'Bot ngẫu nhiên',
    description: 'Đi một nước hợp lệ bất kỳ. Dùng làm mốc so sánh thấp nhất.',
    params: { drawAcceptRate: 0.5 },
    chooseMove(state, J, ctx) {
      return pick(J.getLegalMoves(state), ctx.random);
    },
    acceptDraw(state, J, ctx) {
      return ctx.random() < ctx.params.drawAcceptRate;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
