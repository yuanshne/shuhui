/*
 * online.mjs —— 数回联机模式的真端到端测试
 *
 * 跟 test.mjs 的区别：那边测的是「离线单文件」这一面，全部在 file:// 下跑；
 * 这边把真后端起起来，用两个独立玩家验证联机链路。
 *
 *   玩家 A：浏览器里的真界面（点「联机」→ 注册 → 每日挑战 → 画完 → 看名次 → 看榜单）
 *   玩家 B：Node 里的同款客户端库（发布到 npm 之前先证明它不挑环境）
 *
 * 玩家 A 全程盯着 WebSocket，所以 B 交卷之后 A 的榜单必须自己变 —— 这条断言
 * 是唯一能证明「实时推送真的通了」的东西，比查接口返回有用得多。
 *
 * 运行：cd tests && npm install && node online.mjs
 * 跳过：SKIP_ONLINE=1 node online.mjs
 * 指定解释器：PYTHON=/path/to/python node online.mjs
 */
import { chromium } from 'playwright-core';
import { resolveChrome } from './chrome.mjs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.join(HERE, '..');                  // 数回仓库根
const SERVER = path.join(GAME, 'server'); // 内置后端目录
const SHOTS = path.join(HERE, 'shots');
const require = createRequire(import.meta.url);
fs.mkdirSync(SHOTS, { recursive: true });

/* ---------------------------------------------------------------- 断言 */

let pass = 0;
const failures = [];

function section(name) {
  console.log('\n== ' + name + ' ==');
}

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else {
    console.log('  \u2717 ' + name + (detail ? '  \u2192 ' + detail : ''));
    failures.push(name + (detail ? '  \u2192 ' + detail : ''));
  }
}

/* ---------------------------------------------------------------- 环境 */

/** 定位 Python：优先显式指定，其次仓库内 venv，最后托管 venv / PATH。 */
function resolvePython() {
  const candidates = [
    process.env.PYTHON,
    path.join(SERVER, '.venv', 'Scripts', 'python.exe'),
    path.join(SERVER, '.venv', 'bin', 'python'),
    // 托管 venv：用 homedir 拼，避免把本机绝对路径写进仓库
    path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe'),
    process.platform === 'win32' ? null : 'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'python' || c === 'python3') return c;   // 交给 PATH 解析
    if (existsSync(c)) return c;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json().catch(() => ({}));
    } catch (err) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('等待 ' + url + ' 超时');
}

/** 极简静态服务：把数回仓库当站点发出去，只为让页面有个 http 源。 */
function serveStatic(root) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ---------------------------------------------------------------- 主流程 */

if (process.env.SKIP_ONLINE === '1') {
  console.log('SKIP_ONLINE=1，跳过联机端到端测试');
  process.exit(0);
}

const py = resolvePython();
if (!py) {
  console.log('找不到 Python 解释器。设 PYTHON=/path/to/python 后重试。');
  process.exit(1);
}
if (!existsSync(path.join(SERVER, 'app', 'main.py'))) {
  console.log('找不到后端仓库：' + SERVER);
  process.exit(1);
}

const apiPort = await freePort();
const API = 'http://127.0.0.1:' + apiPort;
const dbFile = path.join(SERVER, 'var', 'online-e2e.db');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  if (existsSync(f)) rmSync(f);
}
fs.mkdirSync(path.join(SERVER, 'var'), { recursive: true });

