#!/usr/bin/env node
/*
 * Đo tốc độ engine và bot tìm kiếm.   npm run bench   (hoặc: node arena/bench.js search:lmr=false)
 *
 * - Thời gian các thao tác cơ bản (sinh nước, kiểm tra chiếu, đánh giá).
 * - perft(3): số chuỗi nước đi hợp lệ dài 3 nửa nước (quân lật ra cố định) – dùng để phát hiện
 *   thay đổi luật ngoài ý muốn khi tối ưu engine: tối ưu đúng thì con số không đổi.
 * - Bot tìm kiếm ở độ sâu cố định trên 6 thế cờ (khai cuộc → trung cuộc): thời gian, số nút, nút/ms.
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const J = require(path.join(ROOT, 'engine'));
const B = require(path.join(ROOT, 'bots'));
const E = B.lib.eval;

const spec = process.argv[2] || 'search';
const depths = (process.argv[3] || '1,2,3').split(',').map(Number);

const time = (f, n) => { const a = performance.now(); for (let i = 0; i < n; i++) f(); return ((performance.now() - a) / n) * 1000; };

// 6 thế cờ cố định: sau 0, 12, 24, ... nửa nước
const positions = [];
for (let g = 0; g < 6; g++) {
  let s = J.createGame({ seed: g });
  for (let i = 0; i < g * 12 && !s.result; i++) { const ms = J.getLegalMoves(s); s = J.makeMove(s, ms[(i * 7 + g) % ms.length]); }
  positions.push(s);
}
const avg = (f, n) => positions.reduce((a, s) => a + time(() => f(s), n), 0) / positions.length;

console.log('Thao tác cơ bản (trung bình 6 thế cờ)');
console.log(`  getLegalMoves      ${avg((s) => J.getLegalMoves(s), 500).toFixed(1)} µs`);
console.log(`  captures only      ${avg((s) => J.getLegalMoves(s, { capturesOnly: true }), 500).toFixed(1)} µs`);
console.log(`  isInCheck          ${avg((s) => J.isInCheck(s), 3000).toFixed(2)} µs`);
console.log(`  evaluate           ${avg((s) => E.evaluate(s, J, s.turn), 2000).toFixed(1)} µs`);
console.log(`  makeMove (fast)    ${avg((s) => J.makeMove(s, J.getLegalMoves(s)[0], { fast: true }), 500).toFixed(1)} µs  (gồm 1 lần sinh nước)`);

function perft(s, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of J.getLegalMoves(s)) {
    const opts = { fast: true };
    const p = s.board[m.from], t = s.board[m.to];
    const first = (side) => Object.keys(s.pools[side]).find((k) => s.pools[side][k] > 0);
    if (p.hidden) opts.revealAs = first(p.side);
    if (t && t.hidden) opts.captureAs = first(t.side);
    n += perft(J.makeMove(s, m, opts), d - 1);
  }
  return n;
}
// perft trên các thế cờ dựng bằng chuỗi nước cố định (không phụ thuộc thứ tự sinh nước)
const perftPositions = [J.createGame({ seed: 1 })];
{
  let s = J.createGame({ seed: 1 });
  for (const [a, b, c, d] of [[1, 7, 1, 0], [0, 0, 1, 0], [7, 7, 7, 0], [8, 0, 7, 0]]) {
    s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) }, { revealAs: Object.keys(s.pools[s.turn]).find((k) => s.pools[s.turn][k] > 0), fast: true });
    perftPositions.push(s);
  }
}
let t0 = performance.now();
const pf = perftPositions.map((s) => perft(s, 3));
console.log(`\nperft(3): ${pf.join(', ')}   (${(performance.now() - t0).toFixed(0)} ms)`);

(async () => {
  console.log(`\nBot "${spec}" – độ sâu cố định trên 6 thế cờ`);
  for (const d of depths) {
    const a = performance.now();
    let nodes = 0;
    const moves = [];
    for (const s of positions) {
      const r = await B.resolve(`${spec}${spec.includes(':') ? ',' : ':'}depth=${d}`)
        .chooseMove(J.cloneState(s), J, { side: s.turn, random: () => 0.5, now: () => performance.now() });
      nodes += r.info.nodes;
      moves.push(`${J.squareName(r.move.from)}${J.squareName(r.move.to)}`);
    }
    const ms = performance.now() - a;
    console.log(`  depth=${d}  ${ms.toFixed(0).padStart(7)} ms  ${String(nodes).padStart(9)} nút  ${(nodes / ms).toFixed(0).padStart(4)} nút/ms   ${moves.join(' ')}`);
  }
})();
