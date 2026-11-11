# Cờ Tướng Úp (Jieqi / 揭棋)

A local Jieqi (face-down Chinese chess) board. Plain HTML/CSS/JS – no build step, no server. The UI is in Vietnamese.

## Running

Open `index.html` in a browser (double-clicking it is enough).

Engine tests (requires Node.js):

```bash
npm test
```

## Rules implemented

- Both Kings start face-up; each side's other 15 pieces start face-down on the standard squares.
- A face-down piece moves like the original piece of its square (face-down on a Rook square moves like a Rook; a hidden Advisor stays in the palace; a hidden Elephant does not cross the river).
- After it moves, the piece is revealed; its identity is drawn at random from that side's "bag" of remaining hidden pieces.
- A revealed Advisor/Elephant may move anywhere on the board (Advisor 1 step diagonally, Elephant 2 steps diagonally, still blocked by its "eye").
- Capturing a hidden piece reveals what it was.
- Flying-general rule, no moving into check, no legal moves = loss.
- Draw after 60 moves (120 plies) in a row with no capture and no reveal by either side (自然限着).
- Repetition follows the **Chinese rules** (see below).

### Repetition (Chinese rules – 中国象棋竞赛规则)

When a position occurs **for the 3rd time** (same piece placement, same side to move), the engine classifies each side's moves within the cycle:

| Move kind | Meaning |
|---|---|
| Check (将) | Gives check |
| Mate threat (杀) | If the opponent passed, there would be an immediate checkmate |
| Chase (捉) | Creates a new **profitable** capture: the target has no real defender (cannot be recaptured), or is worth more than the attacker (e.g. Horse/Cannon attacking a Rook even if the Rook is defended) |
| Idle (闲) | Every other move: offering a trade (兑), sacrificing, blocking, following… |

Not a chase: the King or a Pawn doing the attacking; attacking a Pawn that has not crossed the river; attacking a truly defended piece of equal value (= a trade offer).

**Violation (禁止着法)**: a side whose *every* move in the cycle is a check / mate threat / chase, with no idle move – this includes perpetual check (长将), perpetual mate threat (长杀), perpetual chase (长捉), and the alternating forms 一将一捉, 一将一杀, 一杀一捉 (Asian rules only forbid perpetual check and perpetual chase; Chinese rules also forbid the alternating forms).
**Allowed**: at least one idle move in between (一将一闲, 数将一闲, 一捉一闲…).

**Ruling – must deviate**: perpetual check is the most serious violation. The side with the more serious violation is the violator: any of its moves that would make the position occur for the 3rd time is **not allowed** (`getLegalMoves` filters it out, `makeMove` throws `Illegal move`) – it must play something else. If the violator has no other move, it **loses**. Equal violations or no violation → the 3rd occurrence is a **draw**. Example: one side checks perpetually while the other runs with its King but keeps a mate threat → the checking side must deviate.

In the UI: on the 2nd occurrence the violating side gets a warning; forbidden moves are marked with a red ✕ – click it to see why. The search bot understands these rules and avoids perpetual check/chase on its own when it is the violator (even before the move is outright forbidden). Forbidden moves and their reasons: `Jieqi.forbiddenMoves(state)`.

Configure when creating a game: `Jieqi.createGame({ rules: { repetition: 'chinese' | 'none', repetitionCount: 3, naturalLimit: 120 } })`. Analyse a repeated position: `Jieqi.repetitionStatus(state)`.

Simplifications compared with the full rules (may be added later): the exception "a capture that is immediately followed by being checkmated is not a chase" is not handled; a captured hidden piece is valued at 3; mate threats ignore hidden pieces.

## Clock

- Choose the time control under "Thời gian" (Time): untimed, 3+2, 5, 10, 10+5, 15+10, 30 minutes, or custom (minutes + seconds added per move).
- The clock starts after Red's first move. After each move the increment (if any) is added and the clock switches to the opponent.
- Running out of time loses. Under 10 seconds the clock turns red and shows tenths of a second.
- "Tạm dừng" (Pause, or the Space key) stops the clock and locks the board. "Đi lại" (Undo) restores the time to exactly what it was before that move.
- Changing the time control mid-game takes effect from the next game.
- The clock logic lives in `clock.js` (class `ChessClock`) and can be reused by bots (e.g. for a bot to budget its thinking time).

## Ending a game

