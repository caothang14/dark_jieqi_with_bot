/*
 * Cờ tướng úp (Jieqi / 揭棋) – rules engine.
 * Pure logic, no DOM. Works in the browser (window.Jieqi) and in Node (require('./engine')).
 *
 * Board: 9 columns (x = 0..8) × 10 rows (y = 0..9). Square index = y * 9 + x.
 * Red ('r') is at the bottom (rows 5..9) and moves first. Black ('b') is at the top (rows 0..4).
 *
 * Piece types: K Tướng, A Sĩ, E Tượng, H Mã, R Xe, C Pháo, P Tốt.
 * A piece object: { side: 'r'|'b', type: <type>|null, hidden: bool, role: <type> }
 *   - role   = the type of the starting square (how a hidden piece moves)
 *   - type   = real identity, null while hidden (it is drawn from the side's pool when revealed)
 *
 * Rules implemented:
 *   - Both kings start face-up; the other 15 pieces of each side are face-down on the standard squares.
 *   - A face-down piece moves like the piece of its starting square (standard xiangqi rules,
 *     so a hidden Sĩ stays in the palace and a hidden Tượng stays on its own side).
 *   - When it moves it is revealed; its identity is drawn at random from the side's remaining pool.
 *     (Drawing at reveal time has the same probabilities as shuffling at the start, and it makes
 *     chance nodes explicit for a future bot.)
 *   - A revealed Sĩ / Tượng is NOT restricted to the palace / own half (common Jieqi rule).
 *   - Capturing a face-down piece reveals what it was (drawn from the owner's pool).
 *   - Flying-general rule, no moving into check. No legal moves = loss (checkmate or stalemate).
 *   - Draw after 120 plies without a capture or reveal (simple anti-loop rule).
 */
