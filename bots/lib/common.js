/* Helper dùng chung cho các bot: JieqiBots.lib.common */
(function (root) {
  'use strict';

  // Giá trị quân cơ bản (đơn vị ~ 1 Tốt)
  const VALUE = { K: 1000, R: 9, C: 4.5, H: 4, E: 2, A: 2, P: 1 };

  /** Giá trị kỳ vọng của 1 quân úp của `side` (trung bình theo pool còn lại). */
  function expectedHiddenValue(state, J, side, values = VALUE) {
    const probs = J.revealProbabilities(state, side);
    return Object.entries(probs).reduce((sum, [t, p]) => sum + p * values[t], 0);
  }

  /** Tổng giá trị quân (không tính Tướng) của `side`; quân úp tính theo giá trị kỳ vọng. */
  function material(state, J, side, values = VALUE) {
    const hv = expectedHiddenValue(state, J, side, values);
    let sum = 0;
    for (const p of state.board) {
      if (!p || p.side !== side || p.type === 'K') continue;
      sum += p.hidden ? hv : values[p.type];
    }
    return sum;
  }

  /** Chênh lệch quân theo góc nhìn của `side` (dương = đang hơn). */
  const materialDiff = (state, J, side, values = VALUE) =>
    material(state, J, side, values) - material(state, J, J.opp(side), values);

  const pick = (arr, random) => arr[Math.floor(random() * arr.length)];

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.common = { VALUE, expectedHiddenValue, material, materialDiff, pick };
})(typeof globalThis !== 'undefined' ? globalThis : this);
