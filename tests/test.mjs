/*
 * test.mjs —— 数回的真实 UI 测试
 *
 * 运行：cd tests && npm install && node test.mjs
 *
 * 断言刻意分成两类：
 *   一类数节点（元素个数对不对），
 *   一类量渲染尺寸（元素有没有真的画在该在的位置）。
 * 只数节点是抓不到「棋盘塌成一条线」这种 bug 的——元素都在，尺寸全错。
 */
import { chromium } from 'playwright-core';
import { resolveChrome } from './chrome.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = new URL('../index.html', import.meta.url).href;
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else {
    fail++;
    failures.push(name);
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + extra : ''));
  }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const browser = await chromium.launch({ headless: true, ...resolveChrome() });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 920 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e)));

const st = () => page.evaluate(() => window.__shuhui.state());
const dims = () => page.evaluate(() => window.__shuhui.dims());
const edgesNow = () => page.evaluate(() => window.__shuhui.edges());
const closeModals = () => page.evaluate(() =>
  document.querySelectorAll('.modal').forEach((m) => m.classList.remove('show')));
const waitBoard = () => page.waitForFunction(
  () => window.__shuhui && window.__shuhui.dims().svgEdges > 0 && !window.__shuhui.state().locked,
  null, { timeout: 60000 });
const waitSize = (n) => page.waitForFunction(
  (sz) => window.__shuhui && window.__shuhui.state().size === sz && !window.__shuhui.state().locked,
  n, { timeout: 60000 });

async function setFakeDate(iso) {
  await page.evaluate((isoStr) => {
    const offset = new Date(isoStr).getTime() - Date.now();
    const Real = Date;
    function Fake(...args) {
      if (args.length === 0) return new Real(Real.now() + offset);
      return new Real(...args);
    }
    Fake.now = () => Real.now() + offset;
    Fake.prototype = Real.prototype;
    Fake.parse = Real.parse;
    Fake.UTC = Real.UTC;
    window.Date = Fake;
  }, iso);
}

await page.goto(PAGE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await waitSize(8);

/* ============================================================
 * 1. 棋盘结构
 * ============================================================ */
section('棋盘结构');
{
  const d = await dims();
  const s = await st();
  check('边元素数 = 2n(n+1)', d.svgEdges === 2 * d.size * (d.size + 1), `${d.svgEdges} vs ${2 * d.size * (d.size + 1)}`);
  check('每条边都有命中区', d.svgHits === d.svgEdges, `${d.svgHits} / ${d.svgEdges}`);
  check('排除标记数与边数相等', d.svgMarks === d.svgEdges, `${d.svgMarks} / ${d.svgEdges}`);
  check('数字数 = 线索数', d.svgNums === s.clueCount, `${d.svgNums} vs ${s.clueCount}`);
  check('线索数在合理区间（既不是空盘也不是填满）',
    s.clueCount >= 4 && s.clueCount < d.cells, `${s.clueCount}/${d.cells}`);
}

/* ============================================================
 * 2. 渲染几何（数织就是在这里翻车的）
 * ============================================================ */
section('渲染几何');
{
  const g = await page.evaluate(() => {
    const bb = document.querySelector('#board').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('#board .cellbox')].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, x: r.x, y: r.y };
    });
    const nums = [...document.querySelectorAll('#board .num')].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const lines = [...document.querySelectorAll('#board .vis')].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    return { board: { w: bb.width, h: bb.height }, boxes, nums, lines };
  });

  check('棋盘渲染区域为正方形', Math.abs(g.board.w - g.board.h) < 1.5, `${g.board.w.toFixed(1)}×${g.board.h.toFixed(1)}`);
  check('棋盘有实际尺寸（不是塌成 0）', g.board.w > 200, `${g.board.w.toFixed(1)}px`);

  const box = g.boxes[0];
  check('格子是正方形', Math.abs(box.w - box.h) < 0.8, `${box.w.toFixed(1)}×${box.h.toFixed(1)}`);
  check('格子尺寸足够大（可点可读）', box.w > 12, `${box.w.toFixed(1)}px`);
  check('所有格子尺寸一致',
    g.boxes.every((b) => Math.abs(b.w - box.w) < 0.8 && Math.abs(b.h - box.h) < 0.8));

  const sameRow = g.boxes.filter((b) => Math.abs(b.y - box.y) < 1).length;
  const sameCol = g.boxes.filter((b) => Math.abs(b.x - box.x) < 1).length;
  check('格子按 n×n 铺开', sameRow === sameCol && sameRow > 1, `行 ${sameRow} 列 ${sameCol}`);

  check('数字有实际大小（没被压扁）', g.nums.every((n) => n.h > 4 && n.w > 0), JSON.stringify(g.nums[0]));

  const skew = g.lines.filter((l) => !(Math.abs(l.h) < 1.5 || Math.abs(l.w) < 1.5));
  check('每条边都是水平或垂直的线段', skew.length === 0, `${skew.length} 条异常`);
  const zero = g.lines.filter((l) => l.w < 0.5 && l.h < 0.5);
  check('没有零长度的边', zero.length === 0);
}

