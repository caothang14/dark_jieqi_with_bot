// Run: node test/search.test.js
const assert = require('assert');
const J = require('../engine');
const bots = require('../bots');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const board = (pieces, turn = 'r') => {
  const s = J.createGame({ seed: 1 });
  s.board = s.board.map(() => null);
  for (const [x, y, side, type] of pieces) s.board[J.idx(x, y)] = { side, type, hidden: false, role: type };
  s.pools = { r: {}, b: {} };
  s.turn = turn;
  return s;
};
const ctx = (side) => ({ side, random: () => 0.5, now: () => performance.now(), timeBudgetMs: 1000 });
const think = async (spec, s) => (await bots.resolve(spec).chooseMove(J.cloneState(s), J, ctx(s.turn)));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const name = (m) => `${J.squareName(m.from)}→${J.squareName(m.to)}`;

test('finds mate in 1', async () => {
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 1, 'r', 'R'], [8, 2, 'r', 'R']]);
  const r = await think('search:depth=2', s);
  assert.strictEqual(name(r.move), 'i7→i9');
  assert.ok(r.info.score > 900, `score ${r.info.score}`);
});

test('does not take a Pawn defended by a Rook (sees the recapture)', async () => {
  // Red Rook a4 can take Black Pawn a6, but Black Rook a9 recaptures
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 3, 'b', 'P'], [0, 0, 'b', 'R'], [8, 9, 'r', 'P']]);
  const greedy = await think('greedy', s);
  assert.strictEqual(name(greedy.move), 'a4→a6', 'the greedy bot takes it');
  const r = await think('search:depth=2', s);
  assert.notStrictEqual(name(r.move), 'a4→a6');
});

test('takes an undefended piece', async () => {
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 2, 'b', 'H'], [8, 0, 'b', 'P']]);
  const r = await think('search:depth=2', s);
  assert.strictEqual(name(r.move), 'a4→a7');
});

test('level-4 (step 15 CPU budget) stays within its node budget and does not start an iteration it cannot finish', async () => {
  const s = J.createGame({ seed: 21 });
  const eco = bots.get('level-4').params;
  const c = { side: 'r', random: () => 0.5, now: () => performance.now(), timeBudgetMs: 4000 };
  // warm-up: a cold (not yet JIT-compiled) first search is slow, and predictStop is time-based
  await bots.resolve('level-4').chooseMove(J.cloneState(s), J, c);
  const r = await bots.resolve('level-4').chooseMove(J.cloneState(s), J, c);
  assert.ok(r.info.nodes <= eco.maxNodes + 128, `nodes ${r.info.nodes}`);
  // opening: depth 3 costs ~0.12M nodes, depth 4 ~1.9M > budget → stops after depth 3 instead of cutting depth 4
  assert.strictEqual(r.info.depth, 3);
  assert.ok(r.info.nodes < 200000, `nodes ${r.info.nodes}`);
});

test('level-4 plays an obvious move at once (easyMargin)', async () => {
  // Red Rook can take a free Black Rook; nothing else comes close
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 1, 'b', 'R'], [8, 0, 'b', 'P'], [8, 9, 'r', 'P']]);
  const c = { side: 'r', random: () => 0.5, now: () => performance.now(), timeBudgetMs: 4000 };
  const full = await bots.resolve('search').chooseMove(J.cloneState(s), J, c);
  const eco = await bots.resolve('level-4').chooseMove(J.cloneState(s), J, c);
  assert.strictEqual(name(eco.move), 'a4→a8');
  assert.strictEqual(name(full.move), 'a4→a8');
  assert.strictEqual(eco.info.depth, bots.get('level-4').params.easyMinDepth);
  assert.ok(eco.info.nodes * 5 < full.info.nodes, `eco ${eco.info.nodes} vs full ${full.info.nodes}`);
});

test('fixed-depth search is reproducible', async () => {
  const s = J.createGame({ seed: 11 });
  const a = await think('search:depth=1', s);
  const b = await think('search:depth=1', s);
  assert.deepStrictEqual(a.move, b.move);
  assert.strictEqual(a.info.depth, 1);
});

test('respects the time limit', async () => {
  const s = J.createGame({ seed: 12 });
  const t = performance.now();
  const r = await think('search:maxTimeMs=200', s);
  const ms = performance.now() - t;
  assert.ok(ms < 600, `took ${ms.toFixed(0)}ms`);
  assert.ok(J.getLegalMoves(s).some((m) => m.from === r.move.from && m.to === r.move.to));
});

