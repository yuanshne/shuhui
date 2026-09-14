#!/usr/bin/env node
/**
 * 生成每日题池。
 *
 * 为什么不把出题逻辑用 Python 重写一遍：出题算法与游戏引擎是同一份逻辑，
 * 抄成两份迟早会漂移（改了一边忘了另一边，服务端的"标准答案"就和游戏算的不一致）。
 * 这里直接 require 游戏的引擎，服务端拿到的题必然是游戏认得的题。
 *
 * 用法：
 *   node tools/gen_pool.mjs                       # 从今天起 30 天
 *   node tools/gen_pool.mjs --days 90 --start 2026-10-01
 *   node tools/gen_pool.mjs --out ../data/pool.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const NG = require('./engines/shuzhi-engine.js'); // 数织
const SH = require('./engines/shuhui-engine.js'); // 数回

const TZ_OFFSET_HOURS = 8; // 与后端 app/clock.py 的切日口径保持一致

// ------------------------------------------------------------------ 参数

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days || 30);
const START = args.start || todayInTz(TZ_OFFSET_HOURS);
const OUT = args.out
  ? path.resolve(process.cwd(), args.out)
  : path.join(ROOT, 'data', 'pool.json');

if (!Number.isFinite(DAYS) || DAYS < 1 || DAYS > 730) {
  console.error('--days 需在 1~730 之间');
  process.exit(2);
}

// ------------------------------------------------------------------ 日期

function todayInTz(offsetHours) {
  return new Date(Date.now() + offsetHours * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ 出题器

const SHUZHI_W = 10;
const SHUZHI_H = 10;

/**
 * 收题门槛：唯一解 + 传播器能独立推完。
 *
 * 只验唯一解是不够的。"唯一解"说的是答案只有一个，不代表不用猜就能走到 ——
 * 实测 10×10 马赛克里有约 3% 的题传播器推不出来，玩家（和游戏内的提示/演示）
 * 就只能靠试错。这类题在这里直接淘汰，宁可多抽几轮。
 */
function isPropagationSolvable(game, built) {
  if (game === 'shuzhi-classic') {
    const r = NG.solveClassic(built.payload.rowClues, built.payload.colClues);
    return r.solved;
  }
  if (game === 'shuzhi-mosaik') {
    const r = NG.mosaikSolve(built.payload.clues);
    return r.solved;
  }
  return true; // 数回 / 数独另有一套判据，在 verify_pool.mjs 里查
}

/** 数织·经典：行列线索，唯一解。 */
function makeShuzhiClassic(date) {
  const rng = NG.mulberry32(NG.hashSeed(`shuzhi:classic:${date}`));
  for (let round = 0; round < 12; round++) {
    const g = NG.generateClassic(SHUZHI_W, SHUZHI_H, rng, 120);
    if (!g || !g.unique || !g.solution) continue;
    const built = {
      difficulty: 'normal',
      payload: {
        mode: 'classic',
        w: SHUZHI_W,
        h: SHUZHI_H,
        rowClues: g.rowClues,
        colClues: g.colClues,
      },
      solution: { rows: g.solution },
    };
    if (isPropagationSolvable('shuzhi-classic', built)) return built;
  }
  return null;
}

/** 数织·马赛克：3×3 邻域计数线索，唯一解。 */
function makeShuzhiMosaik(date) {
  const rng = NG.mulberry32(NG.hashSeed(`shuzhi:mosaik:${date}`));
  for (let round = 0; round < 12; round++) {
    const g = NG.mosaikGenerate(SHUZHI_W, SHUZHI_H, rng, 120);
    if (!g || !g.unique || !g.solution) continue;
    const built = {
      difficulty: 'normal',
      payload: { mode: 'mosaik', w: SHUZHI_W, h: SHUZHI_H, clues: g.clues },
      solution: { rows: g.solution },
    };
    if (isPropagationSolvable('shuzhi-mosaik', built)) return built;
  }
  return null;
}

