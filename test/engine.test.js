// Run: node test/engine.test.js
const assert = require('assert');
const J = require('../engine');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('✓', name); };

const emptyGame = () => {
  const s = J.createGame({ seed: 1 });
  s.board = s.board.map(() => null);
  return s;
};
const put = (s, x, y, side, type, hidden = false, role = type) => {
  s.board[J.idx(x, y)] = { side, type: hidden ? null : type, hidden, role };
};

test('opening position has 44 legal moves (same as xiangqi)', () => {
  assert.strictEqual(J.getLegalMoves(J.createGame({ seed: 42 })).length, 44);
});

test('same seed -> same reveals', () => {
  const play = () => {
    let s = J.createGame({ seed: 7 });
    for (let i = 0; i < 20 && !s.result; i++) s = J.makeMove(s, J.getLegalMoves(s)[0]);
    return J.toAscii(s);
  };
  assert.strictEqual(play(), play());
});

test('moving a hidden piece reveals it and uses the pool', () => {
  let s = J.createGame({ seed: 3 });
  const from = J.idx(0, 9), to = J.idx(0, 8); // red hidden "rook" square
  s = J.makeMove(s, { from, to }, { revealAs: 'P' });
  assert.strictEqual(s.board[to].type, 'P');
  assert.strictEqual(s.board[to].hidden, false);
  assert.strictEqual(s.pools.r.P, 4);
});

test('hidden advisor stays in palace, revealed advisor can leave', () => {
  const s = emptyGame();
  put(s, 4, 9, 'r', 'K'); put(s, 3, 0, 'b', 'K');
  put(s, 3, 9, 'r', null, true, 'A');
  let targets = J.getLegalMovesFrom(s, J.idx(3, 9)).map((m) => J.squareName(m.to));
  assert.deepStrictEqual(targets, ['e1']);
  put(s, 3, 9, 'r', 'A');
  targets = J.getLegalMovesFrom(s, J.idx(3, 9)).map((m) => J.squareName(m.to)).sort();
  assert.deepStrictEqual(targets, ['c1', 'e1']);
});

test('revealed elephant may cross the river', () => {
  const s = emptyGame();
  put(s, 4, 9, 'r', 'K'); put(s, 3, 0, 'b', 'K');
  put(s, 2, 5, 'r', 'E');
  const t = J.getLegalMovesFrom(s, J.idx(2, 5)).map((m) => J.Y(m.to));
  assert.ok(t.includes(3));
});

test('flying general is illegal', () => {
  const s = emptyGame();
  put(s, 4, 9, 'r', 'K'); put(s, 3, 0, 'b', 'K');
  const t = J.getLegalMovesFrom(s, J.idx(4, 9)).map((m) => J.squareName(m.to));
  assert.ok(!t.includes('d0'));
});

test('flying general: moving the only blocker off the file is illegal', () => {
  const s = emptyGame();
  put(s, 4, 9, 'r', 'K'); put(s, 4, 0, 'b', 'K'); put(s, 4, 5, 'r', 'R');
  const t = J.getLegalMovesFrom(s, J.idx(4, 5)).map((m) => J.X(m.to));
  assert.ok(t.length > 0 && t.every((x) => x === 4), 'rook may only move along file e');
  s.board[J.idx(4, 5)] = null;
  assert.ok(J.isInCheck(s, 'r') && J.isInCheck(s, 'b'), 'facing kings = in check');
});

test('fast attack detection matches slow version (random games)', () => {
  const { isSquareAttackedSlow, kingsFacing } = J._debug;
  for (let g = 0; g < 30; g++) {
    let s = J.createGame({ seed: 1000 + g });
    let r = g + 1;
    while (!s.result && s.ply < 150) {
      for (let sq = 0; sq < 90; sq++) {
        const p = s.board[sq];
        if (!p) continue;
        const by = J.opp(p.side);
        const slow = isSquareAttackedSlow(s.board, sq, by) || (p.type === 'K' && kingsFacing(s.board));
        assert.strictEqual(J.isSquareAttacked(s.board, sq, by), slow, `game ${g} ply ${s.ply} sq ${J.squareName(sq)}`);
      }
      const moves = J.getLegalMoves(s);
      r = (r * 1103515245 + 12345) >>> 0;
      s = J.makeMove(s, moves[r % moves.length]);
    }
  }
});

test('captureUnknown removes a hidden piece without drawing from the pool', () => {
  let s = J.createGame({ seed: 2 });
  const from = J.idx(1, 7), to = J.idx(1, 0); // red (hidden) cannon captures the hidden piece on black's Horse square
  s = J.makeMove(s, { from, to }, { revealAs: 'C', captureUnknown: true });
  assert.strictEqual(s.lastMove.captured.type, null);
  assert.strictEqual(Object.values(s.pools.b).reduce((a, b) => a + b, 0), 15, 'black pool unchanged');
});

