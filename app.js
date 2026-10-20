/* 道具贪吃蛇 · 渲染 / 输入 / 音频 / 主循环（依赖 game.js 暴露的 ItemSnake） */
(function () {
  'use strict';
  var G = window.ItemSnake;
  if (!G) { console.error('game.js 未加载'); return; }

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 道具外观与文案（颜色对齐 PRD §3）
  var ITEM_META = {
    apple:  { color: '#ff4d6d', glyph: '🍎', name: '普通苹果 +1长' },
    slow:   { color: '#38bdf8', glyph: '🐢', name: '减速 ×0.55 / 5s' },
    fast:   { color: '#fb923c', glyph: '🚀', name: '加速 ×1.7 / 5s' },
    shrink: { color: '#a855f7', glyph: '✂', name: '减身 −3节' },
    poison: { color: '#0b0b1a', glyph: '☠', name: '毒药 即死', ring: '#39ff14' },
    double: { color: '#f472b6', glyph: '✨', name: '双倍分数 ×2 / 8s' }
  };

  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');
  var stage = document.getElementById('stage');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var effectsEl = document.getElementById('effects');
  var legendEl = document.getElementById('legend');
  var ovReady = document.getElementById('ovReady');
  var ovPause = document.getElementById('ovPause');
  var ovOver = document.getElementById('ovOver');
  var overTitle = document.getElementById('overTitle');
  var overSub = document.getElementById('overSub');
  var overScore = document.getElementById('overScore');
  var overBest = document.getElementById('overBest');

  var BEST_KEY = 'itemsnake.best';
  var storedBest = 0;
  try { storedBest = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0; } catch (e) {}

  var params = new URLSearchParams(location.search);
  var seed = params.has('seed') ? (parseInt(params.get('seed'), 10) >>> 0) : (Date.now() >>> 0);
  var state = G.createGame({ seed: seed, best: storedBest });

  // ---- 画布尺寸（DPR 上限 2）----
  var cell = 0;
  function resize() {
    var rect = stage.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(rect.width * dpr));
    cv.height = Math.max(1, Math.round(rect.height * dpr));
    cell = cv.width / G.COLS;
  }
  window.addEventListener('resize', resize);

  // ---- 图例 ----
  (function buildLegend() {
    var order = ['apple', 'slow', 'fast', 'shrink', 'poison', 'double'];
    legendEl.innerHTML = '';
    order.forEach(function (k) {
      var m = ITEM_META[k];
      var div = document.createElement('div');
      div.className = 'item';
      var sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = m.ring ? '#0b0b1a' : m.color;
      sw.style.border = m.ring ? '2px solid ' + m.ring : 'none';
      var txt = document.createElement('span');
      txt.textContent = m.glyph + ' ' + m.name;
      div.appendChild(sw); div.appendChild(txt);
      legendEl.appendChild(div);
    });
  })();

  // ---- 音频（Web Audio 合成，无音频文件）----
  var AC = null;
  function audio() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (AC && AC.state === 'suspended') AC.resume();
    return AC;
  }
  function beep(freq, dur, type, vol) {
    var ac = audio(); if (!ac) return;
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.value = vol || 0.05;
    o.connect(g); g.connect(ac.destination);
    var t = ac.currentTime;
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur);
  }
  function sndEat(kind) {
    switch (kind) {
      case 'apple': beep(660, 0.08, 'square', 0.05); break;
      case 'slow': beep(300, 0.12, 'sine', 0.06); break;
      case 'fast': beep(900, 0.12, 'sawtooth', 0.05); break;
      case 'double': beep(990, 0.14, 'triangle', 0.05); break;
      case 'shrink': beep(210, 0.14, 'sine', 0.06); break;
      default: beep(520, 0.08, 'sine', 0.05);
    }
  }
  function sndDeath(kind) {
    if (kind === 'poison') { beep(140, 0.45, 'sawtooth', 0.09); beep(90, 0.5, 'square', 0.06); }
    else { beep(170, 0.32, 'sine', 0.07); }
  }

  // ---- 转向输入 ----
  var KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right'
  };
  function onKey(e) {
    var k = e.key;
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      if (state.status === 'ready' || state.status === 'over') beginOrRestart();
      else if (state.status === 'playing') G.pause(state);
      else if (state.status === 'paused') G.resume(state);
      syncOverlays();
      return;
    }
    if (k === 'r' || k === 'R') { beginOrRestart(); return; }
    var dir = KEYMAP[k];
    if (dir) {
      e.preventDefault();
      if (state.status === 'ready') G.start(state);
      G.turn(state, dir);
      audio();
    }
  }
  window.addEventListener('keydown', onKey);

  // 触屏滑动
  var pStart = null;
  stage.addEventListener('pointerdown', function (e) { pStart = { x: e.clientX, y: e.clientY, id: e.pointerId }; audio(); });
  stage.addEventListener('pointerup', function (e) {
    if (!pStart || pStart.id !== e.pointerId) return;
    var dx = e.clientX - pStart.x, dy = e.clientY - pStart.y;
    pStart = null;
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16) { // 轻点 = 开始/继续
      if (state.status === 'ready' || state.status === 'over') beginOrRestart();
      else if (state.status === 'paused') G.resume(state);
      syncOverlays();
      return;
    }
    var dir;
    if (Math.abs(dx) > Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
    if (state.status === 'ready') G.start(state);
    G.turn(state, dir);
  });
  stage.addEventListener('pointercancel', function () { pStart = null; });

  document.getElementById('btnStart').addEventListener('click', function () { audio(); beginOrRestart(); });
  document.getElementById('btnRestart').addEventListener('click', function () { audio(); beginOrRestart(); });

  function beginOrRestart() {
    if (state.status === 'over') G.restart(state, (Date.now() >>> 0));
    else if (state.status === 'ready') G.start(state);
    else if (state.status === 'paused') G.resume(state);
    syncOverlays();
  }

  // 切后台自动暂停
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.status === 'playing') { G.pause(state); syncOverlays(); }
  });
  window.addEventListener('blur', function () {
    if (state.status === 'playing') { G.pause(state); syncOverlays(); }
  });

  // ---- 遮罩同步 ----
  function syncOverlays() {
    ovReady.hidden = state.status !== 'ready';
    ovPause.hidden = state.status !== 'paused';
    var over = state.status === 'over';
    ovOver.hidden = !over;
    if (over) {
      var causeMap = { wall: '撞到了边界', self: '咬到了自己', poison: '吃到了毒药 ☠' };
      overTitle.textContent = '游戏结束';
      overSub.textContent = (causeMap[state.cause] || '游戏结束') + ' · 按 R 重新开始';
      overScore.textContent = state.score;
      overBest.hidden = !state.newBest;
    }
  }

  // ---- HUD 效果条 ----
  function renderEffects() {
    var chips = [];
    if (state.slow > 0) chips.push(effChip('slow', state.slow, G.SLOW_MS));
    if (state.fast > 0) chips.push(effChip('fast', state.fast, G.FAST_MS));
    if (state.double > 0) chips.push(effChip('double', state.double, G.DOUBLE_MS));
    if (!chips.length) { effectsEl.innerHTML = '<span class="chip empty">暂无激活效果</span>'; return; }
    effectsEl.innerHTML = chips.join('');
  }
  function effChip(kind, remain, total) {
    var m = ITEM_META[kind];
    var pct = Math.max(0, Math.min(1, remain / total)) * 100;
    return '<span class="chip" style="color:' + m.color + '">' +
      '<span class="dot" style="background:' + m.color + '"></span>' +
      m.glyph + ' ' + m.name.split(' ')[0] +
      '<span class="bar" style="width:' + pct + '%"></span></span>';
  }

  // ---- 渲染 ----
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawGrid() {
    ctx.fillStyle = '#0e0e22';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (var i = 1; i < G.COLS; i += 1) {
      var p = i * cell;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, cv.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(cv.width, p); ctx.stroke();
    }
  }

  function drawItem(it, now) {
    var m = ITEM_META[it.type];
    var x = it.x * cell, y = it.y * cell;
    var pad = cell * 0.14;
    var fade = 1;
    if (it.ttl < G.FADE_MS) fade = Math.max(0.2, it.ttl / G.FADE_MS);
    ctx.save();
    ctx.globalAlpha = fade;
    // 脉冲外圈
    if (!REDUCED) {
      var pulse = 0.5 + 0.5 * Math.sin(now / 260 + it.id);
      ctx.globalAlpha = fade * (0.18 + 0.22 * pulse);
      ctx.fillStyle = m.ring || m.color;
      roundRect(x - pad * 0.6, y - pad * 0.6, cell + pad * 1.2, cell + pad * 1.2, cell * 0.32);
      ctx.fill();
      ctx.globalAlpha = fade;
    }
    // 主体
    ctx.fillStyle = m.ring ? '#0b0b1a' : m.color;
    roundRect(x + pad, y + pad, cell - pad * 2, cell - pad * 2, cell * 0.28);
    ctx.fill();
    if (m.ring) { ctx.lineWidth = Math.max(2, cell * 0.08); ctx.strokeStyle = m.ring; ctx.stroke(); }
    // 图标
    ctx.globalAlpha = fade;
    ctx.font = (cell * 0.62) + 'px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(m.glyph, x + cell / 2, y + cell / 2 + cell * 0.04);
    ctx.restore();
  }

  function drawSnake(alpha) {
    var snake = state.snake;
    var prev = state.prevSnake;
    for (var i = snake.length - 1; i >= 0; i -= 1) {
      var cur = snake[i];
      var pv = (prev && prev[i]) ? prev[i] : cur;
      var p = G.interpolate(pv, cur, alpha);
      var x = p.x * cell, y = p.y * cell;
      var pad = cell * 0.08;
      var t = i / Math.max(1, snake.length - 1);
      // 头亮尾暗
      var lum = 1 - t * 0.45;
      ctx.fillStyle = i === 0 ? '#7df3dc' : 'rgba(94,234,212,' + (0.55 + 0.45 * (1 - t)) + ')';
      if (!REDUCED) { ctx.shadowColor = '#5eead4'; ctx.shadowBlur = cell * 0.4 * lum; }
      roundRect(x + pad, y + pad, cell - pad * 2, cell - pad * 2, cell * 0.3);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (i === 0) drawEyes(p, alpha);
    }
  }
  function drawEyes(head, alpha) {
    var d = G.DIRS[state.dir];
    var cx = head.x * cell + cell / 2, cy = head.y * cell + cell / 2;
    var off = cell * 0.18, r = cell * 0.09;
    // 垂直于前进方向放置两只眼
    var ex = -d.y * off, ey = d.x * off;
    ctx.fillStyle = '#0b0b1a';
    ctx.beginPath(); ctx.arc(cx + ex, cy + ey, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx - ex, cy - ey, r, 0, Math.PI * 2); ctx.fill();
  }

  function render(now) {
    drawGrid();
    var alpha = (state.status === 'playing' && !REDUCED) ? Math.max(0, Math.min(1, state.stepAcc / G.currentStepMs(state))) : 1;
    if (state.apple) drawItem({ type: 'apple', x: state.apple.x, y: state.apple.y, id: 0, ttl: 99999 }, now);
    for (var i = 0; i < state.items.length; i += 1) drawItem(state.items[i], now);
    drawSnake(alpha);
  }

  // ---- 主循环（在 app 内推进，以便逐格触发音效）----
  var last = 0;
  function frame(now) {
    if (!last) last = now;
    var dt = now - last; last = now;
    if (dt > 100) dt = 100; // 防止后台切回后暴步
    if (state.status === 'playing') {
      G.updateTimers(state, dt);
      if (state.alive) {
        state.stepAcc += dt;
        var interval = G.currentStepMs(state);
        var guard = 0;
        while (state.stepAcc >= interval && state.alive && state.status === 'playing') {
          state.stepAcc -= interval;
          var res = G.step(state);
          if (res.ate) sndEat(res.ate);
          if (res.died) { sndDeath(res.died); onDeath(); }
          interval = G.currentStepMs(state);
          if (++guard > 8) { state.stepAcc = 0; break; }
        }
      }
    }
    scoreEl.textContent = state.score;
    bestEl.textContent = state.best;
    renderEffects();
    render(now);
    syncOverlays();
    requestAnimationFrame(frame);
  }

  function onDeath() {
    if (state.newBest) {
      try { localStorage.setItem(BEST_KEY, String(state.best)); } catch (e) {}
    }
  }

  // ---- 演示模式（?demo=1 预置全部道具，便于截图/预览）----
  if (params.get('demo')) {
    state.apple = { x: 10, y: 4 };
    state.items = [
      { id: 1, type: 'slow', x: 4, y: 6, ttl: G.SPECIAL_TTL_MS },
      { id: 2, type: 'fast', x: 16, y: 6, ttl: G.SPECIAL_TTL_MS },
      { id: 3, type: 'shrink', x: 4, y: 15, ttl: G.SPECIAL_TTL_MS },
      { id: 4, type: 'poison', x: 16, y: 15, ttl: G.SPECIAL_TTL_MS },
      { id: 5, type: 'double', x: 10, y: 17, ttl: G.SPECIAL_TTL_MS }
    ];
    state.slow = G.SLOW_MS; state.fast = G.FAST_MS; state.double = G.DOUBLE_MS;
    G.start(state);
  }

  resize();
  syncOverlays();
  renderEffects();
  requestAnimationFrame(frame);

  // 暴露给自测页 / 无头脚本
  window.__snake = { state: state, G: G, beginOrRestart: beginOrRestart };
})();
