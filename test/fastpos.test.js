// Run: node test/fastpos.test.js – the fast mutable position (bots/lib/fastpos.js) and the fast tree search
// (bots/lib/fastsearch.js) must reproduce the engine, the evaluation and the reference search exactly.
const assert = require('assert');
const J = require('../engine');
const bots = require('../bots');
const E = bots.lib.eval;
const { Position, HID } = bots.lib.fastpos;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const W = E.resolveWeights(bots.get('search').params);   // the search bot's weights (all its eval terms on)
const code = (m) => m.from * 90 + m.to;

/** Positions from random games (random moves, random reveal outcomes), every few plies. */
function randomPositions(games, maxPlies, every) {
  const out = [];
  for (let g = 0; g < games; g++) {
    const rnd = bots.seededRandom(1000 + g);
    let s = J.createGame({ seed: 500 + g });
    for (let i = 0; i < maxPlies && !s.result; i++) {
      if (i % every === 0) out.push(s);
      const ms = J.getLegalMoves(s);
      s = J.makeMove(s, ms[Math.floor(rnd() * ms.length)]);
    }
  }
  return out;
}
const POSITIONS = randomPositions(12, 140, 7);

function sameAsState(pos, s, msg) {
  assert.strictEqual(pos.key(), J.positionKey(s), `${msg}: key`);
  assert.strictEqual(pos.turn, s.turn === 'r' ? 0 : 1, `${msg}: turn`);
  assert.deepStrictEqual(pos.legalMoveList(false), J.getLegalMoves(s).map(code), `${msg}: legal moves (same order)`);
  assert.deepStrictEqual(pos.legalMoveList(true), J.getLegalMoves(s, { capturesOnly: true }).map(code), `${msg}: captures`);
  for (const side of [0, 1]) {
    assert.strictEqual(pos.inCheck(side), J.isInCheck(s, side ? 'b' : 'r'), `${msg}: inCheck ${side}`);
    // bit-identical score (same terms summed in the same order)
    assert.strictEqual(pos.evaluate(side), E.evaluate(s, J, side ? 'b' : 'r', W), `${msg}: evaluate ${side}`);
  }
}

test('same keys, legal moves, checks and evaluation as the engine on random positions', () => {
  assert.ok(POSITIONS.length > 150);
  for (const [n, s] of POSITIONS.entries()) {
    const pos = new Position(J, s, W);
    sameAsState(pos, s, `position ${n}`);
    for (let sq = 0; sq < 90; sq++) {
      for (const by of [0, 1]) assert.strictEqual(pos.attacked(sq, by), J.isSquareAttacked(s.board, sq, by ? 'b' : 'r'), `position ${n}: attacked ${sq} by ${by}`);
    }
  }
});

test('make() matches engine makeMove (forced reveal, captureUnknown) and unmake() restores everything', () => {
  const rnd = bots.seededRandom(7);
  let checked = 0;
  for (const [n, s] of POSITIONS.entries()) {
    const pos = new Position(J, s, W);
    const before = { b: pos.b.slice(), pool: pos.pool.slice(), key: pos.key(), quiet: pos.quiet, kings: pos.kingSq.slice(), sp: pos.sp, count: pos.count };
    const moves = J.getLegalMoves(s);
    for (let k = 0; k < Math.min(6, moves.length); k++) {
      const m = moves[Math.floor(rnd() * moves.length)];
      const mover = s.board[m.from], target = s.board[m.to];
      let revealAs = null;
      if (mover.hidden) {
        const kinds = Object.keys(s.pools[mover.side]).filter((t) => s.pools[mover.side][t] > 0);
        revealAs = kinds[Math.floor(rnd() * kinds.length)];
      }
      const child = J.makeMove(s, m, { fast: true, revealAs: revealAs || undefined, captureUnknown: !!(target && target.hidden) });
      pos.make(m.from, m.to, revealAs ? bots.lib.fastpos.KIND[revealAs] : 0);
      assert.strictEqual(pos.quiet, child.quietPlies, `position ${n}: quiet plies`);
      assert.strictEqual(pos.cLen[pos.sp], child.rep.len, `position ${n}: repetition chain length`);
      sameAsState(pos, child, `position ${n} after ${J.squareName(m.from)}${J.squareName(m.to)}`);
      pos.unmake();
      assert.deepStrictEqual({ b: pos.b.slice(), pool: pos.pool.slice(), key: pos.key(), quiet: pos.quiet, kings: pos.kingSq.slice(), sp: pos.sp, count: pos.count }, before, `position ${n}: unmake`);
      checked++;
    }
  }
  assert.ok(checked > 500);
});

