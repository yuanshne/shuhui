/*
 * engine.test.mjs —— 数回（Slitherlink）引擎自测
 *
 * 运行：node src/engine.test.mjs   （必须全绿）
 *
 * 验证策略上有一条硬要求：求解器不能「自己证明自己」。
 * 因此这里另写了一个完全独立、笨拙但绝对可信的暴力枚举器
 * （枚举全部格子子集 → 取边界 → 看哪些边界满足线索），
 * 用它来核对 countSolutions 的计数和 propagate 的每一个推导。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SH = require('./engine.js');

const {
  UNKNOWN, OFF, ON, NO_CLUE,
  hashSeed, mulberry32,
  buildLayout,
  emptyState,
  propagate,
  isLoop,
  isSolved,
  cluesSatisfied,
  conflictedCells,
  countSolutions,
  solve,
  randomRegion,
  isSimpleRegion,
  regionToLoop,
  deformLoop,
  cluesFromLoop,
  generate,
  DIFFICULTY,
} = SH;

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`[ok] ${name}`);
}

/* ============================================================
 * 独立参照实现：暴力枚举
 * 不调用引擎的求解/传播代码，只借用「子集 → 边界」这个定义。
 * ============================================================ */
function bruteSolutions(L, clue) {
  const n = L.n;
  const nc = n * n;
  const out = [];
  const inP = new Uint8Array(nc);
  const limit = 1 << nc;                    // 只在 n ≤ 4 时使用
  for (let mask = 1; mask < limit; mask++) {
    for (let i = 0; i < nc; i++) inP[i] = (mask >> i) & 1;
    if (!isSimpleRegion(inP, n)) continue;
    const st = regionToLoop(L, inP);
    if (!isLoop(L, st)) continue;
    let match = true;
    for (let i = 0; i < nc; i++) {
      if (clue[i] < 0) continue;
      const b = i * 4;
      const k =
        (st[L.cellE[b]] === ON ? 1 : 0) +
        (st[L.cellE[b + 1]] === ON ? 1 : 0) +
        (st[L.cellE[b + 2]] === ON ? 1 : 0) +
        (st[L.cellE[b + 3]] === ON ? 1 : 0);
      if (k !== clue[i]) { match = false; break; }
    }
    if (match) out.push(st);
  }
  return out;
}

/** 造一道「保证有解」的小题：随机区域 → 边界 → 挖掉部分线索。 */
function makeSmallCase(n, rng, blankRate) {
  const L = buildLayout(n);
  const nc = n * n;
  for (let attempt = 0; attempt < 200; attempt++) {
    const target = 1 + Math.floor(rng() * nc);
    const { inP, count } = randomRegion(n, rng, target);
    if (count < 1) continue;
    if (!isSimpleRegion(inP, n)) continue;
    const sol = regionToLoop(L, inP);
    if (!isLoop(L, sol)) continue;
    const clue = cluesFromLoop(L, sol);
    for (let i = 0; i < nc; i++) if (rng() < blankRate) clue[i] = NO_CLUE;
    return { L, clue, sol };
  }
  return null;
}

/* ============================================================
 * 1. 确定性随机
 * ============================================================ */
ok('hashSeed：字符串种子不再退化为 0（每日挑战同题的根因）', () => {
  assert.equal(hashSeed('d20260914') === 0, false);
  assert.equal(hashSeed('d20260915') === 0, false);
  assert.notEqual(hashSeed('d20260914'), hashSeed('d20260915'));
  assert.notEqual(hashSeed('d20260914'), hashSeed('d20260916'));
  // 数字与等值字符串必须得到同一结果，否则调用方换个入参类型就换了题目
  assert.equal(hashSeed('12345'), hashSeed(12345));
  assert.equal(hashSeed('0'), hashSeed(0));
});

