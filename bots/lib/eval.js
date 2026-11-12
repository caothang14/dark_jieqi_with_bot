/*
 * Position evaluation shared by the bots: JieqiBots.lib.eval
 *
 *   const E = JieqiBots.lib.eval;
 *   const w = E.resolveWeights(ctx.params);        // default weights + overrides from params
 *   E.evaluate(state, J, 'r', w)                   // score from Red's point of view (positive = Red is better)
 *   E.explain(state, J, 'r', w)                    // { score, material, mobility, check, phase, pieces: [...] }
 *   E.pieceValue(state, J, square, w)              // value of one piece (hidden piece = expected value)
 *
 * Override weights via params (also in a bot spec): 'eval-1ply:R.endgame=11,mobility=0,P.crossed=2.5'
 */
JieqiBots.module(function (root) {
  'use strict';

  const DEFAULT_WEIGHTS = {
    // Pawn: own palace centre (blocks the King) / not crossed / crossed the river / bottomed out (opponent's last rank)
    P: { palaceCenter: -1, home: 1, crossed: 2, bottom: 0.5 },
    E: 1,                                              // Elephant
    A: { single: 2, paired: 3 },                       // Advisor; "paired" = 2 Advisors diagonally adjacent, protecting each other
    H: { opening: 3, middlegame: 4, endgame: 5 },      // Horse
    C: { opening: 5, middlegame: 4, endgame: 3 },      // Cannon
    R: { opening: 9.5, middlegame: 9, endgame: 10 },   // Rook
    // Game phase by the ratio of pieces left on the board / 32
    phase: { openingAbove: 0.9, middlegameAbove: 0.5 },
    hiddenBonus: 0,     // bonus per piece still hidden ("mystery" value), off by default
    development: 0,     // penalty for still-hidden pieces by reveal priority (lib/opening.js): pieces that should be revealed
                        // early (edge Pawns) are penalised most, a hidden Rook barely at all. 0 = off
    crossedAE: 0,       // bonus for a revealed Advisor/Elephant across the river ("Sĩ/Tượng chiến"). 0 = off
    hiddenTrapped: 0,   // penalty per own hidden piece that has moves but every target square is attacked by the
                        // opponent – it cannot be revealed safely ("bị cấm"; the opponent controls it). 0 = off
    mobility: 0.02,     // score per legal move more than the opponent
    check: 0.3,         // score when giving check
    win: 1000,          // win score (checkmate / opponent has no moves)
  };

  const TOTAL_PIECES = 32;

  // ── Weights ────────────────────────────────────────────────────────────
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Merge DEFAULT_WEIGHTS with params.weights (object) and keys like 'R.endgame' / 'mobility' in params. */
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

  // ── Game phase ─────────────────────────────────────────────────────────
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

  // ── Piece values ───────────────────────────────────────────────────────
  const isPalaceCenter = (side, x, y) => x === 4 && y === (side === 'r' ? 8 : 1);
  const crossedRiver = (side, y) => (side === 'r' ? y <= 4 : y >= 5);
  const atBottom = (side, y) => (side === 'r' ? y === 0 : y === 9);

  /** A (revealed) Advisor of `side` diagonally adjacent to `sq` – excluding `sq` itself. */
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

  /** Value of a (revealed) piece of type `type` standing on square `sq`. */
  function typeValueAt(state, J, type, side, sq, phase, w) {
    const x = J.X(sq), y = J.Y(sq);
    switch (type) {
      case 'K': return 0; // the King is not part of material; losing it = loss (handled separately)
      case 'P':
        if (isPalaceCenter(side, x, y)) return w.P.palaceCenter;
        if (atBottom(side, y)) return w.P.bottom;
        return crossedRiver(side, y) ? w.P.crossed : w.P.home;
      case 'E': return w.E + (w.crossedAE && crossedRiver(side, y) ? w.crossedAE : 0);
      case 'A': return (hasPairedAdvisor(state, J, sq, side) ? w.A.paired : w.A.single)
        + (w.crossedAE && crossedRiver(side, y) ? w.crossedAE : 0);
      case 'H': return w.H[phase];
      case 'C': return w.C[phase];
      case 'R': return w.R[phase];
    }
    return 0;
  }

  /** Value of the piece on `sq`. Hidden piece = average over reveal probabilities (+ hiddenBonus). */
  function pieceValue(state, J, sq, w = DEFAULT_WEIGHTS, phase = gamePhase(state, w)) {
    const p = state.board[sq];
    if (!p) return 0;
    if (!p.hidden) return typeValueAt(state, J, p.type, p.side, sq, phase, w);
    // Note: a hidden piece revealed as an Advisor counts as a single Advisor (pairing unknown)
    let ev = 0;
    for (const [t, prob] of Object.entries(J.revealProbabilities(state, p.side))) {
      ev += prob * (t === 'A' ? w.A.single : typeValueAt(state, J, t, p.side, sq, phase, w));
    }
    return ev + w.hiddenBonus - developmentPenalty(p, J.X(sq), w);
  }

  /** Penalty for a still-hidden piece by reveal rank: rank 1 (edge Pawn) gets the full `development`, rank 9 (Rook) none. */
  function developmentPenalty(p, x, w) {
    if (!w.development) return 0;
    const op = root.JieqiBots.lib.opening;
    return op ? (w.development * (9 - op.hiddenRank(p, x))) / 8 : 0;
  }

  /** Total material of `side`. */
  function material(state, J, side, w = DEFAULT_WEIGHTS, phase = gamePhase(state, w)) {
    let sum = 0;
    for (let i = 0; i < state.board.length; i++) {
      const p = state.board[i];
      if (p && p.side === side) sum += pieceValue(state, J, i, w, phase);
    }
    return sum;
  }

  // ── Full evaluation ────────────────────────────────────────────────────
  function mobilityCount(state, J, side) {
    return J.countPseudoMoves(state, side);
  }

  /** Hidden pieces of `side` that have moves, but every target square is attacked by the opponent ("bị cấm"). */
  const trappedHidden = (state, J, side) => J.countTrappedHidden(state, side);
  const controlScore = (state, J, side, w) => (w.hiddenTrapped
    ? w.hiddenTrapped * (trappedHidden(state, J, J.opp(side)) - trappedHidden(state, J, side)) : 0);

  /**
   * Detailed breakdown from `side`'s point of view.
   * If the game is over (state.result), returns ±win (draw = 0).
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
    const ctl = controlScore(state, J, side, w);
    const score = mat + mob + chk + ctl;
    return { score, terminal: false, phase, material: mat, mobility: mob, check: chk, control: ctl, pieces };
  }

  // ── Fast version for search (same result as explain, without building the piece list) ──
  /** Value of a hidden piece of `side` = base + pawnProb * (Pawn value on that square). */
  function hiddenStats(state, J, side, phase, w) {
    const probs = J.revealProbabilities(state, side);
    let base = w.hiddenBonus, pawnProb = 0;
    for (const t in probs) {
      if (t === 'P') pawnProb = probs[t];
      else base += probs[t] * (t === 'A' ? w.A.single : t === 'E' ? w.E : w[t][phase]);
    }
    return { base, pawnProb };
  }

  /** Score from `side`'s point of view (positive = `side` is better). */
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
    if (w.hiddenTrapped) score += controlScore(state, J, side, w);
    return score;
  }

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.eval = {
    DEFAULT_WEIGHTS, resolveWeights, gamePhase, piecesOnBoard,
    typeValueAt, pieceValue, material, evaluate, explain, trappedHidden,
  };
});