/* ============================================================
 * 3. 基本操作
 * ============================================================ */
section('基本操作');
const sol = await page.evaluate(() => window.__shuhui.sol());
const ON_EDGE = sol.indexOf(1);
const OFF_EDGE = sol.indexOf(0);
check('解里既有在回路上的边、也有不在的', ON_EDGE >= 0 && OFF_EDGE >= 0);

{
  const r = await page.evaluate((e) => window.__shuhui.edgeRect(e), ON_EDGE);
  await page.mouse.click(r.cx, r.cy);
  check('点击边 → 画上回路',
    (await page.evaluate((e) => window.__shuhui.edges()[e], ON_EDGE)) === 1);

  await page.mouse.click(r.cx, r.cy);
  check('再点一次 → 退回未定',
    (await page.evaluate((e) => window.__shuhui.edges()[e], ON_EDGE)) === -1);
}

{
  await page.click('#btnMark');
  const r = await page.evaluate((e) => window.__shuhui.edgeRect(e), OFF_EDGE);
  await page.mouse.click(r.cx, r.cy);
  check('标记模式下点击 → 标为「不在回路上」',
    (await page.evaluate((e) => window.__shuhui.edges()[e], OFF_EDGE)) === 0);
  check('排除标记的 ✕ 已显示',
    (await page.evaluate((e) => document.querySelectorAll('#board .mark')[e].classList.contains('hide'), OFF_EDGE)) === false);

  await page.mouse.click(r.cx, r.cy);
  check('标记模式下再点一次 → 清除标记',
    (await page.evaluate((e) => window.__shuhui.edges()[e], OFF_EDGE)) === -1);
  await page.click('#btnMark');
}

{
  const pair = await page.evaluate(() => {
    const s = window.__shuhui.sol();
    const n = window.__shuhui.dims().size;
    const hc = n * (n + 1);
    for (let e = 0; e < hc - 1; e++) {
      if (e % n === n - 1) continue;              // 跨行不算相邻
      if (s[e] === 1 && s[e + 1] === 1) return [e, e + 1];
    }
    return null;
  });
  check('能找到两条相邻且都在回路上的边（供拖动测试）', pair !== null);
  if (pair) {
    const [a, b] = pair;
    const ra = await page.evaluate((e) => window.__shuhui.edgeRect(e), a);
    const rb = await page.evaluate((e) => window.__shuhui.edgeRect(e), b);
    await page.mouse.move(ra.cx, ra.cy);
    await page.mouse.down();
    await page.mouse.move((ra.cx + rb.cx) / 2, (ra.cy + rb.cy) / 2, { steps: 5 });
    await page.mouse.move(rb.cx, rb.cy, { steps: 5 });
    await page.mouse.up();
    const vs = await page.evaluate((es) => es.map((e) => window.__shuhui.edges()[e]), [a, b]);
    check('拖动可以连续画线', vs[0] === 1 && vs[1] === 1, JSON.stringify(vs));
    await page.evaluate(() => window.__shuhui.clearAll());
  }
}

/* ============================================================
 * 4. 即时纠错
 * ============================================================ */
