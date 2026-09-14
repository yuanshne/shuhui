/* ==========================================================================
 * puzzle-client.js —— 四款游戏共用的后端接入层
 * --------------------------------------------------------------------------
 * 单文件、零依赖、可内联进 <script>。职责只有三件事：
 *   1. 账号：注册 / 登录 / 记住令牌
 *   2. 每日挑战：领题、交卷
 *   3. 榜单：拉一次、订阅实时推送
 *
 * 刻意不做的事：
 *   - 不碰 DOM。界面归各游戏自己，这个文件在 Node 里也能跑。
 *   - 不吞错误。所有方法返回 Promise，失败一律 reject，由调用方决定
 *     "降级成本地生成"还是"提示用户"。库自己猜不出来哪种更合适。
 *
 * 离线是常态而非异常：游戏的主卖点是"双击就能玩"，
 * 所以每个方法都可能在网络不可达时失败，调用方必须能兜住。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PuzzleClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  var DEFAULTS = {
    // 后端地址。留空 = 同源（后端同时托管前端时用）
    baseUrl: '',
    game: '',
    variant: null,
    timeout: 10000,
    // 令牌存放在哪。key 里带 baseUrl 以免连过两个后端后串号
    storageKey: 'puzzle.auth',
    // 实时推送断了之后多久重连（毫秒），指数退避到上限
    reconnectBase: 1500,
    reconnectMax: 30000
  };

  var API_PREFIX = '/api/v1';

  // ------------------------------------------------------------------ 工具

  function joinUrl(base, path) {
    if (/^https?:\/\//i.test(path)) return path;
    var b = String(base || '').replace(/\/+$/, '');
    var p = String(path || '').replace(/^\/+/, '');
    return p ? b + '/' + p : b;
  }

  function wsUrl(base, path) {
    var absolute = joinUrl(base, path);
    if (/^wss?:\/\//i.test(absolute)) return absolute;
    if (/^https:\/\//i.test(absolute)) return absolute.replace(/^https:/, 'wss:');
    if (/^http:\/\//i.test(absolute)) return absolute.replace(/^http:/, 'ws:');
    // 相对路径（baseUrl 为空 = 同源）：交给浏览器按当前页面推导
    if (typeof location !== 'undefined') {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var p = path.charAt(0) === '/' ? path : '/' + path;
      return proto + '//' + location.host + p;
    }
    return absolute;
  }

  function elapsedText(ms) {
    if (ms === null || ms === undefined) return '-';
    var total = Math.max(Number(ms), 0) / 1000;
    var minutes = Math.floor(total / 60);
    if (minutes >= 1) {
      return minutes + ':' + ('0' + (total % 60).toFixed(1)).slice(-4);
    }
    return total.toFixed(1) + 's';
  }

  function tryStorage() {
    // file:// 或隐私模式下 localStorage 可能直接抛异常，别让它把整个库带崩
    try {
      if (typeof localStorage === 'undefined') return null;
      var probe = '__pc_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    } catch (err) {
      return null;
    }
  }

  // ------------------------------------------------------------------ 主体

  function PuzzleClient(options) {
    if (!(this instanceof PuzzleClient)) return new PuzzleClient(options);
    this.options = Object.assign({}, DEFAULTS, options || {});
    this._storage = tryStorage();
    this._listeners = { state: [], leaderboard: [] };
    this._ws = null;
    this._wsStopped = true;
    this._wsRetry = 0;
    this._wsTimer = null;
    this._auth = this._readAuth();
  }

  PuzzleClient.VERSION = VERSION;
  PuzzleClient.defaults = DEFAULTS;

  // ------------------------------------------------ 配置与状态

  /**
   * 改配置。baseUrl 变了的话会把当前令牌丢掉 —— 那是另一个后端的令牌，
   * 继续用只会得到一堆 401。
   */
  PuzzleClient.prototype.config = function (options) {
    options = options || {};
    if (options.baseUrl !== undefined &&
        joinUrl(options.baseUrl, '') !== joinUrl(this.options.baseUrl, '')) {
      this.logout();
      this.stopWatching();
    }
    Object.assign(this.options, options);
    return this;
  };

  PuzzleClient.prototype.on = function (event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    var list = this._listeners[event];
    list.push(handler);
    return function off() {
      var at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    };
  };

  PuzzleClient.prototype._emit = function (event, payload) {
    (this._listeners[event] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (err) { /* 一个监听器出错不该影响别的 */ }
    });
  };

  PuzzleClient.prototype._readAuth = function () {
    if (!this._storage) return null;
    try {
      var raw = this._storage.getItem(this.options.storageKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.token) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  };

  PuzzleClient.prototype._writeAuth = function (auth) {
    this._auth = auth;
    if (this._storage) {
      try {
        if (auth) this._storage.setItem(this.options.storageKey, JSON.stringify(auth));
        else this._storage.removeItem(this.options.storageKey);
      } catch (err) { /* 存不进去也不影响本次会话 */ }
    }
    this._emit('state', { loggedIn: !!auth, user: auth ? auth.user : null });
  };

  PuzzleClient.prototype.isLoggedIn = function () {
    return !!(this._auth && this._auth.token);
  };

  PuzzleClient.prototype.user = function () {
    return this._auth ? this._auth.user : null;
  };

  PuzzleClient.prototype.username = function () {
    var u = this.user();
    return u ? u.username : null;
  };

  PuzzleClient.prototype.token = function () {
    return this._auth ? this._auth.token : null;
  };

  // ------------------------------------------------ HTTP

  PuzzleClient.prototype._fetch = function (path, init) {
    init = init || {};
    var headers = Object.assign({}, init.headers || {});
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    var token = this.token();
    if (token && !init.anonymous) headers.Authorization = 'Bearer ' + token;

    var controller = null;
    var timer = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      // 这里必须先把 timeout 取出来：回调里的 this 不是 client
      var limit = this.options.timeout;
      timer = setTimeout(function () { controller.abort(); }, limit);
    }

    var url = joinUrl(this.options.baseUrl, API_PREFIX + path);
    return fetch(url, {
      method: init.method || 'GET',
      headers: headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller ? controller.signal : undefined
    }).then(function (resp) {
      if (timer) clearTimeout(timer);
      return resp.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = { detail: text }; }
        if (!resp.ok) {
          var err = new Error(detailText(data) || ('HTTP ' + resp.status));
          err.status = resp.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        var timeoutErr = new Error('请求超时');
        timeoutErr.status = 0;
        throw timeoutErr;
      }
      // fetch 在网络层失败时抛的是 TypeError，补一个 status=0 方便调用方判断"离线"
      if (err && err.status === undefined) err.status = 0;
      throw err;
    });
  };

  function detailText(data) {
    if (!data) return '';
    if (typeof data.detail === 'string') return data.detail;
    if (Array.isArray(data.detail) && data.detail.length) {
      return data.detail.map(function (d) { return d.msg || JSON.stringify(d); }).join('; ');
    }
    return '';
  }

  // ------------------------------------------------ 账号

  PuzzleClient.prototype.register = function (username, password, options) {
    var self = this;
    return this._fetch('/auth/register', {
      method: 'POST',
      anonymous: true,
      body: { username: username, password: password, guest: !!(options && options.guest) }
    }).then(function (data) { return self._adopt(data); });
  };

  PuzzleClient.prototype.login = function (username, password) {
    var self = this;
    return this._fetch('/auth/login', {
      method: 'POST',
      anonymous: true,
      body: { username: username, password: password }
    }).then(function (data) { return self._adopt(data); });
  };

  PuzzleClient.prototype._adopt = function (data) {
    this._writeAuth({ token: data.access_token, user: data.user, expiresIn: data.expires_in });
    return data.user;
  };

  PuzzleClient.prototype.logout = function () {
    this._writeAuth(null);
    return this;
  };

  /** 令牌还有效吗。顺带把服务端认为已失效的令牌清掉。 */
  PuzzleClient.prototype.refreshMe = function () {
    var self = this;
    if (!this.isLoggedIn()) return Promise.resolve(null);
    return this._fetch('/auth/me').then(function (user) {
      self._writeAuth(Object.assign({}, self._auth, { user: user }));
      return user;
    }).catch(function (err) {
      if (err.status === 401) self.logout();
      throw err;
    });
  };

  // ------------------------------------------------ 每日挑战

  /**
   * 领今天的题。返回的 puzzle 结构随游戏而异，见后端 app/games.py。
   * 登录用户会同时开启服务端计时（返回 timed: true）。
   */
  PuzzleClient.prototype.fetchDaily = function (options) {
    options = options || {};
    var query = [];
    var variant = options.variant || this.options.variant;
    if (variant) query.push('variant=' + encodeURIComponent(variant));
    if (options.date) query.push('date=' + encodeURIComponent(options.date));
    var path = '/daily/' + encodeURIComponent(this.options.game) +
      (query.length ? '?' + query.join('&') : '');
    return this._fetch(path);
  };

  /**
   * 交卷。solution 的结构随游戏而异。
   * 名次相关字段只有登录用户、且进了榜单时才有值。
   */
  PuzzleClient.prototype.submit = function (puzzleId, solution) {
    return this._fetch('/daily/' + encodeURIComponent(this.options.game) + '/submit', {
      method: 'POST',
      body: { puzzle_id: puzzleId, solution: solution }
    });
  };

  // ------------------------------------------------ 榜单

  PuzzleClient.prototype.leaderboard = function (options) {
    options = options || {};
    var query = ['scope=' + (options.scope === 'all' ? 'all' : 'daily')];
    if (options.limit) query.push('limit=' + options.limit);
    if (options.date) query.push('date=' + encodeURIComponent(options.date));
    var variant = options.variant || this.options.variant;
    if (variant) query.push('variant=' + encodeURIComponent(variant));
    return this._fetch('/leaderboard/' + encodeURIComponent(this.options.game) +
      '?' + query.join('&'));
  };

  PuzzleClient.prototype.myRank = function (options) {
    options = options || {};
    var query = ['scope=' + (options.scope === 'all' ? 'all' : 'daily')];
    if (options.date) query.push('date=' + encodeURIComponent(options.date));
    var variant = options.variant || this.options.variant;
    if (variant) query.push('variant=' + encodeURIComponent(variant));
    return this._fetch('/leaderboard/' + encodeURIComponent(this.options.game) +
      '/rank?' + query.join('&'));
  };

  PuzzleClient.prototype.stats = function (game) {
    return this._fetch('/stats/' + encodeURIComponent(game || this.options.game));
  };

  /** 叙事类游戏上报进度。 */
  PuzzleClient.prototype.reportEvent = function (kind, payload) {
    return this._fetch('/events/' + encodeURIComponent(this.options.game), {
      method: 'POST',
      body: { kind: kind, payload: payload || {} }
    });
  };

  /**
   * 叙事类游戏的全局分布：各结局被多少人走到、灯花收集度分布。
   * 只对 kind === 'narrative' 的游戏有效，判分游戏调用会得到 400。
   */
  PuzzleClient.prototype.narrativeStats = function (game, options) {
    options = options || {};
    var query = [];
    if (options.limit) query.push('limit=' + options.limit);
    return this._fetch('/stats/' + encodeURIComponent(game || this.options.game) +
      '/narrative' + (query.length ? '?' + query.join('&') : ''));
  };

  // ------------------------------------------------ 实时推送

  /**
   * 订阅榜单更新。连上先收一份快照，之后每次有人上榜都会收到新的完整快照。
   * 返回一个取消订阅的函数。断线会自动重连（指数退避）。
   *
   * 浏览器不支持 WebSocket 时返回一个空函数，调用方不用写分支。
   */
  PuzzleClient.prototype.watchLeaderboard = function (onSnapshot, onStatus) {
    var self = this;
    if (typeof WebSocket === 'undefined' || !this.options.game) {
      return function () {};
    }

    this._wsStopped = false;
    this._wsRetry = 0;
    this._wsOnSnapshot = onSnapshot;
    this._wsOnStatus = onStatus;

    function status(state, detail) {
      if (onStatus) { try { onStatus(state, detail); } catch (err) {} }
    }

    function connect() {
      if (self._wsStopped) return;
      var path = '/ws/leaderboard/' + encodeURIComponent(self.options.game);
      if (self.options.variant) path += '?variant=' + encodeURIComponent(self.options.variant);

      var sock;
      try {
        sock = new WebSocket(wsUrl(self.options.baseUrl, path));
      } catch (err) {
        return scheduleRetry();
      }
      self._ws = sock;
      status('connecting');

      sock.onopen = function () {
        self._wsRetry = 0;
        status('open');
        // 心跳：服务端只靠收消息判断连接是否还活着
        var beat = setInterval(function () {
          if (sock.readyState === 1) {
            try { sock.send('ping'); } catch (err) { clearInterval(beat); }
          } else {
            clearInterval(beat);
          }
        }, 20000);
        sock._beat = beat;
      };

      sock.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        if (msg && msg.type === 'leaderboard' && onSnapshot) {
          try { onSnapshot(msg); } catch (err) {}
        }
      };

      sock.onclose = function (ev) {
        if (sock._beat) clearInterval(sock._beat);
        if (self._ws === sock) self._ws = null;
        if (self._wsStopped) return;
        // 4004/4003 是"参数不对"，重连一万次也没用
        if (ev && (ev.code === 4004 || ev.code === 4003)) {
          status('unsupported', ev.reason);
          return;
        }
        status('closed');
        scheduleRetry();
      };

      sock.onerror = function () { /* onclose 会跟着触发，这里不用管 */ };
    }

    function scheduleRetry() {
      if (self._wsStopped) return;
      var delay = Math.min(
        self.options.reconnectBase * Math.pow(2, self._wsRetry),
        self.options.reconnectMax
      );
      self._wsRetry += 1;
      clearTimeout(self._wsTimer);
      self._wsTimer = setTimeout(connect, delay);
    }

    connect();

    return function stop() { self.stopWatching(); };
  };

  PuzzleClient.prototype.stopWatching = function () {
    this._wsStopped = true;
    clearTimeout(this._wsTimer);
    if (this._ws) {
      try { if (this._ws._beat) clearInterval(this._ws._beat); } catch (err) {}
      try { this._ws.onclose = null; this._ws.close(); } catch (err) {}
      this._ws = null;
    }
  };

  // ------------------------------------------------ 杂项

  PuzzleClient.prototype.isOnline = function () {
    return !!(typeof navigator === 'undefined' || navigator.onLine !== false);
  };

  /** 只探一下后端在不在，不抛异常。用来决定"要不要显示在线功能"。 */
  PuzzleClient.prototype.ping = function () {
    return this._fetch('/stats/overview').then(
      function () { return true; },
      function () { return false; }
    );
  };

  PuzzleClient.formatElapsed = elapsedText;

  return PuzzleClient;
});