- **Resign** ("Chịu thua"): with 2 humans the side to move resigns; against a bot the human resigns. Requires confirmation.
- **Offer a draw** ("Cầu hoà"): with 2 humans the other side clicks Accept / Decline; against a bot the bot decides via its `acceptDraw` function (the greedy bot accepts when it is behind or level in material).
- **Reveal all hidden pieces** ("Lật hết quân úp"): shown after the game ends; pieces revealed this way get an orange outline. The engine provides `Jieqi.revealAll(state)`.
- Clicking "Đi lại" (Undo) right after a resignation / draw / timeout cancels that result and play continues.

> If the rules you usually play differ (e.g. revealed Advisors/Elephants stay restricted), change `pseudoTargets` in `engine.js`.

## Structure

| File | Role |
|---|---|
| `engine.js` | Game rules, no DOM. Works in the browser (`window.Jieqi`) and in Node (`require('./engine')`) |
| `clock.js` | Two-sided clock (increment per move, pause, save/restore on undo) |
| `ui.js` | Draws the board, handles clicks, undo, move list; Human/bot selection for each side |
| `bots/registry.js` | Bot registration + the shared interface (`JieqiBots`) |
| `bots/manifest.js` | List of bot files – **adding a bot only requires editing this file** |
| `bots/lib/common.js` | Shared helpers (simple piece values, random pick…) |
| `bots/lib/eval.js` | Position evaluation (phase-dependent piece values, mobility, check) |
| `bots/lib/opening.js` | Priority order for revealing hidden pieces |
| `bots/random.js`, `bots/greedy.js`, `bots/eval1.js`, `bots/search.js` | Bots: random, greedy, 1-ply evaluation, multi-ply search |
| `bots/index.js` | Loads every bot in Node |
| `arena/match.js` | Plays one bot-vs-bot game, replays a game from a record |
| `arena/arena.js` | Arena: runs many games in parallel, Elo statistics |
| `arena/bench.js` | Engine/bot benchmarks, perft to catch rule changes |
| `test/` | Tests for the rules (including repetition), bots, arena (`npm test`) |

## Engine API (for writing bots)

```js
const s0 = Jieqi.createGame({ seed: 123 });   // fixed seed => reproducible game
Jieqi.getLegalMoves(s)                         // [{from, to}], square = y*9 + x
Jieqi.makeMove(s, move)                        // returns a NEW state (immutable)
Jieqi.makeMove(s, move, { revealAs: 'R' })     // force the revealed piece to be a Rook (for expectimax)
Jieqi.makeMove(s, move, { captureAs: 'C' })    // force the captured hidden piece to be a Cannon
Jieqi.makeMove(s, move, { fast: true })        // skip legality/result checks, for fast search
Jieqi.revealProbabilities(s, 'b')              // { R: 0.2, C: 0.13, ... } reveal probabilities
Jieqi.revealAll(s)                             // reveal every hidden piece (only for viewing after the game)
Jieqi.isInCheck(s), s.result, s.turn, s.board, s.pools
```

Each piece: `{ side: 'r'|'b', type, hidden, role }`. `role` = the piece type of its starting square (how a hidden piece moves); `type` = the real piece, `null` while hidden.

Piece codes: K King (Tướng), A Advisor (Sĩ), E Elephant (Tượng), H Horse (Mã), R Rook (Xe), C Cannon (Pháo), P Pawn (Tốt).

## Writing a bot

1. Create `bots/<bot-name>.js`:

