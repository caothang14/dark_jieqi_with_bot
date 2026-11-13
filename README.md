# Cờ Tướng Úp (Jieqi / 揭棋)

A local Jieqi (face-down Chinese chess) board. Plain HTML/CSS/JS – no build step, no server. The UI is in Vietnamese.

## Running

Open `index.html` in a browser (double-clicking it is enough).

Engine tests (requires Node.js):

```bash
npm test
```

## Game modes

The tabs at the top of the panel:

- **Đấu với máy** (play vs computer): pick your side ("Bạn cầm": Red, Black or random); the computer is always the strongest bot (`level-4` = `search`, ~4 s/move in the opening, ~3 s later). When you play Black the board is rotated so your pieces are at the bottom. Changing side applies at the next "Ván mới" (New game), or immediately if no move has been played yet. The choice is remembered in the browser. (A difficulty selector existed in step 5 and was removed in step 11; the levels are still available in the "Tuỳ chỉnh" tab.)
- **Hai người** (two players): two humans on the same screen.
- **Tuỳ chỉnh** (custom): choose a Human or any bot for each side (e.g. bot vs bot).

### Difficulty levels (`bots/levels.js`)

All four are variants of the search bot (`level-1` … `level-4`):

| Level | Settings | |
|---|---|---|
| Dễ (Easy) | depth 1, `randomness=1.5` | often picks a weaker move (up to ~1.5 Pawns worse) |
| Vừa (Medium) | depth 2, `randomness=0.4` | occasionally picks a slightly weaker move |
| Khó (Hard) | full search, at most 0.5 s/move | |
| Rất khó (Very hard) | full search, ~4 s/move in the opening, ~3 s later | = the `search` bot, the strongest one |

`randomness`: every root move gets an exact score and the bot picks at random among the moves at most `randomness` below the best one (the closer to the best, the more likely). It never throws away a forced mate, and a large gain (e.g. a free Rook) is always taken.

Arena check that the levels are ordered (2 s/move cap):

| Match | Result |
|---|---|
| Vừa vs Dễ | 90% (+17 =2 −1, 20 games) |
| Khó vs Vừa | 95% (+19 =0 −1, 20 games) |
| Rất khó vs Khó | 58% (+7 =0 −5, 12 games – not yet significant, the gap is small) |

### Bots run in a Web Worker

Bots think in a Web Worker (`bots/worker.js`), so the page stays responsive while a bot is thinking. "Đi lại" (Undo), "Ván mới" (New game) or changing players while a bot is thinking stops the computation right away.

This also works when `index.html` is opened via `file://`: browsers block `new Worker('file.js')` there, so the worker is built from a Blob containing the source code of `engine.js`, `bots/registry.js` and every bot file (each file registers its factory function via `JieqiBots.module`, and `Function.prototype.toString` gives back its source). If a worker cannot be created, bots simply run on the main thread as before.

## Publishing (GitHub Pages)