// ── repetition ──
function setup(pieces, turn = 'r') {
  const s = J.createGame({ seed: 1 });
  s.board = s.board.map(() => null);
  for (const [x, y, side, type] of pieces) s.board[J.idx(x, y)] = { side, type, hidden: false, role: type };
  s.pools = { r: {}, b: {} };
  s.turn = turn;
  s.key = J.positionKey(s);
  [s.k1, s.k2] = J._zobrist.positionKeyParts(s);
  s.rep = { key: s.key, from: -1, to: -1, prev: null, len: 1 };
  return s;
}
const play = (s, seq) => seq.reduce((st, [a, b, c, d]) => J.makeMove(st, { from: J.idx(a, b), to: J.idx(c, d) }), s);
/** Perpetual check: Red's next i8→i9 would repeat a 3rd time (forbidden). */
function perpetualCheck() {
  let s = setup([[3, 0, 'b', 'K'], [4, 9, 'r', 'K'], [8, 2, 'r', 'R'], [0, 6, 'r', 'P']]);
  s = play(s, [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0], [8, 1, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]);
  return s;
}
/** Perpetual chase: the Rook keeps chasing the undefended Horse. */
function perpetualChase() {
  let s = setup([[3, 0, 'b', 'K'], [5, 9, 'r', 'K'], [6, 4, 'r', 'R'], [2, 2, 'b', 'H'], [8, 6, 'r', 'P']]);
  return play(s, [[6, 4, 6, 2], [2, 2, 0, 3], [6, 2, 6, 3], [0, 3, 2, 2], [6, 3, 6, 2], [2, 2, 0, 3], [6, 2, 6, 3], [0, 3, 2, 2]]);
}

test('repetition: the must-deviate filter and the chain match the engine', () => {
  for (const s of [perpetualCheck(), perpetualChase()]) {
    const pos = new Position(J, s, W);
    assert.ok(pos.cLen[pos.sp] >= 8);
    sameAsState(pos, s, 'repetition position');
    const st = J.repetitionStatus(pos.toState());
    assert.deepStrictEqual(st && st.result, J.repetitionStatus(s) && J.repetitionStatus(s).result);
  }
  const s = perpetualCheck();
  const pos = new Position(J, s, W);
  assert.ok(!pos.legalMoveList(false).includes(J.idx(8, 1) * 90 + J.idx(8, 0)), 'the perpetual check move is filtered out');
});

// ── search: fast tree vs the engine-state reference (fast=false) ──
const ctx = (s) => ({ side: s.turn, random: () => 0.5, now: () => performance.now() });
async function sameSearch(spec, s, msg) {
  const a = await bots.resolve(`${spec}${spec.includes(':') ? ',' : ':'}fast=false`).chooseMove(J.cloneState(s), J, ctx(s));
  const b = await bots.resolve(spec).chooseMove(J.cloneState(s), J, ctx(s));
  assert.deepStrictEqual(b.move, a.move, `${msg}: move`);
  assert.strictEqual(b.info.score, a.info.score, `${msg}: score`);
  assert.strictEqual(b.info.nodes, a.info.nodes, `${msg}: nodes`);
}

test('the fast tree search gives the same moves, scores and node counts as the reference search', async () => {
  const sample = POSITIONS.filter((_, i) => i % 9 === 0);
  for (const [n, s] of sample.entries()) await sameSearch('search:depth=2', s, `position ${n}`);
  for (const [n, s] of sample.slice(0, 4).entries()) await sameSearch('search:depth=3', s, `position ${n} depth 3`);
  await sameSearch('search-v4:depth=2', sample[3], 'search-v4');
  await sameSearch('level-1', sample[5], 'level-1 (randomness)');
});

test('the fast tree search handles repetition positions like the reference search', async () => {
  for (const [n, s] of [perpetualCheck(), perpetualChase()].entries()) {
    for (const d of [1, 2, 3, 4]) await sameSearch(`search:depth=${d}`, s, `repetition ${n} depth ${d}`);
  }
});

test('timeouts leave a usable result (time-based search with the fast tree)', async () => {
  const s = POSITIONS[3];
  const r = await bots.resolve('search:maxTimeMs=150').chooseMove(J.cloneState(s), J, { ...ctx(s), timeBudgetMs: 150 });
  assert.ok(J.getLegalMoves(s).some((m) => m.from === r.move.from && m.to === r.move.to));
  assert.ok(r.info.depth >= 1);
});

test('falls back to the reference search for features the fast tree lacks', async () => {
  const s = POSITIONS[2];
  // horseReach (eval) and revealSkipRoles (search) are not implemented in the fast path → same result either way
  await sameSearch('search:depth=2,horseReach=0.3', s, 'horseReach');
  await sameSearch('search:depth=2,revealSkipRoles=RC', s, 'revealSkipRoles');
  assert.ok(HID === 8);
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
