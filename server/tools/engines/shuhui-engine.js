/* ==========================================================================
 * 数回 · Slitherlink 引擎
 * --------------------------------------------------------------------------
 * 规则：在点阵上沿格线连出一条单一闭合回路，不交叉、不分叉；
 *       格子中的数字表示它四条边里有几条属于回路。
 *
 * 坐标系（n×n 个格子、(n+1)×(n+1) 个点）
 *   水平边 H(r,c)：第 r 行点上、点 (r,c) 与 (r,c+1) 之间   r∈[0,n] c∈[0,n-1]
 *   垂直边 V(r,c)：第 c 列点上、点 (r,c) 与 (r+1,c) 之间   r∈[0,n-1] c∈[0,n]
 *   统一编号：H(r,c) → r*n + c
 *             V(r,c) → n*(n+1) + r*(n+1) + c
 *
 * 边状态：UNKNOWN(-1) 未定 / OFF(0) 确定不在回路上 / ON(1) 确定在回路上
 *
 * 本文件不依赖 DOM，Node 与浏览器通用。
 * ========================================================================== */

const UNKNOWN = -1;
const OFF = 0;
const ON = 1;
const NO_CLUE = -1;

/* ==================== 确定性随机 ==================== */

/**
 * FNV-1a 32 位散列。数字与字符串走同一条路径，`hashSeed(20260914)`
 * 与 `hashSeed('20260914')` 结果相同 —— 两种入参行为不一致是会埋雷的。
 *
 * 存在的理由：直接把日期字符串当种子会踩坑——`'d20260914' >>> 0` 先转数字得 NaN、
 * 再转 uint32 得 0，于是「每日挑战」每天都是同一道题。任何种子都要先过这里。
 */
function hashSeed(seed) {
  const s = typeof seed === 'string' ? seed : String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG：接受数字或字符串种子，返回 () => [0,1) 的确定性随机函数。 */
function mulberry32(seed) {
  let a = hashSeed(seed);
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================== 盘面布局（索引预计算） ==================== */

/**
 * 把 n×n 盘面的全部索引关系预先算好，避免求解时反复做除法取模。
 * 返回的对象在多次求解之间可复用（同尺寸）。
 */
function buildLayout(n) {
  const hCount = n * (n + 1);   // 水平边条数
  const E = 2 * n * (n + 1);    // 总边数
  const dots = (n + 1) * (n + 1);

  const H = (r, c) => r * n + c;
  const V = (r, c) => hCount + r * (n + 1) + c;

  // 每个格子的 4 条边：上/下/左/右
  const cellE = new Int32Array(n * n * 4);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = (r * n + c) * 4;
      cellE[i] = H(r, c);
      cellE[i + 1] = H(r + 1, c);
      cellE[i + 2] = V(r, c);
      cellE[i + 3] = V(r, c + 1);
    }
  }

  // 每个点相邻的边（最多 4 条，-1 表示越界）
  const dotE = new Int32Array(dots * 4).fill(-1);
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      const i = (r * (n + 1) + c) * 4;
      if (r > 0) dotE[i] = V(r - 1, c);
      if (r < n) dotE[i + 1] = V(r, c);
      if (c > 0) dotE[i + 2] = H(r, c - 1);
      if (c < n) dotE[i + 3] = H(r, c);
    }
  }

  // 每条边的两个端点（点编号）
  const eA = new Int32Array(E);
  const eB = new Int32Array(E);
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c < n; c++) {
      const e = H(r, c);
      eA[e] = r * (n + 1) + c;
      eB[e] = r * (n + 1) + c + 1;
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n; c++) {
      const e = V(r, c);
      eA[e] = r * (n + 1) + c;
      eB[e] = (r + 1) * (n + 1) + c;
    }
  }

  // 每条边相邻的格子（最多 2 个，-1 表示盘外）
  const eCell = new Int32Array(E * 2).fill(-1);
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c < n; c++) {
      const e = H(r, c);
      if (r > 0) eCell[e * 2] = (r - 1) * n + c;
      if (r < n) eCell[e * 2 + 1] = r * n + c;
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n; c++) {
      const e = V(r, c);
      if (c > 0) eCell[e * 2] = r * n + c - 1;
      if (c < n) eCell[e * 2 + 1] = r * n + c;
    }
  }

  return { n, hCount, E, dots, cellE, dotE, eA, eB, eCell, H, V };
}

