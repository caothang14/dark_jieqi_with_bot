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
const removeN = (s, n) => { // bỏ n quân không phải Tướng
  let k = 0;
  for (let i = 0; i < s.board.length && k < n; i++) if (s.board[i] && s.board[i].type !== 'K') { s.board[i] = null; k++; }
  return s;
};
const W = E.DEFAULT_WEIGHTS;

test('giai đoạn: >90% khai cuộc, >50% trung cuộc, còn lại tàn cuộc', () => {
  assert.strictEqual(E.gamePhase(J.createGame()), 'opening');               // 32
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 3)), 'opening');   // 29 = 90.6%
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 4)), 'middlegame'); // 28 = 87.5%
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 15)), 'middlegame'); // 17 = 53%
  assert.strictEqual(E.gamePhase(removeN(J.createGame(), 16)), 'endgame');   // 16 = 50%
});

test('Tốt: tâm cung mình -1, chưa qua sông 1, qua sông 2, lụt 0.5', () => {
  const s = emptyGame();
  close(E.pieceValue(s, J, put(s, 4, 8, 'r', 'P')), -1, 'tốt đỏ tâm cung');
  close(E.pieceValue(s, J, put(s, 0, 6, 'r', 'P')), 1, 'tốt đỏ chưa qua sông');
  close(E.pieceValue(s, J, put(s, 2, 9, 'r', 'P')), 1, 'tốt đỏ ở hàng cuối của mình');
  close(E.pieceValue(s, J, put(s, 2, 4, 'r', 'P')), 2, 'tốt đỏ qua sông');
  close(E.pieceValue(s, J, put(s, 6, 0, 'r', 'P')), 0.5, 'tốt đỏ lụt');
  close(E.pieceValue(s, J, put(s, 4, 1, 'b', 'P')), -1, 'tốt đen tâm cung');
  close(E.pieceValue(s, J, put(s, 8, 3, 'b', 'P')), 1, 'tốt đen chưa qua sông');
  close(E.pieceValue(s, J, put(s, 8, 5, 'b', 'P')), 2, 'tốt đen qua sông');
  close(E.pieceValue(s, J, put(s, 1, 9, 'b', 'P')), 0.5, 'tốt đen lụt');
  close(E.pieceValue(s, J, put(s, 4, 1, 'r', 'P')), 2, 'tốt đỏ ở tâm cung đối phương = tốt qua sông');
});

test('Tượng 1', () => {
  const s = emptyGame();
  close(E.pieceValue(s, J, put(s, 2, 9, 'r', 'E')), 1);
  close(E.pieceValue(s, J, put(s, 4, 3, 'r', 'E')), 1, 'tượng đã qua sông');
});

test('Sĩ 2, sĩ giao nhau (chéo cạnh nhau) mỗi con 3', () => {
  let s = emptyGame();
  const a = put(s, 3, 9, 'r', 'A');
  close(E.pieceValue(s, J, a), 2, 'sĩ đơn');
  const b = put(s, 4, 8, 'r', 'A');
  close(E.pieceValue(s, J, a), 3, 'sĩ giao nhau');
  close(E.pieceValue(s, J, b), 3, 'sĩ giao nhau');
  s = emptyGame();
  close(E.pieceValue(s, J, put(s, 3, 9, 'r', 'A')), 2, 'hai sĩ cùng hàng không bảo vệ nhau');
  put(s, 5, 9, 'r', 'A');
  close(E.pieceValue(s, J, J.idx(3, 9)), 2);
  s = emptyGame();
  put(s, 3, 9, 'r', 'A'); put(s, 4, 8, 'b', 'A');
  close(E.pieceValue(s, J, J.idx(3, 9)), 2, 'sĩ đối phương không tính');
});

