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
    sol: null,          // 本地解；在线领题时靠引擎就地解出来，解不出则为 null
    edges: null,
    size: 8,
    level: 'normal',
    daily: false,
    dailyKey: '',
    key: '',
    onlineId: null,     // 服务端题号；null = 本地出题，不参与榜单
    timed: false,       // 本局是否由服务端计时
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
    // 拿得到本地解就当场纠错；拿不到（在线题且引擎没解出来）就不拦，
    // 让玩家先画，最终由服务端判分。
    if (v !== SH.UNKNOWN && S.sol && v !== S.sol[e]) {
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
      if (!S.sol) { toast('这局拿不到本地解，给不出提示'); return; }
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
        // 传播到头，补一条答案里的边继续；没有本地解就只能停在这里
        if (!S.sol) break;
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
    $('#winNet').textContent = netWinPendingText();
    $('#modalWin').classList.add('show');
    hudRefresh();
    save();

    // 成绩上不上的去榜，不影响这一局的结算 —— 所以提交放在弹窗出来之后，
    // 失败了只改那一行文字，不会把已经赢下的局面弄回去。
    netSubmitDaily().then((r) => {
      if (!r) return;
      $('#winNet').textContent = netWinResultText(r);
    }).catch((err) => {
      $('#winNet').textContent = '提交失败：' + netErrText(err);
    });
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
      sol: S.sol ? Array.from(S.sol) : null,
      edges: Array.from(S.edges),
      elapsed: Math.floor(S.elapsed),
      miss: S.miss,
      hints: S.hints,
      done: S.done,
      level: S.level,
      daily: S.daily,
      dailyKey: S.dailyKey,
      key: S.key,
      onlineId: S.onlineId,
      timed: S.timed,
    };
    writeSave();
  }

  /* ==================================================================
   * 联机（可选；后端不可达时整块静默降级）
   * ------------------------------------------------------------------
   * 立场：这仍然是一个「双击 index.html 就能玩」的单文件游戏。
   * 联机是加成，不是前提 —— 探测失败、没登录、令牌过期、交卷超时，
   * 任何一种都只让榜单那部分消失，棋盘照常能玩。
   *
   * 在线每日挑战的题面由服务端下发，但不含答案；本地用引擎的求解器
   * 就地还原一份，只为保住「画错当场闪红」的手感。真正的判定在服务端。
   * ================================================================== */
  const API_KEY = 'shuhui.api';

  const Net = {
    client: null,
    ready: false,
    probePromise: null,
    snapshot: null,
    scope: 'daily',
    stopWs: null,
    wsState: null,
    lastError: '',
    solveMs: null,
    lastSubmit: null,
  };

  /** 后端地址解析顺序：?api= → localStorage → <meta name="puzzle-api"> → 同源 */
  function readApiBase() {
    let q = null;
    try { q = new URLSearchParams(location.search).get('api'); } catch (e) { /* 忽略 */ }
    if (q !== null) {
      const v = q.trim().replace(/\/+$/, '');
      netSaveApi(v);
      return v;
    }
    try {
      const v = localStorage.getItem(API_KEY);
      if (v) return v.replace(/\/+$/, '');
    } catch (e) { /* 隐私模式 */ }
    const m = document.querySelector('meta[name="puzzle-api"]');
    return m && m.content ? m.content.trim().replace(/\/+$/, '') : '';
  }

  function netSaveApi(url) {
    try {
      if (url) localStorage.setItem(API_KEY, url);
      else localStorage.removeItem(API_KEY);
    } catch (e) { /* 存不进去也不影响本次会话 */ }
  }

  function netErrText(err) {
    if (!err) return '未知错误';
    if (err.status === 0) return '连不上服务器（地址不对或后端没起）';
    if (err.status === 401) return '登录已过期，请重新登录';
    if (err.status === 404) return '服务端没有这道题（题池可能没灌）';
    if (err.status === 429) return '操作太频繁，歇一下再试';
    if (err.status >= 500) return '服务端出错（HTTP ' + err.status + '）';
    return err.message || ('HTTP ' + err.status);
  }

  function fmtElapsedMs(ms) {
    if (window.PuzzleClient && window.PuzzleClient.formatElapsed) {
      return window.PuzzleClient.formatElapsed(ms);
    }
    return ms == null ? '—' : (ms / 1000).toFixed(1) + 's';
  }

  /** 把联机状态画到工具栏那个小圆点上。不联网时就是灰的，不吵人。 */
  function netPaint() {
    const dot = $('#netDot');
    const label = $('#netLabel');
    if (!Net.client) { dot.className = 'ndot'; label.textContent = '离线'; return; }

    const logged = Net.client.isLoggedIn();
    let cls = 'ndot';
    if (!Net.ready) cls += Net.lastError ? ' bad' : '';
    else cls += logged ? ' live' : ' on';
    dot.className = cls;

    const who = Net.client.username();
    if (!Net.ready) label.textContent = '离线';
    else if (!logged) label.textContent = '联机';
    else label.textContent = who && who.length > 8 ? who.slice(0, 7) + '…' : (who || '已登录');
  }

  function netMsg(text, kind) {
    const m = $('#onlineMsg');
    m.textContent = text || '';
    m.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /** 登录表单 / 已登录面板的互斥显示，以及服务器地址那一行的说明。 */
  function netSyncOnlineUI() {
    const box = $('#onlineMe');
    const form = $('#onlineForm');
    if (!box || !form) return;
    const logged = !!(Net.client && Net.client.isLoggedIn());
    form.hidden = logged;
    box.hidden = !logged;
    $('#meName').textContent = logged ? (Net.client.username() || '—') : '—';

    const hint = $('#apiHint');
    const base = Net.client.options.baseUrl;
    let fileProto = false;
    try { fileProto = location.protocol === 'file:'; } catch (e) { /* 忽略 */ }
    if (Net.ready) {
      hint.textContent = '已连上 ' + (base || '同源地址') + '。';
    } else if (fileProto && !base) {
      hint.textContent = '本页是直接打开的文件，同源地址不可用，得填上后端地址（例：http://127.0.0.1:8077）才能联机。';
    } else {
      hint.textContent = '还没连上 ' + (base || '同源地址') + '。填好地址后点「登录」会再试一次。';
    }
  }

  /**
   * 这一页到底有没有探测的必要。
   *
   * 双击 index.html 打开时协议是 file:，此时「同源」等于 file:///api/...，
   * 浏览器必然按 CORS 拦掉并在控制台留一条红字。既然结果注定，就别发这个请求 ——
   * 单文件离线玩法不该背一条无意义的报错。填了后端地址的话照常探。
   */
  function netProbePossible() {
    if (!Net.client) return false;
    if (Net.client.options.baseUrl) return true;
    try { return /^https?:$/.test(location.protocol); } catch (e) { return false; }
  }

  /**
   * 探一次后端在不在。同一个 Promise 会被并发的调用方共用，
   * 避免点一下按钮打出一串请求。
   */
  function netProbe(force) {
    if (!netProbePossible()) {
      Net.ready = false;
      Net.lastError = '';
      netPaint(); netSyncOnlineUI();
      return Promise.resolve(false);
    }
    if (Net.probePromise && !force) return Net.probePromise;
    Net.probePromise = Net.client.ping().then(
      (ok) => {
        Net.ready = !!ok;
        Net.lastError = ok ? '' : '后端不可达';
        if (ok && Net.client.isLoggedIn()) {
          Net.client.refreshMe().then(() => {
            netPaint(); netSyncOnlineUI();
          }).catch(() => { /* 令牌失效时库自己会清掉，不用管 */ });
          netWatch();
        }
        netPaint(); netSyncOnlineUI();
        return Net.ready;
      },
      () => {
        Net.ready = false;
        Net.lastError = '后端不可达';
        netPaint(); netSyncOnlineUI();
        return false;
      }
    );
    return Net.probePromise;
  }

  /**
   * 等探测结果，但最多等 ms 毫秒。
   * 有上限是必要的：后端地址填错时 TCP 连接会一直挂着，
   * 不能让「每日挑战」这个按钮跟着卡住。
   */
  async function netReady(ms) {
    if (!Net.client) return false;
    if (Net.ready) return true;
    await Promise.race([netProbe(true).catch(() => false), sleep(ms == null ? 3000 : ms)]);
    return Net.ready;
  }

  function setApiBase(url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    netSaveApi(url);
    if (Net.client) {
      const changed = url !== (Net.client.options.baseUrl || '');
      Net.client.config({ baseUrl: url });   // 换后端 = 旧令牌作废，库内部会 logout
      if (changed) { netStopWatch(); Net.ready = false; Net.lastError = ''; }
    }
    Net.snapshot = null;
    netPaint(); netSyncOnlineUI();
    return netProbe(true);
  }

  /* ---------------- 实时榜单 ---------------- */

  function netWatch() {
    if (!Net.client || !Net.ready || Net.stopWs) return;
    Net.stopWs = Net.client.watchLeaderboard(
      (snap) => {
        if (Net.scope !== 'daily') return;    // 推送只覆盖当日榜
        Net.snapshot = snap;
        renderBoard(snap);
      },
      (state) => { Net.wsState = state; if (state === 'open') netPaint(); }
    );
  }

  function netStopWatch() {
    if (Net.stopWs) { try { Net.stopWs(); } catch (e) { /* 忽略 */ } Net.stopWs = null; }
    Net.wsState = null;
  }

  function renderBoard(payload) {
    const list = $('#lbList');
    const entries = (payload && payload.entries) || [];
    const me = Net.client ? Net.client.username() : null;
    list.innerHTML = '';

    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还没有人上榜，你可以是第一个';
      list.appendChild(li);
    } else {
      entries.forEach((e) => {
        const li = document.createElement('li');
        if (me && e.username === me) li.className = 'me';
        const rk = document.createElement('span');
        rk.className = 'rk'; rk.textContent = '#' + e.rank;
        const nm = document.createElement('span');
        nm.className = 'nm'; nm.textContent = e.username;
        const tm = document.createElement('span');
        tm.className = 'tm'; tm.textContent = e.elapsed_text;
        li.appendChild(rk); li.appendChild(nm); li.appendChild(tm);
        list.appendChild(li);
      });
    }
    $('#lbMeta').textContent = netMetaText(payload);
  }

  function netMetaText(payload) {
    if (!payload) return '尚未取到数据';
    const parts = [
      payload.scope === 'all' ? '历史总榜' : ((payload.date || '今日') + ' 当日榜'),
      '共 ' + (payload.total || 0) + ' 人上榜',
      payload.backend === 'redis' ? '存储 Redis' : '存储 内存',
    ];
    if (Net.wsState === 'open') parts.push('实时同步中');
    return parts.join(' · ');
  }

  function boardEmpty(text) {
    const list = $('#lbList');
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    list.appendChild(li);
    $('#lbMeta').textContent = '—';
  }

  function netLoadBoard(scope) {
    if (!Net.client) return;
    if (scope) Net.scope = scope;
    $('#tabDaily').classList.toggle('on', Net.scope === 'daily');
    $('#tabAll').classList.toggle('on', Net.scope === 'all');
    $('#boardSub').textContent = Net.scope === 'all'
      ? '所有人所有日期的个人最好成绩' : '按用时排名，快者在前（同分并列）';
    $('#lbList').innerHTML = '<li class="empty">正在拉取…</li>';

    Net.client.leaderboard({ scope: Net.scope, limit: 20 }).then(
      (r) => { Net.snapshot = r; renderBoard(r); },
      (err) => { boardEmpty('取榜单失败：' + netErrText(err)); }
    );
  }

  async function openBoard() {
    $('#modalBoard').classList.add('show');
    if (!Net.client) { boardEmpty('联机库没有加载'); return; }
    if (await netReady(2500)) {
      netWatch();
      netLoadBoard(Net.scope);
    } else {
      boardEmpty('连不上 ' + (Net.client.options.baseUrl || '同源地址') +
        '。点「联机」改地址后重试。');
    }
  }

  /* ---------------- 账号 ---------------- */

  function netAuth(mode) {
    if (!Net.client) { netMsg('联机库没有加载', 'bad'); return; }
    const u = $('#inUser').value.trim();
    const p = $('#inPass').value;
    const api = $('#inApi').value.trim().replace(/\/+$/, '');

    if (u.length < 3 || u.length > 24) { netMsg('用户名需 3~24 位', 'bad'); return; }
    if (p.length < 6) { netMsg('密码至少 6 位', 'bad'); return; }

    netMsg(mode === 'register' ? '注册中…' : '登录中…');
    const baseChanged = api !== (Net.client.options.baseUrl || '');
    const chain = baseChanged ? setApiBase(api) : netReady(3000);

    chain
      .then((ok) => {
        if (!ok) throw Object.assign(new Error('连不上 ' + (api || '同源地址')), { status: 0 });
        return mode === 'register' ? Net.client.register(u, p) : Net.client.login(u, p);
      })
      .then((user) => {
        Net.ready = true; Net.lastError = '';
        $('#inPass').value = '';
        netMsg('已登录 ' + user.username + '，从现在起成绩计入榜单', 'ok');
        netPaint(); netSyncOnlineUI(); netWatch();
      })
      .catch((err) => {
        Net.lastError = err && err.message;
        netMsg(netErrText(err), 'bad');
        netPaint(); netSyncOnlineUI();
      });
  }

  function netLogout() {
    if (!Net.client) return;
    Net.client.logout();
    netStopWatch();
    netMsg('已退出登录，成绩不再上榜', '');
    netPaint(); netSyncOnlineUI();
  }

  function netRecheckToken() {
    if (!Net.client || !Net.client.isLoggedIn()) { netMsg('当前没有登录', ''); return; }
    netMsg('正在校验…');
    Net.client.refreshMe().then(
      (user) => { netMsg('令牌有效，账号 ' + user.username, 'ok'); netPaint(); netSyncOnlineUI(); },
      (err) => { netMsg(netErrText(err), 'bad'); netPaint(); netSyncOnlineUI(); }
    );
  }

  /* ---------------- 在线每日挑战 ---------------- */

  /**
   * 服务端下发的题面 → 本地的 puzzle 结构。
   * 答案不在题面里，用引擎就地解一份出来；解不出就给 null，
   * 此时游戏照常可玩，只是没有即时纠错和提示。
   */
  function puzzleFromPayload(payload) {
    if (!payload || !Array.isArray(payload.clue)) return null;
    const n = Number(payload.n);
    if (!(n >= 2 && n <= 20)) return null;
    const flat = payload.clue.flat();
    if (flat.length !== n * n) return null;
    const clue = Int8Array.from(flat);
    for (let i = 0; i < clue.length; i++) {
      if (clue[i] < SH.NO_CLUE || clue[i] > 4) return null;
    }
    const L = SH.buildLayout(n);
    let sol = null;
    const t0 = Date.now();
    try { sol = SH.solve(L, clue, SH.emptyState(L), 200000); } catch (e) { sol = null; }
    Net.solveMs = Date.now() - t0;
    return { size: n, clue: clue, solution: sol, clueCount: payload.clueCount };
  }

  /**
   * 交卷。探测可能还没回来（比如刷新页面后立刻通关），所以这里等一小会儿 ——
   * 成绩上不上榜不该由"谁先跑完"决定。
   */
  async function netSubmitDaily() {
    if (!S.onlineId) return null;
    if (!Net.client) return { note: '联机库没有加载 · 本局不计入榜单' };
    if (!(await netReady(2000))) return { note: '后端不可达 · 本局不计入榜单' };
    if (!Net.client.isLoggedIn()) {
      return { note: '未登录 · 登录后成绩才能上榜' };
    }
    const on = [];
    for (let e = 0; e < S.L.E; e++) if (S.edges[e] === SH.ON) on.push(e);
    // 只报「哪些边在回路上」；顺序和重复由服务端归一化
    const r = await Net.client.submit(S.onlineId, { on: on });
    Net.lastSubmit = r;
    return r;
  }

  function netWinPendingText() {
    if (!S.onlineId) return '离线 · 本局不计入榜单';
    if (!Net.client) return '联机库没有加载 · 本局不计入榜单';
    if (!Net.client.isLoggedIn()) return '未登录 · 登录后成绩才能上榜';
    return '正在提交成绩…';
  }

  function netWinResultText(r) {
    if (r.note) return r.note;
    if (!r.correct) return '服务端判定不通过：' + r.message;
    if (r.ranked) {
      const extra = r.improved ? '（个人最好）' : '';
      return `第 ${r.rank} 名 / 共 ${r.total} 人 · 服务端计时 ${fmtElapsedMs(r.elapsed_ms)}${extra}`;
    }
    return r.message || '答对了，但本局未计入榜单';
  }

  function netInit() {
    if (typeof window.PuzzleClient !== 'function') { netPaint(); netSyncOnlineUI(); return; }
    Net.client = window.PuzzleClient({
      baseUrl: readApiBase(),
      game: 'shuhui',
      variant: 'standard',
      storageKey: 'shuhui.auth',
    });
    Net.client.on('state', () => { netPaint(); netSyncOnlineUI(); });
    $('#inApi').value = Net.client.options.baseUrl || '';
    netPaint();
    netSyncOnlineUI();
    netProbe();
  }

  /* ---------------- 开局 ---------------- */
  function startPuzzle(p, opt) {
    opt = opt || {};
    S.size = p.size;
    S.L = SH.buildLayout(p.size);
    S.clue = p.clue;
    S.sol = p.solution || null;
    S.edges = SH.emptyState(S.L);
    S.level = opt.level || S.level;
    S.daily = !!opt.daily;
    S.dailyKey = opt.dailyKey || '';
    S.key = opt.key || '';
    S.onlineId = opt.onlineId || null;
    S.timed = !!opt.timed;
    S.elapsed = 0; S.miss = 0; S.hints = 0;
    S.done = false; S.running = false; S.demoBusy = false; S.demoToken++;
    stopTimer();
    buildBoard();
    paintAll();
    hudRefresh();
    $('#modalWin').classList.remove('show');
    $('#stMode').textContent = modeLabel();
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

  /** 状态栏左侧的模式文字。在线题额外标出来，免得玩家以为自己在玩本地题。 */
  function modeLabel() {
    if (!S.daily) return ({ easy: '初级', normal: '中级', hard: '高级' }[S.level] || '经典');
    const kind = S.onlineId
      ? (S.timed ? '每日挑战 · 在线计时' : '每日挑战 · 在线（未登录）')
      : '每日挑战 · 本地';
    return kind + ' · ' + fmtDaily(S.dailyKey);
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

  /**
   * 每日挑战。
   *
   * 先问服务端要今天这道题（全球同一道、服务端计时、成绩可上榜）；
   * 断网 / 后端没起 / 题池没灌，任何一种情况都退回本地按日期定种子生成 ——
   * 这样"每日挑战"这个功能在完全离线时依然存在，只是不上榜。
   */
  async function startDaily() {
    if (S.locked) return;
    const now = new Date();
    const ymd = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const dailyKey = 'd' + ymd;
    const dateStr = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');

    S.locked = true;
    stopDemo();
    toast('正在取题…');

    // ---- 1) 服务端优先 ----
    if (Net.client && await netReady(3000)) {
      try {
        const r = await Net.client.fetchDaily({ date: dateStr });
        const p = puzzleFromPayload(r.puzzle);
        if (p) {
          startPuzzle(p, {
            level: r.difficulty || 'normal',
            daily: true, dailyKey: dailyKey, key: 'daily-' + dailyKey,
            onlineId: r.puzzle_id, timed: !!r.timed,
          });
          toast(r.timed
            ? '在线每日挑战 · 服务端计时中'
            : '在线每日挑战 · 未登录，不计入榜单');
          return;
        }
        Net.lastError = '题面格式不认识';
      } catch (err) {
        Net.lastError = err && err.message;
        toast('服务端取题失败，改用本地题');
      } finally {
        S.locked = false;
        netPaint();
      }
    }

    // ---- 2) 本地兜底 ----
    S.locked = true;
    await sleep(16);
    try {
      const seed = SH.hashSeed(dailyKey);          // 必须散列：'d20260914' >>> 0 会变成 0
      const level = ['easy', 'normal', 'hard'][now.getDay() % 3];
      const cfg = SH.DIFFICULTY[level];
      const p = SH.generate(cfg.size, SH.mulberry32(seed), cfg);
      if (!p) { toast('今日题目生成失败'); return; }
      startPuzzle(p, { level: level, daily: true, dailyKey: dailyKey, key: 'daily-' + dailyKey });
      const rec = SAVE.daily[dailyKey];
      if (rec && rec.count) {
        toast(`今日已挑战 ${rec.count} 次，最佳 ${fmtTime(rec.best)}`);
      } else {
        toast('本地每日挑战 · ' + fmtDaily(dailyKey));
      }
    } finally {
      S.locked = false;
    }
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

    /* ---- 联机相关的界面 ---- */
    $('#btnOnline').addEventListener('click', () => {
      $('#modalOnline').classList.add('show');
      netSyncOnlineUI();
      if (!Net.ready) netProbe(true);
    });
    $('#btnBoard').addEventListener('click', openBoard);
    $('#btnCloseOnline').addEventListener('click', () => $('#modalOnline').classList.remove('show'));
    $('#btnCloseBoard').addEventListener('click', () => $('#modalBoard').classList.remove('show'));
    $('#btnLogin').addEventListener('click', () => netAuth('login'));
    $('#btnRegister').addEventListener('click', () => netAuth('register'));
    $('#btnLogout').addEventListener('click', netLogout);
    $('#btnCheckToken').addEventListener('click', netRecheckToken);
    $('#tabDaily').addEventListener('click', () => netLoadBoard('daily'));
    $('#tabAll').addEventListener('click', () => netLoadBoard('all'));
    $('#inPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') netAuth('login'); });
    // 地址在失焦或回车时保存并立刻试连一次，不必先点登录
    $('#inApi').addEventListener('change', () => {
      const v = $('#inApi').value.trim().replace(/\/+$/, '');
      if (v !== (Net.client ? Net.client.options.baseUrl || '' : '')) setApiBase(v);
    });
    $('#inApi').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); setApiBase($('#inApi').value); }
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

    // 联机初始化的失败是被吞掉的：没网就静默退化成单机，不该弹任何错误
    netInit();

    // 有存档就接着玩，否则开一局中级
    if (SAVE.cur && SAVE.cur.clue && SAVE.cur.edges) {
      const c = SAVE.cur;
      const L = SH.buildLayout(c.size);
      S.size = c.size;
      S.L = L;
      S.clue = Int8Array.from(c.clue);
      S.sol = c.sol ? Int8Array.from(c.sol) : null;
      S.edges = Int8Array.from(c.edges);
      S.elapsed = c.elapsed || 0;
      S.miss = c.miss || 0;
      S.hints = c.hints || 0;
      S.done = !!c.done;
      S.level = c.level || 'normal';
      S.daily = !!c.daily;
      S.dailyKey = c.dailyKey || '';
      S.key = c.key || '';
      S.onlineId = c.onlineId || null;
      S.timed = !!c.timed;
      buildBoard();
      paintAll();
      hudRefresh();
      $('#stMode').textContent = modeLabel();
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
      onlineId: S.onlineId, timed: S.timed,
      hasLocalSolution: !!S.sol, timeLabel: modeLabel(),
    }),
    dims: () => ({
      size: S.size,
      edges: S.L ? S.L.E : 0,
      dots: S.L ? S.L.dots : 0,
      cells: S.size * S.size,
      svgEdges: document.querySelectorAll('#board .vis').length,
      svgHits: document.querySelectorAll('#board .hit').length,
      svgMarks: document.querySelectorAll('#board .mark').length,
      svgNums: document.querySelectorAll('#board .num').length,
      viewBox: document.querySelector('#board').getAttribute('viewBox'),
    }),
    clue: () => (S.clue ? Array.from(S.clue) : []),
    sol: () => (S.sol ? Array.from(S.sol) : null),
    edges: () => (S.edges ? Array.from(S.edges) : []),
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
    fillSolution: () => {
      if (!S.sol) return false;
      S.edges.set(S.sol);
      paintAll();
      hudRefresh();
      save();
      if (SH.isSolved(S.L, S.clue, S.edges)) win();
      return true;
    },
    /** 只填不判胜，用来测「差一条边时不算赢」这类情形。 */
    fillWithoutWin: () => {
      if (!S.sol) return false;
      S.edges.set(S.sol);
      paintAll();
      hudRefresh();
      return true;
    },
    firstUnknown: () => (S.edges ? S.edges.findIndex((v) => v === SH.UNKNOWN) : -1),
    clearAll: () => { if (!S.L) return; S.edges = SH.emptyState(S.L); paintAll(); hudRefresh(); },
    isSolvedNow: () => !!(S.L && SH.isSolved(S.L, S.clue, S.edges)),
    conflicts: () => (S.L ? Array.from(SH.conflictedCells(S.L, S.clue, S.edges)) : []),
    hint, demo, check, reset,
    newPuzzle, startDaily,
    save: () => { save(); return SAVE; },
    sound: (on) => { S.sound = !!on; },
    /* 联机部分。在线测试要能驱动它，所以一并暴露出来。 */
    net: {
      hasClient: () => !!Net.client,
      ready: () => Net.ready,
      api: () => (Net.client ? Net.client.options.baseUrl : null),
      setApi: (url) => setApiBase(url),
      probe: (force) => netProbe(force !== false),
      loggedIn: () => !!(Net.client && Net.client.isLoggedIn()),
      username: () => (Net.client ? Net.client.username() : null),
      register: (u, p) => Net.client.register(u, p),
      login: (u, p) => Net.client.login(u, p),
      logout: () => netLogout(),
      label: () => $('#netLabel').textContent,
      dotClass: () => $('#netDot').className,
      pendingText: () => netWinPendingText(),
      resultText: (r) => netWinResultText(r),
      lastSubmit: () => Net.lastSubmit,
      solveMs: () => Net.solveMs,
      snapshot: () => Net.snapshot,
      wsState: () => Net.wsState,
      openBoard, loadBoard: netLoadBoard,
      submitNow: () => netSubmitDaily(),
      puzzleFrom: (payload) => {
        const p = puzzleFromPayload(payload);
        return p ? { size: p.size, clue: Array.from(p.clue), hasSolution: !!p.solution } : null;
      },
    },
  };
  S.sound = false;   // 默认静音，避免自动化测试时出声

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