/** 空盘：全部边未定。 */
function emptyState(L) {
  return new Int8Array(L.E).fill(UNKNOWN);
}

/* ==================== 约束传播 ==================== */

/**
 * 传播到不动点。就地修改 st，返回 false 表示出现矛盾。
 *
 * 三类规则：
 *   1. 线索：格 (r,c) 四条边中 ON 的条数必须等于线索值
 *   2. 度数：每个点相邻边中 ON 的条数只能是 0 或 2（回路不分叉、不留线头）
 *   3. 回路：ON 边已闭合成环时，不可能再有别的 ON 边；任何会让回路提前闭合
 *            （闭出的环不含全部 ON 边）的边都必须排除
 */
function propagate(L, clue, st) {
  const nc = L.n * L.n;
  const nd = L.dots;

  const mark = new Uint8Array(nc + nd);
  const q = [];
  let qh = 0;
  let bad = false;

  const push = (k) => {
    if (!mark[k]) { mark[k] = 1; q.push(k); }
  };

  const enqueueEdge = (e) => {
    const c0 = L.eCell[e * 2];
    const c1 = L.eCell[e * 2 + 1];
    if (c0 >= 0) push(c0);
    if (c1 >= 0) push(c1);
    push(nc + L.eA[e]);
    push(nc + L.eB[e]);
  };

  const setE = (e, v) => {
    if (st[e] === v) return true;
    if (st[e] !== UNKNOWN) { bad = true; return false; }
    st[e] = v;
    enqueueEdge(e);
    return true;
  };

  const runQueue = () => {
    while (qh < q.length && !bad) {
      const k = q[qh++];
      mark[k] = 0;                      // 允许之后重新入队
      if (k < nc) {
        const K = clue[k];
        if (K < 0) continue;
        const b = k * 4;
        const e0 = L.cellE[b], e1 = L.cellE[b + 1], e2 = L.cellE[b + 2], e3 = L.cellE[b + 3];
        const v0 = st[e0], v1 = st[e1], v2 = st[e2], v3 = st[e3];
        let on = 0, unk = 0;
        if (v0 === ON) on++; else if (v0 === UNKNOWN) unk++;
        if (v1 === ON) on++; else if (v1 === UNKNOWN) unk++;
        if (v2 === ON) on++; else if (v2 === UNKNOWN) unk++;
        if (v3 === ON) on++; else if (v3 === UNKNOWN) unk++;
        if (on > K || on + unk < K) { bad = true; return; }
        if (on + unk === K) {
          if (v0 === UNKNOWN) setE(e0, ON);
          if (v1 === UNKNOWN) setE(e1, ON);
          if (v2 === UNKNOWN) setE(e2, ON);
          if (v3 === UNKNOWN) setE(e3, ON);
        } else if (on === K) {
          if (v0 === UNKNOWN) setE(e0, OFF);
          if (v1 === UNKNOWN) setE(e1, OFF);
          if (v2 === UNKNOWN) setE(e2, OFF);
          if (v3 === UNKNOWN) setE(e3, OFF);
        }
      } else {
        const base = (k - nc) * 4;
        let on = 0, unk = 0, lastUnk = -1;
        for (let j = 0; j < 4; j++) {
          const e = L.dotE[base + j];
          if (e < 0) continue;
          const v = st[e];
          if (v === ON) on++;
          else if (v === UNKNOWN) { unk++; lastUnk = e; }
        }
        if (on > 2) { bad = true; return; }
        if (on === 2) {
          for (let j = 0; j < 4; j++) {
            const e = L.dotE[base + j];
            if (e >= 0 && st[e] === UNKNOWN) setE(e, OFF);
          }
        } else if (on === 1) {
          if (unk === 0) { bad = true; return; }   // 度数为 1：回路不能有线头
          if (unk === 1) setE(lastUnk, ON);
        } else if (unk === 1) {
          setE(lastUnk, OFF);                       // 只有一条可选却选它 → 度数 1，非法
        }
      }
    }
  };

  for (let i = 0; i < nc; i++) push(i);
  for (let i = 0; i < nd; i++) push(nc + i);
  runQueue();
  if (bad) return false;

  // 环路规则会把边直接改掉，需要补一次增量传播
  for (let round = 0; round < 32; round++) {
    const dirty = applyLoopRule(L, st);
    if (dirty === false) return false;
    if (!dirty.length) break;
    for (let i = 0; i < dirty.length; i++) enqueueEdge(dirty[i]);
    runQueue();
    if (bad) return false;
  }
  return true;
}

