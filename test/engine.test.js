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

test('checkmate detected', () => {
  let s = emptyGame();
  put(s, 4, 0, 'b', 'K');
  put(s, 3, 9, 'r', 'K');
  put(s, 0, 1, 'r', 'R'); put(s, 8, 2, 'r', 'R');
  s = J.makeMove(s, { from: J.idx(8, 2), to: J.idx(8, 0) });
  assert.deepStrictEqual(s.result, { winner: 'r', reason: 'checkmate' });
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

console.log(`\n${passed} tests passed`);