test('Star2 (probing at chance nodes) gives exactly the same score as without probing', async () => {
  for (let g = 0; g < 4; g++) {
    let s = J.createGame({ seed: 40 + g });
    for (let i = 0; i < g * 10 && !s.result; i++) { const ms = J.getLegalMoves(s); s = J.makeMove(s, ms[(i * 7 + g) % ms.length]); }
    const base = 'search:depth=2,tt=false,lmr=false,nullMove=false';
    const a = await think(base + ',probe=true', s);
    const b = await think(base + ',probe=false', s);
    assert.strictEqual(a.info.score, b.info.score, `seed ${40 + g}`);
    assert.ok(a.info.nodes <= b.info.nodes, 'probing must reduce the node count');
  }
});

test('regression: does not miss capturing a Rook when the revealed piece hits the probe bound exactly', async () => {
  // Red's (hidden) Cannon takes the hidden piece on black's Horse square and is revealed as a Rook on b9; Black must recapture with the piece on a9
  let s = J.createGame({ seed: 15 });
  s = J.makeMove(s, { from: J.idx(1, 7), to: J.idx(1, 0) }, { revealAs: 'R', captureAs: 'H' });
  for (const spec of ['search:depth=1', 'search:depth=2']) {
    const r = await think(spec, s);
    assert.strictEqual(name(r.move), 'a9→b9', spec);
  }
});

test('repetition: the bot avoids perpetual check when it is the violator', async () => {
  // Black threatens mate (Rook a1 locks rank 1, Rook h5 waits to drop to rank 0). Red holds on with Rook checks, King d9 ↔ d8.
  let s = board([[3, 0, 'b', 'K'], [4, 9, 'r', 'K'], [8, 2, 'r', 'R'], [0, 8, 'b', 'R'], [7, 5, 'b', 'R'], [0, 6, 'r', 'P']]);
  s.k1 = null; s.key = J.positionKey(s); s.rep = { key: s.key, from: -1, to: -1, prev: null, len: 1 };
  const cycle = [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]];
  for (const [a, b, c, d] of cycle) s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  // After 1 cycle: checking again with i8→i9 is still legal (2nd repetition). A bot unaware of the rules keeps checking;
  // a bot aware of them knows it will be forced to deviate next cycle, so it deviates now.
  assert.strictEqual(name((await think('search:depth=2,repetition=false', s)).move), 'i8→i9');
  for (const spec of ['search:depth=2', 'search:depth=3']) {
    assert.notStrictEqual(name((await think(spec, s)).move), 'i8→i9', spec);
  }
  // After 2 cycles: the check repeating a 3rd time is outright forbidden
  for (const [a, b, c, d] of [[8, 1, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]) s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  assert.deepStrictEqual(J.forbiddenMoves(s).map((m) => `${J.squareName(m.from)}→${J.squareName(m.to)}:${m.violation}`), ['i8→i9:perpetual-check']);
  const r = await think('search:depth=2,repetition=false', s);
  assert.notStrictEqual(name(r.move), 'i8→i9', 'even a bot unaware of the rules cannot pick a forbidden move');
});

test('bot styles are registered', () => {
  for (const id of ['search', 'search-fast', 'search-midgame', 'search-endgame', 'search-v4', 'search-v5', 'search-v6', 'search-v7']) assert.ok(bots.get(id), id);
  const sp = bots.resolve('search').params;
  assert.deepStrictEqual([sp.horseCheckThreat, sp.cannonFacingKing, sp.cannonEmptyFile, sp.centralCannon, sp.bottomCannon],
    [0.4, 0.5, 0.8, 0.3, undefined], 'step 8 on in search, pháo giác off');
  assert.strictEqual(bots.resolve('level-4').params.cannonEmptyFile, 0.8, 'levels inherit it');
  assert.strictEqual(bots.resolve('search').params.hiddenTrapped, 0.3);
  assert.strictEqual(bots.resolve('search-v5').params.hiddenTrapped, 0, 'reference keeps the old evaluation');
  assert.strictEqual(bots.resolve('search-endgame').params['R.endgame'], 11);
});

test('difficulty levels are registered in order', () => {
  assert.deepStrictEqual(bots.levels().map((l) => l.id), ['level-1', 'level-2', 'level-3', 'level-4']);
  assert.ok(bots.levels().every((l) => l.levelName && !l.hidden && l.baseId === 'search'));
  assert.strictEqual(bots.get('search').level, undefined, 'the base bot is not a level');
});