/**
 * 回路唯一性规则。返回：
 *   false        —— 矛盾
 *   []           —— 无改动
 *   [e, e, ...]  —— 这些边被确定为 OFF
 *
 * 判据：ON 边在度数约束下只能构成路径或环。
 *   · 已经出现两个环，或一个环之外还有别的 ON 边 → 矛盾（回路只能有一条）
 *   · 环已经闭合且它就是全部 ON 边 → 回路完成，其余边全部排除
 *   · 某条未定边两端已连通：闭出的环若不含全部 ON 边 → 该边排除；
 *     若恰好含全部 ON 边 → 它正是完整回路，不能排除，留给分支去试
 */
function applyLoopRule(L, st) {
  const { n, E, eA, eB, dots } = L;
  const par = new Int32Array(dots);
  for (let i = 0; i < dots; i++) par[i] = i;
  const find = (x) => {
    while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; }
    return x;
  };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };

  let onCount = 0;
  for (let e = 0; e < E; e++) {
    if (st[e] === ON) { onCount++; union(eA[e], eB[e]); }
  }
  if (onCount === 0) return [];

  const dotCnt = new Int32Array(dots);
  const edgeCnt = new Int32Array(dots);
  for (let i = 0; i < dots; i++) {
    const b = i * 4;
    for (let j = 0; j < 4; j++) {
      const e = L.dotE[b + j];
      if (e >= 0 && st[e] === ON) { dotCnt[find(i)]++; break; }
    }
  }
  for (let e = 0; e < E; e++) {
    if (st[e] === ON) edgeCnt[find(eA[e])]++;
  }

  // 连通分量里 边数 == 点数 ⇔ 恰好含一个环
  let loopRoot = -1, loopEdges = 0;
  for (let i = 0; i < dots; i++) {
    if (par[i] !== i) continue;
    if (edgeCnt[i] > 0 && edgeCnt[i] === dotCnt[i]) {
      if (loopRoot >= 0) return false;          // 两个环
      loopRoot = i;
      loopEdges = edgeCnt[i];
    }
  }
  if (loopRoot >= 0 && loopEdges < onCount) return false;   // 有环 + 还有别的 ON 边

  const dirty = [];
  if (loopRoot >= 0) {
    // 回路已闭合：它必然是最终回路，其余边全排除
    for (let e = 0; e < E; e++) {
      if (st[e] === UNKNOWN) { st[e] = OFF; dirty.push(e); }
    }
    return dirty;
  }

  for (let e = 0; e < E; e++) {
    if (st[e] !== UNKNOWN) continue;
    const ra = find(eA[e]);
    if (ra !== find(eB[e])) continue;
    // 两端已经连通 ⇒ 选它就会闭合出一个环。这时要分两种情况：
    //   · 该分量已经含有全部 ON 边 ⇒ 闭合出来的正是完整回路，是个候选解，交给分支去试
    //   · 否则闭出的环不含全部 ON 边 ⇒ 必然矛盾，直接排除
    // 少了前一条判断会漏解（一个环的最后一条边恰好连接首尾两端，正是这种情况）。
    if (edgeCnt[ra] === onCount) continue;
    st[e] = OFF;
    dirty.push(e);
  }
  return dirty;
}

/* ==================== 解判定 ==================== */

