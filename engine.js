/*
 * Cờ tướng úp (Jieqi / 揭棋) – rules engine.
 * Pure logic, no DOM. Works in the browser (window.Jieqi) and in Node (require('./engine')).
 *
 * Board: 9 columns (x = 0..8) × 10 rows (y = 0..9). Square index = y * 9 + x.
 * Red ('r') is at the bottom (rows 5..9) and moves first. Black ('b') is at the top (rows 0..4).
 *
 * Piece types: K King (Tướng), A Advisor (Sĩ), E Elephant (Tượng), H Horse (Mã), R Rook (Xe),
 *              C Cannon (Pháo), P Pawn (Tốt).
 * A piece object: { side: 'r'|'b', type: <type>|null, hidden: bool, role: <type> }
 *   - role   = the type of the starting square (how a hidden piece moves)
 *   - type   = real identity, null while hidden (it is drawn from the side's pool when revealed)
 *
 * Rules implemented:
 *   - Both kings start face-up; the other 15 pieces of each side are face-down on the standard squares.
 *   - A face-down piece moves like the piece of its starting square (standard xiangqi rules,
 *     so a hidden Advisor stays in the palace and a hidden Elephant stays on its own side).
 *   - When it moves it is revealed; its identity is drawn at random from the side's remaining pool.
 *     (Drawing at reveal time has the same probabilities as shuffling at the start, and it makes
 *     chance nodes explicit for a future bot.)
 *   - A revealed Advisor / Elephant is NOT restricted to the palace / own half (common Jieqi rule).
 *   - Capturing a face-down piece reveals what it was (drawn from the owner's pool).
 *   - Flying-general rule, no moving into check. No legal moves = loss (checkmate or stalemate).
 *   - Repetition under the Chinese rules (中国象棋竞赛规则): see the "Repetition" section below.
 *   - Draw after 60 moves (120 plies) in a row with no capture and no reveal by either side (自然限着).
 */