/** 数回：唯一闭合回路，答案转成 ON 边编号集合。 */
function makeShuhui(date) {
  const diff = 'normal';
  const rng = SH.mulberry32(SH.hashSeed(`shuhui:standard:${date}`));
  for (let round = 0; round < 4; round++) {
    const p = SH.makePuzzle(diff, rng);
    if (!p) continue;

    const n = p.size;
    const clue2d = [];
    for (let r = 0; r < n; r++) {
      clue2d.push(Array.from(p.clue.slice(r * n, r * n + n)));
    }
    const on = [];
    for (let e = 0; e < p.solution.length; e++) {
      if (p.solution[e] === SH.ON) on.push(e);
    }
    return {
      difficulty: diff,
      payload: { n, clue: clue2d, clueCount: p.clueCount },
      solution: { on },
    };
  }
  return null;
}

/**
 * 立方数独：没有唯一解，所以「题面」就是一组开局参数 —— 阶数 + 难度 + 种子。
 * 客户端用同一个种子会展开出同一个开局，这就是「全球同题」的全部机制；
 * 服务端不参与出题，只在判分时验「六个面是否各含 1~N² 恰好一次」。
 *
 * scramble 是元信息（打乱步数），不参与判分。但它必须跟客户端真正转出来的步数一致，
 * 否则题池上写的难度和玩家实际遇到的对不上。下面这段是 shudu3d/index.html 里
 * diffParams() + genScramble() 的等价复现 —— 只算「步数」，不生成移动序列，
 * 因为序列由客户端按种子自己展开，服务端存一份只会引入第二个真相。
 */
const SHUDU_ORDER = 3;
const SHUDU_DIFF = 'mid';
const SHUDU_MOVES = [4, 6]; // 与游戏内 DIFFS.mid.mv 一致

function makeShudu3d(date) {
  const rng = NG.mulberry32(NG.hashSeed(`shudu3d:cube:${date}`));
  const seed = Math.floor(rng() * 0xffffffff) >>> 0;

  const r = NG.mulberry32(seed);
  const span = SHUDU_MOVES[1] - SHUDU_MOVES[0] + 1;
  const scramble = Math.max(2, SHUDU_MOVES[0] + Math.floor(r() * span));

  return {
    difficulty: 'normal',
    payload: { order: SHUDU_ORDER, diff: SHUDU_DIFF, seed, scramble },
    solution: {},
  };
}

// ------------------------------------------------------------------ 主流程

const SPECS = [
  { game: 'shuhui', variant: 'standard', make: makeShuhui },
];

const entries = [];
const skipped = [];

console.log(`生成题池：${START} 起 ${DAYS} 天，共 ${SPECS.length} 个组合\n`);

const t0 = Date.now();
for (let d = 0; d < DAYS; d++) {
  const date = addDays(START, d);
  const row = [];

  for (const spec of SPECS) {
    const started = Date.now();
    let built = null;
    try {
      built = spec.make(date);
    } catch (err) {
      skipped.push({ date, ...spec, error: String(err && err.message) });
      continue;
    }
    if (!built) {
      skipped.push({ date, game: spec.game, variant: spec.variant, error: '出题失败' });
      continue;
    }
    entries.push({
      game: spec.game,
      variant: spec.variant,
      date,
      difficulty: built.difficulty,
      payload: built.payload,
      solution: built.solution,
    });
    row.push(`${spec.game}/${spec.variant} ${Date.now() - started}ms`);
  }

  if (d === 0 || d === DAYS - 1 || (d + 1) % 10 === 0) {
    console.log(`  ${date}  ${row.join('  ')}`);
  }
}

const payload = {
  generated_at: new Date().toISOString(),
  tz_offset_hours: TZ_OFFSET_HOURS,
  days: DAYS,
  start: START,
  count: entries.length,
  entries,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');

const seconds = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n写入 ${OUT}`);
console.log(`共 ${entries.length} 条题，耗时 ${seconds}s`);
if (skipped.length) {
  console.warn(`有 ${skipped.length} 条没生成出来（首次出现的时间与原因）：`);
  for (const s of skipped.slice(0, 8)) {
    console.warn(`  ${s.date} ${s.game}/${s.variant}: ${s.error}`);
  }
  process.exitCode = 1;
}