/** ON 边是否恰好构成一条闭合回路（点数 0 或 2、且连通）。 */
function isLoop(L, st) {
  const { E, dots } = L;
  const deg = new Uint8Array(dots);
  let onCount = 0, start = -1;
  for (let e = 0; e < E; e++) {
    if (st[e] !== ON) continue;
    onCount++;
    deg[L.eA[e]]++;
    deg[L.eB[e]]++;
    start = L.eA[e];
  }
  if (onCount < 4 || start < 0) return false;      // 最小回路是 1 个格子的 4 条边
  for (let i = 0; i < dots; i++) {
    if (deg[i] !== 0 && deg[i] !== 2) return false;
  }
  const seen = new Uint8Array(E);
  const vis = new Uint8Array(dots);
  const stack = [start];
  vis[start] = 1;
  let walked = 0;
  while (stack.length) {
    const u = stack.pop();
    const b = u * 4;
    for (let j = 0; j < 4; j++) {
      const e = L.dotE[b + j];
      if (e < 0 || st[e] !== ON || seen[e]) continue;
      seen[e] = 1;
      walked++;
      const w = L.eA[e] === u ? L.eB[e] : L.eA[e];
      if (!vis[w]) { vis[w] = 1; stack.push(w); }
    }
  }
  return walked === onCount;
}

/** 所有线索是否都被满足。 */
function cluesSatisfied(L, clue, st) {
  const nc = L.n * L.n;
  for (let i = 0; i < nc; i++) {
    const K = clue[i];
    if (K < 0) continue;
    const b = i * 4;
    let on = 0;
    if (st[L.cellE[b]] === ON) on++;
    if (st[L.cellE[b + 1]] === ON) on++;
    if (st[L.cellE[b + 2]] === ON) on++;
    if (st[L.cellE[b + 3]] === ON) on++;
    if (on !== K) return false;
  }
  return true;
}

/** 局面是否已经是一份完整解答。 */
function isSolved(L, clue, st) {
  return isLoop(L, st) && cluesSatisfied(L, clue, st);
}

/** 违反线索的格子编号列表（用于界面实时提示冲突）。 */
function conflictedCells(L, clue, st) {
  const nc = L.n * L.n;
  const out = [];
  for (let i = 0; i < nc; i++) {
    const K = clue[i];
    if (K < 0) continue;
    const b = i * 4;
    let on = 0, unk = 0;
    for (let j = 0; j < 4; j++) {
      const v = st[L.cellE[b + j]];
      if (v === ON) on++;
      else if (v === UNKNOWN) unk++;
    }
    // 已确定地违反，或已无空间可满足
    if (on > K || on + unk < K) out.push(i);
  }
  return out;
}

/* ==================== 求解 / 计数 ==================== */

/**
 * 选一条待定边做分支。
 * 优先挑「线索格中未定边最少」的，分支因子小、剪枝快。
 */
function pickBranch(L, clue, st) {
  const nc = L.n * L.n;
  let bestE = -1, bestUnk = 99;
  for (let i = 0; i < nc; i++) {
    if (clue[i] < 0) continue;
    const b = i * 4;
    let unk = 0, first = -1;
    for (let j = 0; j < 4; j++) {
      const e = L.cellE[b + j];
      if (st[e] === UNKNOWN) { unk++; if (first < 0) first = e; }
    }
    if (unk > 0 && unk < bestUnk) {
      bestUnk = unk;
      bestE = first;
      if (unk === 1) break;
    }
  }
  if (bestE >= 0) return bestE;
  for (let e = 0; e < L.E; e++) if (st[e] === UNKNOWN) return e;
  return -1;
}

/**
 * 数一数有几个解，最多数到 limit 个就停（limit=2 即「是否唯一」）。
 *
 * budget 是搜索节点预算：超过就放弃，返回 aborted=true。
 * 存在的理由：个别盘面会让搜索爆炸（实测 10×10 出题时最坏一次验证要 7 秒），
 * 出题器据此把「拿不准」当成「不能挖」，宁可题目留多一点线索，也不能卡住界面。
 *
 * 返回 { count, solution, aborted }。aborted 为真时 count 不可信。
 */