ok('hashSeed：60 个连续日期两两不同（同一道题不该连续两天出现）', () => {
  const seen = new Set();
  const base = new Date('2026-01-01T12:00:00');
  for (let d = 0; d < 60; d++) {
    const dt = new Date(base.getTime() + d * 86400000);
    const key = 'd' + (dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate());
    seen.add(hashSeed(key));
  }
  assert.equal(seen.size, 60);
});

ok('mulberry32：同种子同序列、异种子异序列', () => {
  const a = mulberry32('shuhui');
  const b = mulberry32('shuhui');
  const c = mulberry32('shuhu1');
  const sa = [a(), a(), a()];
  const sb = [b(), b(), b()];
  const sc = [c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  for (const v of sa) assert.ok(v >= 0 && v < 1);
});

/* ============================================================
 * 2. 盘面索引
 * ============================================================ */
ok('buildLayout：边数、端点、相邻格互相自洽', () => {
  for (const n of [2, 3, 5, 8]) {
    const L = buildLayout(n);
    assert.equal(L.E, 2 * n * (n + 1));
    assert.equal(L.dots, (n + 1) * (n + 1));
    assert.equal(L.hCount, n * (n + 1));

    for (let e = 0; e < L.E; e++) {
      assert.notEqual(L.eA[e], L.eB[e], '边两端不应重合');
      // 该边的每个端点，反向查都应能找到这条边
      for (const p of [L.eA[e], L.eB[e]]) {
        let found = false;
        for (let j = 0; j < 4; j++) if (L.dotE[p * 4 + j] === e) found = true;
        assert.ok(found, `点 ${p} 的邻边里找不到边 ${e}`);
      }
      // 该边相邻的格子，正向查也应包含这条边
      for (const cell of [L.eCell[e * 2], L.eCell[e * 2 + 1]]) {
        if (cell < 0) continue;
        let found = false;
        for (let j = 0; j < 4; j++) if (L.cellE[cell * 4 + j] === e) found = true;
        assert.ok(found, `格 ${cell} 的边里找不到边 ${e}`);
      }
    }
    // 每个格恰好 4 条边，且互不相同
    for (let i = 0; i < n * n; i++) {
      const s = new Set();
      for (let j = 0; j < 4; j++) s.add(L.cellE[i * 4 + j]);
      assert.equal(s.size, 4);
    }
  }
});

/* ============================================================
 * 3. 区域判定与边界
 * ============================================================ */
ok('isSimpleRegion：拒绝洞、拒绝对角接触', () => {
  // 3×3 的“回”字：中间空一格 → 有洞
  const ring = new Uint8Array(9);
  ring[0] = ring[1] = ring[2] = ring[3] = ring[5] = ring[6] = ring[7] = ring[8] = 1;
  assert.equal(isSimpleRegion(ring, 3), false, '8 字形应被判为有洞');

  // 2×2 里只有两个对角格 → 边界自接触
  const bow = new Uint8Array(4);
  bow[0] = 1; bow[3] = 1;
  assert.equal(isSimpleRegion(bow, 2), false, '对角接触应被拒绝');

  // 正常的 L 形
  const ell = new Uint8Array(9);
  ell[0] = 1; ell[3] = 1; ell[6] = 1; ell[7] = 1;
  assert.equal(isSimpleRegion(ell, 3), true);

  // 单个格子
  const one = new Uint8Array(9);
  one[4] = 1;
  assert.equal(isSimpleRegion(one, 3), true);
});

ok('regionToLoop：简单区域的边界恰好是一条回路', () => {
  const rng = mulberry32('boundary');
  let n_checked = 0;
  for (let t = 0; t < 200; t++) {
    const n = 3 + (t % 3);
    const L = buildLayout(n);
    const { inP, count } = randomRegion(n, rng, 1 + Math.floor(rng() * n * n));
    if (count < 1 || !isSimpleRegion(inP, n)) continue;
    const st = regionToLoop(L, inP);
    assert.ok(isLoop(L, st), `简单区域的边界必须是一条回路 (n=${n}, count=${count})`);
    n_checked++;
  }
  assert.ok(n_checked > 60, `抽样量偏少: ${n_checked}`);
});

ok('deformLoop：局部翻拐保持回路单一性', () => {
  const rng = mulberry32('deform');
  let n_checked = 0;
  for (let t = 0; t < 120; t++) {
    const n = 4 + (t % 3);
    const L = buildLayout(n);
    let found = null;
    for (let a = 0; a < 100 && !found; a++) {
      const target = Math.max(4, Math.round(n * n * (0.2 + rng() * 0.35)));
      const { inP, count } = randomRegion(n, rng, target);
      if (count >= 4 && isSimpleRegion(inP, n)) {
        const st = regionToLoop(L, inP);
        if (isLoop(L, st)) found = st;
      }
    }
    if (!found) continue;
    for (let k = 1; k <= 5; k++) {
      deformLoop(L, found, rng, 8);
      assert.ok(isLoop(L, found), `第 ${k} 轮翻拐后回路被破坏 (n=${n})`);
    }
    n_checked++;
  }
  assert.ok(n_checked > 40, `抽样量偏少: ${n_checked}`);
});

/* ============================================================
 * 4. 求解器 vs 暴力枚举（核心）
 * ============================================================ */
ok('countSolutions 的计数与暴力枚举完全一致', () => {
  const rng = mulberry32('cross-count');
  let cases = 0, withSol = 0, multi = 0;
  for (let t = 0; t < 320; t++) {
    const n = 2 + (t % 2);                  // 2 或 3，保证暴力枚举可行
    const c = makeSmallCase(n, rng, 0.25 + rng() * 0.55);
    if (!c) continue;
    cases++;

    const sols = bruteSolutions(c.L, c.clue);
    // limit 要比真实解数大，否则数到上限就停，比的是「上限」而不是「解数」
    const real = countSolutions(c.L, c.clue, emptyState(c.L), sols.length + 1);

    assert.equal(real.count, sols.length,
      `解数不一致 n=${n} clue=${JSON.stringify(Array.from(c.clue))} 引擎=${real.count} 暴力=${sols.length}`);
    if (sols.length > 0) withSol++;
    if (sols.length > 1) multi++;
  }
  assert.ok(cases > 250, `样本不足: ${cases}`);
  assert.ok(withSol > 100, `有解样本不足: ${withSol}`);
  assert.ok(multi > 5, `多解样本不足: ${multi}（这个用例的意义就在于覆盖多解）`);
  console.log(`      样本 ${cases} 例（有解 ${withSol}、多解 ${multi}）`);
});

ok('propagate 的每个推导都经得起全部解的检验', () => {
  const rng = mulberry32('cross-propagate');
  let cases = 0, deduced = 0, contradicted = 0;
  for (let t = 0; t < 500; t++) {
    const n = 2 + (t % 2);
    const c = makeSmallCase(n, rng, 0.35 + rng() * 0.5);
    if (!c) continue;
    cases++;

    const sols = bruteSolutions(c.L, c.clue);
    const st = emptyState(c.L);
    const consistent = propagate(c.L, c.clue, st);

    if (!consistent) {
      contradicted++;
      assert.equal(sols.length, 0,
        `报矛盾却存在解 n=${n} clue=${JSON.stringify(Array.from(c.clue))}`);
      continue;
    }

    for (let e = 0; e < c.L.E; e++) {
      if (st[e] === UNKNOWN) continue;
      deduced++;
      for (const s of sols) {
        assert.equal(s[e], st[e],
          `推导不可靠 n=${n} 边${e} 推出 ${st[e]}，但某解中为 ${s[e]}`);
      }
    }
    if (isLoop(c.L, st)) {
      assert.equal(sols.length, 1, '传播宣称已围成回路时，解必须唯一');
    }
  }
  assert.ok(cases > 400, `样本不足: ${cases}`);
  assert.ok(deduced > 1500, `推导量不足: ${deduced}`);
  console.log(`      样本 ${cases} 例、推导 ${deduced} 个、报矛盾 ${contradicted} 例，全部与暴力枚举一致`);
});

ok('isSolved / conflictedCells 与暴力枚举对同一判据', () => {
  const rng = mulberry32('cross-solved');
  let checked = 0;
  for (let t = 0; t < 240; t++) {
    const n = 3;
    const c = makeSmallCase(n, rng, rng() * 0.7);
    if (!c) continue;
    checked++;
    const sols = bruteSolutions(c.L, c.clue);

    // 引擎的解必须是真解
    assert.ok(isSolved(c.L, c.clue, c.sol), '生成的解应被判为完成');
    // 解出来的那份也必须是真解
    const found = solve(c.L, c.clue);
    if (sols.length > 0) {
      assert.ok(found, '暴力枚举有解，引擎却没解出来');
      assert.ok(isSolved(c.L, c.clue, found), '引擎给出的解不合法');
    } else {
      assert.equal(found, null, '暴力枚举无解，引擎却给出了解');
    }

    // 冲突格：对真解不应报任何冲突
    assert.equal(conflictedCells(c.L, c.clue, c.sol).length, 0, '真解不应有冲突格');
  }
  assert.ok(checked > 200);
});

/* ============================================================
 * 5. 出题器
 * ============================================================ */
ok('generate：每一道题都有唯一解、线索与解自洽', () => {
  const rng = mulberry32('gen');
  const sizes = [5, 6, 8];
  let made = 0;
  const stats = [];
  for (let t = 0; t < 12; t++) {
    const size = sizes[t % sizes.length];
    const p = generate(size, rng, { keepRatio: 0.42 });
    assert.ok(p, `第 ${t} 题生成失败 (size=${size})`);
    made++;

    assert.equal(p.clue.length, size * size);

    const L = buildLayout(size);
    assert.ok(isLoop(L, p.solution), '生成的解必须是一条单一闭合回路');
    assert.ok(cluesSatisfied(L, p.clue, p.solution), '解必须满足全部线索');
    assert.equal(conflictedCells(L, p.clue, p.solution).length, 0);

    const r = countSolutions(L, p.clue, emptyState(L), 2);
    assert.equal(r.count, 1, `第 ${t} 题不是唯一解 (size=${size})`);

    let kept = 0;
    for (let i = 0; i < p.clue.length; i++) if (p.clue[i] >= 0) kept++;
    assert.equal(kept, p.clueCount);
    stats.push(`${size}×${size} 线索${kept}/${size * size}`);
  }
  assert.ok(made === 12);
  console.log(`      ${stats.join(' | ')}`);
});

ok('generate：同种子可复现、异种子不同题', () => {
  const a = generate(5, mulberry32('same'), { keepRatio: 0.45 });
  const b = generate(5, mulberry32('same'), { keepRatio: 0.45 });
  const c = generate(5, mulberry32('other'), { keepRatio: 0.45 });
  assert.deepEqual(Array.from(a.clue), Array.from(b.clue));
  assert.deepEqual(Array.from(a.solution), Array.from(b.solution));
  assert.notDeepEqual(Array.from(a.clue), Array.from(c.clue));
});

ok('难度档位配置合理（尺寸递增、线索比例递减）', () => {
  assert.ok(DIFFICULTY.easy.size < DIFFICULTY.normal.size);
  assert.ok(DIFFICULTY.normal.size < DIFFICULTY.hard.size);
  assert.ok(DIFFICULTY.easy.keepRatio > DIFFICULTY.normal.keepRatio);
  assert.ok(DIFFICULTY.normal.keepRatio > DIFFICULTY.hard.keepRatio);
});

/* ============================================================
 * 6. 边界情形
 * ============================================================ */
ok('空线索盘面：约束形同不存在，允许歧义但不许报错', () => {
  const L = buildLayout(3);
  const clue = new Int8Array(9).fill(NO_CLUE);
  const r = countSolutions(L, clue, emptyState(L), 3);
  assert.ok(r.count >= 2, '完全没有线索时显然不止一个解');
});

ok('矛盾盘面能被识别：相邻两格对同一条边提出相反要求', () => {
  const L = buildLayout(3);
  const clue = new Int8Array(9).fill(NO_CLUE);
  clue[0] = 4;                              // 左上格四边全在回路上
  clue[1] = 0;                              // 右上格四边全不在 —— 两格共享 V(0,1)
  // 注意：单独一个「3 与 0 相邻」并不矛盾——0 排除掉共享边之后，
  // 3 仍可从另外三条边全取。只有 4 与 0 相邻才是死结。
  const r = countSolutions(L, clue, emptyState(L), 2);
  assert.equal(r.count, 0);
  assert.equal(solve(L, clue), null);

  const st = emptyState(L);
  assert.equal(propagate(L, clue, st), false, '传播应当直接报矛盾');
});

ok('矛盾盘面能被识别：回路不能留下线头（度数为 1）', () => {
  const L = buildLayout(2);
  const clue = new Int8Array(4).fill(NO_CLUE);
  clue[0] = 1;                              // 左上格：恰好一条边在回路上
  clue[1] = 0;                              // 右上格：全排除，含 V(0,1)
  clue[2] = 0;                              // 左下格：全排除，含 H(1,0)
  // 于是左上格只能在 H(0,0) 与 V(0,0) 里挑一条，而这两条都连着角点 (0,0)，
  // 无论挑哪条该点度数都是 1 —— 回路不能有线头。
  const r = countSolutions(L, clue, emptyState(L), 2);
  assert.equal(r.count, 0);
  assert.equal(solve(L, clue), null);
});

ok('countSolutions 的 limit 会真的提前停下', () => {
  const L = buildLayout(3);
  const clue = new Int8Array(9).fill(NO_CLUE);   // 空线索盘解极多
  const one = countSolutions(L, clue, emptyState(L), 1);
  const two = countSolutions(L, clue, emptyState(L), 2);
  assert.equal(one.count, 1);
  assert.equal(two.count, 2);
});

ok('isSolved 拒绝这些似是而非的局面', () => {
  const L = buildLayout(2);
  const clue = cluesFromLoop(L, (() => {
    const inP = new Uint8Array(4).fill(1);
    return regionToLoop(L, inP);
  })());

  // 只有一条线头 → 不是回路
  const dangling = emptyState(L);
  dangling[L.H(0, 0)] = ON;
  assert.equal(isSolved(L, clue, dangling), false);

  // 回路对了但线索不符
  const good = regionToLoop(L, new Uint8Array(4).fill(1));
  assert.equal(isSolved(L, clue, good), true);
  const wrongClue = Int8Array.from(clue);
  wrongClue[0] = (wrongClue[0] + 1) % 5;
  assert.equal(isSolved(L, wrongClue, good), false);

  // 两个环 → 不是单一回路
  const twoRings = regionToLoop(L, new Uint8Array(4).fill(1));
  const L4 = buildLayout(4);
  const inLeft = new Uint8Array(16); inLeft[0] = 1;
  const inBelow = new Uint8Array(16); inBelow[5] = 1; inBelow[6] = 1; inBelow[9] = 1; inBelow[10] = 1;
  const st = regionToLoop(L4, inLeft);
  const st2 = regionToLoop(L4, inBelow);
  for (let e = 0; e < L4.E; e++) if (st2[e] === ON) st[e] = ON;
  assert.equal(isSolved(L4, cluesFromLoop(L4, st), st), false, '两个独立回路不应被当作解');
});

console.log(`\n${passed} 组测试全部通过`);
console.log('ALL TESTS PASSED');
