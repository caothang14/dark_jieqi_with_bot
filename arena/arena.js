#!/usr/bin/env node
/*
 * Đấu trường bot vs bot.
 *
 *   node arena/arena.js --a greedy --b random --games 200
 *   node arena/arena.js --a greedy:revealBonus=0 --b greedy --games 400 --workers 8 --out results/g.json
 *   node arena/arena.js --a mybot --b greedy --tc 60+1        # đồng hồ thật 60s + 1s/nước
 *   node arena/arena.js --list                                 # liệt kê bot
 *
 * Mỗi seed được chơi 2 ván, A cầm Đỏ một ván và cầm Đen một ván, để công bằng về lượt đi trước.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const J = require(path.join(ROOT, 'engine'));
const bots = require(path.join(ROOT, 'bots'));
const { playGame } = require('./match');

// ───────────────────────────── Worker ─────────────────────────────
if (!isMainThread) {
  parentPort.on('message', async (job) => {
    if (job === 'exit') process.exit(0);
    try {
      const rec = await playGame({ J, bots, ...workerData.options, ...job });
      parentPort.postMessage({ ok: true, job, rec });
    } catch (err) {
      parentPort.postMessage({ ok: false, job, error: String(err && err.stack || err) });
    }
  });
  parentPort.postMessage({ ready: true });
  return;
}

// ───────────────────────────── Main ─────────────────────────────
function parseArgs(argv) {
  const args = { games: 100, seed: 1, maxPlies: 300, movetime: 1000, workers: Math.max(1, os.cpus().length - 1) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--a': args.a = next(); break;
      case '--b': args.b = next(); break;
      case '--games': case '-n': args.games = +next(); break;
      case '--seed': args.seed = +next(); break;
      case '--max-plies': args.maxPlies = +next(); break;
      case '--movetime': args.movetime = +next(); break;
      case '--tc': {
        const [base, inc = '0'] = next().split('+');
        args.tc = { initialMs: +base * 1000, incrementMs: +inc * 1000 };
        break;
      }
      case '--workers': case '-j': args.workers = +next(); break;
      case '--out': args.out = next(); break;
      case '--verbose': case '-v': args.verbose = true; break;
      case '--list': args.list = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`Tham số lạ: ${a}`);
    }
  }
  return args;
}

const HELP = `
Đấu trường bot cờ tướng úp

  --a <bot>          bot A (spec: id hoặc id:k=v,k=v)       [bắt buộc]
  --b <bot>          bot B                                   [bắt buộc]
  --games, -n <N>    số ván (nên chẵn; mỗi seed chơi 2 ván đổi màu)  [100]
  --seed <S>         seed bắt đầu                            [1]
  --max-plies <N>    quá số nửa nước này thì xử hoà          [300]
  --movetime <ms>    thời gian gợi ý mỗi nước (khi không --tc) [1000]
  --tc <s+inc>       đồng hồ thật, vd 60+1 (giây); hết giờ là thua
  --workers, -j <N>  số luồng chạy song song                 [số CPU - 1]
  --out <file>       lưu toàn bộ ván (JSON) để replay/phân tích
  --verbose, -v      in từng ván
  --list             liệt kê bot đã đăng ký
`;

// ── Thống kê ──
function erf(x) { // Abramowitz-Stegun
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const eloFromScore = (s) => (s <= 0 ? -Infinity : s >= 1 ? Infinity : -400 * Math.log10(1 / s - 1));
const fmtElo = (e) => (Number.isFinite(e) ? (e >= 0 ? '+' : '') + e.toFixed(0) : e > 0 ? '+∞' : '-∞');

function summarize(records) {
  const scores = [];
  const s = { w: 0, d: 0, l: 0, asRed: { w: 0, d: 0, l: 0 }, asBlack: { w: 0, d: 0, l: 0 }, reasons: {}, plies: 0 };
  const timing = { A: { moves: 0, timeMs: 0, maxMs: 0, depthSum: 0, depthCount: 0 }, B: { moves: 0, timeMs: 0, maxMs: 0, depthSum: 0, depthCount: 0 } };
  for (const r of records) {
    const aSide = r.aIsRed ? 'r' : 'b';
    const res = r.result;
    const bucket = aSide === 'r' ? s.asRed : s.asBlack;
    let sc;
    if (!res.winner) { s.d++; bucket.d++; sc = 0.5; }
    else if (res.winner === aSide) { s.w++; bucket.w++; sc = 1; }
    else { s.l++; bucket.l++; sc = 0; }
    scores.push(sc);
    const key = res.reason + (res.winner ? (res.winner === aSide ? ' (A thắng)' : ' (B thắng)') : '');
    s.reasons[key] = (s.reasons[key] || 0) + 1;
    s.plies += r.plies;
    for (const [side, who] of [[aSide, 'A'], [aSide === 'r' ? 'b' : 'r', 'B']]) {
      const st = r.stats[side], t = timing[who];
      t.moves += st.moves; t.timeMs += st.timeMs; t.maxMs = Math.max(t.maxMs, st.maxMs);
      t.depthSum += st.depthSum; t.depthCount += st.depthCount;
    }
  }
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(scores.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const lo = Math.max(0, mean - 1.96 * se), hi = Math.min(1, mean + 1.96 * se);
  const los = s.w + s.l > 0 ? 0.5 * (1 + erf((s.w - s.l) / Math.sqrt(2 * (s.w + s.l)))) : 0.5;
  return { n, ...s, score: mean, elo: eloFromScore(mean), eloLo: eloFromScore(lo), eloHi: eloFromScore(hi), los, avgPlies: s.plies / n, timing };
}

function printSummary(sum, args) {
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const wdl = (o) => `+${o.w} =${o.d} -${o.l}`;
  const t = (x) => (x.moves ? `${(x.timeMs / x.moves).toFixed(1)}ms/nước (max ${x.maxMs.toFixed(0)}ms)` : '-')
    + (x.depthCount ? `, độ sâu TB ${(x.depthSum / x.depthCount).toFixed(1)}` : '');
  console.log('\n══════════════════════════════════════════════');
  console.log(`  A = ${args.a}`);
  console.log(`  B = ${args.b}`);
  console.log('──────────────────────────────────────────────');
  console.log(`  Số ván        : ${sum.n}  (seed ${args.seed}…, ${args.tc ? `đồng hồ ${args.tc.initialMs / 1000}+${args.tc.incrementMs / 1000}s` : `${args.movetime}ms/nước`})`);
  console.log(`  A thắng/hoà/thua: ${wdl(sum)}   điểm ${pct(sum.score)}`);
  console.log(`    A cầm Đỏ    : ${wdl(sum.asRed)}`);
  console.log(`    A cầm Đen   : ${wdl(sum.asBlack)}`);
  console.log(`  Elo (A - B)   : ${fmtElo(sum.elo)}   [95%: ${fmtElo(sum.eloLo)} … ${fmtElo(sum.eloHi)}]`);
  console.log(`  LOS           : ${pct(sum.los)}  (xác suất A mạnh hơn B)`);
  console.log(`  Ván dài TB    : ${sum.avgPlies.toFixed(0)} nửa nước`);
  console.log(`  Thời gian A   : ${t(sum.timing.A)}`);
  console.log(`  Thời gian B   : ${t(sum.timing.B)}`);
  console.log('  Kết thúc do   :');
  for (const [k, v] of Object.entries(sum.reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}`);
  console.log('══════════════════════════════════════════════');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (args.list) {
    for (const b of bots.list()) {
      console.log(`${b.id.padEnd(16)} ${b.name}${b.baseId ? `  [biến thể của ${b.baseId}]` : ''}`);
      if (b.description) console.log(`${''.padEnd(16)} ${b.description}`);
      if (Object.keys(b.params).length) console.log(`${''.padEnd(16)} params: ${JSON.stringify(b.params)}`);
    }
    return;
  }
  if (!args.a || !args.b) { console.log(HELP); process.exit(1); }
  bots.resolve(args.a); bots.resolve(args.b); // báo lỗi sớm nếu sai tên

  const jobs = [];
  for (let i = 0; i < args.games; i++) {
    const aIsRed = i % 2 === 0;
    jobs.push({ index: i, seed: args.seed + Math.floor(i / 2), red: aIsRed ? args.a : args.b, black: aIsRed ? args.b : args.a, aIsRed });
  }
  const options = { maxPlies: args.maxPlies, moveTimeMs: args.movetime, tc: args.tc || null };
  const nWorkers = Math.max(1, Math.min(args.workers, jobs.length));
  const records = [];
  const live = { w: 0, d: 0, l: 0 };
  const started = Date.now();

  const progress = () => {
    const done = records.length;
    const sec = (Date.now() - started) / 1000;
    const line = `[${done}/${jobs.length}]  A: +${live.w} =${live.d} -${live.l}   ${sec.toFixed(0)}s`;
    if (process.stdout.isTTY) process.stdout.write(`\r  ${line}   `);
    else if (done === jobs.length || done % Math.max(1, Math.round(jobs.length / 10)) === 0) console.log(`  ${line}`);
  };

  await new Promise((resolve, reject) => {
    let next = 0, finished = 0;
    for (let w = 0; w < nWorkers; w++) {
      const worker = new Worker(__filename, { workerData: { options } });
      const feed = () => {
        if (next < jobs.length) worker.postMessage(jobs[next++]);
        else worker.postMessage('exit');
      };
      worker.on('message', (msg) => {
        if (msg.ready) return feed();
        if (!msg.ok) { reject(new Error(msg.error)); return; }
        const rec = { ...msg.rec, aIsRed: msg.job.aIsRed, index: msg.job.index };
        records.push(rec);
        const aSide = rec.aIsRed ? 'r' : 'b';
        if (!rec.result.winner) live.d++; else if (rec.result.winner === aSide) live.w++; else live.l++;
        if (args.verbose) {
          const res = rec.result.winner ? `${rec.result.winner === 'r' ? 'Đỏ' : 'Đen'} thắng` : 'Hoà';
          console.log(`\n  #${rec.index} seed ${rec.seed}  Đỏ=${rec.red}  Đen=${rec.black}  → ${res} (${rec.result.reason}${rec.result.detail ? ': ' + rec.result.detail : ''}), ${rec.plies} nửa nước`);
        }
        progress();
        if (++finished === jobs.length) resolve();
        feed();
      });
      worker.on('error', reject);
    }
  });

  records.sort((x, y) => x.index - y.index);
  const sum = summarize(records); // dùng aIsRed (A và B có thể trùng spec)
  printSummary(sum, args);
  console.log(`  Xong trong ${((Date.now() - started) / 1000).toFixed(1)}s với ${nWorkers} luồng.`);

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify({ args, summary: sum, games: records }, null, 1));
    console.log(`  Đã lưu ${records.length} ván vào ${args.out}`);
  }
}

main().catch((err) => { console.error('\n' + (err.stack || err)); process.exit(1); });
