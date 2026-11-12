// Run: node test/eval.test.js
const assert = require('assert');
const J = require('../engine');
const bots = require('../bots');
const E = bots.lib.eval;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);

const emptyGame = () => {
  const s = J.createGame({ seed: 1 });
  s.board = s.board.map(() => null);
  s.board[J.idx(4, 9)] = { side: 'r', type: 'K', hidden: false, role: 'K' };
  s.board[J.idx(3, 0)] = { side: 'b', type: 'K', hidden: false, role: 'K' };
  return s;
};
const put = (s, x, y, side, type) => {
  s.board[J.idx(x, y)] = { side, type, hidden: false, role: type };
  return J.idx(x, y);
};
const removeN = (s, n) => { // remove n non-King pieces
  let k = 0;
  for (let i = 0; i < s.board.length && k < n; i++) if (s.board[i] && s.board[i].type !== 'K') { s.board[i] = null; k++; }
  return s;
};
const W = E.DEFAULT_WEIGHTS;

test('phase: >90% opening, >50% middlegame, otherwise endgame', () => {
  assert.strictEqual(E.gamePhase(J.createGame()), 'opening');               // 32
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 3)), 'opening');   // 29 = 90.6%
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 4)), 'middlegame'); // 28 = 87.5%
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 15)), 'middlegame'); // 17 = 53%
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 16)), 'endgame');   // 16 = 50%
});

test('Pawn: own palace centre -1, not crossed 1, crossed 2, bottomed out 0.5', () => {
  const s = emptyGame();
  close(E.pieceValue(s, J, put(s, 4, 8, 'r', 'P')), -1, 'red pawn on palace centre');
  close(E.pieceValue(s, J, put(s, 0, 6, 'r', 'P')), 1, 'red pawn not crossed');
  close(E.pieceValue(s, J, put(s, 2, 9, 'r', 'P')), 1, 'red pawn on its own last rank');
  close(E.pieceValue(s, J, put(s, 2, 4, 'r', 'P')), 2, 'red pawn crossed');
  close(E.pieceValue(s, J, put(s, 6, 0, 'r', 'P')), 0.5, 'red pawn bottomed out');
  close(E.pieceValue(s, J, put(s, 4, 1, 'b', 'P')), -1, 'black pawn on palace centre');
  close(E.pieceValue(s, J, put(s, 8, 3, 'b', 'P')), 1, 'black pawn not crossed');
  close(E.pieceValue(s, J, put(s, 8, 5, 'b', 'P')), 2, 'black pawn crossed');
  close(E.pieceValue(s, J, put(s, 1, 9, 'b', 'P')), 0.5, 'black pawn bottomed out');
  close(E.pieceValue(s, J, put(s, 4, 1, 'r', 'P')), 2, 'red pawn on the opponent palace centre = crossed pawn');
});

test('Elephant 1', () => {
  const s = emptyGame();
  close(E.pieceValue(s, J, put(s, 2, 9, 'r', 'E')), 1);
  close(E.pieceValue(s, J, put(s, 4, 3, 'r', 'E')), 1, 'elephant across the river');
});

test('Advisor 2, paired advisors (diagonally adjacent) 3 each', () => {
  let s = emptyGame();
  const a = put(s, 3, 9, 'r', 'A');
  close(E.pieceValue(s, J, a), 2, 'single advisor');
  const b = put(s, 4, 8, 'r', 'A');
  close(E.pieceValue(s, J, a), 3, 'paired advisors');
  close(E.pieceValue(s, J, b), 3, 'paired advisors');
  s = emptyGame();
  close(E.pieceValue(s, J, put(s, 3, 9, 'r', 'A')), 2, 'two advisors on the same rank do not protect each other');
  put(s, 5, 9, 'r', 'A');
  close(E.pieceValue(s, J, J.idx(3, 9)), 2);
  s = emptyGame();
  put(s, 3, 9, 'r', 'A'); put(s, 4, 8, 'b', 'A');
  close(E.pieceValue(s, J, J.idx(3, 9)), 2, 'opponent advisor does not count');
});

test('Horse 3/4/5, Cannon 5/4/3, Rook 9.5/9/10 by phase', () => {
  const s = emptyGame();
  const sq = J.idx(4, 5);
  const v = (t, ph) => E.typeValueAt(s, J, t, 'r', sq, ph, W);
  assert.deepStrictEqual(['opening', 'middlegame', 'endgame'].map((ph) => v('H', ph)), [3, 4, 5]);
  assert.deepStrictEqual(['opening', 'middlegame', 'endgame'].map((ph) => v('C', ph)), [5, 4, 3]);
  assert.deepStrictEqual(['opening', 'middlegame', 'endgame'].map((ph) => v('R', ph)), [9.5, 9, 10]);
  // sparse board (2 Kings + 1 Rook) is an endgame
  close(E.pieceValue(s, J, put(s, 0, 5, 'r', 'R')), 10);
});

test('hidden piece = pool average, scored on its current square', () => {
  const s = J.createGame({ seed: 1 });
  // opening, Rook square (0,9): A2 E1 H3 R9.5 C5 P1 → (2*2 + 2*1 + 2*3 + 2*9.5 + 2*5 + 5*1)/15
  close(E.pieceValue(s, J, J.idx(0, 9)), (4 + 2 + 6 + 19 + 10 + 5) / 15);
});