function countSolutions(L, clue, st0, limit, budget) {
  const st = Int8Array.from(st0);
  const maxNodes = budget == null ? 20000 : budget;
  let count = 0;
  let nodes = 0;
  let aborted = false;
  let solution = null;

  const dfs = () => {
    if (count >= limit || aborted) return;
    if (++nodes > maxNodes) { aborted = true; return; }
    if (!propagate(L, clue, st)) return;

    if (isLoop(L, st)) {
      // 回路已经围好：其余边只能全部不在回路上，解唯一确定
      if (!cluesSatisfied(L, clue, st)) return;
      count++;
      if (!solution) solution = Int8Array.from(st);
      return;
    }

    const e = pickBranch(L, clue, st);
    if (e < 0) return;                       // 没有可分支的边，却也不是回路

    const saved = Int8Array.from(st);
    st[e] = ON;
    dfs();
    st.set(saved);
    if (count >= limit || aborted) return;
    st[e] = OFF;
    dfs();
    st.set(saved);
  };

  dfs();
  return { count, solution, aborted };
}

/** 求一个解；无解或超出预算返回 null。 */
function solve(L, clue, st0, budget) {
  const r = countSolutions(L, clue, st0 || emptyState(L), 1, budget == null ? 60000 : budget);
  return r.count > 0 ? r.solution : null;
}

/* ==================== 随机区域 → 回路 ==================== */

/**
 * 随机长出一个 4-连通的多连块（随机生长，从随机起点向外扩张）。
 */
function randomRegion(n, rng, target) {
  const inP = new Uint8Array(n * n);
  const inF = new Uint8Array(n * n);
  const frontier = [];

  const r0 = Math.floor(rng() * n);
  const c0 = Math.floor(rng() * n);
  inP[r0 * n + c0] = 1;
  let count = 1;

  const addNb = (i) => {
    const r = (i / n) | 0, c = i % n;
    if (r > 0 && !inP[i - n] && !inF[i - n]) { inF[i - n] = 1; frontier.push(i - n); }
    if (r < n - 1 && !inP[i + n] && !inF[i + n]) { inF[i + n] = 1; frontier.push(i + n); }
    if (c > 0 && !inP[i - 1] && !inF[i - 1]) { inF[i - 1] = 1; frontier.push(i - 1); }
    if (c < n - 1 && !inP[i + 1] && !inF[i + 1]) { inF[i + 1] = 1; frontier.push(i + 1); }
  };
  addNb(r0 * n + c0);

  while (count < target && frontier.length) {
    const idx = Math.floor(rng() * frontier.length);
    const k = frontier[idx];
    frontier[idx] = frontier[frontier.length - 1];
    frontier.pop();
    if (inP[k]) continue;
    inP[k] = 1;
    count++;
    addNb(k);
  }
  return { inP, count };
}

/**
 * 多连块的边界是否为一条简单闭合回路？
 *   条件一：不存在 2×2 里恰好两个对角格都属内（会造成边界自接触）
 *   条件二：补集 4-连通（无洞）
 */
function isSimpleRegion(inP, n) {
  for (let r = 0; r + 1 < n; r++) {
    for (let c = 0; c + 1 < n; c++) {
      const a = inP[r * n + c];
      const b = inP[r * n + c + 1];
      const d = inP[(r + 1) * n + c];
      const e = inP[(r + 1) * n + c + 1];
      if (a + b + d + e === 2 && ((a && e) || (b && d))) return false;
    }
  }

  // 在 (n+2)×(n+2) 的虚拟网格上从外部漫延，看能否覆盖全部非内格
  const W = n + 2;
  const vis = new Uint8Array(W * W);
  const isP = (gr, gc) =>
    gr >= 0 && gc >= 0 && gr < n && gc < n ? inP[gr * n + gc] : 0;
  const stack = [0];
  vis[0] = 1;
  while (stack.length) {
    const k = stack.pop();
    const rr = (k / W) | 0, cc = k % W;
    const nb = [[rr - 1, cc], [rr + 1, cc], [rr, cc - 1], [rr, cc + 1]];
    for (let t = 0; t < 4; t++) {
      const nr = nb[t][0], ncc = nb[t][1];
      if (nr < 0 || ncc < 0 || nr >= W || ncc >= W) continue;
      const k2 = nr * W + ncc;
      if (vis[k2]) continue;
      if (isP(nr - 1, ncc - 1)) continue;
      vis[k2] = 1;
      stack.push(k2);
    }
  }
  for (let r = 0; r < W; r++) {
    for (let c = 0; c < W; c++) {
      if (!isP(r - 1, c - 1) && !vis[r * W + c]) return false;
    }
  }
  return true;
}