console.log('启动后端 ' + API + '（解释器 ' + py + '）');
const server = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort), '--log-level', 'warning'], {
  cwd: SERVER,
  env: {
    ...process.env,
    PUZZLE_STORAGE_MODE: 'memory',            // 跳过 Redis 探测，省掉一次超时
    PUZZLE_DATABASE_URL: 'sqlite:///./var/online-e2e.db',
    PUZZLE_SEED_ON_STARTUP: 'true',
    PUZZLE_BCRYPT_ROUNDS: '4',                // 生产是 12；这里只求快
    PUZZLE_JWT_SECRET: 'online-e2e-secret-0123456789abcdef',
    PUZZLE_MIN_ELAPSED_MS: '3000',            // 保持真实下限，顺便验证服务端计时
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
server.on('exit', (code) => { if (code !== 0 && code !== null) serverLog += `\n[后端退出 code=${code}]`; });

let browser = null;
let staticSrv = null;
let exitCode = 0;

try {
  const health = await waitHttp(API + '/health', 60000);
  section('后端就绪');
  check('健康检查通过', health.status === 'ok', JSON.stringify(health));
  check('排行榜走进程内实现', health.leaderboard === 'memory', String(health.leaderboard));

  const today = new Date();
  const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') +
    '-' + String(today.getDate()).padStart(2, '0');
  const dailyProbe = await fetch(API + '/api/v1/daily/shuhui?date=' + dateStr);
  if (dailyProbe.status !== 200) {
    console.log('\n今天（' + dateStr + '）没有题：' + await dailyProbe.text());
    console.log('先在后端仓库跑 tools/gen_pool.mjs 覆盖这个日期，再重试。');
    throw new Error('题池不覆盖今天');
  }

  /* ---------------- 玩家 B：Node 客户端库 ---------------- */
  section('玩家 B · Node 里的同款客户端库');
  const PuzzleClient = require(path.join(GAME, 'src', 'puzzle-client.js'));
  const SH = require(path.join(GAME, 'src', 'engine.js'));
  check('客户端库能在 Node 下加载', typeof PuzzleClient === 'function');
  check('引擎能在 Node 下加载', typeof SH.solve === 'function');

  const suffixB = Math.random().toString(16).slice(2, 8);
  const rivalName = 'rival_' + suffixB;
  const rival = new PuzzleClient({ baseUrl: API, game: 'shuhui', variant: 'standard' });

  const rivalUser = await rival.register(rivalName, 'rival-pass-1234');
  check('玩家 B 注册成功', rivalUser.username === rivalName, JSON.stringify(rivalUser));

  const rivalDaily = await rival.fetchDaily({ date: dateStr });
  check('玩家 B 领到题', rivalDaily.puzzle && rivalDaily.puzzle.n === 8,
    'n=' + (rivalDaily.puzzle && rivalDaily.puzzle.n));
  check('题面里没有答案', !('solution' in rivalDaily.puzzle) && !('solution' in rivalDaily),
    Object.keys(rivalDaily.puzzle).join(','));

  const rL = SH.buildLayout(rivalDaily.puzzle.n);
  const rClue = Int8Array.from(rivalDaily.puzzle.clue.flat());
  const rSol = SH.solve(rL, rClue, SH.emptyState(rL), 200000);
  check('本地求解器还原出答案', !!rSol);
  const rOn = [];
  for (let i = 0; i < rSol.length; i++) if (rSol[i] === SH.ON) rOn.push(i);

  /* ---------------- 玩家 A：浏览器 ---------------- */
  section('玩家 A · 浏览器真界面');
  const stat = await serveStatic(GAME);
  staticSrv = stat.srv;
  const PAGE = 'http://127.0.0.1:' + stat.port + '/index.html?api=' + encodeURIComponent(API);

  const consoleErrors = [];
  browser = await chromium.launch({ headless: true, ...resolveChrome() });
  const page = await browser.newPage();

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e)));

  await page.goto(PAGE);
  await page.waitForFunction(
    () => window.__shuhui && window.__shuhui.dims().svgEdges > 0 && !window.__shuhui.state().locked,
    null, { timeout: 60000 });

  await page.waitForFunction(() => window.__shuhui.net.ready(), null, { timeout: 30000 });
  const connected = await page.evaluate(() => ({
    label: window.__shuhui.net.label(),
    dot: window.__shuhui.net.dotClass(),
    api: window.__shuhui.net.api(),
  }));
  check('页面按 ?api= 连上了后端', connected.api === API, JSON.stringify(connected));
  check('工具栏状态变为「联机」', connected.label === '联机', connected.label);
  check('状态点转为在线色', connected.dot.includes('on'), connected.dot);

  // 通过界面注册，而不是直接调库 —— 要顺带验证表单接线
  const suffixA = Math.random().toString(16).slice(2, 8);
  const heroName = 'hero_' + suffixA;
  await page.click('#btnOnline');
  await page.fill('#inUser', heroName);
  await page.fill('#inPass', 'hero-pass-1234');
  await page.click('#btnRegister');
  await page.waitForFunction(() => window.__shuhui.net.loggedIn(), null, { timeout: 30000 });

  const logged = await page.evaluate(() => ({
    user: window.__shuhui.net.username(),
    label: window.__shuhui.net.label(),
    formHidden: document.querySelector('#onlineForm').hidden,
    meShown: !document.querySelector('#onlineMe').hidden,
    msg: document.querySelector('#onlineMsg').textContent,
  }));
  check('界面注册后进入已登录态', logged.user === heroName, JSON.stringify(logged));
  check('登录表单收起、账号面板展开', logged.formHidden && logged.meShown);
  check('工具栏显示当前账号', logged.label.startsWith('hero_'), logged.label);
  check('提示文案确认成绩将上榜', /计入榜单/.test(logged.msg), logged.msg);
  await page.screenshot({ path: path.join(SHOTS, 'online-panel.png') });

  await page.click('#btnCloseOnline');
  await page.click('#btnDaily');
  await page.waitForFunction(
    () => window.__shuhui.state().daily && !window.__shuhui.state().locked,
    null, { timeout: 60000 });

  const online = await page.evaluate(() => window.__shuhui.state());
  check('每日挑战来自服务端（有题号）', typeof online.onlineId === 'number' && online.onlineId > 0,
    String(online.onlineId));
  check('登录用户被服务端计时', online.timed === true);
  check('本地还原出解，即时纠错可用', online.hasLocalSolution === true);
  check('状态栏写明是「在线计时」', /在线计时/.test(online.timeLabel), online.timeLabel);

  const dailyPayload = await page.evaluate(() => ({ clue: window.__shuhui.clue(), size: window.__shuhui.state().size }));
  check('服务端题面与 Node 侧一致',
    dailyPayload.size === rivalDaily.puzzle.n &&
    JSON.stringify(dailyPayload.clue) === JSON.stringify(rivalDaily.puzzle.clue.flat()));

  // 服务端计时有下限（早于 3s 的交卷判为脚本，不计榜单）—— 等满再交
  console.log('  等待服务端计时下限（3s）…');
  await sleep(3300);
  const filled = await page.evaluate(() => window.__shuhui.fillSolution());
  check('用本地解一次填完即判胜', filled === true);
  await page.waitForFunction(() => window.__shuhui.net.lastSubmit() !== null, null, { timeout: 30000 });

  const sub = await page.evaluate(() => ({
    raw: window.__shuhui.net.lastSubmit(),
    text: document.querySelector('#winNet').textContent,
    modalShown: document.querySelector('#modalWin').classList.contains('show'),
  }));
  check('交卷被服务端判为正确', sub.raw.correct === true, JSON.stringify(sub.raw));
  check('成绩计入榜单', sub.raw.ranked === true, JSON.stringify(sub.raw));
  check('拿到第 1 名', sub.raw.rank === 1 && sub.raw.total >= 1,
    'rank=' + sub.raw.rank + ' total=' + sub.raw.total);
  check('服务端计时结果落在合理区间（3~20s）',
    sub.raw.elapsed_ms >= 3000 && sub.raw.elapsed_ms < 20000, String(sub.raw.elapsed_ms));
  check('结算弹窗写明名次与服务端计时', /第 1 名/.test(sub.text) && /服务端计时/.test(sub.text), sub.text);
  check('首答记为个人最好', sub.raw.improved === true, JSON.stringify(sub.raw));
  await page.screenshot({ path: path.join(SHOTS, 'online-win.png') });

  /* ---------------- 实时推送 ---------------- */
  section('实时推送');
  await page.click('#btnCloseWin');
  // README 的门面图：一条真正闭合的回路上，工具栏挂着在线账号
  await page.screenshot({ path: path.join(SHOTS, 'hero.png') });
  await page.click('#btnBoard');
  await page.waitForFunction(() => window.__shuhui.net.wsState() === 'open', null, { timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#lbList li').length >= 1, null, { timeout: 30000 });

  const boardA = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('#lbList li')).map((li) => li.textContent),
    mine: !!document.querySelector('#lbList li.me'),
    meta: document.querySelector('#lbMeta').textContent,
    ws: window.__shuhui.net.wsState(),
  }));
  check('榜单已渲染出玩家 A', boardA.rows.some((t) => t.includes(heroName)), JSON.stringify(boardA.rows));
  check('榜单高亮自己那一行', boardA.mine);
  check('WebSocket 处于已连接', boardA.ws === 'open', String(boardA.ws));
  check('榜单页脚写明实时同步', /实时同步中/.test(boardA.meta), boardA.meta);

  console.log('  玩家 B 交卷，观察玩家 A 的榜单是否自己变…');
  const rivalSubmit = await rival.submit(rivalDaily.puzzle_id, { on: rOn });
  check('玩家 B 交卷被接受', rivalSubmit.correct === true && rivalSubmit.ranked === true,
    JSON.stringify(rivalSubmit));

  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#lbList li')).some((li) => li.textContent.includes('rival_')),
    null, { timeout: 20000 }).catch(() => {});

  const boardAfter = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('#lbList li')).map((li) => li.textContent),
    meta: document.querySelector('#lbMeta').textContent,
  }));
  check('未刷新页面，榜单自动出现了玩家 B',
    boardAfter.rows.some((t) => t.includes(rivalName)), JSON.stringify(boardAfter.rows));
  check('人数统计同步更新', /共 2 人上榜/.test(boardAfter.meta), boardAfter.meta);
  await page.screenshot({ path: path.join(SHOTS, 'online-board.png') });

  /* ---------------- 切换历史总榜 ---------------- */
  section('榜单切换');
  await page.click('#tabAll');
  await page.waitForFunction(
    () => /历史总榜/.test(document.querySelector('#lbMeta').textContent), null, { timeout: 20000 });
  const allBoard = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('#lbList li')).map((li) => li.textContent),
    meta: document.querySelector('#lbMeta').textContent,
  }));
  check('切到历史总榜仍列出两人', allBoard.rows.length === 2, JSON.stringify(allBoard.rows));
  check('总榜页脚标明范围', /历史总榜/.test(allBoard.meta), allBoard.meta);

  /* ---------------- 反作弊与榜单口径 ---------------- */
  section('反作弊与榜单口径');
  // 关键前提：这个人从来没领过这道题。没有领题记录时服务端按 0 耗时算，
  // 必然低于 min_elapsed 下限，于是「算他答对，但不让他上榜」。
  const sneakName = 'sneak_' + Math.random().toString(16).slice(2, 8);
  const sneak = new PuzzleClient({ baseUrl: API, game: 'shuhui', variant: 'standard' });
  await sneak.register(sneakName, 'sneak-pass-1234');
  const sneakRes = await sneak.submit(rivalDaily.puzzle_id, { on: rOn });
  check('没领题就交卷：判对但不计榜单',
    sneakRes.correct === true && sneakRes.ranked === false, JSON.stringify(sneakRes));
  check('拦截原因写明低于耗时下限', /低于下限/.test(sneakRes.message), sneakRes.message);

  // 同一玩家再交一次，比自己的最好成绩慢 —— 榜上该留最快那次
  const again = await rival.submit(rivalDaily.puzzle_id, { on: rOn });
  check('再次交卷慢于个人最好，improved=false',
    again.ranked === true && again.improved === false, JSON.stringify(again));

  const lb = await rival.leaderboard({ scope: 'daily', date: dateStr });
  const rivalRow = lb.entries.find((e) => e.username === rivalName);
  check('榜上保留个人最快成绩',
    !!rivalRow && rivalRow.elapsed_ms === rivalSubmit.elapsed_ms,
    JSON.stringify(rivalRow));
  check('被拦下的交卷没有混进榜里',
    !lb.entries.some((e) => e.username === sneakName), JSON.stringify(lb.entries.map((e) => e.username)));

  const bad = await fetch(API + '/api/v1/daily/shuhui/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rival.token() },
    body: JSON.stringify({ puzzle_id: rivalDaily.puzzle_id, solution: { on: [999999] } }),
  });
  check('越界边编号被判为格式错误（400）', bad.status === 400, String(bad.status));

  /* ---------------- 退出登录后仍能单机玩 ---------------- */
  section('登出降级');
  await page.click('#tabDaily');
  await page.click('#btnCloseBoard');
  await page.click('#btnOnline');
  await page.click('#btnLogout');
  await page.waitForFunction(() => !window.__shuhui.net.loggedIn(), null, { timeout: 20000 });
  const afterLogout = await page.evaluate(() => ({
    label: window.__shuhui.net.label(),
    formShown: !document.querySelector('#onlineForm').hidden,
  }));
  check('退出后回到未登录态', afterLogout.label === '联机' && afterLogout.formShown,
    JSON.stringify(afterLogout));

  await page.click('#btnCloseOnline');
  await page.evaluate(() => window.__shuhui.startDaily());
  await page.waitForFunction(
    () => window.__shuhui.state().daily && !window.__shuhui.state().locked,
    null, { timeout: 60000 });
  const guest = await page.evaluate(() => window.__shuhui.state());
  check('未登录也能领到在线题', typeof guest.onlineId === 'number');
  check('未登录时服务端不计时', guest.timed === false);
  check('状态栏提示未登录', /未登录/.test(guest.timeLabel), guest.timeLabel);
  check('未登录时结算文案说明不上榜',
    /未登录/.test(await page.evaluate(() => window.__shuhui.net.pendingText())),
    await page.evaluate(() => window.__shuhui.net.pendingText()));

  section('控制台');
  check('无 console 错误、无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} 项` + (failures.length ? `，失败 ${failures.length} 项` : '，全部通过'));
  if (failures.length) {
    console.log('失败清单：');
    failures.forEach((f) => console.log('  - ' + f));
    exitCode = 1;
  } else {
    console.log('ALL ONLINE E2E TESTS PASSED');
  }
} catch (err) {
  console.log('\n测试中断：' + (err && err.stack ? err.stack : err));
  if (serverLog) console.log('后端日志：\n' + serverLog.slice(-2000));
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (staticSrv) await new Promise((r) => staticSrv.close(r));
  server.kill();
  await sleep(300);
}

process.exit(exitCode);