test('randomness: varies the move, but only among near-best moves', async () => {
  const s0 = J.createGame({ seed: 5 });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const c = { ...ctx('r'), random: bots.seededRandom(i) };
    const r = await bots.resolve('search:depth=1,randomness=1.5').chooseMove(J.cloneState(s0), J, c);
    seen.add(name(r.move));
  }
  assert.ok(seen.size > 1, 'should not always play the same move');
  // a free Rook (+9) is far above every alternative: even the easiest level always takes it
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 2, 'b', 'R'], [8, 0, 'b', 'P'], [8, 9, 'r', 'P']]);
  for (let i = 0; i < 8; i++) {
    const r = await bots.resolve('level-1').chooseMove(J.cloneState(s), J, { ...ctx('r'), random: bots.seededRandom(i) });
    assert.strictEqual(name(r.move), 'a4→a7', `seed ${i}`);
  }
  // a mate is never thrown away
  const m = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 1, 'r', 'R'], [8, 2, 'r', 'R']]);
  for (let i = 0; i < 8; i++) {
    const r = await bots.resolve('level-2').chooseMove(J.cloneState(m), J, { ...ctx('r'), random: bots.seededRandom(i) });
    assert.strictEqual(name(r.move), 'i7→i9', `seed ${i}`);
  }
});

/** Start position (seed 3) with some squares changed: [x, y, side, type] (type null = empty square). */
const fromStart = (changes) => {
  const s = J.createGame({ seed: 3 });
  for (const [x, y, side, type] of changes) {
    if (type) { s.board[J.idx(x, y)] = { side, type, hidden: false, role: 'P' }; s.pools[side][type]--; } else s.board[J.idx(x, y)] = null;
  }
  return s;
};

// The step-7 tests below use search-v7 (= search without the step-8 evaluation terms) so that they keep testing
// exactly the rule they are about.
test('a hidden piece in danger is not dropped by reveal pruning (keepThreatened)', async () => {
  // Black Cannon a5 attacks the red hidden piece a0 through the Pawn a3; nothing defends a0. Its way out is a
  // low-priority reveal (e.g. b0→c2 frees b0), which root pruning used to drop – the bot then lost a0 for nothing.
  const s = fromStart([[0, 4, 'b', 'C'], [1, 2, 'b', null]]);
  const off = await think('search-v7:depth=2,keepThreatened=false,horseReach=0', s);
  const on = await think('search-v7:depth=2,horseReach=0', s);
  assert.ok(on.info.score > off.info.score, `${on.info.score} should beat ${off.info.score}`);
  assert.notStrictEqual(name(on.move), name(off.move));
});

test('blocks an enemy Horse that came out on the edge with a Pawn (horseBlockBonus)', async () => {
  // Black Horse a5 (revealed from the edge Pawn) can jump into red's camp via b3; pushing the Pawn a3→a4 blocks its leg
  const s = fromStart([[0, 4, 'b', 'H'], [0, 3, 'b', null], [4, 5, 'r', 'P'], [4, 6, 'r', null]]);
  assert.notStrictEqual(name((await think('search-v7:depth=2,horseBlockBonus=0,cannonRaidMalus=0', s)).move), 'a3→a4');
  assert.strictEqual(name((await think('search-v7:depth=2', s)).move), 'a3→a4');
  // the eval-based alternative (horseReach, off by default) also finds it
  assert.strictEqual(name((await think('search-v7:depth=2,horseBlockBonus=0,horseReach=0.3', s)).move), 'a3→a4');
});

test("no 'cản mã' bonus for a block that still leaves our Pawn to the Horse (game 2026-11-12)", async () => {
  // i3i4 (Advisor) c6c5 (Pawn) a3a4 (Horse): the red Horse a4 can take c5 and jump to b6. a6a5 blocks only b6 –
  // it used to get the bonus and was played although it was worse; now the bonus needs a full block
  const sq = (n) => J.idx('abcdefghi'.indexOf(n[0]), 9 - Number(n[1]));
  let s = J.createGame({ seed: 1 });
  for (const [f, t, r] of [['i3', 'i4', 'A'], ['c6', 'c5', 'P'], ['a3', 'a4', 'H']]) s = J.makeMove(s, { from: sq(f), to: sq(t) }, { revealAs: r });
  const r = await think('search-v7:depth=2,debug=true', s);
  assert.strictEqual(r.info.root.find((x) => name(x) === 'a6→a5').pen, 0);
});