```js
(function (root) {
  const { VALUE, materialDiff } = root.JieqiBots.lib.common;
  root.JieqiBots.register({
    id: 'my-bot',
    name: 'Bot của tôi',                        // display name (the UI is in Vietnamese)
    description: 'Mô tả ngắn, hiện trong UI',   // short description shown in the UI
    params: { depth: 2 },                       // default params, overridable
    chooseMove(state, J, ctx) {                 // may be async
      const moves = J.getLegalMoves(state);
      return { move: moves[0], info: { score: 0, depth: ctx.params.depth } };   // or just return moves[0]
    },
    acceptDraw(state, J, ctx) {                 // optional
      return materialDiff(state, J, ctx.side) < 0;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

2. Add `'<bot-name>.js'` to `bots/manifest.js`. The bot then shows up in the UI (Red/Black selectors) and in the arena.

The `ctx` a bot receives: `side`, `ply`, `params`, `random()` (seeded in the arena – do not use `Math.random`), `now()`, `timeBudgetMs`, `deadline`, `clock` (`{ myTimeMs, oppTimeMs, incrementMs }` or `null`), `history`. Details at the top of `bots/registry.js`.

**Several styles from one algorithm**: use variants instead of copying code.

```js
JieqiBots.variant('my-bot', { id: 'my-bot-endgame', name: 'Bot ưu tiên tàn cuộc', params: { endgameWeight: 2 } });
```

or pick one quickly when running the arena: `--a my-bot:depth=3,endgameWeight=2`.

**A bot service later on**: a bot only needs `chooseMove` to return a Promise, so a bot that calls a service is a small file:

```js
chooseMove: async (state, J, ctx) => {
  const res = await fetch('http://localhost:8000/move', { method: 'POST', body: JSON.stringify({ state, ctx: { side: ctx.side, timeBudgetMs: ctx.timeBudgetMs } }) });
  return res.json();   // { move: {from, to}, info }
}
```

The state is plain JSON and can be sent as is. The arena can call such bots too.

## Position evaluation (`bots/lib/eval.js`)

Score = **material** + **mobility** (0.02 × difference in number of moves) + **check** (±0.3). Win/loss = ±1000.

| Piece | Value |
|---|---|
| Pawn | -1 on its own palace centre (blocks the King – the opponent should not capture it), 1 before crossing the river, 2 after crossing, 0.5 when bottomed out (opponent's last rank) |
| Elephant | 1 |
| Advisor | 2; 3 when paired (2 Advisors diagonally adjacent, protecting each other) |
| Horse | 3 opening · 4 middlegame · 5 endgame |
| Cannon | 5 opening · 4 middlegame · 3 endgame |
| Rook | 9.5 opening · 9 middlegame · 10 endgame |
| Hidden piece | average over the reveal probabilities, each possibility scored as if revealed on its current square |

Game phase by the number of pieces left on the board / 32 (Kings and hidden pieces included): > 90% (≥ 29 pieces) opening, > 50% (17–28) middlegame, otherwise endgame.

Every coefficient can be overridden without touching the code:

```bash
npm run arena -- --a eval-1ply:R.endgame=11,mobility=0 --b eval-1ply
```

```js
JieqiBots.variant('eval-1ply', { id: 'tan-cuoc', name: 'Ưu tiên tàn cuộc', params: { 'H.endgame': 6, 'P.crossed': 2.5 } });
```

In the UI, tick "Hiện đánh giá thế cờ" (Show evaluation) to see the score (from Red's point of view), the game phase and each piece's value right on the board.

Bots using this function: `eval-1ply` (full) and `material-1ply` (material only). Both only look 1 ply ahead, so they are only on par with the greedy bot (~54%) – the evaluation only pays off with a multi-ply search (step 3).

## Search bot (`bots/search.js`)

Looks several moves ahead:

- **Alpha-beta (negamax)**: tries our moves, the opponent's replies…, and prunes branches that are certainly worse.
- **Chance nodes for reveals** (expectimax): a reveal move is scored as the probability-weighted average over every piece type it may turn out to be. **Star2**-style pruning: a cheap probe first gives an upper bound for each outcome (in quiescence this is simply the opponent's stand-pat score); if the weighted total is already worse than the best move, the move is dropped without a full search. The result is *exactly the same* as without probing (there is a test), with ~14× fewer nodes.
- Capturing a hidden piece does *not* split: the board after the capture is the same for every identity, and leaving the pool unchanged keeps the expected probabilities exact (`makeMove(..., { captureUnknown: true })`).
- **Quiescence**: at the depth limit, keep searching captures; when in check, consider every evasion (first 2 plies). Hidden pieces may only capture at the first ply, plus delta pruning.
- **Transposition table** (Zobrist hash, including the hidden pools): reuses results of positions already searched and tries the previous best move first.
- **Move ordering**: best move from the transposition table → captures (MVV-LVA) → killer moves → history.
- **LMR**: later quiet moves are searched 1 ply shallower and re-searched at full depth if they turn out better. **Null move** from depth 3.
- **Iterative deepening** on time; when time runs out mid-iteration, the previous iteration's result is still usable.

| Bot | Style |
|---|---|
| `search` | Search bot – at most 2 seconds/move |
| `search-fast` | At most 0.3 seconds/move |
| `search-midgame` | Plays fast in the opening, spends 2.5× as much time in the middlegame |
| `search-endgame` | Values Horse/Rook/crossed Pawns higher in the endgame, thinks longer once in the endgame |
| `search-v3`, `search-v4` | Step-3 / step-4 versions (before reveal priorities), hidden from the UI – reference points only |

Params: `depth` (fixed depth – reproducible), `maxTimeMs`, `phaseTime.middlegame`, `qDepth`, `probe`, `tt`, `lmr`, `nullMove`, `pvs`… plus every evaluation weight. Examples: `--a search:depth=3`, `--a search:lmr=false --b search`.

### Reveal priorities (`bots/lib/opening.js`)

The order in which hidden pieces should be revealed, from player experience, applied as long as hidden pieces remain:

1. hidden Pawn on an edge file (a, i) → 2. hidden Pawn on file 3, 7 → 3. hidden centre Pawn → 4. hidden Advisor to the palace centre, hidden Elephant to the centre → 5. hidden Horse → 6. hidden Elephant to the edge → 7. hidden Cannon straight forward → 8. hidden Cannon sideways/backwards → 9. hidden Rook.

The bot uses this table in 2 ways (both on by default):

- **Ordering** (`openingOrder`): reveal moves are tried in the order above.
- **Pruning** (`revealTopKRoot=8`, `revealTopK=4`): at the root only the top 8 reveal moves are considered, 4 at deeper levels. Captures, moves of revealed pieces and positions in check are always fully considered. "Don't reveal into the enemy's mouth" is found by the search itself.

A third option, `development` (e.g. `0.3`): an evaluation bonus for revealing in the right order – off by default because it does not help further.

Results (30 games per option, 0.5 seconds/move, against the previous version – `search-v4`):

| Option | Score | Elo |
|---|---|---|
| Ordering only | 48.3% | ≈ 0 |
| **Ordering + pruning (default)** | **68.3% (+20 =1 −9)** | **+134** |
| + bonus `development=0.3` | 66.7% | +120 |

Starting position: a depth-3 search went from 9 seconds down to 1.5 seconds; at 2 seconds/move the bot reaches depth 3 from the very first move (previously 2).

### Progress (measured in the arena, 0.3 seconds/move)

| Milestone | Result |
|---|---|
| Step 3: `search-v3` vs `greedy` | 92.5% (0.5 seconds/move) |
| Step 4: `search` vs `search-v3` | **85% (+31 =6 −3), +301 Elo**; average depth 4.3 vs 2.5 |
| Step 4: `search` vs `greedy` | **100% (30/30 games)** |

### Optimisations in step 4

| | Before | After |
|---|---|---|
| Legal move generation | 110 µs | 11 µs (check detection scans outward from the King, make/unmake in place on the board, no allocation) |
| Check detection | 2.9 µs | 0.6 µs |
| Depth-2 search (6 positions) | 26 seconds, 1 million nodes | 0.9 seconds, 71 thousand nodes |
| Depth reached in 0.5 seconds | 1–4 | 2–6 |

Re-measure with `npm run bench` (or `node arena/bench.js search:lmr=false 1,2,3`). `perft(3)` in the bench must stay unchanged after every engine optimisation – a change means the rules were altered by accident.

**Known limitations**: the starting position (perfectly balanced, every move is a reveal) still only reaches depth 2 in ~1 second. Bots run on the main thread, so the UI freezes while a bot is thinking (step 5: Web Worker).

## Arena (bot vs bot)

```bash
npm run bots                                          # list bots
npm run bench                                         # engine + bot benchmarks
npm run arena -- --a greedy --b random --games 200
npm run arena -- --a greedy:revealBonus=0 --b greedy -n 400 -j 8 --out results/test.json
npm run arena -- --a my-bot --b greedy --tc 60+1      # real clock 60s + 1s/move, running out of time loses
```

- Each seed is played twice with colours swapped, for fairness. Same seed + same bots ⇒ identical result (reproducible for debugging).
- Output: wins/draws/losses (split by colour), Elo difference with a 95% confidence interval, LOS (probability that A is stronger than B), time per move, average depth, end reasons.
- A bot that plays an illegal move or throws ⇒ loses (`illegal-move`, `bot-error`), with details recorded.
- Beyond `--max-plies` (default 300) ⇒ adjudicated as a draw.
- `--out` saves every game (seed + moves); rebuild one with `replay(J, record)` from `arena/match.js`.

Reference points: `greedy` vs `random` ≈ 95%; `search-v3` vs `greedy` ≈ 92.5%; `search` vs `search-v3` ≈ 85%.

## Open-source references

- [wenpinglaoyao/jieqiGame](https://github.com/wenpinglaoyao/jieqiGame)
- [Warm-rain/Pikafish](https://github.com/Warm-rain/Pikafish) (Pikafish fork for Jieqi)
- [arthuryangcs/JieqiAI](https://github.com/arthuryangcs/JieqiAI)
