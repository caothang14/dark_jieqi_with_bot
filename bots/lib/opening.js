/*
 * Thứ tự ưu tiên khi lật quân úp (kinh nghiệm người chơi), dùng chung cho các bot: JieqiBots.lib.opening
 *
 *   1. Tốt úp ở cột biên (a, i)            5. Mã úp
 *   2. Tốt úp ở cột 3, 7 (c, g)            6. Tượng úp đi ra biên (a / i)
 *   3. Tốt úp ở cột giữa (e)               7. Pháo úp tiến thẳng
 *   4. Sĩ úp vào tâm cung,                 8. Pháo úp đi ngang / lùi
 *      Tượng úp vào giữa (cột e)           9. Xe úp
 *
 * Áp dụng suốt lúc còn quân úp. Hạng càng nhỏ càng nên lật sớm. Việc "không lật vào mồm quân địch"
 * do bot tìm kiếm tự thấy (quiescence), bảng này chỉ sắp thứ tự giữa các nước an toàn.
 */
(function (root) {
  'use strict';

  /** Hạng ưu tiên (1..9) của nước lật quân m, hoặc 0 nếu m không phải nước lật quân không ăn quân. */
  function revealRank(state, J, m) {
    const p = state.board[m.from];
    if (!p || !p.hidden || state.board[m.to]) return 0;
    const fx = J.X(m.from), tx = J.X(m.to), fy = J.Y(m.from), ty = J.Y(m.to);
    switch (p.role) {
      case 'P': return fx === 0 || fx === 8 ? 1 : fx === 2 || fx === 6 ? 2 : 3;
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

  /** Hạng tĩnh của một quân úp tại ô đang đứng (không xét nước đi) – dùng cho điểm "phát triển". */
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
})(typeof globalThis !== 'undefined' ? globalThis : this);