/** 多连块的边界 → 回路边状态。 */
function regionToLoop(L, inP) {
  const n = L.n;
  const st = new Int8Array(L.E).fill(OFF);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!inP[r * n + c]) continue;
      const up = r > 0 ? inP[(r - 1) * n + c] : 0;
      const down = r < n - 1 ? inP[(r + 1) * n + c] : 0;
      const left = c > 0 ? inP[r * n + c - 1] : 0;
      const right = c < n - 1 ? inP[r * n + c + 1] : 0;
      if (!up) st[L.H(r, c)] = ON;
      if (!down) st[L.H(r + 1, c)] = ON;
      if (!left) st[L.V(r, c)] = ON;
      if (!right) st[L.V(r, c + 1)] = ON;
    }
  }
  return st;
}

/**
 * 对回路做「局部翻拐」随机变形：2×2 的四个点里若有 3 条边在回路上，
 * 换成剩下那条。这一步保持回路单一性（只是把绕远的一小段拉直），
 * 但能让形状从多连块的方正感变得更自由。
 */
function deformLoop(L, st, rng, times) {
  const n = L.n;
  let moved = 0;
  for (let it = 0; it < times; it++) {
    const r = Math.floor(rng() * n);
    const c = Math.floor(rng() * n);
    const e = [L.H(r, c), L.H(r + 1, c), L.V(r, c), L.V(r, c + 1)];
    let on = 0, offIdx = -1;
    for (let i = 0; i < 4; i++) {
      if (st[e[i]] === ON) on++;
      else offIdx = i;
    }
    if (on === 3) {
      for (let i = 0; i < 4; i++) st[e[i]] = i === offIdx ? ON : OFF;
      moved++;
    }
  }
  return moved;
}

/** 由回路算出每个格子的线索。 */
function cluesFromLoop(L, st) {
  const nc = L.n * L.n;
  const clue = new Int8Array(nc).fill(NO_CLUE);
  for (let i = 0; i < nc; i++) {
    const b = i * 4;
    let k = 0;
    if (st[L.cellE[b]] === ON) k++;
    if (st[L.cellE[b + 1]] === ON) k++;
    if (st[L.cellE[b + 2]] === ON) k++;
    if (st[L.cellE[b + 3]] === ON) k++;
    clue[i] = k;
  }
  return clue;
}

/* ==================== 出题 ==================== */

/** 原地打乱。 */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/**
 * 挖空：把线索一条条拿掉，拿掉后仍唯一解才算数。
 * 每拿掉一批都要重新验证唯一性——这是唯一能保证「题有唯一解」的做法。
 *
 * 一次试一批（batch 条）而不是一条：一批通过就省下 batch-1 次验证；
 * 整批不过再放回逐条试，保证不会因为图快而少挖。
 */
function carve(L, clue, rng, keepRatio, opts) {
  const nc = L.n * L.n;
  const batch = (opts && opts.batch) || 4;
  const budget = (opts && opts.budget) || 4000;
  const order = [];
  for (let i = 0; i < nc; i++) order.push(i);
  shuffle(order, rng);

  const target = Math.max(1, Math.round(nc * keepRatio));
  const empty = emptyState(L);

  // 唯一解的判据：数到第 2 个就停；超出预算一律当「不唯一」处理（保守）
  const stillUnique = () => {
    const r = countSolutions(L, clue, empty, 2, budget);
    return !r.aborted && r.count === 1;
  };

  let kept = nc;
  let idx = 0;
  while (idx < order.length && kept > target) {
    const picks = [];
    while (picks.length < batch && idx < order.length) {
      const i = order[idx++];
      if (clue[i] >= 0) picks.push(i);
    }
    if (!picks.length) break;

    const saved = picks.map((i) => clue[i]);
    for (let k = 0; k < picks.length; k++) clue[picks[k]] = NO_CLUE;
    if (stillUnique()) {
      kept -= picks.length;
      continue;
    }

    // 整批不行：放回去，改成一条一条试，尽量多挖
    for (let k = 0; k < picks.length; k++) clue[picks[k]] = saved[k];
    for (let k = 0; k < picks.length; k++) {
      clue[picks[k]] = NO_CLUE;
      if (stillUnique()) kept--;
      else clue[picks[k]] = saved[k];
    }
  }
  return clue;
}

