/*
 * Priority order for revealing hidden pieces (player experience), shared by the bots: JieqiBots.lib.opening
 *
 *   1. hidden Pawn on an edge file (a, i)      5. hidden Horse
 *   2. hidden Pawn on file 3, 7 (c, g)         6. hidden Elephant moving to the edge (a / i)
 *   3. hidden Pawn on the centre file (e)      7. hidden Cannon moving straight forward
 *   4. hidden Advisor to the palace centre,    8. hidden Cannon moving sideways / backwards
 *      hidden Elephant to the centre (file e)  9. hidden Rook
 *
 * Applies as long as hidden pieces remain. The lower the rank, the earlier it should be revealed. "Don't reveal
 * into the enemy's mouth" is found by the search bot itself (quiescence); this table only orders safe moves.
 */
JieqiBots.module(function (root) {
  'use strict';

  /**
   * Priority rank (1..9) of reveal move m, or 0 if m is not a non-capturing reveal move.
   * pawnOrder: 'edge' (default: edge Pawns first, then files 3/7) or 'c37' (files 3/7 first, then edge Pawns).
   */
  function revealRank(state, J, m, pawnOrder = 'edge') {
    const p = state.board[m.from];
    if (!p || !p.hidden || state.board[m.to]) return 0;
    const fx = J.X(m.from), tx = J.X(m.to), fy = J.Y(m.from), ty = J.Y(m.to);
    switch (p.role) {
      case 'P': {
        const edge = fx === 0 || fx === 8, c37 = fx === 2 || fx === 6;
        if (pawnOrder === 'c37') return c37 ? 1 : edge ? 2 : 3;
        return edge ? 1 : c37 ? 2 : 3;
      }
      case 'A': return 4;
      case 'E': return tx === 4 ? 4 : 6;
      case 'H': return 5;
      case 'C': {
        const forward = p.side === 'r' ? ty < fy : ty > fy;
        return tx === fx && forward ? 7 : 8;
      }
      case 'R': return 9;
    }
    return 9;
  }

  /** Static rank of a hidden piece on its current square (independent of any move) – used for the "development" score. */
  function hiddenRank(p, x) {
    switch (p.role) {
      case 'P': return x === 0 || x === 8 ? 1 : x === 2 || x === 6 ? 2 : 3;
      case 'A': return 4;
      case 'E': return 4.5;
      case 'H': return 5;
      case 'C': return 7;
      case 'R': return 9;
    }
    return 9;
  }

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.opening = { revealRank, hiddenRank };
});
