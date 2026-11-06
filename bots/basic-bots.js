/*
 * Bot interface:
 *   { name: string, chooseMove(state, Jieqi) -> { from, to } }   (may also return a Promise)
 * `state` is a read-only game state; use Jieqi.getLegalMoves / Jieqi.makeMove to explore.
 * Register a bot by adding it to window.JieqiBots – it will show up in the UI dropdown.
 */
(function (root) {
  'use strict';
  const bots = (root.JieqiBots = root.JieqiBots || {});

  const VALUE = { K: 1000, R: 9, C: 4.5, H: 4, E: 2, A: 2, P: 1 };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  bots.random = {
    name: 'Bot ngẫu nhiên',
    chooseMove(state, J) {
      return pick(J.getLegalMoves(state));
    },
  };

  // Greedy 1-ply: prefer the most valuable capture, then reveals, else random.
  // Hidden enemy pieces are valued by their expected identity.
  bots.greedy = {
    name: 'Bot tham ăn (1 nước)',
    chooseMove(state, J) {
      const moves = J.getLegalMoves(state);
      const enemy = J.opp(state.turn);
      const expectedHidden = Object.entries(J.revealProbabilities(state, enemy))
        .reduce((sum, [t, p]) => sum + p * VALUE[t], 0);
      let best = [], bestScore = -Infinity;
      for (const m of moves) {
        const target = state.board[m.to];
        let score = Math.random() * 0.1;
        if (target) score += target.hidden ? expectedHidden : VALUE[target.type];
        if (state.board[m.from].hidden) score += 0.3;
        if (score > bestScore) { bestScore = score; best = [m]; }
      }
      return best[0];
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