test('a chased hidden Cannon prefers stepping to a safe square over raiding (game 2026-11-12)', async () => {
  const sq = (n) => J.idx('abcdefghi'.indexOf(n[0]), 9 - Number(n[1]));
  let s = J.createGame({ seed: 1 });
  for (const [f, t, r, c] of [['i3', 'i4', 'A'], ['c6', 'c5', 'P'], ['a3', 'a4', 'H'], ['a6', 'a5', 'A'], ['a4', 'c5', null, null]]) {
    s = J.makeMove(s, { from: sq(f), to: sq(t) }, r ? { revealAs: r } : {});
  }
  // the red Horse c5 attacks the hidden Cannon b7; b7xb0 (raid) used to be free of penalty because b7 was attacked
  const r = await think('search-v7:depth=2,debug=true', s);
  assert.strictEqual(r.info.root.find((x) => name(x) === 'b7→b0').pen, 0.75);
  assert.strictEqual(name(r.move), 'b7→e7');
});

test('step 9: an edge Pawn holding the enemy hidden edge Pawn is not pushed into its mouth', async () => {
  // Black Pawn a5 controls the red hidden Pawn a3 (its only square a4 is attacked): its job is done, reveal instead
  const s = J.makeMove(J.createGame({ seed: 1 }), { from: J.idx(4, 6), to: J.idx(4, 5) }, { revealAs: 'P' });
  s.board[J.idx(0, 3)] = null; s.board[J.idx(0, 4)] = { side: 'b', type: 'P', hidden: false, role: 'P' }; s.pools.b.P--;
  const r = await think('search-v9:depth=1,debug=true', s);
  const pen = (a, b) => r.info.root.find((x) => name(x) === `${a}→${b}`).pen;
  assert.strictEqual(pen('a5', 'a4'), 1);
  assert.notStrictEqual(name(r.move), 'a5→a4');
  // a centre Pawn, or an edge Pawn with no hidden Pawn opposite, is free to advance
  const t = J.cloneState(s);
  t.board[J.idx(0, 6)] = null;
  const r2 = await think('search-v9:depth=1,debug=true', t);
  assert.strictEqual(r2.info.root.find((x) => name(x) === 'a5→a4').pen, 0);
});

test("step 9: 'phi pháo úp' – a hidden Cannon leaping into the opponent's half pays for the chance of a weak piece", async () => {
  const s = J.makeMove(J.createGame({ seed: 1 }), { from: J.idx(4, 6), to: J.idx(4, 5) }, { revealAs: 'P' });
  const r = await think('search-v9:depth=1,debug=true,revealTopKRoot=0', s);
  const pen = (a, b) => r.info.root.find((x) => name(x) === `${a}→${b}`).pen;
  close(pen('b7', 'b3'), 9 / 15);                       // A2 + E2 + P5 of the 15 hidden black pieces
  assert.strictEqual(pen('b7', 'b5'), 0, 'staying in our half is free');
  // opening only: with 6 pieces off the board (26 left = middlegame) there is no penalty
  const t = J.cloneState(s);
  for (const [x, y] of [[0, 6], [8, 6], [2, 6], [0, 3], [8, 3], [2, 3]]) t.board[J.idx(x, y)] = null;
  const r2 = await think('search-v9:depth=1,debug=true,revealTopKRoot=0', t);
  assert.strictEqual(r2.info.root.find((x) => name(x) === 'b7→b3').pen, 0);
});

test('keepThreatened only while at least 3 Rooks/Cannons/Horses are still hidden', async () => {
  const s = fromStart([[0, 4, 'b', 'C'], [1, 2, 'b', null]]);
  const n = async (spec) => (await think(spec, s)).info.nodes;
  const on = await n('search-v7:depth=1'), off = await n('search-v7:depth=1,keepThreatened=false');
  assert.ok(on > off, 'full pool: reveal pruning is lifted');
  s.pools.r = { ...s.pools.r, R: 0, C: 0, H: 2 };          // only 2 strong pieces left hidden
  assert.strictEqual(await n('search-v7:depth=1'), await n('search-v7:depth=1,keepThreatened=false'));
});

test('cannon raid only with a Rook out and a richer enemy pool', async () => {
  const s = J.makeMove(J.createGame({ seed: 2 }), { from: J.idx(4, 6), to: J.idx(4, 5) });   // Red e3e4; Black to move
  const raidPen = async (st) => (await think('search-v7:depth=1,debug=true', st)).info.root
    .find((x) => name(x) === 'b7→b0').pen;
  assert.strictEqual(await raidPen(s), 1.5, 'no Rook out');
  const t = J.cloneState(s);
  t.board[J.idx(4, 1)] = null; t.board[J.idx(5, 1)] = { side: 'b', type: 'R', hidden: false, role: 'P' }; t.pools.b.R--;
  assert.strictEqual(await raidPen(t), 0, 'Rook out, Red still has more strong pieces hidden');
  t.pools.r = { ...t.pools.r, R: 0 };
  assert.strictEqual(await raidPen(t), 1.5, 'Rook out but our hidden pieces are worth more');
});