section('即时纠错');
{
  await page.evaluate(() => window.__shuhui.clearAll());
  const m0 = (await st()).miss;
  const r = await page.evaluate((e) => window.__shuhui.edgeRect(e), OFF_EDGE);
  await page.mouse.click(r.cx, r.cy);
  const after = await page.evaluate((e) => ({ v: window.__shuhui.edges()[e], miss: window.__shuhui.state().miss }), OFF_EDGE);
  check('画错边会被撤销', after.v === -1, String(after.v));
  check('画错边记一次失误', after.miss === m0 + 1, `${m0} → ${after.miss}`);
}
{
  await page.evaluate(() => window.__shuhui.clearAll());
  const m0 = (await st()).miss;
  await page.click('#btnMark');
  const r = await page.evaluate((e) => window.__shuhui.edgeRect(e), ON_EDGE);
  await page.mouse.click(r.cx, r.cy);
  const after = await page.evaluate((e) => ({ v: window.__shuhui.edges()[e], miss: window.__shuhui.state().miss }), ON_EDGE);
  check('把回路上的边标为排除也会被拦下', after.v === -1, String(after.v));
  check('标错同样记失误', after.miss === m0 + 1);
  await page.click('#btnMark');
}

/* ============================================================
 * 5. 提示 / 演示 / 检查
 * ============================================================ */
section('提示 · 演示 · 检查');
{
  await page.evaluate(() => window.__shuhui.clearAll());
  // 提示揭示的可能是「画上」也可能是「排除」，所以看的是「未定边」有没有减少
  const before = (await st()).unknown;
  await page.click('#btnHint');
  await page.waitForTimeout(150);
  const after = await st();
  check('提示会落下一步', after.unknown < before, `未定 ${before} → ${after.unknown}`);
  check('提示计入次数', after.hints >= 1);
  check('提示落下的边与答案一致', await page.evaluate(() => {
    const e = window.__shuhui.edges(), s = window.__shuhui.sol();
    return e.every((v, i) => v === -1 || v === s[i]);
  }));
}

{
  // 演示：换到 6×6 的小盘，跑得快
  await page.evaluate(() => window.__shuhui.newPuzzle('easy'));
  await waitSize(6);
  await closeModals();
  await page.evaluate(() => window.__shuhui.clearAll());
  await page.click('#btnDemo');
  await page.waitForFunction(() => window.__shuhui.state().done, null, { timeout: 90000 });
  check('演示能自动解到完成', (await st()).done === true);
  check('演示结束的局面确实是合法解',
    (await page.evaluate(() => window.__shuhui.isSolvedNow())) === true);
  await page.screenshot({ path: path.join(SHOTS, 'demo-done.png') });
}

{
  await closeModals();
  await page.evaluate(() => window.__shuhui.newPuzzle('easy'));
  await waitSize(6);
  await page.evaluate(() => window.__shuhui.hint());
  await page.click('#btnCheck');
  await page.waitForTimeout(200);
  const t = await page.evaluate(() => document.querySelector('#toast').textContent);
  check('检查会给出进度反馈', /线索|完成|违反/.test(t), t);
}

/* ============================================================
 * 6. 通关判定
 * ============================================================ */
section('通关判定');
{
  await closeModals();
  await page.evaluate(() => window.__shuhui.newPuzzle('easy'));
  await waitSize(6);
  await page.evaluate(() => window.__shuhui.fillSolution());
  await page.waitForTimeout(250);
  check('填满正确解后判定通关', (await st()).done === true);
  check('通关弹窗出现',
    (await page.evaluate(() => document.querySelector('#modalWin').classList.contains('show'))) === true);
  const sizeTxt = await page.evaluate(() => document.querySelector('#winSize').textContent);
  check('弹窗显示盘面尺寸', sizeTxt === '6×6', sizeTxt);
  await page.screenshot({ path: path.join(SHOTS, 'win.png') });
}

{
  // 只画回路上的边、其余一律不标记（游戏里最常见的完成方式）
  await closeModals();
  await page.evaluate(() => {
    const S = window.__shuhui;
    S.clearAll();
    const s = S.sol();
    for (let e = 0; e < s.length; e++) if (s[e] === 1) S.setEdge(e, 1);
  });
  await page.waitForTimeout(200);
  check('只画回路、不标其余边也算通关', (await st()).done === true);
}

{
  // 少一条边就不该判通关
  await closeModals();
  await page.evaluate(() => window.__shuhui.newPuzzle('easy'));
  await waitSize(6);
  await page.evaluate(() => {
    const S = window.__shuhui;
    S.clearAll();
    const s = S.sol();
    const on = [];
    for (let e = 0; e < s.length; e++) if (s[e] === 1) on.push(e);
    for (let k = 0; k < on.length - 1; k++) S.setEdge(on[k], 1);   // 故意漏掉最后一条
  });
  await page.waitForTimeout(200);
  check('回路缺一条边时不判通关', (await st()).done === false);
}