test('Mã 3/4/5, Pháo 5/4/3, Xe 9.5/9/10 theo giai đoạn', () => {
  const s = emptyGame();
  const sq = J.idx(4, 5);
  const v = (t, ph) => E.typeValueAt(s, J, t, 'r', sq, ph, W);
  assert.deepStrictEqual(['opening', 'middlegame', 'endgame'].map((ph) => v('H', ph)), [3, 4, 5]);
  assert.deepStrictEqual(['opening', 'middlegame', 'endgame'].map((ph) => v('C', ph)), [5, 4, 3]);
  assert.deepStrictEqual(['opening', 'middlegame', 'endgame'].map((ph) => v('R', ph)), [9.5, 9, 10]);
  // bàn cờ thưa (2 Tướng + 1 Xe) là tàn cuộc
  close(E.pieceValue(s, J, put(s, 0, 5, 'r', 'R')), 10);
});

test('quân úp = trung bình theo pool, chấm tại ô đang đứng', () => {
  const s = J.createGame({ seed: 1 });
  // khai cuộc, ô Xe (0,9): A2 E1 H3 R9.5 C5 P1 → (2*2 + 2*1 + 2*3 + 2*9.5 + 2*5 + 5*1)/15
  close(E.pieceValue(s, J, J.idx(0, 9)), (4 + 2 + 6 + 19 + 10 + 5) / 15);
});

test('thế cờ đầu ván cân bằng (điểm 0 cho cả 2 bên)', () => {
  const s = J.createGame({ seed: 3 });
  close(E.evaluate(s, J, 'r'), 0);
  close(E.evaluate(s, J, 'b'), 0);
});

test('đối xứng: điểm Đỏ = - điểm Đen', () => {
  let s = J.createGame({ seed: 4 });
  for (let i = 0; i < 30 && !s.result; i++) {
    const ms = J.getLegalMoves(s);
    s = J.makeMove(s, ms[(i * 7) % ms.length]);
    close(E.evaluate(s, J, 'r'), -E.evaluate(s, J, 'b'));
  }
});

test('ghi đè trọng số qua params', () => {
  const w = E.resolveWeights({ 'R.endgame': 11, mobility: 0, weights: { P: { crossed: 2.5 } }, unknownKey: 1 });
  assert.strictEqual(w.R.endgame, 11);
  assert.strictEqual(w.R.opening, 9.5);
  assert.strictEqual(w.mobility, 0);
  assert.strictEqual(w.P.crossed, 2.5);
  assert.strictEqual(W.R.endgame, 10, 'không sửa mặc định');
});

test('ván kết thúc: thắng +1000, thua -1000', () => {
  let s = emptyGame();
  s.board = s.board.map(() => null);
  put(s, 4, 0, 'b', 'K'); put(s, 3, 9, 'r', 'K'); put(s, 0, 1, 'r', 'R'); put(s, 8, 2, 'r', 'R');
  s = J.makeMove(s, { from: J.idx(8, 2), to: J.idx(8, 0) });
  assert.strictEqual(E.evaluate(s, J, 'r'), 1000);
  assert.strictEqual(E.evaluate(s, J, 'b'), -1000);
});

test('bot không ăn Tốt đang chắn tâm cung đối phương', async () => {
  const s = emptyGame();
  s.board = s.board.map(() => null);
  put(s, 4, 0, 'b', 'K'); put(s, 3, 9, 'r', 'K');
  put(s, 4, 1, 'b', 'P');       // tốt đen chắn tâm cung đen (-1 cho Đen)
  put(s, 4, 5, 'r', 'R');       // xe đỏ có thể ăn tốt này
  put(s, 0, 3, 'b', 'P'); put(s, 8, 3, 'b', 'P');
  s.pools = { r: {}, b: {} };
  const ctx = { side: 'r', random: () => 0.5, now: Date.now };
  return bots.resolve('material-1ply').chooseMove(s, J, ctx).then((r) => {
    assert.notStrictEqual(r.move.to, J.idx(4, 1));
  });
});

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log('✓', name); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
