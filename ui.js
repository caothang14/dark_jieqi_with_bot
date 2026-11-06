/* UI for Cờ Tướng Úp – depends on Jieqi (engine.js), ChessClock (clock.js), JieqiBots (bots/*.js). */
(function () {
  'use strict';
  const J = window.Jieqi;
  const ChessClock = window.ChessClock;
  const BOTS = window.JieqiBots || {};
  const BOT_SIDE = 'b'; // human plays red vs bot
  const SIDE_VI = { r: 'Đỏ', b: 'Đen' };
  const REASON_VI = {
    checkmate: 'chiếu bí', stalemate: 'hết nước đi', timeout: 'hết giờ',
    'quiet-limit': 'quá 120 nước không ăn/lật quân',
  };
  const LOW_TIME_MS = 10000;

  const $ = (id) => document.getElementById(id);
  const layer = $('layer');

  let history = [];       // stack of states; current = last
  let clockSnaps = [];    // clockSnaps[i] = thời gian còn lại của 2 bên khi bắt đầu history[i]
  let clock = null;
  let timeoutResult = null;
  let selected = -1;
  let botThinking = false;
  const current = () => history[history.length - 1];
  const gameResult = () => current().result || timeoutResult;
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
      onTimeout: (side) => {
        timeoutResult = { winner: J.opp(side), reason: 'timeout' };
        selected = -1;
        render();
      },
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
    const s = current();
    const result = gameResult();
    layer.innerHTML = '';
    const showHint = $('hint').checked;
    const checkSq = !result && J.isInCheck(s) ? J.kingSquare(s.board, s.turn) : -1;

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
      if (s.lastMove && s.lastMove.to === i && s.lastMove.revealed) el.classList.add('reveal');
      el.textContent = p.hidden ? (showHint ? J.NAMES_VI[p.role] : '') : J.CHARS[p.side][p.type];
      el.title = p.hidden ? `Quân úp (đi như ${J.NAMES_VI[p.role]})` : J.NAMES_VI[p.type];
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
    }
    renderPanel(s, result, checkSq >= 0);
    renderClocks();
  }

  function renderPanel(s, result, inCheck) {
    const st = $('status');
    if (result) {
      st.className = 'status over';
      st.textContent = result.winner
        ? `${SIDE_VI[result.winner]} thắng (${REASON_VI[result.reason]})`
        : `Hoà (${REASON_VI[result.reason]})`;
    } else {
      st.className = `status ${s.turn}`;
      st.textContent = `Lượt ${SIDE_VI[s.turn]}${inCheck ? ' – đang bị chiếu!' : ''}`
        + `${botThinking ? ' (bot đang nghĩ…)' : ''}${clock.paused ? ' – đang tạm dừng' : ''}`;
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
    history.slice(1).forEach((h) => {
      const m = h.lastMove;
      const li = document.createElement('li');
      li.className = m.side;
      const who = m.wasHidden ? `[úp ${J.NAMES_VI[m.role]}]→${J.NAMES_VI[m.revealed]}` : J.NAMES_VI[m.type];
      const cap = m.captured ? ` ăn ${J.NAMES_VI[m.captured.type]}${m.captured.wasHidden ? ' (úp)' : ''}` : '';
      li.textContent = `${SIDE_VI[m.side]}: ${who} ${J.squareName(m.from)}→${J.squareName(m.to)}${cap}`;
      log.appendChild(li);
    });
    log.scrollTop = log.scrollHeight;
    $('seed').textContent = history[0].seed;
    $('undo').disabled = history.length <= 1 || botThinking;
  }

  // ---------- Interaction ----------
  const botKey = () => ($('mode').value === 'pvp' ? null : $('mode').value);
  const humanCanMove = () => !botThinking && !clock.paused && !(botKey() && current().turn === BOT_SIDE);

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

  function doMove(m) {
    if (gameResult()) return;
    const mover = current().turn;
    const next = J.makeMove(current(), m);
    clock.press(mover);            // cộng giờ cho bên vừa đi, chạy giờ bên kia
    history.push(next);
    clockSnaps.push(clock.snapshot());
    if (next.result) clock.stop();
    selected = -1;
    render();
    maybeBotMove();
  }

  async function maybeBotMove() {
    const key = botKey();
    const s = current();
    if (!key || gameResult() || s.turn !== BOT_SIDE || botThinking) return;
    botThinking = true;
    render();
    await sleep(350);
    try {
      const move = await BOTS[key].chooseMove(J.cloneState(s), J);
      while (clock.paused) await sleep(200);
      botThinking = false;
      if (current() === s && move && !gameResult()) doMove(move); else render();
    } catch (err) {
      botThinking = false;
      console.error('Bot error:', err);
      render();
    }
  }

  function newGame() {
    createClock();
    history = [J.createGame()];
    clockSnaps = [clock.snapshot()];
    timeoutResult = null;
    selected = -1;
    botThinking = false;
    render();
  }

  function undo() {
    if (history.length <= 1 || botThinking) return;
    history.pop(); clockSnaps.pop();
    // vs bot: also take back the bot's move so it's the human's turn again
    if (botKey() && current().turn === BOT_SIDE && history.length > 1) { history.pop(); clockSnaps.pop(); }
    timeoutResult = null;
    // đồng hồ chỉ chạy sau nước đầu tiên
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
      // chưa đi nước nào: áp dụng ngay
      createClock();
      clockSnaps = [clock.snapshot()];
      render();
    } else {
      $('tcNote').hidden = false;
    }
  }

  // ---------- Init ----------
  for (const [key, bot] of Object.entries(BOTS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `Người (Đỏ) vs ${bot.name}`;
    $('mode').appendChild(o);
  }
  $('newGame').addEventListener('click', newGame);
  $('undo').addEventListener('click', undo);
  $('pause').addEventListener('click', togglePause);
  $('hint').addEventListener('change', render);
  $('timeControl').addEventListener('change', onTimeControlChange);
  $('customMin').addEventListener('change', onTimeControlChange);
  $('customInc').addEventListener('change', onTimeControlChange);
  $('mode').addEventListener('change', () => { selected = -1; render(); maybeBotMove(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') undo();
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); togglePause(); }
  });

  drawGrid();
  newGame();
})();
