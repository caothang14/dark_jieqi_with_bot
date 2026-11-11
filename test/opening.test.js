// Run: node test/opening.test.js – thứ tự ưu tiên lật quân
const assert = require('assert');
const J = require('../engine');
const bots = require('../bots');
const OP = bots.lib.opening;
const E = bots.lib.eval;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sq = (name) => J.idx('abcdefghi'.indexOf(name[0]), 9 - Number(name[1]));
const mv = (a, b) => ({ from: sq(a), to: sq(b) });

test('bảng ưu tiên ở thế cờ đầu ván (Đỏ)', () => {
  const s = J.createGame({ seed: 1 });
  const rank = (a, b) => OP.revealRank(s, J, mv(a, b));
  assert.strictEqual(rank('a3', 'a4'), 1, 'Tốt biên');
  assert.strictEqual(rank('i3', 'i4'), 1);
  assert.strictEqual(rank('c3', 'c4'), 2, 'Tốt cột 3/7');
  assert.strictEqual(rank('e3', 'e4'), 3, 'Tốt giữa');
  assert.strictEqual(rank('d0', 'e1'), 4, 'Sĩ vào tâm cung');
  assert.strictEqual(rank('c0', 'e2'), 4, 'Tượng vào giữa');
  assert.strictEqual(rank('b0', 'c2'), 5, 'Mã');
  assert.strictEqual(rank('c0', 'a2'), 6, 'Tượng ra biên');
  assert.strictEqual(rank('b2', 'b6'), 7, 'Pháo tiến thẳng');
  assert.strictEqual(rank('b2', 'e2'), 8, 'Pháo đi ngang');
  assert.strictEqual(rank('a0', 'a1'), 9, 'Xe');
  assert.strictEqual(rank('b2', 'b9'), 0, 'ăn quân không phải nước "lật thường"');
});

test('bảng ưu tiên cho Đen (hướng tiến ngược lại)', () => {
  let s = J.createGame({ seed: 1 });
  s = J.makeMove(s, mv('a3', 'a4'));
  assert.strictEqual(OP.revealRank(s, J, mv('b7', 'b3')), 7, 'Pháo đen tiến thẳng');
  assert.strictEqual(OP.revealRank(s, J, mv('b7', 'b8')), 8, 'Pháo đen lùi');
  assert.strictEqual(OP.revealRank(s, J, mv('i6', 'i5')), 1, 'Tốt biên đen');
});

test('sắp thứ tự: ở gốc, nước lật thường đầu tiên là Tốt biên', async () => {
  const s = J.createGame({ seed: 1 });
  const r = await bots.resolve('search:depth=1,openingOrder=true,revealTopKRoot=1').chooseMove(J.cloneState(s), J,
    { side: 'r', random: () => 0.5, now: () => performance.now() });
  // chỉ còn 1 nước lật (Tốt biên) + các nước ăn quân ở gốc
  const name = J.squareName(r.move.from) + J.squareName(r.move.to);
  assert.ok(['a3a4', 'i3i4', 'b2b9', 'h2h9'].includes(name), name);
});

test('bỏ bớt nước lật vẫn xét đủ nước ăn quân', async () => {
  // Pháo đỏ (úp) ăn được quân úp ở ô Mã đen – nước ăn quân không bị bỏ dù revealTopKRoot rất nhỏ
  const s = J.createGame({ seed: 1 });
  const p = bots.resolve('search:depth=2,openingOrder=true,revealTopK=1,revealTopKRoot=1');
  const r = await p.chooseMove(J.cloneState(s), J, { side: 'r', random: () => 0.5, now: () => performance.now() });
  // nước bot chọn phải là nước ăn quân (Pháo ăn Mã úp) – nghĩa là nước ăn quân đã được xét
  assert.ok(s.board[r.move.to], `bot chọn ${J.squareName(r.move.from)}${J.squareName(r.move.to)}, không phải nước ăn quân`);
});

test('điểm phát triển: đầu ván cân bằng, lật Tốt biên được thưởng nhiều hơn lật Xe', () => {
  const w = E.resolveWeights({ development: 0.3 });
  const s = J.createGame({ seed: 2 });
  assert.ok(Math.abs(E.evaluate(s, J, 'r', w)) < 1e-9);
  assert.ok(Math.abs(E.evaluate(s, J, 'r', w) - E.explain(s, J, 'r', w).score) < 1e-9, 'evaluate = explain');
  const pawn = J.makeMove(s, mv('a3', 'a4'), { revealAs: 'P' });
  const rook = J.makeMove(s, mv('a0', 'a1'), { revealAs: 'P' });
  // cùng lật ra Tốt: lật ở ô Tốt biên được lợi điểm phát triển hơn lật ở ô Xe
  const gain = (st) => E.evaluate(st, J, 'r', w) - E.evaluate(st, J, 'r', E.resolveWeights({}));
  assert.ok(gain(pawn) > gain(rook));
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
