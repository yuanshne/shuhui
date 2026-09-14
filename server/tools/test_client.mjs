#!/usr/bin/env node
/**
 * 客户端库的端到端测试 —— 对着一个**真在跑**的后端。
 *
 * 为什么要有这个：单元测试能证明服务端逻辑对，证明不了"游戏里内联的那份
 * puzzle-client.js 能不能真的把一局走完"。这里用的就是游戏会内联的同一个文件。
 *
 * 用法：
 *   node tools/test_client.mjs                     # 默认 http://127.0.0.1:8000
 *   BASE=http://127.0.0.1:8077 node tools/test_client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PuzzleClient = require(path.join(ROOT, 'web', 'puzzle-client.js'));
const BASE = process.env.BASE || 'http://127.0.0.1:8000';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const GAME = 'shuhui';
const VARIANT = 'standard';

const currentOrder = { v: null };

const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pool.json'), 'utf8'));

// 立方数独没有"标准答案"：服务端只验胜利条件（每面恰好 1~N² 各一次），
// 正确答案直接构造一个合法面分布，不依赖题池里的 solution。
function correctAnswer(date) {
  if (GAME === 'shuzhi' || GAME === 'shuhui') {
    const entry = pool.entries.find((e) => e.date === date);
    if (!entry) throw new Error(`题池里没有 ${date} ${GAME}`);
    return GAME === 'shuzhi' ? { rows: entry.solution.rows } : { on: entry.solution.on };
  }
  const order = currentOrder.v;
  return { faces: Array.from({ length: 6 }, () =>
    Array.from({ length: order ** 2 }, (_, i) => i + 1)) };
}

function wrongAnswer(daily) {
  if (GAME === 'shuzhi') {
    return { rows: new Array(daily.puzzle.h).fill('.'.repeat(daily.puzzle.w)) };
  }
  if (GAME === 'shuhui') {
    return { on: [] };
  }
  const order = daily.puzzle.order;
  return { faces: Array.from({ length: 6 }, () => Array(order ** 2).fill(1)) };
}

async function main() {
  console.log(`客户端库 v${PuzzleClient.VERSION}  →  ${BASE}\n`);

  const client = new PuzzleClient({ baseUrl: BASE, game: GAME, variant: VARIANT });

  // ---------------------------------------------------------- 连通性
  console.log('连通性');
  check('ping() 探到后端在线', await client.ping());
  check('未登录时 isLoggedIn() 为 false', client.isLoggedIn() === false);

  // ---------------------------------------------------------- 离线路径
  const offline = new PuzzleClient({ baseUrl: 'http://127.0.0.1:1', game: GAME, timeout: 2000 });
  let offlineErr = null;
  await offline.fetchDaily({ date: pool.start }).catch((e) => { offlineErr = e; });
  check('后端不可达时 fetchDaily 抛错（调用方据此降级）', !!offlineErr,
    offlineErr ? String(offlineErr.message) : '竟然没抛');
  check('离线错误的 status 标为 0', offlineErr && offlineErr.status === 0);
  check('离线时 ping() 返回 false 而不是抛错', (await offline.ping()) === false);

  // ---------------------------------------------------------- 账号
  console.log('\n账号');
  const name = 'e2e_' + Math.random().toString(36).slice(2, 8);
  const user = await client.register(name, 'pw123456');
  check('注册后拿到用户', user && user.username === name);
  check('注册后 isLoggedIn() 为 true', client.isLoggedIn());

  let dupErr = null;
  await client.register(name, 'pw123456').catch((e) => { dupErr = e; });
  check('重名注册返回 409', dupErr && dupErr.status === 409, dupErr && dupErr.message);

  const me = await client.refreshMe();
  check('refreshMe 拿到同一个用户', me && me.username === name);

  client.logout();
  check('登出后 isLoggedIn() 为 false', client.isLoggedIn() === false);
  const back = await client.login(name, 'pw123456');
  check('能重新登录', back && back.username === name);

  // ---------------------------------------------------------- 每日挑战
  console.log('\n每日挑战');
  const daily = await client.fetchDaily({ date: pool.start });
  check('领到题目', daily && daily.puzzle && typeof daily.puzzle === 'object');
  if (daily.puzzle.order) currentOrder.v = daily.puzzle.order;
  check('登录用户开启了服务端计时', daily.timed === true && !!daily.started_at);
  check('题面里没有答案', !JSON.stringify(daily).includes('"solution"'));

  const params = new PuzzleClient({ baseUrl: BASE, game: GAME });
  const wrong = await params.submit(daily.puzzle_id, wrongAnswer(daily));
  check('错误答案被识别为答错', wrong.correct === false);

  let badFormat = null;
  await client.submit(daily.puzzle_id, { rows: 'not-an-array' }).catch((e) => { badFormat = e; });
  check('格式错误返回 400（与答错区分开）', badFormat && badFormat.status === 400,
    badFormat && badFormat.message);

  console.log('  等 3.5 秒越过服务端 3 秒下限…');
  await sleep(3500);

  const result = await client.submit(daily.puzzle_id, correctAnswer(daily.date));
  check('正确答案被判对', result.correct === true);
  check('进了榜单', result.ranked === true, result.message);
  check('拿到名次与总人数', typeof result.rank === 'number' && typeof result.total === 'number');
  check('耗时由服务端给出', typeof result.elapsed_ms === 'number' && result.elapsed_ms >= 3000,
    result.elapsed_ms + 'ms');

  // ---------------------------------------------------------- 榜单
  console.log('\n榜单');
  const board = await client.leaderboard({ date: daily.date });
  check('榜单里能查到自己', board.entries.some((e) => e.username === name));
  check('榜单带格式化耗时', typeof board.entries[0].elapsed_text === 'string');

  const allTime = await client.leaderboard({ scope: 'all' });
  check('总榜也能查到', allTime.entries.some((e) => e.username === name));

  const mine = await client.myRank({ date: daily.date });
  check('myRank 报告在榜', mine.on_board === true && mine.rank >= 1);

  const stats = await client.stats();
  check('统计里场次大于 0', stats.plays > 0);

  // ---------------------------------------------------------- 实时推送
  console.log('\n实时推送');
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('5 秒内没收到快照')), 5000);
    client.watchLeaderboard((msg) => {
      clearTimeout(timer);
      resolve(msg);
    }, () => {});
  }).catch((e) => ({ error: e.message }));

  check('连上 WebSocket 就收到快照', snapshot && snapshot.type === 'leaderboard',
    snapshot && snapshot.error);
  check('快照里包含自己', snapshot.entries && snapshot.entries.some((e) => e.username === name));
  client.stopWatching();

  // ---------------------------------------------------------- 收尾
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n测试本身崩了：', err);
  process.exit(1);
});