test('checkmate detected', () => {
  let s = emptyGame();
  put(s, 4, 0, 'b', 'K');
  put(s, 3, 9, 'r', 'K');
  put(s, 0, 1, 'r', 'R'); put(s, 8, 2, 'r', 'R');
  s = J.makeMove(s, { from: J.idx(8, 2), to: J.idx(8, 0) });
  assert.deepStrictEqual(s.result, { winner: 'r', reason: 'checkmate' });
});

test('revealAll reveals every hidden piece and empties the pools', () => {
  let s = J.createGame({ seed: 9 });
  s = J.makeMove(s, J.getLegalMoves(s)[0]);
  const r = J.revealAll(s);
  assert.ok(r.board.every((p) => !p || !p.hidden));
  assert.strictEqual(Object.values(r.pools.r).reduce((a, b) => a + b, 0), 0);
  assert.ok(s.board.some((p) => p && p.hidden)); // original untouched
  const count = (t) => r.board.filter((p) => p && p.side === 'r' && p.type === t).length;
  assert.strictEqual(count('P'), 5);
  assert.strictEqual(count('R'), 2);
});

test('100 random games: no crashes, pools stay consistent', () => {
  for (let g = 0; g < 100; g++) {
    let s = J.createGame({ seed: g });
    let rnd = g + 1;
    while (!s.result && s.ply < 400) {
      const moves = J.getLegalMoves(s);
      rnd = (rnd * 1103515245 + 12345) >>> 0;
      s = J.makeMove(s, moves[rnd % moves.length]);
      for (const side of ['r', 'b']) {
        const hiddenOnBoard = s.board.filter((p) => p && p.side === side && p.hidden).length;
        const poolSize = Object.values(s.pools[side]).reduce((a, b) => a + b, 0);
        assert.strictEqual(hiddenOnBoard, poolSize);
      }
    }
  }
});

/** Positions from random games (deterministic), for cross-checking fast code against reference versions. */
function* randomPositions(seeds = 40, plies = 150) {
  for (let seed = 1; seed <= seeds; seed++) {
    let s = J.createGame({ seed });
    for (let i = 0; i < plies && !s.result; i++) {
      yield s;
      const ms = J.getLegalMoves(s);
      s = J.makeMove(s, ms[(i * 7 + seed) % ms.length]);
    }
  }
}

test('speed-ups are exact: legal-move shortcut, attack map, trapped count, one-pass scan', () => {
  const key = (ms) => ms.map((m) => m.from * 90 + m.to).sort((a, b) => a - b).join(',');
  const map = new Uint8Array(90);
  for (const s of randomPositions()) {
    assert.strictEqual(key(J._debug.getGeometricMoves(s)), key(J._debug.getGeometricMovesSlow(s)));
    const sc = J.scanPosition(s, {});
    for (const by of ['r', 'b']) {
      J.attackMap(s.board, by, map);
      for (let q = 0; q < 90; q++) assert.strictEqual(!!map[q], J.isSquareAttacked(s.board, q, by));
      assert.strictEqual(J.countTrappedHidden(s, by), J._debug.countTrappedHiddenSlow(s, by));
      assert.strictEqual(by === 'r' ? sc.mobR : sc.mobB, J.countPseudoMoves(s, by));
      assert.strictEqual(by === 'r' ? sc.trapR : sc.trapB, J.countTrappedHidden(s, by));
      assert.strictEqual(by === 'r' ? sc.checkR : sc.checkB, J.isInCheck(s, by));
    }
  }
});

test('makeMove does not modify the input state or share the moving piece', () => {
  const s = J.createGame({ seed: 5 });
  const before = JSON.stringify(s.board);
  const n = J.makeMove(s, J.getLegalMoves(s)[0]);
  assert.strictEqual(JSON.stringify(s.board), before);
  assert.notStrictEqual(n.board[n.lastMove.to], s.board[n.lastMove.from]);
});

test('revealUnknown (search only): the moving hidden piece stays hidden, pool untouched', () => {
  const s = J.createGame({ seed: 1 });
  const n = J.makeMove(s, { from: J.idx(1, 7), to: J.idx(1, 0) }, { revealUnknown: true, captureUnknown: true, fast: true });
  assert.ok(n.board[J.idx(1, 0)].hidden && n.board[J.idx(1, 0)].role === 'C');
  assert.deepStrictEqual(n.pools, s.pools);
});

console.log(`\n${passed} tests passed`);