(function (root) {
  'use strict';

  const W = 9, H = 10;
  const TYPES = ['K', 'A', 'E', 'H', 'R', 'C', 'P'];
  const START_POOL = { A: 2, E: 2, H: 2, R: 2, C: 2, P: 5 };
  const BACK_RANK = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  const QUIET_PLY_LIMIT = 120;

  const NAMES_VI = { K: 'Tướng', A: 'Sĩ', E: 'Tượng', H: 'Mã', R: 'Xe', C: 'Pháo', P: 'Tốt' };
  const CHARS = {
    r: { K: '帥', A: '仕', E: '相', H: '傌', R: '俥', C: '炮', P: '兵' },
    b: { K: '將', A: '士', E: '象', H: '馬', R: '車', C: '砲', P: '卒' },
  };

  const idx = (x, y) => y * W + x;
  const X = (i) => i % W;
  const Y = (i) => (i / W) | 0;
  const opp = (side) => (side === 'r' ? 'b' : 'r');
  const onBoard = (x, y) => x >= 0 && x < W && y >= 0 && y < H;

  // ---------- RNG (mulberry32, state stored in the game state so games are reproducible) ----------
  function nextRandom(state) {
    let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---------- Setup ----------
  function createGame(opts = {}) {
    const seed = opts.seed != null ? opts.seed >>> 0 : (Math.random() * 4294967296) >>> 0;
    const board = new Array(W * H).fill(null);

    const place = (side, x, y, role) => {
      board[idx(x, y)] = role === 'K'
        ? { side, type: 'K', hidden: false, role: 'K' }
        : { side, type: null, hidden: true, role };
    };
    for (const side of ['r', 'b']) {
      const row = (ry) => (side === 'r' ? ry : 9 - ry); // ry measured from red's side
      BACK_RANK.forEach((role, x) => place(side, x, row(9), role));
      place(side, 1, row(7), 'C');
      place(side, 7, row(7), 'C');
      for (const x of [0, 2, 4, 6, 8]) place(side, x, row(6), 'P');
    }

    return {
      board,
      turn: 'r',
      pools: { r: { ...START_POOL }, b: { ...START_POOL } },
      captured: { r: [], b: [] }, // captured[side] = pieces captured BY side
      ply: 0,
      quietPlies: 0,
      lastMove: null,
      result: null, // { winner: 'r'|'b'|null, reason }
      seed,
      rng: seed,
    };
  }

  function cloneState(s) {
    return {
      ...s,
      board: s.board.map((p) => (p ? { ...p } : null)),
      pools: { r: { ...s.pools.r }, b: { ...s.pools.b } },
      captured: { r: s.captured.r.slice(), b: s.captured.b.slice() },
      lastMove: s.lastMove ? { ...s.lastMove } : null,
      result: s.result ? { ...s.result } : null,
    };
  }

  // ---------- Geometry helpers ----------
  const effType = (p) => (p.hidden ? p.role : p.type);
  const inPalace = (side, x, y) => x >= 3 && x <= 5 && (side === 'r' ? y >= 7 : y <= 2);
  const onOwnHalf = (side, y) => (side === 'r' ? y >= 5 : y <= 4);
  const crossedRiver = (side, y) => (side === 'r' ? y <= 4 : y >= 5);

  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  /** Pseudo-legal target squares for the piece on square i (ignores self-check). */
  function pseudoTargets(board, i) {
    const p = board[i];
    const x = X(i), y = Y(i);
    const out = [];
    const tryAdd = (nx, ny) => {
      if (!onBoard(nx, ny)) return;
      const q = board[idx(nx, ny)];
      if (!q || q.side !== p.side) out.push(idx(nx, ny));
    };

    switch (effType(p)) {
      case 'K':
        for (const [dx, dy] of ORTH) if (inPalace(p.side, x + dx, y + dy)) tryAdd(x + dx, y + dy);
        break;
      case 'A':
        for (const [dx, dy] of DIAG) {
          if (p.hidden && !inPalace(p.side, x + dx, y + dy)) continue;
          tryAdd(x + dx, y + dy);
        }
        break;
      case 'E':
        for (const [dx, dy] of DIAG) {
          const nx = x + 2 * dx, ny = y + 2 * dy;
          if (!onBoard(nx, ny) || board[idx(x + dx, y + dy)]) continue; // blocked "eye"
          if (p.hidden && !onOwnHalf(p.side, ny)) continue;
          tryAdd(nx, ny);
        }
        break;
      case 'H':
        for (const [dx, dy] of ORTH) {
          const lx = x + dx, ly = y + dy;
          if (!onBoard(lx, ly) || board[idx(lx, ly)]) continue; // blocked "leg"
          if (dx !== 0) { tryAdd(x + 2 * dx, y + 1); tryAdd(x + 2 * dx, y - 1); }
          else { tryAdd(x + 1, y + 2 * dy); tryAdd(x - 1, y + 2 * dy); }
        }
        break;
      case 'R':
        for (const [dx, dy] of ORTH) {
          let nx = x + dx, ny = y + dy;
          while (onBoard(nx, ny)) {
            const q = board[idx(nx, ny)];
            if (!q) out.push(idx(nx, ny));
            else { if (q.side !== p.side) out.push(idx(nx, ny)); break; }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'C':
        for (const [dx, dy] of ORTH) {
          let nx = x + dx, ny = y + dy, jumped = false;
          while (onBoard(nx, ny)) {
            const q = board[idx(nx, ny)];
            if (!jumped) {
              if (!q) out.push(idx(nx, ny));
              else jumped = true;
            } else if (q) {
              if (q.side !== p.side) out.push(idx(nx, ny));
              break;
            }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'P': {
        const fwd = p.side === 'r' ? -1 : 1;
        tryAdd(x, y + fwd);
        if (crossedRiver(p.side, y)) { tryAdd(x + 1, y); tryAdd(x - 1, y); }
        break;
      }
    }
    return out;
  }

  function kingSquare(board, side) {
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (p && p.side === side && p.type === 'K') return i;
    }
    return -1;
  }

  function kingsFacing(board) {
    const r = kingSquare(board, 'r'), b = kingSquare(board, 'b');
    if (r < 0 || b < 0 || X(r) !== X(b)) return false;
    for (let y = Y(b) + 1; y < Y(r); y++) if (board[idx(X(r), y)]) return false;
    return true;
  }

  function isSquareAttacked(board, sq, bySide) {
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (p && p.side === bySide && pseudoTargets(board, i).includes(sq)) return true;
    }
    return false;
  }

  function inCheckOnBoard(board, side) {
    const k = kingSquare(board, side);
    if (k < 0) return true;
    return kingsFacing(board) || isSquareAttacked(board, k, opp(side));
  }

  const isInCheck = (state, side = state.turn) => inCheckOnBoard(state.board, side);

  // ---------- Move generation ----------
  /** All legal moves for the side to move: [{ from, to }]. */
  function getLegalMoves(state) {
    const side = state.turn;
    const board = state.board;
    const moves = [];
    for (let from = 0; from < board.length; from++) {
      const p = board[from];
      if (!p || p.side !== side) continue;
      for (const to of pseudoTargets(board, from)) {
        const nb = board.slice();
        nb[to] = p;
        nb[from] = null;
        if (!inCheckOnBoard(nb, side)) moves.push({ from, to });
      }
    }
    return moves;
  }

  function getLegalMovesFrom(state, from) {
    return getLegalMoves(state).filter((m) => m.from === from);
  }

  // ---------- Hidden-identity pool ----------
  /** Probability of each identity for the next reveal of `side`: { R: 0.13, ... } */
  function revealProbabilities(state, side) {
    const pool = state.pools[side];
    const total = Object.values(pool).reduce((a, b) => a + b, 0);
    const out = {};
    for (const t in pool) if (pool[t] > 0) out[t] = pool[t] / total;
    return out;
  }

  function drawFromPool(state, side, forced) {
    const pool = state.pools[side];
    let type = forced;
    if (type) {
      if (!(pool[type] > 0)) throw new Error(`Cannot reveal ${type} for ${side}: none left in pool`);
    } else {
      const total = Object.values(pool).reduce((a, b) => a + b, 0);
      let r = nextRandom(state) * total;
      for (const t of Object.keys(pool)) {
        if (pool[t] <= 0) continue;
        if (r < pool[t]) { type = t; break; }
        r -= pool[t];
      }
      if (!type) type = Object.keys(pool).find((t) => pool[t] > 0);
    }
    pool[type]--;
    return type;
  }

  // ---------- Making moves ----------
  /**
   * Returns a NEW state (the input is not modified).
   * opts.revealAs  – force the identity of the moving hidden piece (for bots / replays)
   * opts.captureAs – force the identity of a captured hidden piece
   * opts.fast      – skip legality check and game-result computation (for bot search)
   * opts.trusted   – skip only the legality check (caller already validated the move)
   */
  function makeMove(state, move, opts = {}) {
    if (state.result && !opts.fast) throw new Error('Game is over');
    if (!opts.fast && !opts.trusted && !getLegalMoves(state).some((m) => m.from === move.from && m.to === move.to)) {
      throw new Error('Illegal move');
    }
    const s = cloneState(state);
    const p = s.board[move.from];
    const target = s.board[move.to];
    const info = {
      from: move.from, to: move.to, side: p.side,
      role: p.role, wasHidden: p.hidden, revealed: null, captured: null,
    };

    if (target) {
      const type = target.hidden ? drawFromPool(s, target.side, opts.captureAs) : target.type;
      info.captured = { side: target.side, type, wasHidden: target.hidden };
      s.captured[p.side].push(info.captured);
    }
    if (p.hidden) {
      p.type = drawFromPool(s, p.side, opts.revealAs);
      p.hidden = false;
      info.revealed = p.type;
    }
    info.type = p.type;

    s.board[move.to] = p;
    s.board[move.from] = null;
    s.turn = opp(s.turn);
    s.ply++;
    s.quietPlies = target || info.revealed ? 0 : s.quietPlies + 1;
    s.lastMove = info;
    if (!opts.fast) s.result = computeResult(s);
    return s;
  }

  /**
   * Lật hết quân úp còn trên bàn (dùng khi hết ván để xem quân thật).
   * Trả về state MỚI; danh tính rút từ pool như khi lật bình thường.
   */
  function revealAll(state) {
    const s = cloneState(state);
    s.board.forEach((p) => {
      if (p && p.hidden) {
        p.type = drawFromPool(s, p.side);
        p.hidden = false;
      }
    });
    return s;
  }

  function computeResult(s) {
    if (getLegalMoves(s).length === 0) {
      return { winner: opp(s.turn), reason: isInCheck(s) ? 'checkmate' : 'stalemate' };
    }
    if (s.quietPlies >= QUIET_PLY_LIMIT) return { winner: null, reason: 'quiet-limit' };
    return null;
  }

  // ---------- Notation / debugging ----------
  const FILES = 'abcdefghi';
  /** Square name from red's point of view: a0 = red's bottom-left corner. */
  const squareName = (i) => FILES[X(i)] + (9 - Y(i));

  function pieceChar(p) {
    if (p.hidden) return p.side === 'r' ? '?' : '¿';
    const c = { K: 'k', A: 'a', E: 'e', H: 'h', R: 'r', C: 'c', P: 'p' }[p.type];
    return p.side === 'r' ? c.toUpperCase() : c;
  }

  function toAscii(state) {
    const lines = [];
    for (let y = 0; y < H; y++) {
      let row = `${9 - y} `;
      for (let x = 0; x < W; x++) {
        const p = state.board[idx(x, y)];
        row += (p ? pieceChar(p) : '.') + ' ';
      }
      lines.push(row);
      if (y === 4) lines.push('  ~~~~~~~~~~~~~~~~~');
    }
    lines.push('  a b c d e f g h i');
    return lines.join('\n');
  }

  const api = {
    W, H, TYPES, START_POOL, NAMES_VI, CHARS,
    idx, X, Y, opp,
    createGame, cloneState,
    getLegalMoves, getLegalMovesFrom, makeMove, revealAll,
    isInCheck, kingSquare, revealProbabilities,
    squareName, toAscii,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Jieqi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
