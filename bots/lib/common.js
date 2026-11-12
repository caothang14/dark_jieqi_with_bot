/* Helpers shared by the bots: JieqiBots.lib.common */
JieqiBots.module(function (root) {
  'use strict';

  // Basic piece values (unit ~ 1 Pawn)
  const VALUE = { K: 1000, R: 9, C: 4.5, H: 4, E: 2, A: 2, P: 1 };

  /** Expected value of one hidden piece of `side` (average over the remaining pool). */
  function expectedHiddenValue(state, J, side, values = VALUE) {
    const probs = J.revealProbabilities(state, side);
    return Object.entries(probs).reduce((sum, [t, p]) => sum + p * values[t], 0);
  }

  /** Total material of `side` (King excluded); hidden pieces count at their expected value. */
  function material(state, J, side, values = VALUE) {
    const hv = expectedHiddenValue(state, J, side, values);
    let sum = 0;
    for (const p of state.board) {
      if (!p || p.side !== side || p.type === 'K') continue;
      sum += p.hidden ? hv : values[p.type];
    }
    return sum;
  }

  /** Material difference from `side`'s point of view (positive = ahead). */
  const materialDiff = (state, J, side, values = VALUE) =>
    material(state, J, side, values) - material(state, J, J.opp(side), values);

  const pick = (arr, random) => arr[Math.floor(random() * arr.length)];

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.common = { VALUE, expectedHiddenValue, material, materialDiff, pick };
});
