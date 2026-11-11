/* UI for Cờ Tướng Úp – depends on Jieqi (engine.js), ChessClock (clock.js), JieqiBots (bots/registry.js + manifest). */
(async function () {
  'use strict';
  const J = window.Jieqi;
  const ChessClock = window.ChessClock;
  const Bots = window.JieqiBots;
  const MIN_BOT_DELAY_MS = 350; // so a human can follow the bot's moves

  // Load the bots listed in the manifest (plain scripts, so it also works when opened via file://)
  const loadScript = (src) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Không nạp được ${src}`));
    document.head.appendChild(el);
  });
  for (const f of window.JieqiBotManifest || []) {
    try { await loadScript(`bots/${f}`); } catch (err) { console.error(err); }
  }
  const SIDE_VI = { r: 'Đỏ', b: 'Đen' };
  const REASON_VI = {
    checkmate: 'chiếu bí', stalemate: 'hết nước đi', timeout: 'hết giờ',
    resign: 'đối thủ chịu thua', agreement: 'hai bên đồng ý hoà',
    'illegal-move': 'đối thủ đi nước không hợp lệ', 'bot-error': 'bot đối thủ bị lỗi',
    'quiet-limit': '60 hiệp không ăn quân',
    repetition: 'lặp nước, không bên nào phạm luật',
  };
  // Loss reasons from repetition (Chinese rules) – phrased for the violating side
  const VIOLATION_VI = {
    'perpetual-check': 'chiếu dai',
    'perpetual-chase': 'đuổi bắt dai',
    'perpetual-mate-threat': 'doạ bí dai',
    'perpetual-attack': 'tấn công dai (chiếu/bắt/doạ bí xen kẽ)',
  };
  const LOW_TIME_MS = 10000;

  const $ = (id) => document.getElementById(id);
  const layer = $('layer');

  let history = [];       // stack of states; current = last
  let clockSnaps = [];    // clockSnaps[i] = both sides' remaining time at the start of history[i]
  let clock = null;
  let endResult = null;     // result not coming from the engine: timeout / resignation / agreed draw
  let revealedState = null; // copy with every hidden piece revealed, only for viewing after the game
  let pendingConfirm = null;
  let selected = -1;
  let botThinking = false;
  let botInfos = [];        // botInfos[i] = info returned by the bot for the move that produced history[i]
  const current = () => history[history.length - 1];
  const displayState = () => revealedState || current();
  const gameResult = () => current().result || endResult;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Board grid ----------
  function drawGrid() {
    const g = $('lines');
    const L = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    let s = '';
    for (let y = 0; y < 10; y++) s += L(50, 50 + y * 100, 850, 50 + y * 100);
    for (let x = 0; x < 9; x++) {
      const px = 50 + x * 100;
      if (x === 0 || x === 8) s += L(px, 50, px, 950);
      else { s += L(px, 50, px, 450); s += L(px, 550, px, 950); }
    }
    s += L(350, 50, 550, 250) + L(550, 50, 350, 250) + L(350, 750, 550, 950) + L(550, 750, 350, 950);
    s += `<rect x="40" y="40" width="820" height="920" fill="none" stroke="#5a3a1a" stroke-width="5"/>`;
    g.innerHTML = s;
  }

  const pos = (i) => ({ left: `${((50 + J.X(i) * 100) / 900) * 100}%`, top: `${((50 + J.Y(i) * 100) / 1000) * 100}%` });
  const place = (el, i) => Object.assign(el.style, pos(i));

  // ---------- Clock ----------
  function readTimeControl() {
    const v = $('timeControl').value;
    if (v === 'custom') {
      const min = Math.max(1, Number($('customMin').value) || 1);
      const inc = Math.max(0, Number($('customInc').value) || 0);
      return { initialMs: min * 60e3, incrementMs: inc * 1e3 };
    }
    const [min, inc] = v.split('+').map(Number);
    return { initialMs: min * 60e3, incrementMs: inc * 1e3 };
  }

  function createClock() {
    if (clock) clock.stop();
    clock = new ChessClock({
      ...readTimeControl(),
      onTick: renderClocks,
      onTimeout: (side) => endGame({ winner: J.opp(side), reason: 'timeout' }),
    });
    $('tcNote').hidden = true;
  }

  function renderClocks() {
    for (const side of ['r', 'b']) {
      const el = side === 'r' ? $('clockR') : $('clockB');
      el.classList.toggle('off', !clock.enabled);
      if (!clock.enabled) continue;
      const ms = clock.remaining[side];
      el.querySelector('.time').textContent = ChessClock.format(ms);
      el.classList.toggle('active', clock.active === side);
      el.classList.toggle('paused', clock.paused);
      el.classList.toggle('low', ms < LOW_TIME_MS);
      el.classList.toggle('flagged', clock.flagged === side);
    }
    const pauseBtn = $('pause');
    pauseBtn.disabled = !(clock.running || clock.paused);
    pauseBtn.textContent = clock.paused ? 'Tiếp tục' : 'Tạm dừng';
  }

  // ---------- Rendering ----------
  function render() {
    const s = displayState();
    const result = gameResult();
    layer.innerHTML = '';
    const showHint = $('hint').checked;
    const checkSq = !result && J.isInCheck(s) ? J.kingSquare(s.board, s.turn) : -1;
    const wasHidden = (i) => revealedState && current().board[i] && current().board[i].hidden;
    const evalInfo = $('showEval').checked && Bots.lib.eval ? Bots.lib.eval.explain(s, J, 'r') : null;
    const evalValues = new Map(evalInfo ? evalInfo.pieces.map((x) => [x.square, x.value]) : []);
    renderEval(evalInfo);

    if (s.lastMove) {
      for (const sq of [s.lastMove.from, s.lastMove.to]) {
        const m = document.createElement('div');
        m.className = 'mark';
        place(m, sq);
        layer.appendChild(m);
      }
    }

    s.board.forEach((p, i) => {
      if (!p) return;
      const el = document.createElement('div');
      el.className = `piece ${p.side}${p.hidden ? ' hidden' : ''}`;
      if (i === selected) el.classList.add('selected');
      if (i === checkSq) el.classList.add('in-check');
      if (s.lastMove && s.lastMove.to === i && s.lastMove.revealed && !revealedState) el.classList.add('reveal');
      if (wasHidden(i)) el.classList.add('shown', 'reveal');
      el.textContent = p.hidden ? (showHint ? J.NAMES_VI[p.role] : '') : J.CHARS[p.side][p.type];
      el.title = p.hidden ? `Quân úp (đi như ${J.NAMES_VI[p.role]})`
        : J.NAMES_VI[p.type] + (wasHidden(i) ? ' (lật sau khi hết ván)' : '');
      if (evalInfo && p.type !== 'K') {
        const v = evalValues.get(i);
        if (v != null) {
          const tag = document.createElement('span');
          tag.className = 'val' + (v < 0 ? ' neg' : '');
          tag.textContent = Number.isInteger(v) ? v : v.toFixed(1);
          el.appendChild(tag);
        }
      }
      place(el, i);
      el.addEventListener('click', () => onSquare(i));
      layer.appendChild(el);
    });

    if (selected >= 0) {
      for (const m of J.getLegalMovesFrom(s, selected)) {
        const d = document.createElement('div');
        d.className = 'dot' + (s.board[m.to] ? ' capture' : '');
        place(d, m.to);
        d.addEventListener('click', (e) => { e.stopPropagation(); doMove(m); });
        layer.appendChild(d);
      }
      // moves forbidden by the repetition rules (must deviate): show a ✕, click it for the reason
      if (!result && J.forbiddenMoves) {
        for (const f of J.forbiddenMoves(s).filter((x) => x.from === selected)) {
          const d = document.createElement('div');
          d.className = 'dot forbidden';
          d.textContent = '✕';
          d.title = 'Nước bị cấm (luật lặp nước)';
          place(d, f.to);
          d.addEventListener('click', (e) => {
            e.stopPropagation();
            toast(`Không được đi: nước này lặp thế cờ lần thứ ${s.rules.repetitionCount} trong khi ${SIDE_VI[s.turn]} đang ${VIOLATION_VI[f.violation] || 'phạm luật lặp'}. Luật Trung Quốc buộc phải đổi nước.`);
          });
          layer.appendChild(d);
        }
      }
    }
    renderPanel(s, result, checkSq >= 0);
    renderClocks();
  }

  const PHASE_VI = { opening: 'Khai cuộc', middlegame: 'Trung cuộc', endgame: 'Tàn cuộc' };
  function renderEval(info) {
    const box = $('evalBox');
    box.hidden = !info;
    if (!info) return;
    const f = (x) => (x > 0 ? '+' : '') + x.toFixed(2);
    // bar: Red's share as a logistic function of the score
    const pct = info.terminal ? (info.score > 0 ? 100 : info.score < 0 ? 0 : 50) : 100 / (1 + Math.exp(-info.score / 4));
    const lead = info.score > 0.05 ? 'Đỏ hơn' : info.score < -0.05 ? 'Đen hơn' : 'Cân bằng';
    box.innerHTML = `<div><span class="big">${f(info.score)}</span> <span class="muted">(${lead}, góc nhìn Đỏ) · ${PHASE_VI[info.phase]}</span></div>`
      + `<div class="eval-bar"><div style="width:${pct}%"></div></div>`
      + (info.terminal ? '' : `<div class="muted">Quân ${f(info.material)} · Cơ động ${f(info.mobility)} · Chiếu ${f(info.check)}</div>`);
  }

  function renderPanel(s, result, inCheck) {
    const st = $('status');
    if (result) {
      st.className = 'status over';
      const loser = result.winner && SIDE_VI[J.opp(result.winner)];
      const reason = result.reason === 'resign' ? `${loser} chịu thua`
        : VIOLATION_VI[result.reason] ? `${loser} ${VIOLATION_VI[result.reason]}${result.detail === 'no-other-move' ? ', không còn nước nào khác' : ''} – luật lặp nước`
          : REASON_VI[result.reason] || result.reason;
      st.textContent = result.winner
        ? `${SIDE_VI[result.winner]} thắng (${reason})`
        : `Hoà (${REASON_VI[result.reason]})`;
    } else {
      st.className = `status ${s.turn}`;
      st.textContent = `Lượt ${SIDE_VI[s.turn]}${inCheck ? ' – đang bị chiếu!' : ''}`
        + `${botThinking ? ` (${playerName(s.turn)} đang nghĩ…)` : ''}${clock.paused ? ' – đang tạm dừng' : ''}`;
    }

    const capHtml = (list) => list.map((c) =>
      `<span class="han ${c.side}" title="${J.NAMES_VI[c.type]}${c.wasHidden ? ' (đang úp)' : ''}">${J.CHARS[c.side][c.type]}</span>`).join('') || '–';
    $('capR').innerHTML = capHtml(s.captured.r);
    $('capB').innerHTML = capHtml(s.captured.b);

    const poolHtml = (side) => Object.entries(s.pools[side]).filter(([, n]) => n > 0)
      .map(([t, n]) => `${J.NAMES_VI[t]}×${n}`).join(', ') || '–';
    $('poolR').textContent = poolHtml('r');
    $('poolB').textContent = poolHtml('b');

    const log = $('log');
    log.innerHTML = '';
    history.slice(1).forEach((h, k) => {
      const m = h.lastMove;
      const info = botInfos[k + 1];
      const li = document.createElement('li');
      li.className = m.side;
      const who = m.wasHidden ? `[úp ${J.NAMES_VI[m.role]}]→${J.NAMES_VI[m.revealed]}` : J.NAMES_VI[m.type];
      const cap = m.captured ? ` ăn ${J.NAMES_VI[m.captured.type]}${m.captured.wasHidden ? ' (úp)' : ''}` : '';
      li.textContent = `${SIDE_VI[m.side]}: ${who} ${J.squareName(m.from)}→${J.squareName(m.to)}${cap}`;
      if (info) {
        const span = document.createElement('span');
        span.className = 'info';
        span.textContent = [info.depth != null && `d${info.depth}`, info.score != null && `${info.score > 0 ? '+' : ''}${info.score}`,
          info.timeMs != null && `${info.timeMs}ms`].filter(Boolean).join(' · ');
        li.appendChild(span);
      }
      log.appendChild(li);
    });
    log.scrollTop = log.scrollHeight;
    $('seed').textContent = history[0].seed;
    const noHuman = !actingSide();
    $('undo').disabled = (history.length <= 1 && !endResult) || botThinking || noHuman;
    $('offerDraw').disabled = !!result || !!pendingConfirm || botThinking || noHuman;
    $('resign').disabled = !!result || !!pendingConfirm || noHuman;
    const anyHidden = current().board.some((p) => p && p.hidden);
    $('revealAll').hidden = !result || !anyHidden || !!revealedState;
    $('confirmBar').hidden = !pendingConfirm;
    if (pendingConfirm) {
      $('confirmText').textContent = pendingConfirm.text;
      $('confirmYes').textContent = pendingConfirm.yes;
      $('confirmNo').textContent = pendingConfirm.no;
    }
    $('toast').hidden = !toastText;
    $('toast').textContent = toastText;
  }

  // ---------- End of game: resign / offer draw / reveal pieces ----------
  let toastText = '';
  let toastTimer = null;
  function toast(text) {
    toastText = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastText = ''; render(); }, 4000);
    render();
  }

  function endGame(result) {
    if (gameResult()) return;
    endResult = result;
    pendingConfirm = null;
    selected = -1;
    clock.stop();
    render();
  }

  // Acting side: 2 humans -> side to move; 1 human -> that human; bot vs bot -> null.
  function actingSide() {
    const humans = ['r', 'b'].filter((side) => !isBot(side));
    if (humans.length === 2) return current().turn;
    return humans[0] || null;
  }

  function askConfirm(text, yes, no, onYes) {
    pendingConfirm = { text, yes, no, onYes };
    selected = -1;
    render();
  }

  function resign() {
    if (gameResult()) return;
    const side = actingSide();
    askConfirm(`${SIDE_VI[side]} chắc chắn chịu thua?`, 'Chịu thua', 'Huỷ',
      () => endGame({ winner: J.opp(side), reason: 'resign' }));
  }

  async function offerDraw() {
    if (gameResult()) return;
    const side = actingSide();
    if (!side) return;
    const other = J.opp(side);
    if (!isBot(other)) {
      askConfirm(`${SIDE_VI[side]} cầu hoà. ${SIDE_VI[other]} có đồng ý không?`, 'Đồng ý hoà', 'Từ chối',
        () => endGame({ winner: null, reason: 'agreement' }));
      return;
    }
    const bot = player(other);
    let accept = false;
    try {
      accept = await bot.acceptDraw(J.cloneState(current()), J, botContext(other));
    } catch (err) { console.error('Bot error:', err); }
    if (accept) endGame({ winner: null, reason: 'agreement' });
    else { toast(`${bot.name} từ chối hoà.`); render(); }
  }

  function revealAll() {
    if (!gameResult()) return;
    revealedState = J.revealAll(current());
    render();
  }

  // ---------- Players / bots ----------
  const playerSpec = (side) => $(side === 'r' ? 'playerR' : 'playerB').value;
  const isBot = (side) => playerSpec(side) !== 'human';
  const playerCache = new Map();
  function player(side) {
    const spec = playerSpec(side);
    if (!playerCache.has(spec)) playerCache.set(spec, Bots.resolve(spec));
    return playerCache.get(spec);
  }
  const playerName = (side) => (isBot(side) ? player(side).name : 'Người');

  function botContext(side) {
    const clk = clock.enabled
      ? { myTimeMs: clock.remaining[side], oppTimeMs: clock.remaining[J.opp(side)], incrementMs: clock.incrementMs }
      : null;
    const budget = Bots.suggestBudget(clk, 1000);
    const t = performance.now();
    return {
      side, ply: current().ply, random: Math.random, now: () => performance.now(),
      timeBudgetMs: budget, deadline: t + budget, clock: clk,
      history: history.slice(1).map((h) => ({ from: h.lastMove.from, to: h.lastMove.to })),
    };
  }

  // ---------- Interaction ----------
  const humanCanMove = () => !botThinking && !clock.paused && !pendingConfirm && !isBot(current().turn);

  function onSquare(i) {
    const s = current();
    if (gameResult() || !humanCanMove()) return;
    const p = s.board[i];
    if (selected >= 0) {
      const m = J.getLegalMovesFrom(s, selected).find((mv) => mv.to === i);
      if (m) return doMove(m);
    }
    selected = p && p.side === s.turn && i !== selected ? i : -1;
    render();
  }

  /** The position just repeated: if a side is violating the rules, warn before it gets penalised. */
  function warnRepetition(state) {
    if (state.result) { toastText = ''; return; }
    if (!J.repetitionStatus) return;
    const st = J.repetitionStatus(state);
    if (!st) return;
    const left = state.rules.repetitionCount - st.count;
    const loser = st.result.winner && J.opp(st.result.winner);
    if (loser) {
      toast(left > 0
        ? `Cảnh báo: ${SIDE_VI[loser]} đang ${VIOLATION_VI[st.violators[loser]]}. Đến lần lặp thứ ${state.rules.repetitionCount}, ${SIDE_VI[loser]} sẽ bị buộc đổi nước.`
        : `${SIDE_VI[loser]} đang ${VIOLATION_VI[st.violators[loser]]}: không được lặp tiếp, phải đổi nước.`);
    } else {
      toast(`Thế cờ lặp lại (lần ${st.count}). Lặp thêm ${left} lần nữa sẽ xử hoà.`);
    }
  }

  function doMove(m, info = null) {
    if (gameResult()) return;
    const mover = current().turn;
    const next = J.makeMove(current(), m);
    clock.press(mover);            // add increment for the side that moved, start the other side's clock
    history.push(next);
    botInfos[history.length - 1] = info;
    clockSnaps.push(clock.snapshot());
    if (next.result) clock.stop();
    selected = -1;
    warnRepetition(next);
    render();
    maybeBotMove();
  }

  async function maybeBotMove() {
    const s = current();
    const side = s.turn;
    if (!isBot(side) || gameResult() || botThinking || pendingConfirm) return;
    while (clock.paused) await sleep(200);
    if (current() !== s || !isBot(side)) return;
    botThinking = true;
    render();
    const bot = player(side);
    const t0 = performance.now();
    try {
      const { move, info } = await bot.chooseMove(J.cloneState(s), J, botContext(side));
      const elapsed = performance.now() - t0;
      await sleep(Math.max(0, MIN_BOT_DELAY_MS - elapsed));
      while (clock.paused) await sleep(200);
      botThinking = false;
      if (current() !== s || gameResult() || !isBot(side)) { render(); return; }
      if (!move || !J.getLegalMovesFrom(s, move.from).some((x) => x.to === move.to)) {
        endGame({ winner: J.opp(side), reason: 'illegal-move' });
        toast(`${bot.name} đi nước không hợp lệ: ${JSON.stringify(move)}`);
        return;
      }
      doMove(move, { ...info, timeMs: Math.round(elapsed) });
    } catch (err) {
      botThinking = false;
      console.error('Bot error:', err);
      endGame({ winner: J.opp(side), reason: 'bot-error' });
      toast(`${bot.name} bị lỗi: ${err.message}`);
    }
  }

  function newGame() {
    createClock();
    history = [J.createGame()];
    botInfos = [null];
    clockSnaps = [clock.snapshot()];
    endResult = null;
    revealedState = null;
    pendingConfirm = null;
    selected = -1;
    botThinking = false;
    render();
    maybeBotMove();
  }

  function undo() {
    if (botThinking) return;
    // Just resigned / drew / timed out: "Undo" only cancels that result, it does not take back a move
    if (endResult) {
      endResult = null;
      revealedState = null;
      clock.restore(clockSnaps[clockSnaps.length - 1], history.length > 1 ? current().turn : null);
      render();
      maybeBotMove();
      return;
    }
    if (!actingSide()) return;
    if (history.length <= 1 || !actingSide()) return;
    history.pop(); clockSnaps.pop();
    // keep taking back bot moves until it is a human's turn
    while (isBot(current().turn) && history.length > 1) { history.pop(); clockSnaps.pop(); }
    botInfos.length = history.length;
    endResult = null;
    revealedState = null;
    pendingConfirm = null;
    // the clock only starts after the first move
    clock.restore(clockSnaps[clockSnaps.length - 1], history.length > 1 ? current().turn : null);
    selected = -1;
    render();
  }

  function togglePause() {
    if (clock.paused) clock.resume(); else clock.pause();
    selected = -1;
    render();
  }

  function onTimeControlChange() {
    $('customTime').hidden = $('timeControl').value !== 'custom';
    if (history.length <= 1 && !gameResult()) {
      // no move played yet: apply immediately
      createClock();
      clockSnaps = [clock.snapshot()];
      render();
    } else {
      $('tcNote').hidden = false;
    }
  }

  // ---------- Init ----------
  for (const id of ['playerR', 'playerB']) {
    for (const bot of Bots.list().filter((b) => !b.hidden)) {
      const o = document.createElement('option');
      o.value = bot.id;
      o.textContent = bot.name;
      o.title = bot.description || '';
      $(id).appendChild(o);
    }
  }
  function onPlayersChange() {
    const descs = ['r', 'b'].filter(isBot).map((side) => `${SIDE_VI[side]}: ${player(side).def.description}`);
    $('botDesc').hidden = !descs.length;
    $('botDesc').textContent = descs.join(' — ');
    selected = -1;
    render();
    maybeBotMove();
  }
  $('newGame').addEventListener('click', newGame);
  $('undo').addEventListener('click', undo);
  $('pause').addEventListener('click', togglePause);
  $('resign').addEventListener('click', resign);
  $('offerDraw').addEventListener('click', offerDraw);
  $('revealAll').addEventListener('click', revealAll);
  $('confirmYes').addEventListener('click', () => { const c = pendingConfirm; pendingConfirm = null; if (c) c.onYes(); render(); });
  $('confirmNo').addEventListener('click', () => { pendingConfirm = null; render(); maybeBotMove(); });
  $('hint').addEventListener('change', render);
  $('showEval').addEventListener('change', render);
  $('timeControl').addEventListener('change', onTimeControlChange);
  $('customMin').addEventListener('change', onTimeControlChange);
  $('customInc').addEventListener('change', onTimeControlChange);
  $('playerR').addEventListener('change', onPlayersChange);
  $('playerB').addEventListener('change', onPlayersChange);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') undo();
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); togglePause(); }
  });

  // Small API for tests / future features (open a position, review a game): load any state as the current position
  window.CotuongUI = {
    load(state) {
      newGame();
      history = [state];
      botInfos = [null];
      render();
      maybeBotMove();
    },
    current: () => current(),
    play(move) { doMove(move); },
  };

  drawGrid();
  newGame();
})();