/**
 * 出题。
 *   size       盘面边长
 *   rng        随机源
 *   opts.minArea/maxArea  回路覆盖的格子数占比区间
 *   opts.keepRatio        目标线索保留比例（越小越难）
 * 返回 { size, clue, solution, clueCount, area }；失败返回 null。
 */
function generate(size, rng, opts) {
  opts = opts || {};
  const minArea = opts.minArea != null ? opts.minArea : 0.16;
  const maxArea = opts.maxArea != null ? opts.maxArea : 0.55;
  const keepRatio = opts.keepRatio != null ? opts.keepRatio : 0.4;

  const L = buildLayout(size);
  const nc = size * size;
  const empty = emptyState(L);

  for (let attempt = 0; attempt < 600; attempt++) {
    const ratio = minArea + rng() * (maxArea - minArea);
    const { inP, count } = randomRegion(size, rng, Math.max(4, Math.round(nc * ratio)));
    if (count < 4) continue;
    if (!isSimpleRegion(inP, size)) continue;

    const sol = regionToLoop(L, inP);
    if (!isLoop(L, sol)) continue;

    deformLoop(L, sol, rng, 12 + Math.floor(rng() * 24));
    if (!isLoop(L, sol)) continue;        // 变形理论上安全，仍复检一次

    // 完整线索也未必唯一解，先验一遍，不唯一就换个形状
    const full = cluesFromLoop(L, sol);
    const fullCheck = countSolutions(L, full, empty, 2, 40000);
    if (fullCheck.aborted || fullCheck.count !== 1) continue;
    const fullCopy = Int8Array.from(full);

    const clue = carve(L, fullCopy, rng, keepRatio, opts);

    // 线索太少会显得空，太多又没意思
    let clueCount = 0;
    for (let i = 0; i < nc; i++) if (clue[i] >= 0) clueCount++;
    if (clueCount < Math.max(3, Math.round(nc * 0.12))) continue;

    // 终检给足预算：这是「唯一解」的最终背书，不能省
    const finalCheck = countSolutions(L, clue, empty, 2, 400000);
    if (finalCheck.aborted || finalCheck.count !== 1) continue;

    return { size, clue, solution: sol, clueCount, area: count };
  }
  return null;
}

/* ==================== 便捷封装 ==================== */

/* minArea/maxArea 是回路占盘面的面积比例。太小会让大片格子没有线索、
   题目看上去空；这里让回路至少占到三分之一左右，线索分布才铺得开。 */
const DIFFICULTY = {
  easy: { size: 6, keepRatio: 0.52, minArea: 0.3, maxArea: 0.62 },
  normal: { size: 8, keepRatio: 0.4, minArea: 0.26, maxArea: 0.62 },
  hard: { size: 10, keepRatio: 0.3, minArea: 0.24, maxArea: 0.62 },
};

/** 按难度出题。diff 取 'easy' | 'normal' | 'hard'，也可传 {size, keepRatio,...}。 */
function makePuzzle(diff, rng) {
  const cfg = typeof diff === 'string' ? DIFFICULTY[diff] : diff;
  if (!cfg) throw new Error('未知难度: ' + diff);
  const r = rng || mulberry32(Date.now());
  return generate(cfg.size, r, cfg);
}

/* ==================== 导出 ==================== */

const API = {
  UNKNOWN, OFF, ON, NO_CLUE,
  DIFFICULTY,
  hashSeed,
  mulberry32,
  buildLayout,
  emptyState,
  propagate,
  applyLoopRule,
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
  carve,
  generate,
  makePuzzle,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.SH = API;
