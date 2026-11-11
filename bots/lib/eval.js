/*
 * Hàm đánh giá thế cờ dùng chung cho các bot: JieqiBots.lib.eval
 *
 *   const E = JieqiBots.lib.eval;
 *   const w = E.resolveWeights(ctx.params);        // trọng số mặc định + ghi đè từ params
 *   E.evaluate(state, J, 'r', w)                   // điểm theo góc nhìn Đỏ (dương = Đỏ hơn)
 *   E.explain(state, J, 'r', w)                    // { score, material, mobility, check, phase, pieces: [...] }
 *   E.pieceValue(state, J, square, w)              // giá trị 1 quân (quân úp = giá trị kỳ vọng)
 *
 * Ghi đè trọng số qua params (cả trong spec bot): 'eval-1ply:R.endgame=11,mobility=0,P.crossed=2.5'
 */
(function (root) {
  'use strict';

  const DEFAULT_WEIGHTS = {
    // Tốt: tâm cung mình (vướng Tướng) / chưa qua sông / đã qua sông / lụt (hàng cuối đối phương)
    P: { palaceCenter: -1, home: 1, crossed: 2, bottom: 0.5 },
    E: 1,                                              // Tượng
    A: { single: 2, paired: 3 },                       // Sĩ; "paired" = 2 Sĩ chéo cạnh nhau, bảo vệ nhau
    H: { opening: 3, middlegame: 4, endgame: 5 },      // Mã
    C: { opening: 5, middlegame: 4, endgame: 3 },      // Pháo
    R: { opening: 9.5, middlegame: 9, endgame: 10 },   // Xe
    // Giai đoạn theo tỉ lệ quân còn trên bàn / 32
    phase: { openingAbove: 0.9, middlegameAbove: 0.5 },
    hiddenBonus: 0,     // cộng thêm cho mỗi quân còn úp (giá trị "bí ẩn"), mặc định tắt
    development: 0,     // phạt quân còn úp theo thứ tự nên lật (lib/opening.js): quân nên lật sớm (Tốt biên)
                        // bị phạt nhiều nhất, Xe úp gần như không bị phạt. 0 = tắt
    mobility: 0.02,     // điểm cho mỗi nước đi hợp lệ hơn đối thủ
    check: 0.3,         // điểm khi đang chiếu đối thủ
    win: 1000,          // điểm thắng (chiếu bí / đối thủ hết nước)
  };

  const TOTAL_PIECES = 32;

  // ── Trọng số ───────────────────────────────────────────────────────────
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Gộp DEFAULT_WEIGHTS với params.weights (object) và các key dạng 'R.endgame' / 'mobility' trong params. */
  function resolveWeights(params = {}) {
    const w = clone(DEFAULT_WEIGHTS);
    const apply = (path, value) => {
      const keys = path.split('.');
      let o = w;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof o[keys[i]] !== 'object') return false;
        o = o[keys[i]];
      }
      if (!(keys[keys.length - 1] in o)) return false;
      o[keys[keys.length - 1]] = value;
      return true;
    };
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj || {})) {
        if (v && typeof v === 'object') walk(v, prefix + k + '.');
        else apply(prefix + k, v);
      }
    };
    walk(params.weights, '');
    for (const [k, v] of Object.entries(params)) if (k !== 'weights') apply(k, v);
    return w;
  }

  // ── Giai đoạn ván ──────────────────────────────────────────────────────
  function piecesOnBoard(state) {
    let n = 0;
    for (const p of state.board) if (p) n++;
    return n;
  }

  /** 'opening' | 'middlegame' | 'endgame' */
  function gamePhase(state, w = DEFAULT_WEIGHTS) {
    const ratio = piecesOnBoard(state) / TOTAL_PIECES;
    if (ratio > w.phase.openingAbove) return 'opening';
    if (ratio > w.phase.middlegameAbove) return 'middlegame';
    return 'endgame';
  }

  // ── Giá trị từng quân ──────────────────────────────────────────────────
  const isPalaceCenter = (side, x, y) => x === 4 && y === (side === 'r' ? 8 : 1);
  const crossedRiver = (side, y) => (side === 'r' ? y <= 4 : y >= 5);
  const atBottom = (side, y) => (side === 'r' ? y === 0 : y === 9);

  /** Sĩ (đã lật) của `side` ở ô chéo cạnh `sq` – ngoại trừ chính ô `sq`. */
  function hasPairedAdvisor(state, J, sq, side) {
    const x = J.X(sq), y = J.Y(sq);
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 8 || ny < 0 || ny > 9) continue;
      const q = state.board[J.idx(nx, ny)];
      if (q && q.side === side && !q.hidden && q.type === 'A') return true;
    }
    return false;
  }

  /** Giá trị của quân loại `type` (đã lật) nếu đứng ở ô `sq`. */
  function typeValueAt(state, J, type, side, sq, phase, w) {
    const x = J.X(sq), y = J.Y(sq);
    switch (type) {
      case 'K': return 0; // Tướng không tính vào chênh lệch quân; mất Tướng = thua (xử lý riêng)
      case 'P':
        if (isPalaceCenter(side, x, y)) return w.P.palaceCenter;
        if (atBottom(side, y)) return w.P.bottom;
        return crossedRiver(side, y) ? w.P.crossed : w.P.home;
      case 'E': return w.E;
      case 'A': return hasPairedAdvisor(state, J, sq, side) ? w.A.paired : w.A.single;
      case 'H': return w.H[phase];
      case 'C': return w.C[phase];
      case 'R': return w.R[phase];
    }
    return 0;
  }

  /** Giá trị quân ở ô `sq`. Quân úp = trung bình theo xác suất lật ra (+ hiddenBonus). */
  function pieceValue(state, J, sq, w = DEFAULT_WEIGHTS, phase = gamePhase(state, w)) {
    const p = state.board[sq];
    if (!p) return 0;
    if (!p.hidden) return typeValueAt(state, J, p.type, p.side, sq, phase, w);
    // Lưu ý: quân úp lật ra Sĩ thì tính như Sĩ đơn (chưa biết có cặp hay không)
    let ev = 0;
    for (const [t, prob] of Object.entries(J.revealProbabilities(state, p.side))) {
      ev += prob * (t === 'A' ? w.A.single : typeValueAt(state, J, t, p.side, sq, phase, w));
    }
    return ev + w.hiddenBonus - developmentPenalty(p, J.X(sq), w);
  }

  /** Phạt quân còn úp theo hạng ưu tiên lật: hạng 1 (Tốt biên) phạt đủ `development`, hạng 9 (Xe) không phạt. */
  function developmentPenalty(p, x, w) {
    if (!w.development) return 0;
    const op = root.JieqiBots.lib.opening;
    return op ? (w.development * (9 - op.hiddenRank(p, x))) / 8 : 0;
  }

  /** Tổng giá trị quân của `side`. */
  function material(state, J, side, w = DEFAULT_WEIGHTS, phase = gamePhase(state, w)) {
    let sum = 0;
    for (let i = 0; i < state.board.length; i++) {
      const p = state.board[i];
      if (p && p.side === side) sum += pieceValue(state, J, i, w, phase);
    }
    return sum;
  }

  // ── Đánh giá tổng ──────────────────────────────────────────────────────
  function mobilityCount(state, J, side) {
    return J.countPseudoMoves(state, side);
  }

  /**
   * Phân tích chi tiết theo góc nhìn `side`.
   * Nếu ván đã kết thúc (state.result) thì trả về ±win (hoà = 0).
   */
  function explain(state, J, side, w = DEFAULT_WEIGHTS) {
    const opp = J.opp(side);
    const phase = gamePhase(state, w);
    if (state.result) {
      const score = state.result.winner == null ? 0 : state.result.winner === side ? w.win : -w.win;
      return { score, terminal: true, phase, material: 0, mobility: 0, check: 0, pieces: [] };
    }
    const pieces = [];
    let mat = 0;
    for (let i = 0; i < state.board.length; i++) {
      const p = state.board[i];
      if (!p || p.type === 'K') continue;
      const v = pieceValue(state, J, i, w, phase);
      mat += p.side === side ? v : -v;
      pieces.push({ square: i, side: p.side, type: p.hidden ? null : p.type, hidden: p.hidden, value: +v.toFixed(2) });
    }
    const mob = w.mobility ? w.mobility * (mobilityCount(state, J, side) - mobilityCount(state, J, opp)) : 0;
    let chk = 0;
    if (w.check && J.isInCheck(state, opp)) chk += w.check;
    if (w.check && J.isInCheck(state, side)) chk -= w.check;
    const score = mat + mob + chk;
    return { score, terminal: false, phase, material: mat, mobility: mob, check: chk, pieces };
  }

  // ── Bản nhanh cho tìm kiếm (cùng kết quả với explain, không dựng danh sách quân) ──
  /** Giá trị quân úp của `side` = base + pawnProb * (giá trị Tốt tại ô đó). */
  function hiddenStats(state, J, side, phase, w) {
    const probs = J.revealProbabilities(state, side);
    let base = w.hiddenBonus, pawnProb = 0;
    for (const t in probs) {
      if (t === 'P') pawnProb = probs[t];
      else base += probs[t] * (t === 'A' ? w.A.single : t === 'E' ? w.E : w[t][phase]);
    }
    return { base, pawnProb };
  }

  /** Điểm theo góc nhìn `side` (dương = `side` đang hơn). */
  function evaluate(state, J, side, w = DEFAULT_WEIGHTS) {
    if (state.result) return state.result.winner == null ? 0 : state.result.winner === side ? w.win : -w.win;
    const phase = gamePhase(state, w);
    const hs = { r: null, b: null };
    let mat = 0;
    const board = state.board;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p || p.type === 'K') continue;
      let v;
      if (p.hidden) {
        const h = hs[p.side] || (hs[p.side] = hiddenStats(state, J, p.side, phase, w));
        v = h.base + (h.pawnProb ? h.pawnProb * typeValueAt(state, J, 'P', p.side, i, phase, w) : 0)
          - (w.development ? developmentPenalty(p, i % 9, w) : 0);
      } else {
        v = typeValueAt(state, J, p.type, p.side, i, phase, w);
      }
      mat += p.side === side ? v : -v;
    }
    const opp = J.opp(side);
    let score = mat;
    if (w.mobility) score += w.mobility * (mobilityCount(state, J, side) - mobilityCount(state, J, opp));
    if (w.check) {
      if (J.isInCheck(state, opp)) score += w.check;
      if (J.isInCheck(state, side)) score -= w.check;
    }
    return score;
  }

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.eval = {
    DEFAULT_WEIGHTS, resolveWeights, gamePhase, piecesOnBoard,
    typeValueAt, pieceValue, material, evaluate, explain,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