The game is static files, so GitHub Pages serves it straight from the `main` branch. **Before committing an update, run `npm run bump`**: it sets a new version tag (`?v=YYYYMMDD-HHMM`) on every script in `index.html` (ui.js loads the bot files with the same tag). Without it, a browser can mix a new `index.html` with cached old `.js` files (GitHub Pages caches files for ~10 minutes) – on an iPhone this showed an empty board.

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
| `bots/levels.js` | Difficulty levels for "Đấu với máy" (variants of the search bot) |
| `bots/worker.js` | Runs bots in a Web Worker (browser only) |
| `bots/index.js` | Loads every bot in Node |
| `arena/match.js` | Plays one bot-vs-bot game, replays a game from a record |
| `arena/arena.js` | Arena: runs many games in parallel, Elo statistics |
| `arena/bench.js` | Engine/bot benchmarks, perft to catch rule changes |
| `test/` | Tests for the rules (including repetition), bots, arena, worker source (`npm test`) |

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
JieqiBots.module(function (root) {             // the wrapper lets the bot also run in the Web Worker
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
});
```

The factory must only use `root` (not variables from outside the function), because the worker rebuilds it from its source text. A bot file without the `JieqiBots.module` wrapper still works, but runs on the main thread (the UI freezes while it thinks).

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
| `search` | Search bot – ~4 s/move in the opening, ~3 s in the middlegame/endgame (`maxTimeMs=4000`, `phaseTime.middlegame/endgame=0.75`) |
| `search-fast` | At most 0.3 seconds/move |
| `search-midgame` | Plays fast in the opening, spends 2.5× as much time in the middlegame |
| `search-endgame` | Values Horse/Rook/crossed Pawns higher in the endgame, thinks longer once in the endgame |
| `level-1` … `level-4` | Difficulty levels (see "Game modes") |
| `search-v3` … `search-v6` | Step-3 / step-4 (before reveal priorities) / step-5 (before `hiddenTrapped`) / step-6 (before the opening fixes) versions, hidden from the UI – reference points only |

Params: `depth` (fixed depth – reproducible), `maxTimeMs`, `phaseTime.middlegame`, `qDepth`, `probe`, `tt`, `lmr`, `nullMove`, `pvs`, `randomness`… plus every evaluation weight. Examples: `--a search:depth=3`, `--a search:lmr=false --b search`.

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

### Ideas from Jieqi player experience (step 6)

Ideas taken from player guides (mistboard.com, zigavn.com) were implemented as params and each one was played against the current bot (`search`) in the arena at 0.5 s/move. Only the one that clearly helped is on by default; the others stay available as params (off).

| Idea | Param | Games | Score | Kept? |
|---|---|---|---|---|
| **"Khống chế quân úp"**: penalty for each own hidden piece that has moves but every target square is attacked (it cannot be revealed safely); the opponent's trapped pieces count for us | `hiddenTrapped=0.3` | 100 | **61% (+60 =2 −38), ≈ +78 Elo** | **yes (default)** |
| Hidden pieces may not capture in quiescence (much smaller tree in the opening) | `qHiddenPly=0` | 60 | 59% alone, but 45% (40 games) combined with `hiddenTrapped` | no |
| Reveal fewer moves (2 below the root, 5 at the root) | `revealTopK=2,revealTopKRoot=5` | 30 | 43% | no |
| Keep hidden Rook/Cannon squares hidden below the root; fewer reveals once 3 big pieces are out | `revealSkipRoles=RC,revealTopKDeveloped=2` | 30 | 50% | no |
| Bonus for revealed Advisor/Elephant across the river ("Sĩ/Tượng chiến") | `crossedAE=0.5` | 30 | 37% | no |
| Weaker Horse ("Mã trong cờ úp không mạnh") | `H.middlegame=3.5,H.endgame=4` | 30 | 53% | no (inconclusive) |
| Reveal Pawns on files 3/7 before edge Pawns | `pawnOrder=c37` | 60 | 52% | no |

Note: 30 games give an error bar of roughly ±120 Elo, so a single 30-game result can be misleading (two ideas that looked good on the first 30 games lost when combined). Only `hiddenTrapped` stayed positive on three different seed sets.

Final check at 2 s/move ("Rất khó"): new `search` vs the previous version `search-v5`: **50% (+10 =0 −10, 20 games)** – no measurable gain at this time control (the error bar is ±170 Elo; the deeper search may already see most of what the penalty encodes). The gain is clear at 0.5 s/move ("Khó").

### Opening fixes from play (step 7)

| Problem seen in games | Fix | Param |
|---|---|---|
| The bot lets an enemy Horse that came out on the edge jump into its camp instead of pushing the Pawn in front of it to block the Horse's leg ("cản mã") | Bonus for revealing a hidden Pawn so that it blocks a leg of a revealed enemy Horse that can jump into our half (the first try, an evaluation term `horseReach=0.3`, lost in the arena and is now off) | `horseBlockBonus=1.5` (on) |
| A hidden piece in danger is not saved: the move that saves it (often a low-priority reveal, e.g. freeing a square) was dropped by reveal pruning at the root | If a hidden piece of the side to move is attacked and undefended, and at least 3 Rooks/Cannons/Horses are still hidden: no reveal pruning at the root, and below the root its own moves are never pruned | `keepThreatened=true`, `keepThreatenedMinBig=3` (on) |
| The bot raids early with a hidden Cannon onto the enemy's hidden Horse square ("vật pháo giả lên mã giả"); experts do it only after the edge Pawn produced a Rook, to break the enemy's hidden Rook on that side | Penalty on the bot's own move: hidden Cannon capturing a hidden piece, unless it has a revealed Rook AND the opponent's hidden Rooks/Cannons/Horses are worth more than its own (R 9, C 4.5, H 4) | `cannonRaidMalus=1.5` (on) |
| The bot captures with its hidden Rook ("xe giả"), which experts keep hidden because it defends well – unless the target is a Rook / Cannon / Horse | Penalty on the bot's own move at the root: hidden Rook capturing anything but a revealed R/C/H | `hiddenRookCaptureMalus=1.5` (on) |
| The bot captures the opponent's hidden pieces instead of revealing its own, even when the opponent already has a Rook out and it has no fighting piece out | Penalty on the bot's own moves of revealed pieces in that situation (capturing a hidden piece / other moves) | `developFirstMalus=1`, `developFirstQuietMalus=0.3` (on) |
| An enemy Cannon on the edge attacks the bot's hidden Rook, and the bot does not block it with the Elephant/Horse ("gác Tượng/Mã chăn Pháo") – it sees the blocker as walking into the Cannon | Bonus for a quiet reveal that puts a second piece between a revealed enemy Cannon and the bot's hidden Rook | `guardRookBonus=2` (on) |

These penalties/bonuses are in Pawns: such a move is only played if it is that much better than the alternatives. They apply only to the bot's own move (when searching, the opponent may still play these moves), and not when in check or when the moving piece is itself attacked and undefended.

Arena (0.5 s/move, the same 60 games each time, against `search-v6`): first version 43.3% (+25 =2 −33, ≈ −47 Elo); after narrowing rules 1, 2, 3 and 6 as above: **55.8% (+33 =1 −26, ≈ +41 Elo, LOS 82%)** – better, not yet statistically certain.

All six have test positions in `test/search.test.js`. To see why the bot chose a move, use `search:depth=3,debug=true`: `info.root` lists the exact score (and penalty) of every root move. The previous version is kept as the hidden bot `search-v6` for the next arena run.

### King safety and cannon placement (step 8)

Evaluation terms from the user's experience, for both sides (in Pawns). On in `search` (and so in every difficulty level), except "pháo giác", which lost in the arena. The previous version is kept as the hidden bot `search-v7`.

| Idea | Rule | Param in `search` |
|---|---|---|
| Horse check threat | Per square an enemy revealed Horse can jump to next move and check our King from, that we do not guard (at most 2.5 squares per Horse) | `horseCheckThreat=0.4` |
| Enemy central Cannon ("pháo đầu") | Enemy revealed Cannon on our King's file with exactly one piece between, while our King is on its starting square | `cannonFacingKing=0.5` |
| Own Cannon to the centre | Our revealed Cannon on file e, in the opening, while the opponent has ≥ 2 hidden pieces on its Advisor/Elephant squares | `centralCannon=0.3` |
| "Pháo giác" | Our revealed Cannon on the opponent's back rank: per enemy hidden piece on an Advisor/Elephant square that it stops from being revealed (every reveal lands on an attacked square or uncovers a Cannon check) | `bottomCannon` – **off** (0.4 tested) |
| "Pháo trống" | Enemy revealed Cannon on our King's file with nothing between (worse than "pháo đầu"; the defence is to reveal Advisor/Elephant into the centre so two pieces stand between) | `cannonEmptyFile=0.8` |

These terms make the evaluation slower: ~20–25% fewer nodes per second.

Arena, each idea alone vs `search` (40 games, 0.5 s/move, `--seed 601`):

| Idea | Score |
|---|---|
| Horse check threat (`horseCheckThreat=0.4`) | **63.7% (+25 =1 −14)** |
| Pháo đầu + pháo trống (`cannonFacingKing=0.5,cannonEmptyFile=0.8`) | 52.5% (+20 =2 −18) |
| Own Cannon to the centre (`centralCannon=0.3`) | **58.8% (+23 =1 −16)** |
| Pháo giác (`bottomCannon=0.4`) | 45.0% (+17 =2 −21) |
| The two winners together (60 games, `--seed 701`) | **55.8% (+33 =1 −26), ≈ +41 Elo, LOS 82%** |

Decision (user): keep everything except "pháo giác". "Pháo đầu + pháo trống" is on although it was only 52.5% in the arena – the user considers an empty-file Cannon too dangerous to leave unguarded (it decided the game analysed above).

### Edge-Pawn standoff and "phi pháo úp" (step 9)

| Problem seen in games | Fix (root penalty on the bot's own move) | Param |
|---|---|---|
| The bot pushes its revealed edge Pawn further into the mouth of the enemy's hidden edge Pawn, although that hidden Pawn is already held ("the enemy piece is already dead – leave it") – it should reveal a piece instead | Pushing our revealed Pawn on file a / i forward from our river bank while the enemy's hidden Pawn still stands on its start square opposite (any phase; not when our Pawn is attacked and undefended) | `releaseControlMalus=1` |
| "Phi pháo úp": the bot leaps a hidden Cannon into the opponent's half – good if it turns out a strong piece, a stranded weak piece otherwise | Opening only: penalty × probability that it turns out an Advisor/Elephant/Pawn (≈ 0.6 at the start) | `cannonLeapMalus=1` |

Previous version kept as the hidden bot `search-v8`.

Arena vs `search-v8` (0.5 s/move): the first, broad versions together lost (60 games, 38.3%: the Pawn rule penalised every Pawn move onto a square attacked by any hidden piece). After narrowing them as above, each alone (40 games, `--seed 901`): edge-Pawn rule **57.5% (+23 −17, ≈ +53 Elo)**, Cannon rule 50.0% (+19 =2 −19, neutral).

### Faster search (step 10)

Exact speed-ups – the bot plays exactly the same moves with the same node counts, only faster (checked against the old code on ~45,000 random positions, perft unchanged):

| Change | Why it helps |
|---|---|
| Legal-move shortcut | When not in check, a non-King move can only expose our King if it leaves/enters the King's file or rank, or leaves a square diagonally next to the King (Horse leg / Elephant eye). Other moves skip the self-check test |
| Attack map | One pass marks every square a side attacks, instead of one `isSquareAttacked` call per square (used by the "trapped hidden piece" term) |
| One-pass evaluation scan | Mobility, check and trapped hidden pieces for both sides from one loop and two attack maps |
| Cheaper king-safety terms | King and Horse squares collected in the evaluation's main loop; Horse check threats tried in place, no board copies |
| `makeMove` | Copies the board array but clones only the moving piece (pieces are never modified once on the board) |

Result: depth 3 on the 6 bench positions 4.0 s → 2.0 s (2×), opening positions 16.3 s → 9.2 s; perft(3) 450 → 240 ms. Arena proxy (the old speed = `timeScale=0.56`): **62.5% (+23 =4 −13, ≈ +89 Elo, LOS 95%)** at 0.5 s/move.

Tried and left off (params kept): `qRevealUnknown=true` (a hidden piece capturing in quiescence stays hidden – 3× fewer nodes but 36.3%), `ttKeep=true` (keep the transposition table between moves – 58.8% then 45.0% on a second seed set, ≈ 52% over 80 games).

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

**Known limitations**: the starting position (perfectly balanced, every move is a reveal) still only reaches depth 2 in ~1 second.

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