test('expert habits: no early hidden-Cannon raid, hidden Rook does not capture weak pieces', async () => {
  const kind = (s, m) => {
    const a = s.board[m.from], t = s.board[m.to];
    if (!t || !a.hidden) return '';
    if (a.role === 'C' && t.hidden) return 'cannon-raid';
    if (a.role === 'R' && (t.hidden || !['R', 'C', 'H'].includes(t.type))) return 'rook-capture';
    return '';
  };
  let rawRaids = 0;
  for (const seed of [2, 3, 4, 5]) {
    // Red opens e3e4; Black replies. The step-6 bot raids b7xb0 here; the new one should not.
    const s = J.makeMove(J.createGame({ seed }), { from: J.idx(4, 6), to: J.idx(4, 5) });
    if (kind(s, (await think('search-v6:depth=2', s)).move) === 'cannon-raid') rawRaids++;
    assert.strictEqual(kind(s, (await think('search-v7:depth=2', s)).move), '', `seed ${seed}`);
  }
  assert.ok(rawRaids >= 3, 'test positions should tempt the old bot');
  // after Black's raid, the old bot recaptures with its hidden Rook a0; the new one keeps it hidden
  // unless the raider turned out to be a Rook / Cannon / Horse
  for (const seed of [2, 3, 5]) {
    let s = J.makeMove(J.createGame({ seed }), { from: J.idx(4, 6), to: J.idx(4, 5) });
    s = J.makeMove(s, { from: J.idx(1, 2), to: J.idx(1, 9) });
    const raider = s.board[J.idx(1, 9)].type;
    const m = (await think('search-v7:depth=2', s)).move;
    if (!['R', 'C', 'H'].includes(raider)) assert.strictEqual(kind(s, m), '', `seed ${seed}, raider ${raider}`);
  }
});

test('guards a hidden Rook attacked by an enemy Cannon by putting a piece in the line (guardRookBonus)', async () => {
  // Black Cannon a5 attacks the hidden Rook a0 through a3: the expert move is c0→a2 (or b0→a2) to block it
  const s = fromStart([[0, 4, 'b', 'C'], [1, 2, 'b', null]]);
  assert.notStrictEqual(name((await think('search-v7:depth=2,guardRookBonus=0', s)).move), 'c0→a2');
  assert.ok(['c0→a2', 'b0→a2'].includes(name((await think('search-v7:depth=2', s)).move)));
});

test('reveals first when the opponent already has a Rook out and we have no big piece out (developFirst)', async () => {
  // Black has a Rook on c8; Red only has an Advisor out, which could take the hidden Pawn a6
  const s = fromStart([[2, 1, 'b', 'R'], [2, 0, 'b', null], [1, 4, 'r', 'A'], [3, 9, 'r', null]]);
  const r = await think('search-v7:depth=2,debug=true', s);
  const pen = (from, to) => r.info.root.find((x) => name(x) === `${from}→${to}`).pen;
  assert.strictEqual(pen('b5', 'a6'), 1, 'Advisor taking a hidden piece');
  assert.strictEqual(pen('b5', 'c4'), 0.3, 'other Advisor moves');
  assert.strictEqual(pen('e3', 'e4'), 0, 'reveal moves are free');
});

// ── Step 12: revealed-strength balance (user's experience, 2026-11-13) ──
test('step 12: Pawn row first when equal, back-rank reveals cost when ahead (strength modes)', async () => {
  const s = J.makeMove(J.createGame({ seed: 1 }), { from: J.idx(4, 6), to: J.idx(4, 5) }, { revealAs: 'P' });  // Red e3e4
  const pens = async (st) => {
    const r = await think('search:depth=1,debug=true,controlBonus=0,revealTopKRoot=0', st);
    return (a, b) => r.info.root.find((x) => name(x) === `${a}→${b}`).pen;
  };
  let pen = await pens(s);                                   // 0 vs 0: equal
  assert.strictEqual(pen('a6', 'a5'), -0.4, 'safe Pawn-row reveal');
  assert.strictEqual(pen('e6', 'e5'), 0, 'e5 is in the mouth of the Pawn e4 and undefended: no bonus');
  assert.strictEqual(pen('b9', 'c7'), 0);
  const t = J.cloneState(s);                                 // Black gets a revealed Rook on e8: ahead by 9
  t.board[J.idx(4, 1)] = { side: 'b', type: 'R', hidden: false, role: 'P' }; t.pools.b.R--;
  pen = await pens(t);
  assert.strictEqual(pen('a6', 'a5'), 0, 'ahead: Pawn row neither rewarded nor penalised');
  assert.strictEqual(pen('b9', 'c7'), 0.3, 'ahead: back-rank reveal');
  assert.strictEqual((await think('search-v9:depth=1,debug=true,revealTopKRoot=0', t)).info.root.find((x) => name(x) === 'b9→c7').pen, 0);
});

