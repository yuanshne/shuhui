/* ==========================================================================
 * 数回 · 界面逻辑
 * 依赖引擎暴露的 window.SH（构建时由 build.py 内联在前一个 <script> 里）
 * ========================================================================== */
(function () {
  'use strict';

  const SH = window.SH;
  const $ = (sel) => document.querySelector(sel);
  const NS = 'http://www.w3.org/2000/svg';
  const CS = 40;        // 一格的边长（SVG 用户单位）
  const PAD = 26;       // 四周留白，让贴边的回路也看得清
  const SAVE_KEY = 'shuhui.v1';

  const el = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* ---------------- 状态 ---------------- */
  const S = {
    L: null,
    clue: null,
    sol: null,
    edges: null,
    size: 8,
    level: 'normal',
    daily: false,
    dailyKey: '',
    key: '',
    elapsed: 0,
    t0: 0,
    running: false,
    miss: 0,
    hints: 0,
    done: false,
    demoToken: 0,
    demoBusy: false,
    markMode: false,
    locked: false,
  };

  let edgeVisEls = [];
  let edgeMarkEls = [];
  let cellEls = [];
  let timerId = null;
  let painting = false;
  let paintMode = 'on';       // on | off | clear

  /* ---------------- 小工具 ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /* 音效：Web Audio 合成，不需要任何素材文件 */
  let actx = null;
  function sfx(kind) {
    try {
      if (!S.sound) return;
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      const cfg = {
        ok: [520, 0.05, 'sine'],
        off: [300, 0.05, 'triangle'],
        bad: [150, 0.16, 'sawtooth'],
        win: [740, 0.42, 'sine'],
        hint: [880, 0.1, 'sine'],
      }[kind] || [440, 0.05, 'sine'];
      o.type = cfg[2];
      o.frequency.value = cfg[0];
      g.gain.value = 0.045;
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + cfg[1]);
      o.connect(g).connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + cfg[1]);
    } catch (e) { /* 音频不可用时静默降级 */ }
  }

  /* ---------------- 棋盘几何 ---------------- */
  /** 边索引 → 两端点坐标 */
  function edgeGeom(e) {
    const n = S.size;
    if (e < S.L.hCount) {
      const r = Math.floor(e / n), c = e % n;
      return [c * CS, r * CS, (c + 1) * CS, r * CS];
    }
    const i = e - S.L.hCount;
    const r = Math.floor(i / (n + 1)), c = i % (n + 1);
    return [c * CS, r * CS, c * CS, (r + 1) * CS];
  }

  function buildBoard() {
    const svg = $('#board');
    svg.innerHTML = '';
    const n = S.size;
    const W = n * CS;
    svg.setAttribute('viewBox', `${-PAD} ${-PAD} ${W + PAD * 2} ${W + PAD * 2}`);

    const gCell = el('g'), gHit = el('g'), gVis = el('g'), gMark = el('g'), gDot = el('g'), gNum = el('g');

    // 格子：只作为冲突高亮的底色
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const box = el('rect', {
          class: 'cellbox', x: c * CS, y: r * CS, width: CS, height: CS,
        });
        gCell.appendChild(box);
      }
    }

    edgeVisEls = new Array(S.L.E);
    edgeMarkEls = new Array(S.L.E);
    for (let e = 0; e < S.L.E; e++) {
      const [x1, y1, x2, y2] = edgeGeom(e);
      // 命中区：一条很粗但不可见的线，让手指/鼠标容易点中
      gHit.appendChild(el('line', {
        class: 'hit', x1, y1, x2, y2,
        'stroke-width': CS * 0.5, 'data-e': e,
      }));
      const vis = el('line', { class: 'vis', x1, y1, x2, y2, 'stroke-width': CS * 0.17, 'data-e': e });
      edgeVisEls[e] = vis;
      gVis.appendChild(vis);

      // 排除标记：边中点的小叉
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = CS * 0.12;
      const mk = el('path', {
        class: 'mark hide',
        d: `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`,
      });
      edgeMarkEls[e] = mk;
      gMark.appendChild(mk);
    }

    for (let r = 0; r <= n; r++) {
      for (let c = 0; c <= n; c++) {
        gDot.appendChild(el('circle', { class: 'dot', cx: c * CS, cy: r * CS, r: CS * 0.055 }));
      }
    }

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        if (S.clue[i] < 0) continue;
        const t = el('text', {
          class: 'num' + (S.clue[i] === 0 ? ' k0' : ''),
          x: (c + 0.5) * CS, y: (r + 0.5) * CS, 'font-size': CS * 0.46,
        });
        t.textContent = String(S.clue[i]);
        gNum.appendChild(t);
      }
    }

    svg.appendChild(gCell);
    svg.appendChild(gHit);
    svg.appendChild(gVis);
    svg.appendChild(gMark);
    svg.appendChild(gDot);
    svg.appendChild(gNum);
    cellEls = Array.from(gCell.children);
  }

  function paintEdge(e) {
    const v = S.edges[e];
    const vis = edgeVisEls[e], mk = edgeMarkEls[e];
    if (!vis) return;
    vis.classList.toggle('on', v === SH.ON);
    vis.classList.toggle('offline', v === SH.OFF);
    mk.classList.toggle('hide', v !== SH.OFF);
  }

  function paintAll() {
    for (let e = 0; e < S.L.E; e++) paintEdge(e);
    refreshConflicts();
  }

  /** 线索格被确定性地违反时，给它上一层淡红底 */
  function refreshConflicts() {
    const bad = new Set(SH.conflictedCells(S.L, S.clue, S.edges));
    for (let i = 0; i < cellEls.length; i++) {
      cellEls[i].classList.toggle('bad', bad.has(i));
    }
    return bad.size;
  }

  function flashWrong(e) {
    const vis = edgeVisEls[e];
    if (!vis) return;
    vis.classList.remove('wrong');
    void vis.getBoundingClientRect();
    vis.classList.add('wrong');
    setTimeout(() => vis.classList.remove('wrong'), 480);
  }

  function flashCell(i) {
    const c = cellEls[i];
    if (!c) return;
    c.classList.remove('pulse');
    void c.getBoundingClientRect();
    c.classList.add('pulse');
    setTimeout(() => c.classList.remove('pulse'), 520);
  }

  /* ---------------- 计分 / 统计 ---------------- */
  function calcScore() {
    const base = S.size * S.size * 32;
    return Math.max(0, base - Math.floor(S.elapsed) * 2 - S.miss * 80 - S.hints * 60);
  }

  function hudRefresh() {
    $('#hudTime').textContent = fmtTime(S.elapsed);
    $('#hudClues').textContent = S.clue ? S.clue.filter((v) => v >= 0).length : '—';
    $('#hudMiss').textContent = S.miss;
    $('#hudScore').textContent = calcScore();

    let on = 0, unk = 0;
    for (let e = 0; e < S.L.E; e++) {
      if (S.edges[e] === SH.ON) on++;
      else if (S.edges[e] === SH.UNKNOWN) unk++;
    }
    $('#stEdges').textContent = on;
    $('#stUnknown').textContent = unk;

    const msgEl = $('#stMsg');
    if (S.done) { msgEl.textContent = '已完成'; msgEl.className = ''; }
    else if (refreshConflicts() > 0) { msgEl.textContent = '有线索被违反'; msgEl.className = 'bad'; }
    else {
      const unsat = countUnsatisfied();
      msgEl.textContent = unsat > 0 ? `还有 ${unsat} 个线索格未满足` : '线索已全部满足';
      msgEl.className = 'warn';
    }
  }

  function countUnsatisfied() {
    let c = 0;
    const nc = S.size * S.size;
    for (let i = 0; i < nc; i++) {
      const K = S.clue[i];
      if (K < 0) continue;
      const b = i * 4;
      let on = 0;
      for (let j = 0; j < 4; j++) if (S.edges[S.L.cellE[b + j]] === SH.ON) on++;
      if (on !== K) c++;
    }
    return c;
  }

  /* ---------------- 计时 ---------------- */
  function startTimer() {
    if (S.running || S.done) return;
    S.running = true;
    S.t0 = Date.now() - S.elapsed * 1000;
    clearInterval(timerId);
    timerId = setInterval(() => {
      S.elapsed = (Date.now() - S.t0) / 1000;
      $('#hudTime').textContent = fmtTime(S.elapsed);
      $('#hudScore').textContent = calcScore();
    }, 500);
  }

  function stopTimer() {
    S.running = false;
    clearInterval(timerId);
  }

  /* ---------------- 操作 ---------------- */
  function afterChange() {
    refreshConflicts();
    hudRefresh();
    save();
    if (SH.isSolved(S.L, S.clue, S.edges)) win();
  }

  function userSet(e, v) {
    if (S.done || S.locked) return;
    if (v !== SH.UNKNOWN && v !== S.sol[e]) {
      S.miss++;
      flashWrong(e);
      sfx('bad');
      hudRefresh();
      toast(v === SH.ON ? '这条边不在回路上' : '这条边其实在回路上');
      save();
      return;
    }
    if (S.edges[e] === v) return;
    S.edges[e] = v;
    paintEdge(e);
    if (v === SH.UNKNOWN) sfx('off'); else sfx('ok');
    startTimer();
    afterChange();
  }

  function edgeFromPoint(ev) {
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!t || t.dataset === undefined || t.dataset.e === undefined) return -1;
    return Number(t.dataset.e);
  }

  function onDown(ev) {
    if (S.done || S.locked) return;
    const e = edgeFromPoint(ev);
    if (e < 0) return;
    ev.preventDefault();
    stopDemo();
    const right = ev.button === 2;
    const wantMark = right || S.markMode;
    if (wantMark) paintMode = S.edges[e] === SH.OFF ? 'clear' : 'off';
    else paintMode = S.edges[e] === SH.ON ? 'clear' : 'on';
    painting = true;
    applyPaint(e);
    try { $('#board').setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
  }

  function onMove(ev) {
    if (!painting) return;
    ev.preventDefault();
    const e = edgeFromPoint(ev);
    if (e >= 0) applyPaint(e);
  }

  function onUp() { painting = false; }

  function applyPaint(e) {
    if (paintMode === 'on' && S.edges[e] === SH.UNKNOWN) userSet(e, SH.ON);
    else if (paintMode === 'off' && S.edges[e] === SH.UNKNOWN) userSet(e, SH.OFF);
    else if (paintMode === 'clear' && S.edges[e] !== SH.UNKNOWN) userSet(e, SH.UNKNOWN);
  }

  /* ---------------- 提示 / 演示 / 检查 ---------------- */
  function hint() {
    if (S.done || S.locked) return;
    stopDemo();
    const st = Int8Array.from(S.edges);
    const consistent = SH.propagate(S.L, S.clue, st);
    const cands = [];
    if (consistent) {
      for (let e = 0; e < S.L.E; e++) {
        if (st[e] !== SH.UNKNOWN && S.edges[e] === SH.UNKNOWN) cands.push([e, st[e]]);
      }
    }
    let reasoned = true;
    if (!cands.length) {
      // 传播推不动：这一步只能靠试探，直接取答案里的一条
      reasoned = false;
      for (let e = 0; e < S.L.E; e++) {
        if (S.edges[e] === SH.UNKNOWN) { cands.push([e, S.sol[e]]); break; }
      }
    }
    if (!cands.length) { toast('所有边都已确定'); return; }

    const [e, v] = cands[0];
    S.hints++;
    S.edges[e] = v;
    paintEdge(e);
    startTimer();
    sfx('hint');
    toast(reasoned ? '这一步可以直接推出来' : '推不出来了，这条只能试');
    afterChange();
  }

  function stopDemo() {
    S.demoToken++;
    S.demoBusy = false;
    $('#btnDemo').classList.remove('on');
  }

  async function demo() {
    if (S.done || S.locked || S.demoBusy) { stopDemo(); return; }
    S.demoBusy = true;
    const token = ++S.demoToken;
    $('#btnDemo').classList.add('on');
    toast('演示推理中…');
    startTimer();

    for (let step = 0; step < 400; step++) {
      if (token !== S.demoToken) return;
      const st = Int8Array.from(S.edges);
      const consistent = SH.propagate(S.L, S.clue, st);
      const newly = [];
      if (consistent) {
        for (let e = 0; e < S.L.E; e++) {
          if (st[e] !== SH.UNKNOWN && S.edges[e] === SH.UNKNOWN) newly.push([e, st[e]]);
        }
      }
      if (!newly.length) {
        // 传播到头，补一条答案里的边继续
        for (let e = 0; e < S.L.E; e++) {
          if (S.edges[e] === SH.UNKNOWN) { newly.push([e, S.sol[e]]); break; }
        }
      }
      if (!newly.length) break;

      const take = newly.slice(0, 8);
      for (let k = 0; k < take.length; k++) {
        S.edges[take[k][0]] = take[k][1];
        paintEdge(take[k][0]);
      }
      refreshConflicts();
      hudRefresh();
      await sleep(200);
      if (token !== S.demoToken) return;
      if (SH.isSolved(S.L, S.clue, S.edges)) break;
    }

    if (token === S.demoToken) {
      S.demoBusy = false;
      $('#btnDemo').classList.remove('on');
      save();
      if (SH.isSolved(S.L, S.clue, S.edges)) win();
    }
  }

  function check() {
    if (S.done) { toast('已经完成了'); return; }
    const bad = refreshConflicts();
    const unsat = countUnsatisfied();
    const st = Int8Array.from(S.edges);
    const consistent = SH.propagate(S.L, S.clue, st);
    let deducible = 0;
    if (consistent) {
      for (let e = 0; e < S.L.E; e++) {
        if (st[e] !== SH.UNKNOWN && S.edges[e] === SH.UNKNOWN) deducible++;
      }
    }
    if (bad > 0) toast(`${bad} 个线索格已被违反，需要退回去改`);
    else if (unsat === 0) toast('线索都对上了，只差把回路围起来');
    else toast(`还有 ${unsat} 个线索格没满足，其中 ${deducible} 条边可以直接推出来`);
  }

  function reset() {
    if (S.locked) return;
    stopDemo();
    S.edges = SH.emptyState(S.L);
    S.miss = 0; S.hints = 0; S.elapsed = 0; S.done = false; S.running = false;
    stopTimer();
    paintAll();
    hudRefresh();
    save();
    toast('已清空重来');
  }

  /* ---------------- 胜负 ---------------- */
  function win() {
    if (S.done) return;
    S.done = true;
    stopTimer();
    stopDemo();
    sfx('win');

    const isNew = S.key ? (SAVE.best[S.key] == null || S.elapsed < SAVE.best[S.key]) : false;
    if (S.key && isNew) SAVE.best[S.key] = S.elapsed;

    if (S.dailyKey) {
      const rec = SAVE.daily[S.dailyKey] || { done: false, count: 0, best: null };
      rec.done = true;
      rec.count = (rec.count || 0) + 1;
      rec.best = rec.best == null ? S.elapsed : Math.min(rec.best, S.elapsed);
      SAVE.daily[S.dailyKey] = rec;
    }
    writeSave();

    $('#winTitle').textContent = S.daily ? '今日挑战完成' : '回路闭合';
    $('#winSub').textContent = isNew ? '新纪录！全部线索满足，回路单一闭合' : '全部线索满足，回路单一闭合';
    $('#winTime').textContent = fmtTime(S.elapsed);
    $('#winMiss').textContent = S.miss;
    $('#winHints').textContent = S.hints;
    $('#winScore').textContent = calcScore();
    $('#winSize').textContent = S.size + '×' + S.size;
    const best = S.key ? SAVE.best[S.key] : null;
    $('#winBest').textContent = best == null ? '—' : fmtTime(best);
    $('#modalWin').classList.add('show');
    hudRefresh();
    save();
  }

  /* ---------------- 存档 ---------------- */
  let SAVE = { best: {}, daily: {}, cur: null };
  let SAVE_load_error = false;

  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        SAVE.best = d.best || {};
        SAVE.daily = d.daily || {};
        SAVE.cur = d.cur || null;
      }
    } catch (e) { SAVE_load_error = true; }
  }

  function writeSave() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(SAVE)); } catch (e) { /* 隐私模式下忽略 */ }
  }

  function save() {
    if (!S.L) return;
    SAVE.cur = {
      size: S.size,
      clue: Array.from(S.clue),
      sol: Array.from(S.sol),
      edges: Array.from(S.edges),
      elapsed: Math.floor(S.elapsed),
      miss: S.miss,
      hints: S.hints,
      done: S.done,
      level: S.level,
      daily: S.daily,
      dailyKey: S.dailyKey,
      key: S.key,
    };
    writeSave();
  }

  /* ---------------- 开局 ---------------- */
  function startPuzzle(p, opt) {
    opt = opt || {};
    S.size = p.size;
    S.L = SH.buildLayout(p.size);
    S.clue = p.clue;
    S.sol = p.solution;
    S.edges = SH.emptyState(S.L);
    S.level = opt.level || S.level;
    S.daily = !!opt.daily;
    S.dailyKey = opt.dailyKey || '';
    S.key = opt.key || '';
    S.elapsed = 0; S.miss = 0; S.hints = 0;
    S.done = false; S.running = false; S.demoBusy = false; S.demoToken++;
    stopTimer();
    buildBoard();
    paintAll();
    hudRefresh();
    $('#modalWin').classList.remove('show');
    $('#stMode').textContent = S.daily ? '每日挑战 · ' + fmtDaily(S.dailyKey) : ({ easy: '初级', normal: '中级', hard: '高级' }[S.level] || '经典');
    document.querySelectorAll('#levelSeg button').forEach((b) => {
      b.classList.toggle('on', !S.daily && b.dataset.lv === S.level);
    });
    $('#btnDaily').classList.toggle('on', S.daily);
    save();
  }

  function fmtDaily(key) {
    const m = /^d(\d{4})(\d{2})(\d{2})$/.exec(key || '');
    return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
  }

  function newPuzzle(level) {
    if (S.locked) return;
    S.locked = true;
    stopDemo();
    toast('正在出题…');
    // 让浏览器先把「出题中」画出来，再去做重活（高级盘要几百毫秒）
    setTimeout(() => {
      try {
        const rng = SH.mulberry32('rnd-' + Date.now() + '-' + Math.random());
        const cfg = SH.DIFFICULTY[level] || SH.DIFFICULTY.normal;
        let p = null;
        for (let k = 0; k < 3 && !p; k++) {
          p = SH.generate(cfg.size, rng, cfg);
        }
        if (!p) { toast('出题失败，请再点一次'); return; }
        startPuzzle(p, { level: level, key: 'rnd-' + Math.floor(Math.random() * 1e9) });
        toast(({ easy: '初级', normal: '中级', hard: '高级' }[level] || '') + ' · ' + cfg.size + '×' + cfg.size);
      } finally {
        S.locked = false;
      }
    }, 16);
  }

  function startDaily() {
    if (S.locked) return;
    const d = new Date();
    const ymd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const dailyKey = 'd' + ymd;
    const seed = SH.hashSeed(dailyKey);            // 必须散列：'d20260914' >>> 0 会变成 0
    const level = ['easy', 'normal', 'hard'][d.getDay() % 3];
    const cfg = SH.DIFFICULTY[level];

    S.locked = true;
    stopDemo();
    toast('正在出题…');
    setTimeout(() => {
      try {
        const p = SH.generate(cfg.size, SH.mulberry32(seed), cfg);
        if (!p) { toast('今日题目生成失败'); return; }
        startPuzzle(p, { level: level, daily: true, dailyKey: dailyKey, key: 'daily-' + dailyKey });
        const rec = SAVE.daily[dailyKey];
        if (rec && rec.count) {
          toast(`今日已挑战 ${rec.count} 次，最佳 ${fmtTime(rec.best)}`);
        } else {
          toast('今日挑战 · ' + fmtDaily(dailyKey));
        }
      } finally {
        S.locked = false;
      }
    }, 16);
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    loadSave();

    $('#board').addEventListener('pointerdown', onDown);
    $('#board').addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    $('#board').addEventListener('contextmenu', (e) => e.preventDefault());

    $('#btnNew').addEventListener('click', () => newPuzzle(S.level));
    $('#btnDaily').addEventListener('click', startDaily);
    $('#btnHint').addEventListener('click', hint);
    $('#btnDemo').addEventListener('click', () => (S.demoBusy ? stopDemo() : demo()));
    $('#btnCheck').addEventListener('click', check);
    $('#btnReset').addEventListener('click', reset);
    $('#btnHelp').addEventListener('click', () => $('#modalHelp').classList.add('show'));
    $('#btnCloseHelp').addEventListener('click', () => $('#modalHelp').classList.remove('show'));
    $('#btnCloseWin').addEventListener('click', () => $('#modalWin').classList.remove('show'));
    $('#btnAgain').addEventListener('click', () => {
      $('#modalWin').classList.remove('show');
      if (S.daily) startDaily(); else newPuzzle(S.level);
    });
    $('#btnMark').addEventListener('click', () => {
      S.markMode = !S.markMode;
      $('#btnMark').classList.toggle('on', S.markMode);
      toast(S.markMode ? '标记模式：点击边 = 确定不在回路上' : '标记模式已关闭');
    });
    document.querySelectorAll('#levelSeg button').forEach((b) => {
      b.addEventListener('click', () => { S.level = b.dataset.lv; newPuzzle(S.level); });
    });
    document.querySelectorAll('.modal').forEach((m) => {
      m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
    });

    document.addEventListener('keydown', (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'n') newPuzzle(S.level);
      else if (k === 'h') hint();
      else if (k === 'd') (S.demoBusy ? stopDemo() : demo());
      else if (k === 'c') check();
      else if (k === 'r') reset();
      else if (k === 'escape') document.querySelectorAll('.modal').forEach((m) => m.classList.remove('show'));
      else return;
      e.preventDefault();
    });

    // 有存档就接着玩，否则开一局中级
    if (SAVE.cur && SAVE.cur.clue && SAVE.cur.edges) {
      const c = SAVE.cur;
      const L = SH.buildLayout(c.size);
      S.size = c.size;
      S.L = L;
      S.clue = Int8Array.from(c.clue);
      S.sol = Int8Array.from(c.sol);
      S.edges = Int8Array.from(c.edges);
      S.elapsed = c.elapsed || 0;
      S.miss = c.miss || 0;
      S.hints = c.hints || 0;
      S.done = !!c.done;
      S.level = c.level || 'normal';
      S.daily = !!c.daily;
      S.dailyKey = c.dailyKey || '';
      S.key = c.key || '';
      buildBoard();
      paintAll();
      hudRefresh();
      $('#stMode').textContent = S.daily ? '每日挑战 · ' + fmtDaily(S.dailyKey) : ({ easy: '初级', normal: '中级', hard: '高级' }[S.level] || '经典');
      document.querySelectorAll('#levelSeg button').forEach((b) => b.classList.toggle('on', !S.daily && b.dataset.lv === S.level));
      $('#btnDaily').classList.toggle('on', S.daily);
      toast('已恢复上次的进度');
    } else {
      newPuzzle('normal');
    }
  }

  /* ---------------- 调试 API（供自动化测试使用） ---------------- */
  window.__shuhui = {
    version: '1.0',
    state: () => ({
      size: S.size, level: S.level, daily: S.daily, done: S.done,
      elapsed: S.elapsed, miss: S.miss, hints: S.hints, score: calcScore(),
      key: S.key, dailyKey: S.dailyKey, locked: S.locked, demoBusy: S.demoBusy,
      markMode: S.markMode, clueCount: S.clue ? S.clue.filter((v) => v >= 0).length : 0,
      onEdges: Array.from(S.edges || []).filter((v) => v === SH.ON).length,
      unknown: Array.from(S.edges || []).filter((v) => v === SH.UNKNOWN).length,
    }),
    dims: () => ({
      size: S.size, edges: S.L.E, dots: S.L.dots, cells: S.size * S.size,
      svgEdges: document.querySelectorAll('#board .vis').length,
      svgHits: document.querySelectorAll('#board .hit').length,
      svgMarks: document.querySelectorAll('#board .mark').length,
      svgNums: document.querySelectorAll('#board .num').length,
      viewBox: document.querySelector('#board').getAttribute('viewBox'),
    }),
    clue: () => Array.from(S.clue),
    sol: () => Array.from(S.sol),
    edges: () => Array.from(S.edges),
    edgeRect: (e) => {
      const vis = edgeVisEls[e];
      if (!vis) return null;
      const r = vis.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    },
    clueRect: (i) => {
      const b = cellEls[i];
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    },
    setEdge: (e, v) => { S.edges[e] = v; paintEdge(e); afterChange(); },
    fillSolution: () => { S.edges.set(S.sol); paintAll(); hudRefresh(); save(); if (SH.isSolved(S.L, S.clue, S.edges)) win(); },
    firstUnknown: () => S.edges.findIndex((v) => v === SH.UNKNOWN),
    clearAll: () => { S.edges = SH.emptyState(S.L); paintAll(); hudRefresh(); },
    isSolvedNow: () => SH.isSolved(S.L, S.clue, S.edges),
    conflicts: () => Array.from(SH.conflictedCells(S.L, S.clue, S.edges)),
    hint, demo, check, reset,
    newPuzzle, startDaily,
    save: () => { save(); return SAVE; },
    sound: (on) => { S.sound = !!on; },
  };
  S.sound = false;   // 默认静音，避免自动化测试时出声

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