/* ============================================================
 * 7. 难度
 * ============================================================ */
section('难度切换');
{
  await closeModals();
  await page.evaluate(() => localStorage.clear());
  await page.click('#levelSeg button[data-lv="hard"]');
  await waitSize(10);
  const d = await dims();
  check('高级难度是 10×10', d.size === 10, String(d.size));
  check('高级难度的边元素随之重建', d.svgEdges === 2 * 10 * 11, String(d.svgEdges));
  const hb = await page.evaluate(() => {
    const r = document.querySelector('#board .cellbox').getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  check('10×10 的格子仍是正方形且有尺寸',
    Math.abs(hb.w - hb.h) < 0.8 && hb.w > 8, `${hb.w.toFixed(1)}×${hb.h.toFixed(1)}`);
  check('高级难度按钮处于选中态',
    (await page.evaluate(() => document.querySelector('#levelSeg button[data-lv="hard"]').classList.contains('on'))) === true);

  await page.click('#levelSeg button[data-lv="easy"]');
  await waitSize(6);
  check('切回初级是 6×6', (await st()).size === 6);
}

/* ============================================================
 * 8. 每日挑战
 * ============================================================ */
section('每日挑战');
let day1 = null;
{
  await closeModals();
  await setFakeDate('2026-09-14T12:00:00');
  await page.evaluate(() => window.__shuhui.startDaily());
  await page.waitForFunction(() => window.__shuhui.state().daily && !window.__shuhui.state().locked, null, { timeout: 60000 });
  day1 = await page.evaluate(() => ({ clue: window.__shuhui.clue(), key: window.__shuhui.state().dailyKey, size: window.__shuhui.state().size }));
  check('每日挑战的题目尺寸落在难度档位内', [6, 8, 10].includes(day1.size), String(day1.size));

  await page.evaluate(() => window.__shuhui.startDaily());
  await page.waitForFunction(() => !window.__shuhui.state().locked, null, { timeout: 60000 });
  const day1b = await page.evaluate(() => window.__shuhui.clue());
  check('同一天两次进入得到同一道题', JSON.stringify(day1.clue) === JSON.stringify(day1b));

  await setFakeDate('2026-09-15T12:00:00');
  await page.evaluate(() => window.__shuhui.startDaily());
  await page.waitForFunction(() => !window.__shuhui.state().locked, null, { timeout: 60000 });
  const day2 = await page.evaluate(() => window.__shuhui.clue());
  check('换一天得到不同的题', JSON.stringify(day1.clue) !== JSON.stringify(day2));

  await setFakeDate('2026-09-16T12:00:00');
  await page.evaluate(() => window.__shuhui.startDaily());
  await page.waitForFunction(() => !window.__shuhui.state().locked, null, { timeout: 60000 });
  const day3 = await page.evaluate(() => window.__shuhui.clue());
  check('再换一天仍是不同的题',
    JSON.stringify(day3) !== JSON.stringify(day2) && JSON.stringify(day3) !== JSON.stringify(day1.clue));

  const mode = await page.evaluate(() => document.querySelector('#stMode').textContent);
  check('状态栏显示每日挑战与日期', /每日挑战/.test(mode) && /2026\.09\.16/.test(mode), mode);
  check('「每日挑战」按钮处于选中态',
    (await page.evaluate(() => document.querySelector('#btnDaily').classList.contains('on'))) === true);
  check('此时难度分段控件不高亮（不与每日挑战抢状态）',
    (await page.evaluate(() => [...document.querySelectorAll('#levelSeg button')].filter((b) => b.classList.contains('on')).length)) === 0);
}

{
  // 通关后写入当日记录
  await page.evaluate(() => window.__shuhui.fillSolution());
  await page.waitForTimeout(300);
  const daily = await page.evaluate(() => JSON.parse(localStorage.getItem('shuhui.v1')).daily);
  const keys = Object.keys(daily);
  check('完成每日挑战后写入当日记录', keys.length >= 1, JSON.stringify(daily));
  check('记录绑定到开局那一天', keys[0] === 'd20260916', keys[0]);
  check('记录标记为已完成', daily[keys[0]].done === true);
  check('记录存下最佳用时', typeof daily[keys[0]].best === 'number');
}

/* ============================================================
 * 9. 存档
 * ============================================================ */
section('存档与恢复');
{
  await closeModals();
  await page.evaluate(() => window.__shuhui.newPuzzle('normal'));
  await waitSize(8);
  await page.evaluate(() => {
    const S = window.__shuhui;
    S.clearAll();
    const s = S.sol();
    let n = 0;
    for (let e = 0; e < s.length && n < 6; e++) { if (s[e] === 1) { S.setEdge(e, 1); n++; } }
  });
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => ({ edges: window.__shuhui.edges(), size: window.__shuhui.state().size }));

  await page.reload();
  await waitBoard();
  const after = await page.evaluate(() => ({ edges: window.__shuhui.edges(), size: window.__shuhui.state().size }));
  check('刷新后盘面尺寸一致', before.size === after.size, `${before.size} vs ${after.size}`);
  check('刷新后已画的边被保留', JSON.stringify(before.edges) === JSON.stringify(after.edges));
  check('刷新后仍能继续操作', (await st()).locked === false);
}

/* ============================================================
 * 10. 窄屏
 * ============================================================ */
section('窄屏布局');
{
  const mobile = await ctx.newPage();
  mobile.on('pageerror', (e) => consoleErrors.push('mobile pageerror: ' + String(e)));
  await mobile.goto(PAGE);
  await mobile.setViewportSize({ width: 390, height: 780 });
  await mobile.evaluate(() => localStorage.clear());
  await mobile.reload();
  await mobile.waitForFunction(
    () => window.__shuhui && window.__shuhui.dims().svgEdges > 0 && !window.__shuhui.state().locked,
    null, { timeout: 60000 });

  const m = await mobile.evaluate(() => {
    const b = document.querySelector('#board').getBoundingClientRect();
    return {
      board: { w: b.width, h: b.height, x: b.x },
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    };
  });
  check('窄屏下棋盘未溢出视口', m.scrollW <= m.innerW + 1, `scrollW=${m.scrollW} innerW=${m.innerW}`);
  check('窄屏下棋盘左边不为负', m.board.x >= -1, String(m.board.x));
  check('窄屏下棋盘仍有可用尺寸', m.board.w > 200, `${m.board.w.toFixed(1)}px`);

  const mb = await mobile.evaluate(() => {
    const r = document.querySelector('#board .cellbox').getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  check('窄屏下格子仍是正方形', Math.abs(mb.w - mb.h) < 0.8, `${mb.w.toFixed(1)}×${mb.h.toFixed(1)}`);

  const solM = await mobile.evaluate(() => window.__shuhui.sol());
  const onM = solM.indexOf(1);
  const rM = await mobile.evaluate((e) => window.__shuhui.edgeRect(e), onM);
  await mobile.mouse.click(rM.cx, rM.cy);
  check('窄屏下点击边仍能命中',
    (await mobile.evaluate((e) => window.__shuhui.edges()[e], onM)) === 1);

  await mobile.evaluate(() => window.__shuhui.newPuzzle('hard'));
  await mobile.waitForFunction(
    () => window.__shuhui.state().size === 10 && !window.__shuhui.state().locked, null, { timeout: 60000 });
  const mh = await mobile.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    cellR: document.querySelector('#board .cellbox').getBoundingClientRect().width,
  }));
  check('窄屏下 10×10 也不溢出', mh.scrollW <= mh.innerW + 1, `scrollW=${mh.scrollW} innerW=${mh.innerW}`);
  check('窄屏下 10×10 的格子仍可点击', mh.cellR > 8, `${mh.cellR.toFixed(1)}px`);
  await mobile.screenshot({ path: path.join(SHOTS, 'mobile-hard.png') });
  await mobile.close();
}

/* ============================================================
 * 11. 控制台
 * ============================================================ */
section('控制台');
check('无 console 错误、无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await page.screenshot({ path: path.join(SHOTS, 'final.png') });
await browser.close();

console.log(`\n通过 ${pass} 项` + (fail ? `，失败 ${fail} 项` : '，全部通过'));
if (fail) {
  console.log('失败清单：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL UI TESTS PASSED');