test('step 12: behind in revealed strength → reveal instead of the lone Rook raid (game 2026-11-13, move 11)', async () => {
  const sq = (n) => J.idx('abcdefghi'.indexOf(n[0]), 9 - Number(n[1]));
  let s = J.createGame({ seed: 1 });
  for (const [f, t, r, c] of [['i3', 'i4', 'A'], ['i6', 'i5', 'P'], ['g3', 'g4', 'P'], ['i5', 'i4'], ['c3', 'c4', 'P'],
    ['a6', 'a5', 'R'], ['a3', 'a4', 'P'], ['a5', 'e5'], ['c0', 'e2', 'H'], ['e5', 'e3', null, 'E'], ['b0', 'c2', 'R']]) {
    s = J.makeMove(s, { from: sq(f), to: sq(t) }, { ...(r ? { revealAs: r } : {}), ...(c ? { captureAs: c } : {}) });
  }
  // Black: Rook (9) vs Red Rook + Horse (13) → behind
  const r = await think('search:depth=2,debug=true', s);
  const pen = (a, b) => r.info.root.find((x) => name(x) === `${a}→${b}`).pen;
  assert.strictEqual(pen('e3', 'h3'), 1);
  assert.ok(s.board[r.move.from].hidden, `plays a reveal, not ${name(r.move)}`);
});

test('step 12: reveal the hidden Advisor a revealed Rook hits next to the King (palaceGuardBonus)', async () => {
  // Black Rook d7 looks down the open d-file at the red hidden piece d0 next to the King e0
  const s = fromStart([[3, 2, 'b', 'R']]);
  const r = await think('search:depth=1,debug=true,revealTopKRoot=0', s);
  const pen = (a, b) => r.info.root.find((x) => name(x) === `${a}→${b}`).pen;
  assert.strictEqual(pen('d0', 'e1'), -1, 'reveal the piece itself');
  assert.strictEqual(pen('b2', 'd2'), -1, 'or block the file with a reveal');
  assert.strictEqual(pen('f0', 'e1'), 0);
});

test('step 13: the King prefers to stay home – recapture with the hidden Advisor, not the King (game 2026-11-13)', async () => {
  const sq = (n) => J.idx('abcdefghi'.indexOf(n[0]), 9 - Number(n[1]));
  let s = J.createGame({ seed: 1 });
  for (const [f, t, r] of [['i3', 'i4', 'P'], ['e6', 'e5', 'E'], ['g3', 'g4', 'C'], ['g9', 'i7', 'E'], ['c3', 'c4', 'P'],
    ['a6', 'a5', 'C'], ['b0', 'a2', 'P'], ['e5', 'g3'], ['e3', 'e4', 'P'], ['a5', 'a8'], ['f0', 'e1', 'P'], ['g6', 'g5', 'P'],
    ['g4', 'f4'], ['a8', 'e8'], ['f4', 'f2'], ['b9', 'c7', 'P'], ['f2', 'e2'], ['g5', 'g4'], ['h0', 'g2', 'H'], ['b7', 'b5', 'A'],
    ['e2', 'e8']]) {
    s = J.makeMove(s, { from: sq(f), to: sq(t) }, r ? { revealAs: r } : {});
  }
  const r = await think('search:depth=2,debug=true', s);
  const pen = (a, b) => r.info.root.find((x) => name(x) === `${a}→${b}`).pen;
  assert.strictEqual(pen('e9', 'e8'), 1, 'King forward off its start square');
  assert.notStrictEqual(name(r.move), 'e9→e8');
  assert.strictEqual(name((await think('search-v10:depth=2', s)).move), 'e9→e8', 'the step-12 bot took with the King');
  // sideways costs less (strengthGap=0: Black is also "behind" here, rule 2 would add its quiet-move penalty)
  const t = J.cloneState(s);
  t.board[sq('d9')] = null;
  const r2 = await think('search:depth=1,debug=true,strengthGap=0', t);
  assert.strictEqual(r2.info.root.find((x) => name(x) === 'e9→d9').pen, 0.3);
});