(function (factory) {
  // The factory is also kept as source text for the bot Web Worker (bots/worker.js).
  (globalThis.JieqiSources = globalThis.JieqiSources || []).push({ name: 'engine.js', factory });
  factory(globalThis);
})(function (root) {
  'use strict';

  const W = 9, H = 10;
  const TYPES = ['K', 'A', 'E', 'H', 'R', 'C', 'P'];
  const START_POOL = { A: 2, E: 2, H: 2, R: 2, C: 2, P: 5 };
  const BACK_RANK = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  const DEFAULT_RULES = {
    repetition: 'chinese',  // 'chinese' | 'none'
    repetitionCount: 3,     // adjudicate when a position occurs for the N-th time
    naturalLimit: 120,      // plies in a row without capture/reveal → draw (60 moves)
  };

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

    const s = {
      board,
      turn: 'r',
      pools: { r: { ...START_POOL }, b: { ...START_POOL } },
      captured: { r: [], b: [] }, // captured[side] = pieces captured BY side
      ply: 0,
      quietPlies: 0,              // plies in a row without a capture / reveal
      lastMove: null,
      result: null, // { winner: 'r'|'b'|null, reason, detail? }
      seed,
      rng: seed,
      rules: { ...DEFAULT_RULES, ...(opts.rules || {}) },
      key: 0,
      rep: null,
    };
    [s.k1, s.k2] = positionKeyParts(s);
    s.key = combineKey(s.k1, s.k2);
    s.rep = { key: s.key, from: -1, to: -1, prev: null, len: 1 };
    return s;
  }

  // ---------- Position key (Zobrist) – used to detect repetition ----------
  const ZOB = (() => {
    let a = 0x9e3779b9;
    const r32 = () => { // mulberry32
      let t = (a = (a + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    const mk = (n) => { const x = new Uint32Array(n); for (let i = 0; i < n; i++) x[i] = r32(); return x; };
    return { a: mk(90 * 28), b: mk(90 * 28), turnA: r32(), turnB: r32(), poolA: mk(2 * 6 * 16), poolB: mk(2 * 6 * 16) };
  })();
  const ZCODE = { K: 0, A: 1, E: 2, H: 3, R: 4, C: 5, P: 6 };
  const ZPOOL = ['A', 'E', 'H', 'R', 'C', 'P'];

  /** Numeric (53-bit) position key: piece placement (hidden pieces by role), side to move, hidden pools. */
  function positionKey(state) {
    const [h1, h2] = positionKeyParts(state);
    return combineKey(h1, h2);
  }
  const combineKey = (h1, h2) => (h1 >>> 0) * 2097152 + (h2 & 0x1fffff);
  const pieceZ = (pc) => (pc.side === 'r' ? 0 : 14) + (pc.hidden ? 7 + ZCODE[pc.role] : ZCODE[pc.type]);

  function positionKeyParts(state) {
    let h1 = 0, h2 = 0;
    const board = state.board;
    for (let i = 0; i < 90; i++) {
      const pc = board[i];
      if (!pc) continue;
      const k = i * 28 + (pc.side === 'r' ? 0 : 14) + (pc.hidden ? 7 + ZCODE[pc.role] : ZCODE[pc.type]);
      h1 ^= ZOB.a[k]; h2 ^= ZOB.b[k];
    }
    if (state.turn === 'b') { h1 ^= ZOB.turnA; h2 ^= ZOB.turnB; }
    for (let s2 = 0; s2 < 2; s2++) {
      const pool = state.pools[s2 === 0 ? 'r' : 'b'];
      for (let t = 0; t < 6; t++) {
        const c = Math.min(15, pool[ZPOOL[t]] || 0);
        if (c) { const k = (s2 * 6 + t) * 16 + c; h1 ^= ZOB.poolA[k]; h2 ^= ZOB.poolB[k]; }
      }
    }
    return [h1, h2];
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

  /**
   * Writes the pseudo-legal target squares (self-check not filtered out) of the piece on square i into `out`
   * starting at index `n`; returns the end index. Allocation-free – meant for hot loops.
   */
  function genTargets(board, i, out, n) {
    const p = board[i];
    const side = p.side;
    const x = i % W, y = (i / W) | 0;
    let nx, ny, q, t;
    switch (p.hidden ? p.role : p.type) {
      case 'K':
        for (let d = 0; d < 4; d++) {
          nx = x + ORTH[d][0]; ny = y + ORTH[d][1];
          if (ny < 0 || ny >= H || !inPalace(side, nx, ny)) continue;
          t = ny * W + nx; q = board[t];
          if (!q || q.side !== side) out[n++] = t;
        }
        break;
      case 'A':
        for (let d = 0; d < 4; d++) {
          nx = x + DIAG[d][0]; ny = y + DIAG[d][1];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (p.hidden && !inPalace(side, nx, ny)) continue;
          t = ny * W + nx; q = board[t];
          if (!q || q.side !== side) out[n++] = t;
        }
        break;
      case 'E':
        for (let d = 0; d < 4; d++) {
          const dx = DIAG[d][0], dy = DIAG[d][1];
          nx = x + 2 * dx; ny = y + 2 * dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (board[(y + dy) * W + x + dx]) continue;           // Elephant's eye is blocked
          if (p.hidden && !onOwnHalf(side, ny)) continue;
          t = ny * W + nx; q = board[t];
          if (!q || q.side !== side) out[n++] = t;
        }
        break;
      case 'H':
        for (let d = 0; d < 4; d++) {
          const dx = ORTH[d][0], dy = ORTH[d][1];
          const lx = x + dx, ly = y + dy;
          if (lx < 0 || lx >= W || ly < 0 || ly >= H || board[ly * W + lx]) continue; // Horse's leg is blocked
          for (let s2 = -1; s2 <= 1; s2 += 2) {
            if (dx !== 0) { nx = x + 2 * dx; ny = y + s2; } else { nx = x + s2; ny = y + 2 * dy; }
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            t = ny * W + nx; q = board[t];
            if (!q || q.side !== side) out[n++] = t;
          }
        }
        break;
      case 'R':
        for (let d = 0; d < 4; d++) {
          const dx = ORTH[d][0], dy = ORTH[d][1];
          nx = x + dx; ny = y + dy;
          while (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            t = ny * W + nx; q = board[t];
            if (!q) out[n++] = t;
            else { if (q.side !== side) out[n++] = t; break; }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'C':
        for (let d = 0; d < 4; d++) {
          const dx = ORTH[d][0], dy = ORTH[d][1];
          let jumped = false;
          nx = x + dx; ny = y + dy;
          while (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            t = ny * W + nx; q = board[t];
            if (!jumped) {
              if (!q) out[n++] = t;
              else jumped = true;
            } else if (q) {
              if (q.side !== side) out[n++] = t;
              break;
            }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'P': {
        ny = y + (side === 'r' ? -1 : 1);
        if (ny >= 0 && ny < H) { t = ny * W + x; q = board[t]; if (!q || q.side !== side) out[n++] = t; }
        if (crossedRiver(side, y)) {
          for (let s2 = -1; s2 <= 1; s2 += 2) {
            nx = x + s2;
            if (nx < 0 || nx >= W) continue;
            t = y * W + nx; q = board[t];
            if (!q || q.side !== side) out[n++] = t;
          }
        }
        break;
      }
    }
    return n;
  }

  const TARGET_BUF = new Int16Array(64);

  /** Pseudo-legal target squares for the piece on square i (ignores self-check). */
  function pseudoTargets(board, i) {
    const n = genTargets(board, i, TARGET_BUF, 0);
    return Array.from(TARGET_BUF.subarray(0, n));
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

  /** Slow version (generate moves for every piece and check whether one hits the square) – kept for cross-checking in tests. */
  function isSquareAttackedSlow(board, sq, bySide) {
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (p && p.side === bySide && pseudoTargets(board, i).includes(sq)) return true;
    }
    return false;
  }

  const HORSE_ATTACKS = [ // [dx, dy] from the attacked square to the Horse, plus the Horse's "leg" [lx, ly]
    [2, 1, 1, 1], [2, -1, 1, -1], [-2, 1, -1, 1], [-2, -1, -1, -1],
    [1, 2, 1, 1], [-1, 2, -1, 1], [1, -2, 1, -1], [-1, -2, -1, -1],
  ];

  /**
   * Is square sq attacked by side `by`? Scans outward from sq (much faster than generating moves for every piece).
   * Hidden pieces attack according to their `role` (with the palace/river limits of hidden Advisors/Elephants).
   * Facing kings (same file, nothing in between) also count as an attack.
   */
  function isSquareAttacked(board, sq, by) {
    const x = X(sq), y = Y(sq);
    // Rook / Cannon / King (flying general) / Pawn (1 square) in 4 directions
    for (let d = 0; d < 4; d++) {
      const dx = ORTH[d][0], dy = ORTH[d][1];
      let nx = x + dx, ny = y + dy, dist = 1, screen = false;
      while (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const q = board[ny * W + nx];
        if (q) {
          if (!screen) {
            if (q.side === by) {
              const t = q.hidden ? q.role : q.type;
              if (t === 'R') return true;
              if (t === 'K') {
                if (dist === 1 && inPalace(by, x, y)) return true;                        // adjacent King (inside its palace)
                if (dx === 0 && board[sq] && board[sq].type === 'K') return true;         // flying general
              }
              if (t === 'P' && dist === 1) {
                const fwd = by === 'r' ? -1 : 1; // forward direction of the attacking side's Pawns
                if (dy === -fwd) return true;   // Pawn right "behind" the square (relative to its direction)
                if (dy === 0 && crossedRiver(by, ny)) return true;
              }
            }
            screen = true;
          } else {
            if (q.side === by && (q.hidden ? q.role : q.type) === 'C') return true;
            break;
          }
        }
        nx += dx; ny += dy; dist++;
      }
    }
    // Horse
    for (let k = 0; k < 8; k++) {
      const a = HORSE_ATTACKS[k];
      const hx = x + a[0], hy = y + a[1];
      if (hx < 0 || hx >= W || hy < 0 || hy >= H) continue;
      const q = board[hy * W + hx];
      if (!q || q.side !== by || (q.hidden ? q.role : q.type) !== 'H') continue;
      // Horse's leg: the square next to the Horse in the 2-step direction
      const lx = Math.abs(a[0]) === 2 ? hx - a[2] : hx;
      const ly = Math.abs(a[1]) === 2 ? hy - a[3] : hy;
      if (!board[ly * W + lx]) return true;
    }
    // Advisor (1 diagonal) and Elephant (2 diagonal, eye empty)
    for (let k = 0; k < 4; k++) {
      const dx = DIAG[k][0], dy = DIAG[k][1];
      const ax = x + dx, ay = y + dy;
      if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
      const q = board[ay * W + ax];
      if (q) {
        if (q.side === by && (q.hidden ? q.role : q.type) === 'A' && (!q.hidden || inPalace(by, x, y))) return true;
        continue; // Elephant's eye is blocked
      }
      const ex = x + 2 * dx, ey = y + 2 * dy;
      if (ex < 0 || ex >= W || ey < 0 || ey >= H) continue;
      const e = board[ey * W + ex];
      if (e && e.side === by && (e.hidden ? e.role : e.type) === 'E' && (!e.hidden || onOwnHalf(by, y))) return true;
    }
    return false;
  }

  function inCheckOnBoard(board, side, kingSq) {
    const k = kingSq != null ? kingSq : kingSquare(board, side);
    if (k < 0) return true;
    return isSquareAttacked(board, k, opp(side)); // includes the flying-general rule
  }

  const isInCheck = (state, side = state.turn) => inCheckOnBoard(state.board, side);

  // ---------- Move generation ----------
  /**
   * All legal moves for the side to move: [{ from, to }].
   * opts.capturesOnly – only moves that capture (for quiescence search)
   */
  const MOVE_BUF = new Int16Array(64);
  function getLegalMoves(state, opts) {
    const moves = getGeometricMoves(state, opts);
    if (opts && (opts.capturesOnly || opts.ignoreRepetition)) return moves;
    return filterRepetition(state, moves);
  }

  /** Geometrically legal moves (correct piece movement, no self-check), repetition rules not applied. */
  function getGeometricMoves(state, opts) {
    const side = state.turn;
    const board = state.board;
    const capturesOnly = !!(opts && opts.capturesOnly);
    const enemy = opp(side);
    const myKing = kingSquare(board, side);
    const moves = [];
    const buf = MOVE_BUF;
    for (let from = 0; from < board.length; from++) {
      const p = board[from];
      if (!p || p.side !== side) continue;
      const n = genTargets(board, from, buf, 0);
      for (let k = 0; k < n; k++) {
        const to = buf[k];
        const captured = board[to];
        if (capturesOnly && !captured) continue;
        // try the move in place and undo it (no board copy)
        board[to] = p;
        board[from] = null;
        const illegal = isSquareAttacked(board, p.type === 'K' ? to : myKing, enemy);
        board[from] = p;
        board[to] = captured;
        if (!illegal) moves.push({ from, to });
      }
    }
    return moves;
  }

  /**
   * Fast count of the pseudo-legal moves of `side` (self-check not filtered out).
   * Much cheaper than getLegalMoves – used for the mobility term of the evaluation.
   */
  const COUNT_BUF = new Int16Array(64);
  function countPseudoMoves(state, side) {
    const board = state.board;
    let n = 0;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (p && p.side === side) n = genTargets(board, i, COUNT_BUF, 0) + n;
    }
    return n;
  }

  /**
   * Hidden pieces of `side` that have pseudo-legal moves but every target square is attacked by the opponent
   * (on the current board) – they cannot be revealed safely. Allocation-free, stops at the first safe square.
   */
  const TRAP_BUF = new Int16Array(64);
  function countTrappedHidden(state, side) {
    const board = state.board, enemy = opp(side);
    let n = 0;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p || !p.hidden || p.side !== side) continue;
      const k = genTargets(board, i, TRAP_BUF, 0);
      if (!k) continue;
      let safe = false;
      for (let j = 0; j < k && !safe; j++) if (!isSquareAttacked(board, TRAP_BUF[j], enemy)) safe = true;
      if (!safe) n++;
    }
    return n;
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
   * opts.captureUnknown – capturing a hidden piece does not draw its identity (search only)
   * The result also carries: key (position key), rep (chain of positions since the last capture/reveal – for repetition).
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
      // captureUnknown: capture a hidden piece without drawing from the pool (search only – the pool ratios
      // stay exactly at their expectation). Then type = null and the pool may exceed the hidden pieces left on the board.
      const type = !target.hidden ? target.type
        : opts.captureUnknown ? null : drawFromPool(s, target.side, opts.captureAs);
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
    // Chain of positions since the last irreversible move (capture / reveal): only within this
    // span can a position repeat. Immutable linked list – cheap and shared between states.
    [s.k1, s.k2] = positionKeyParts(s);
    s.key = combineKey(s.k1, s.k2);
    s.rep = target || info.revealed || !state.rep
      ? { key: s.key, from: -1, to: -1, prev: null, len: 1 }
      : { key: s.key, from: move.from, to: move.to, prev: state.rep, len: state.rep.len + 1 };
    if (!opts.fast) s.result = computeResult(s);
    return s;
  }

  /**
   * Reveal every hidden piece left on the board (used after the game to see the real pieces).
   * Returns a NEW state; identities are drawn from the pool just like a normal reveal.
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
    const rules = s.rules || DEFAULT_RULES;
    if (getLegalMoves(s).length === 0) {
      // moves exist but all are forbidden repetitions → the violating side cannot deviate → loss
      const banned = forbiddenMoves(s);
      if (banned.length) return { winner: opp(s.turn), reason: banned[0].violation, detail: 'no-other-move' };
      return { winner: opp(s.turn), reason: isInCheck(s) ? 'checkmate' : 'stalemate' };
    }
    if (rules.repetition !== 'none') {
      const r = repetitionStatus(s);
      if (r && r.count >= rules.repetitionCount) {
        const mover = opp(s.turn);
        // Nobody violates (or both equally) → draw. The side that just moved is the violator (only possible when the
        // legality check was skipped) → loss. The violator is the side to move → game goes on, that side must deviate.
        if (!r.result.winner) return r.result;
        if (r.result.winner !== mover) return r.result;
      }
    }
    if (s.quietPlies >= rules.naturalLimit) return { winner: null, reason: 'quiet-limit' };
    return null;
  }

  /**
   * Chinese "must deviate" rule: a move that makes a position occur for the `repetitionCount`-th time while the mover
   * is the violating side (perpetual check, perpetual chase…) is not allowed. Returns the remaining moves.
   */
  function filterRepetition(state, moves) {
    const rules = state.rules;
    const head = state.rep;
    if (!rules || rules.repetition === 'none' || !head) return moves;
    const need = rules.repetitionCount - 1;       // times the child position must already have occurred
    if (head.len < need * 4) return moves;        // chain too short to repeat often enough
    // count positions with the same side to move as the child (odd distance from the current position)
    const counts = new Map();
    let maxCount = 0;
    for (let node = head.prev, d = 1; node; node = node.prev, d++) {
      if (d % 2 === 1) {
        const c = (counts.get(node.key) || 0) + 1;
        counts.set(node.key, c);
        if (c > maxCount) maxCount = c;
      }
    }
    if (maxCount < need) return moves;
    const [k1, k2] = state.k1 != null ? [state.k1, state.k2] : positionKeyParts(state);
    const out = [];
    for (const m of moves) {
      const p = state.board[m.from];
      if (state.board[m.to] || p.hidden) { out.push(m); continue; } // capture / reveal: cannot repeat
      const z = pieceZ(p);
      const h1 = k1 ^ ZOB.a[m.from * 28 + z] ^ ZOB.a[m.to * 28 + z] ^ ZOB.turnA;
      const h2 = k2 ^ ZOB.b[m.from * 28 + z] ^ ZOB.b[m.to * 28 + z] ^ ZOB.turnB;
      if ((counts.get(combineKey(h1, h2)) || 0) < need) { out.push(m); continue; }
      const st = repetitionStatus(makeMove(state, m, { fast: true }));
      if (st && st.result.winner === opp(state.turn)) continue; // mover is the violating side → forbidden
      out.push(m);
    }
    return out;
  }

  /** Moves forbidden by the repetition rules (so the UI can explain): [{ from, to, violation }]. */
  function forbiddenMoves(state) {
    const all = getGeometricMoves(state);
    if (!state.rep || all.length === 0) return [];
    const allowed = new Set(filterRepetition(state, all).map((m) => m.from * 90 + m.to));
    const out = [];
    for (const m of all) {
      if (allowed.has(m.from * 90 + m.to)) continue;
      const st = repetitionStatus(makeMove(state, m, { fast: true }));
      out.push({ from: m.from, to: m.to, violation: st ? st.violators[state.turn] : null });
    }
    return out;
  }

  // ---------- Repetition (Chinese rules) ----------
  /*
   * When a position repeats, classify each side's moves within the cycle (between its 2 latest occurrences):
   *   check  将  – gives check
   *   mate   杀  – mate threat: if the opponent "passed", there would be an immediate checkmate
   *   chase  捉  – creates a new PROFITABLE capture: the target has no defender (cannot be recaptured),
   *               or the target is worth more than the attacker (e.g. Horse/Cannon attacking a defended Rook).
   *               Not counted: King or Pawn as the attacker; attacking an uncrossed Pawn; offering a trade (兑).
   *   idle   闲  – every other move (including 兑, 献, 拦, 跟)
   * A side whose EVERY move in the cycle is check/mate/chase (长将, 长杀, 长捉, 一将一捉, 一将一杀,
   * 一杀一捉 …) violates the rules (禁止着法). Perpetual check is the most serious. The more serious violator
   * loses; equal violations or no violation → draw.
   */
  const CHASE_VALUE = { K: 100, R: 9, H: 4, C: 4, A: 2, E: 2, P: 1 };
  const HIDDEN_CHASE_VALUE = 3;
  const chaseValue = (p) => (p.hidden ? HIDDEN_CHASE_VALUE : CHASE_VALUE[p.type]);

  /** Squares of enemy pieces that `side` (to move) can capture PROFITABLY on `board`. */
  function chaseTargets(board, side, pools) {
    const out = new Set();
    const enemy = opp(side);
    for (const m of getLegalMoves({ board, turn: side, pools }, { capturesOnly: true })) {
      const a = board[m.from], v = board[m.to];
      const at = a.hidden ? a.role : a.type;
      if (at === 'K' || at === 'P') continue;                                  // King / Pawn attacking: counts as idle
      if (!v.hidden && v.type === 'P' && !crossedRiver(v.side, Y(m.to))) continue; // Pawn not across the river
      if (chaseValue(v) > chaseValue(a)) { out.add(m.to); continue; }          // attacking a more valuable piece: always profitable
      // is the target really defended: after the capture, can the opponent legally recapture?
      const b2 = board.slice();
      b2[m.to] = a; b2[m.from] = null;
      const recapture = getLegalMoves({ board: b2, turn: enemy, pools }, { capturesOnly: true }).some((x) => x.to === m.to);
      if (!recapture) out.add(m.to);
    }
    return out;
  }

  /** After `side` has moved (board `after`), if the opponent passed, could `side` checkmate immediately? */
  function threatensMate(after, side, pools) {
    const enemy = opp(side);
    for (const m of getLegalMoves({ board: after, turn: side, pools })) {
      if (after[m.from].hidden) continue; // hidden piece: identity unknown – not counted
      const b2 = after.slice();
      b2[m.to] = b2[m.from]; b2[m.from] = null;
      if (inCheckOnBoard(b2, enemy) && getLegalMoves({ board: b2, turn: enemy, pools }).length === 0) return true;
    }
    return false;
  }

  /** Classify one move of `side` (board before: `before`, after: `after`): 'check' | 'mate' | 'chase' | 'idle'. */
  function classifyMove(before, after, side, pools) {
    if (inCheckOnBoard(after, opp(side))) return 'check';
    if (threatensMate(after, side, pools)) return 'mate';
    const prev = chaseTargets(before, side, pools);
    for (const sq of chaseTargets(after, side, pools)) if (!prev.has(sq)) return 'chase';
    return 'idle';
  }

  /**
   * Repetition status of the current position, or null if the position has not occurred before.
   * { count, cycle: [{ side, from, to, kind }], violators: { r, b }, result }
   *   count  – how many times the current position has occurred (including now)
   *   result – ruling: winner = the non-violating side (the violator must deviate; if it has no other move
   *            it loses), or winner = null = draw
   */
  function repetitionStatus(state) {
    const head = state.rep;
    if (!head || head.len < 5) return null;
    let count = 1, cycleLen = 0;
    let node = head.prev, d = 1;
    while (node) {
      if (d % 2 === 0 && node.key === head.key) { count++; if (!cycleLen) cycleLen = d; }
      node = node.prev; d++;
    }
    if (count < 2) return null;

    // Rebuild the boards of the cycle by stepping backwards (no captures/reveals inside this chain)
    const boards = [state.board.slice()];
    const moves = [];
    node = head;
    for (let i = 0; i < cycleLen; i++) {
      const b = boards[i].slice();
      b[node.from] = b[node.to]; b[node.to] = null;
      moves.push({ from: node.from, to: node.to });
      boards.push(b);
      node = node.prev;
    }
    const cycle = [];
    for (let i = 0; i < cycleLen; i++) {
      // move i (counting back from now) turns boards[i+1] into boards[i]; mover = the side NOT to move in boards[i]
      const side = i % 2 === 0 ? opp(state.turn) : state.turn;
      const kind = classifyMove(boards[i + 1], boards[i], side, state.pools);
      cycle.unshift({ side, from: moves[i].from, to: moves[i].to, kind });
    }
    const violators = {};
    for (const side of ['r', 'b']) {
      const mine = cycle.filter((c) => c.side === side);
      if (!mine.length || mine.some((c) => c.kind === 'idle')) { violators[side] = null; continue; }
      const kinds = new Set(mine.map((c) => c.kind));
      violators[side] = kinds.size > 1 ? 'perpetual-attack'          // 一将一捉, 一将一杀, 一杀一捉 …
        : kinds.has('check') ? 'perpetual-check'                      // 长将
          : kinds.has('chase') ? 'perpetual-chase'                    // 长捉
            : 'perpetual-mate-threat';                                // 长杀
    }
    // Violation level: perpetual check (3) is more serious than other perpetual attacks (2); legal (0).
    // The more serious violator loses; equal levels (both or neither violating) → draw.
    // E.g. one side checks perpetually, the other runs with its King while keeping a mate threat → the checker loses.
    const level = (v) => (!v ? 0 : v === 'perpetual-check' ? 3 : 2);
    const lr = level(violators.r), lb = level(violators.b);
    let result;
    if (lr > lb) result = { winner: 'b', reason: violators.r };
    else if (lb > lr) result = { winner: 'r', reason: violators.b };
    else result = { winner: null, reason: 'repetition' };
    return { count, cycle, violators, result };
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
    getLegalMoves, getLegalMovesFrom, countPseudoMoves, makeMove, revealAll,
    positionKey, repetitionStatus, classifyMove, forbiddenMoves, DEFAULT_RULES,
    isInCheck, kingSquare, revealProbabilities, isSquareAttacked, pseudoTargets, countTrappedHidden,
    _debug: { isSquareAttackedSlow, kingsFacing },
    squareName, toAscii,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Jieqi = api;
});