test('starting position is balanced (score 0 for both sides)', () => {
  const s = J.createGame({ seed: 3 });
  close(E.evaluate(s, J, 'r'), 0);
  close(E.evaluate(s, J, 'b'), 0);
});

test('symmetry: Red score = - Black score', () => {
  let s = J.createGame({ seed: 4 });
  for (let i = 0; i < 30 && !s.result; i++) {
    const ms = J.getLegalMoves(s);
    s = J.makeMove(s, ms[(i * 7) % ms.length]);
    close(E.evaluate(s, J, 'r'), -E.evaluate(s, J, 'b'));
  }
});

test('override weights via params', () => {
  const w = E.resolveWeights({ 'R.endgame': 11, mobility: 0, weights: { P: { crossed: 2.5 } }, unknownKey: 1 });
  assert.strictEqual(w.R.endgame, 11);
  assert.strictEqual(w.R.opening, 9.5);
  assert.strictEqual(w.mobility, 0);
  assert.strictEqual(w.P.crossed, 2.5);
  assert.strictEqual(W.R.endgame, 10, 'defaults are not modified');
});

test('game over: win +1000, loss -1000', () => {
  let s = emptyGame();
  s.board = s.board.map(() => null);
  put(s, 4, 0, 'b', 'K'); put(s, 3, 9, 'r', 'K'); put(s, 0, 1, 'r', 'R'); put(s, 8, 2, 'r', 'R');
  s = J.makeMove(s, { from: J.idx(8, 2), to: J.idx(8, 0) });
  assert.strictEqual(E.evaluate(s, J, 'r'), 1000);
  assert.strictEqual(E.evaluate(s, J, 'b'), -1000);
});

test('bot does not capture a Pawn blocking the opponent palace centre', async () => {
  const s = emptyGame();
  s.board = s.board.map(() => null);
  put(s, 4, 0, 'b', 'K'); put(s, 3, 9, 'r', 'K');
  put(s, 4, 1, 'b', 'P');       // black pawn blocks black's palace centre (-1 for Black)
  put(s, 4, 5, 'r', 'R');       // red rook can capture this pawn
  put(s, 0, 3, 'b', 'P'); put(s, 8, 3, 'b', 'P');
  s.pools = { r: {}, b: {} };
  const ctx = { side: 'r', random: () => 0.5, now: Date.now };
  return bots.resolve('material-1ply').chooseMove(s, J, ctx).then((r) => {
    assert.notStrictEqual(r.move.to, J.idx(4, 1));
  });
});

test('crossedAE: revealed Advisor/Elephant across the river get a bonus (off by default)', () => {
  const s = emptyGame();
  const e = put(s, 4, 3, 'r', 'E'), a = put(s, 5, 2, 'r', 'A'), home = put(s, 2, 9, 'r', 'E');
  close(E.pieceValue(s, J, e), 1, 'default: no bonus');
  const w = E.resolveWeights({ crossedAE: 0.5 });
  close(E.pieceValue(s, J, e, w), 1.5, 'elephant across');
  close(E.pieceValue(s, J, a, w), 2.5, 'advisor across');
  close(E.pieceValue(s, J, home, w), 1, 'elephant at home');
});

test('hiddenTrapped: a hidden piece whose every move lands on an attacked square', () => {
  const s = emptyGame();
  // red hidden Pawn e3 (4,6) can only go to e4 (4,5)
  s.board[J.idx(4, 6)] = { side: 'r', type: null, hidden: true, role: 'P' };
  s.pools.r = { P: 1 };
  assert.strictEqual(E.trappedHidden(s, J, 'r'), 0, 'e4 is free');
  put(s, 0, 5, 'b', 'R');                       // black Rook on rank 4 attacks e4
  assert.strictEqual(E.trappedHidden(s, J, 'r'), 1, 'e4 attacked → trapped');
  const w = E.resolveWeights({ hiddenTrapped: 0.4, mobility: 0, check: 0 });
  const base = E.resolveWeights({ mobility: 0, check: 0 });
  close(E.evaluate(s, J, 'r', w) - E.evaluate(s, J, 'r', base), -0.4, 'penalty for red');
  close(E.explain(s, J, 'r', w).score, E.evaluate(s, J, 'r', w), 'explain = evaluate');
});

test('horseReach: squares a revealed Horse can jump to in the opponent half; a blocked leg removes them', () => {
  const s = emptyGame();
  put(s, 0, 4, 'b', 'H');                                   // black Horse a5 reaches b3 (1,6) and c4 (2,5) in red's half
  assert.strictEqual(E.horseReach(s, J, 'b'), 2);
  put(s, 0, 5, 'r', 'P');                                   // red Pawn a4 blocks the leg towards b3
  assert.strictEqual(E.horseReach(s, J, 'b'), 1);
  const w = E.resolveWeights({ horseReach: 0.3 });
  close(E.explain(s, J, 'r', w).score, E.evaluate(s, J, 'r', w), 'explain = evaluate');
});

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log('✓', name); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