// ── Step 16 (user's game report 2026-11-18) ──────────────────────────────────────────────────────────
// Game 2 of the report (Red = user, Black = bot), replayed with the logged reveals
const GAME_2018 = 'Đỏ: [úp Tốt]→Tượng i3→i4 Đen: [úp Tốt]→Tượng g6→g5 Đỏ: [úp Tốt]→Tốt e3→e4 Đen: [úp Tốt]→Mã a6→a5 Đỏ: [úp Tốt]→Tốt a3→a4 Đen: [úp Tốt]→Pháo c6→c5 Đỏ: [úp Tượng]→Pháo c0→e2 Đen: Tượng g5→e3 Đỏ: Tốt a4→a5 ăn Mã Đen: Pháo c5→i5 Đỏ: Tượng i4→g6 Đen: Pháo i5→g5 Đỏ: [úp Mã]→Xe h0→i2 Đen: [úp Tốt]→Tốt i6→i5 Đỏ: [úp Pháo]→Mã h2→h9 ăn Xe (úp) Đen: [úp Xe]→Tốt i9→h9 ăn Mã Đỏ: Xe i2→f2 Đen: Tốt i5→i4 Đỏ: [úp Tốt]→Sĩ g3→g4 Đen: [úp Tượng]→Mã c9→e7 Đỏ: Sĩ g4→h5 Đen: [úp Mã]→Sĩ b9→c7 Đỏ: [úp Tốt]→Tượng c3→c4 Đen: Tốt i4→h4 Đỏ: Tốt e4→e5 Đen: [úp Tốt]→Tốt e6→e5 ăn Tốt Đỏ: Pháo e2→e5 ăn Tốt Đen: Mã e7→c6 Đỏ: Pháo e5→e4 Đen: [úp Pháo]→Tượng b7→b4';
function replayLog(text, upto) {
  const T = { 'Tướng': 'K', 'Sĩ': 'A', 'Tượng': 'E', 'Mã': 'H', 'Xe': 'R', 'Pháo': 'C', 'Tốt': 'P' };
  const sq = (x) => J.idx('abcdefghi'.indexOf(x[0]), 9 - +x[1]);
  const re = /(Đỏ|Đen): (?:\[úp (\S+)\]→)?(\S+) ([a-i]\d)→([a-i]\d)(?: ăn (Tướng|Sĩ|Tượng|Mã|Xe|Pháo|Tốt)( \(úp\))?)?/g;
  let s = J.createGame({ seed: 1 }), m, n = 0;
  const history = [];
  while ((m = re.exec(text)) && n < upto) {
    const from = sq(m[4]), to = sq(m[5]), opts = { trusted: true };
    if (s.board[from].hidden) opts.revealAs = T[m[3]];
    if (s.board[to] && s.board[to].hidden) opts.captureAs = T[m[6]];
    s = J.makeMove(s, { from, to }, opts);
    history.push({ from, to });
    n++;
  }
  return { s, history };
}
const rootOf = async (spec, s, history) => {
  const r = await bots.resolve(`${spec},debug=true`).chooseMove(J.cloneState(s), J, { ...ctx(s.turn), history });
  return { r, root: r.info.root, find: (n) => r.info.root.find((x) => name(x) === n) };
};

test('step 16 rule 1: with an enemy Cannon on the King file and the file thin, the bot puts an Advisor on e8 first', async () => {
  // move 26 of the reported game: the bot (Black) played e6xe5, opening the file → Pháo e2xe5+, then pháo trống
  const { s, history } = replayLog(GAME_2018, 25);
  const old = await think('search-v11:depth=4', s);
  assert.strictEqual(name(old.move), 'e6→e5', 'the old bot opens the file');
  const r = await bots.resolve('search:depth=4').chooseMove(J.cloneState(s), J, { ...ctx(s.turn), history });
  assert.ok(['f9→e8', 'd9→e8'].includes(name(r.move)), `played ${name(r.move)}`);
});

test('step 16 rule 2 + LMR fix: against an eyeing Elephant (g6 → e8 through f7) the eye is blocked', async () => {
  // move 30: the bot played b7b4 (it missed Xe f2→f8 because LMR reduced that quiet move); h7→f7 blocks the eye
  const { s, history } = replayLog(GAME_2018, 29);
  const { find } = await rootOf('search:depth=2', s, history);
  const f7 = find('h7→f7');
  assert.ok(f7 && f7.pen <= -0.6, `h7→f7 is kept at the root with the bonus (${f7 && f7.pen})`);
  const { find: findOld } = await rootOf('search-v11:depth=2', s, history);
  assert.ok(!findOld('h7→f7'), 'the old bot pruned it at the root');
  // with the LMR exemption the full-window score of b7b4 at depth 4 sees the mate threat
  const r = await bots.resolve('search:depth=4').chooseMove(J.cloneState(s), J, { ...ctx(s.turn), history });
  assert.notStrictEqual(name(r.move), 'b7→b4');
});

test('step 16: pushing a revealed Pawn into the mouth of a hidden Pawn is penalised on every file', async () => {
  // Black revealed Pawn e5 (x4,y4), Red hidden Pawn still on e3 (x4,y6): e5→e4 frees it (game 1 of the report)
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [4, 4, 'b', 'P'], [0, 0, 'b', 'R'], [8, 9, 'r', 'R']], 'b');
  s.board[J.idx(4, 6)] = { side: 'r', type: null, hidden: true, role: 'P' };
  s.pools = { r: { P: 1 }, b: {} };
  const spec = 'search:depth=1,strengthGap=0,palaceGuardBonus=0,phase.middlegameAbove=0';
  const { find } = await rootOf(spec, s, []);
  assert.ok(find('e5→e4').pen >= 1, `pen ${find('e5→e4').pen}`);
  const { find: f2 } = await rootOf(`${spec},releaseControlAllFiles=false`, s, []);
  assert.ok(!(f2('e5→e4').pen >= 1), 'step 9 alone: edge files only');
});

test('step 16: the same revealed piece moving again (0.3, third time 0.6); A/E wandering into the enemy half (0.5)', async () => {
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 2, 'b', 'R'], [8, 9, 'r', 'R'], [2, 0, 'b', 'E'], [7, 9, 'r', 'P']], 'b');
  const spec = 'search:depth=1,strengthGap=0,palaceGuardBonus=0,phase.middlegameAbove=0';
  // Black's previous move ended on a7 (0,2); the one before ended on a9, from where a9→… : third move in a row
  const h2 = [{ from: J.idx(0, 0), to: J.idx(0, 2) }, { from: J.idx(8, 9), to: J.idx(8, 8) }];
  const h3 = [{ from: J.idx(1, 0), to: J.idx(0, 0) }, { from: J.idx(8, 8), to: J.idx(8, 9) }, ...h2];
  assert.strictEqual((await rootOf(spec, s, h2)).find('a7→b7').pen, 0.3);
  assert.strictEqual((await rootOf(spec, s, h3)).find('a7→b7').pen, 0.6);
  assert.strictEqual((await rootOf(spec, s, [])).find('a7→b7').pen, 0);
  // Elephant c9 → e7 stays home; a revealed Elephant crossing the river is penalised
  const t = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [2, 4, 'b', 'E'], [8, 9, 'r', 'R'], [7, 9, 'r', 'P']], 'b');
  const { find } = await rootOf(spec, t, []);
  assert.strictEqual(find('c5→e3').pen, 0.5);
  assert.strictEqual(find('c5→a7').pen, 0);
});

test('step 16 eval: pháo đầu away from home, pháo đầu xa (2 between), palace centre controlled', () => {
  const E = bots.lib.eval;
  const w = E.resolveWeights(bots.get('search').params), w0 = E.resolveWeights(bots.get('search-v11').params);
  // Red Cannon e2 (4,7) on Black King's file e9 (4,0) with 2 pieces between (Black Pawns e6, e7)
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [4, 7, 'r', 'C'], [4, 3, 'b', 'P'], [4, 2, 'b', 'P']], 'r');
  assert.strictEqual(E.cannonScreens(s, J, 'b', J.idx(4, 0)), 2);
  const d = E.evaluate(s, J, 'r', w) - E.evaluate(s, J, 'r', w0);
  assert.ok(Math.abs(d - 0.25) < 1e-9, `cannonFile2 ${d}`);
  // the square in front of the Black King (e8) attacked by a Red Elephant on g6 (6,3): +0.5
  s.board[J.idx(6, 3)] = { side: 'r', type: 'E', hidden: false, role: 'E' };
  const d2 = E.evaluate(s, J, 'r', w) - E.evaluate(s, J, 'r', w0);
  assert.ok(Math.abs(d2 - 0.75) < 1e-9, `+ palace centre controlled ${d2}`);
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
