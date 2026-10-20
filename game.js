/* Snake.io 风格 · 道具贪吃蛇 — 纯模拟层。
 * 无 DOM、无计时器、可注入种子。渲染与输入在 app.js。
 *
 * 实体/道具（见 PRD §3）：
 *   apple  普通苹果  +1 分、蛇 +1 长
 *   slow   减速食物  速度 ×0.55，持续 5s
 *   fast   加速食物  速度 ×1.70，持续 5s
 *   shrink 减身食物  立即缩短 3 节（下限 3）
 *   poison 毒药     吃到立即结束
 *   double 双倍分数 得分 ×2，持续 8s
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ItemSnake = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- 网格 / 基础参数 ----
  var COLS = 21;
  var ROWS = 21;
  var START_LEN = 3;
  var BASE_MS = 140;   // 长度 3 时每格耗时
  var MIN_MS = 70;     // 加速封顶（长度到 RAMP_LEN 后不再变快）
  var RAMP_LEN = 26;   // 26 节及以上速度封顶
  var BUFFER = 2;      // 输入缓冲：可预存 2 个转向

  // ---- 道具参数 ----
  var SLOW_MS = 5000;
  var FAST_MS = 5000;
  var DOUBLE_MS = 8000;
  var SLOW_MUL = 0.55;   // 速度倍率（<1 变慢）
  var FAST_MUL = 1.70;   // 速度倍率（>1 变快）
  var SHRINK_AMOUNT = 3; // 减身食物移除的节数（下限 START_LEN）

  // ---- 生成器参数 ----
  var MAX_SPECIAL = 4;        // 场上特殊道具同时存在的上限
  var SPAWN_INTERVAL_MS = 2600; // 每隔多久尝试生成一个特殊道具
  var SPECIAL_TTL_MS = 13000;   // 特殊道具存活时间，到期消失
  var FADE_MS = 3000;           // 最后 3s 淡出提示

  // 特殊道具生成权重（poison 略低以保证公平）
  var WEIGHTS = { slow: 18, fast: 18, shrink: 16, double: 14, poison: 12 };

  var DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  // mulberry32：同一 seed 可复现同一局
  function makeRandom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 长度决定的基础步进间隔（不含速度道具）
  function stepMsFor(length) {
    var span = RAMP_LEN - START_LEN;
    var t = (length - START_LEN) / span;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return Math.round(BASE_MS - t * (BASE_MS - MIN_MS));
  }

  function cellsPerSecond(length) {
    return 1000 / stepMsFor(length);
  }

  // 当前实际步进间隔（含速度道具）
  function currentStepMs(state) {
    var base = stepMsFor(state.snake.length);
    if (state.fast > 0) return Math.round(base / FAST_MUL);
    if (state.slow > 0) return Math.round(base / SLOW_MUL);
    return base;
  }

  function scoreMul(state) {
    return state.double > 0 ? 2 : 1;
  }

  function weightedType(rand) {
    var total = 0, k;
    for (k in WEIGHTS) total += WEIGHTS[k];
    var r = rand() * total;
    for (k in WEIGHTS) {
      r -= WEIGHTS[k];
      if (r <= 0) return k;
    }
    return 'slow';
  }

  function createGame(options) {
    var opts = options || {};
    var seed = typeof opts.seed === 'number' ? opts.seed >>> 0 : (Date.now() >>> 0);
    var rand = makeRandom(seed);

    var startY = ROWS >> 1;
    var startX = Math.floor(COLS / 2) - 1;
    var snake = [];
    var i;
    for (i = 0; i < START_LEN; i += 1) {
      snake.push({ x: startX - i, y: startY });
    }

    var state = {
      cols: COLS,
      rows: ROWS,
      seed: seed,
      rand: rand,
      status: 'ready', // ready | playing | paused | over
      snake: snake,
      dir: 'right',
      queue: [],
      prevSnake: null, // 上一步快照，供渲染插值
      score: 0,
      apples: 0,
      alive: true,
      cause: null,     // wall | self | poison | null
      steps: 0,
      apple: null,
      items: [],       // 特殊道具数组
      nextId: 1,
      slow: 0,         // 剩余毫秒
      fast: 0,
      double: 0,
      spawnAcc: 0,     // 生成计时累加
      stepAcc: 0,      // 步进计时累加（app 用）
      best: typeof opts.best === 'number' ? opts.best : 0,
      newBest: false
    };

    state.apple = spawnApple(state);
    return state;
  }

  function isOccupied(state, x, y) {
    var i;
    if (state.apple && state.apple.x === x && state.apple.y === y) return true;
    for (i = 0; i < state.items.length; i += 1) {
      if (state.items[i].x === x && state.items[i].y === y) return true;
    }
    for (i = 0; i < state.snake.length; i += 1) {
      if (state.snake[i].x === x && state.snake[i].y === y) return true;
    }
    return false;
  }

  function pickFreeCell(state) {
    var free = [];
    var x, y;
    for (y = 0; y < state.rows; y += 1) {
      for (x = 0; x < state.cols; x += 1) {
        if (!isOccupied(state, x, y)) free.push({ x: x, y: y });
      }
    }
    if (!free.length) return null;
    var idx = Math.floor(state.rand() * free.length);
    if (idx >= free.length) idx = free.length - 1;
    return free[idx];
  }

  function spawnApple(state) {
    state.apple = pickFreeCell(state);
    return state.apple;
  }

  function spawnSpecial(state) {
    if (state.items.length >= MAX_SPECIAL) return null;
    var cell = pickFreeCell(state);
    if (!cell) return null;
    var item = {
      id: state.nextId++,
      type: weightedType(state.rand),
      x: cell.x,
      y: cell.y,
      ttl: SPECIAL_TTL_MS
    };
    state.items.push(item);
    return item;
  }

  // 返回 'ok' | 'reverse' | 'duplicate' | 'buffer_full' | 'invalid'
  function turn(state, dir) {
    if (!DIRS[dir]) return 'invalid';
    var last = state.queue.length ? state.queue[state.queue.length - 1] : state.dir;
    if (dir === last) return 'duplicate';
    if (OPPOSITE[dir] === last) return 'reverse';
    if (state.queue.length >= BUFFER) return 'buffer_full';
    state.queue.push(dir);
    return 'ok';
  }

  function itemAt(state, x, y) {
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].x === x && state.items[i].y === y) return state.items[i];
    }
    return null;
  }

  // 前进一个逻辑步（一个格子）。死亡后幂等。
  function step(state) {
    if (!state.alive || state.status !== 'playing') {
      return { moved: false, died: null };
    }

    if (state.queue.length) state.dir = state.queue.shift();

    var delta = DIRS[state.dir];
    var head = state.snake[0];
    var nx = head.x + delta.x;
    var ny = head.y + delta.y;

    // 撞墙
    if (nx < 0 || ny < 0 || nx >= state.cols || ny >= state.rows) {
      state.alive = false;
      state.status = 'over';
      state.cause = 'wall';
      finalizeBest(state);
      return { moved: false, died: 'wall' };
    }

    var eatingApple = !!(state.apple && state.apple.x === nx && state.apple.y === ny);
    var hitItem = itemAt(state, nx, ny);

    // 撞自身：尾巴本步会让位（除非变长），进入尾巴格合法
    var limit = eatingApple ? state.snake.length : state.snake.length - 1;
    var i;
    for (i = 0; i < limit; i += 1) {
      if (state.snake[i].x === nx && state.snake[i].y === ny) {
        state.alive = false;
        state.status = 'over';
        state.cause = 'self';
        finalizeBest(state);
        return { moved: false, died: 'self' };
      }
    }

    state.prevSnake = cloneSnake(state.snake);
    state.snake.unshift({ x: nx, y: ny });

    var ate = null;

    if (eatingApple) {
      state.score += 1 * scoreMul(state);
      state.apples += 1;
      ate = 'apple';
      spawnApple(state); // 苹果被吃立即补一个新苹果
    } else {
      state.snake.pop(); // 正常前进移除尾节
    }

    if (hitItem) {
      ate = hitItem.type;
      applyItem(state, hitItem);
      removeItem(state, hitItem.id);
    }

    state.steps += 1;
    return { moved: true, ate: ate, died: null };
  }

  function applyItem(state, item) {
    switch (item.type) {
      case 'slow':
        state.slow = SLOW_MS;
        state.fast = 0; // 速度类互斥
        break;
      case 'fast':
        state.fast = FAST_MS;
        state.slow = 0;
        break;
      case 'double':
        state.double = DOUBLE_MS;
        break;
      case 'shrink': {
        // 此时已执行过「正常前进移除尾节」，故当前长度即步进前长度 L。
        // 再额外移除若干节，使净缩短 SHRINK_AMOUNT，且最终长度不低于 START_LEN。
        var cur = state.snake.length;
        var pops = Math.min(SHRINK_AMOUNT, cur - START_LEN);
        for (var p = 0; p < pops; p += 1) state.snake.pop();
        break;
      }
      case 'poison':
        state.alive = false;
        state.status = 'over';
        state.cause = 'poison';
        finalizeBest(state);
        break;
      default:
        break;
    }
  }

  function removeItem(state, id) {
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].id === id) {
        state.items.splice(i, 1);
        return;
      }
    }
  }

  function finalizeBest(state) {
    if (state.score > state.best) {
      state.best = state.score;
      state.newBest = true;
    }
  }

  // 老化计时器 + 特殊道具生成（由 app 每帧调用，dt 毫秒）
  function updateTimers(state, dtMs) {
    if (state.status !== 'playing') return;
    if (state.slow > 0) { state.slow = Math.max(0, state.slow - dtMs); }
    if (state.fast > 0) { state.fast = Math.max(0, state.fast - dtMs); }
    if (state.double > 0) { state.double = Math.max(0, state.double - dtMs); }

    // 道具到期消失（最后 FADE_MS 仅用于渲染淡出）
    for (var i = state.items.length - 1; i >= 0; i -= 1) {
      state.items[i].ttl -= dtMs;
      if (state.items[i].ttl <= 0) state.items.splice(i, 1);
    }

    // 周期生成特殊道具
    state.spawnAcc += dtMs;
    if (state.spawnAcc >= SPAWN_INTERVAL_MS) {
      state.spawnAcc = 0;
      spawnSpecial(state);
    }
  }

  // app 主循环：按真实 dt 推进步进 + 老化
  function advance(state, dtMs) {
    if (state.status !== 'playing') return;
    updateTimers(state, dtMs);
    if (!state.alive) return;
    state.stepAcc += dtMs;
    var interval = currentStepMs(state);
    var guard = 0;
    while (state.stepAcc >= interval && state.alive && state.status === 'playing') {
      state.stepAcc -= interval;
      step(state);
      interval = currentStepMs(state);
      guard += 1;
      if (guard > 8) { state.stepAcc = 0; break; } // 防止长时间卡顿后暴步
    }
  }

  function start(state) {
    if (state.status === 'ready' || state.status === 'over') {
      // 直接开始当前局（over 时由 restart 重置）
      if (state.status === 'over') return;
      state.status = 'playing';
    } else if (state.status === 'paused') {
      state.status = 'playing';
    }
  }

  function pause(state) {
    if (state.status === 'playing') state.status = 'paused';
  }

  function resume(state) {
    if (state.status === 'paused') state.status = 'playing';
  }

  function restart(state, seed) {
    var best = state.best;
    var fresh = createGame({ seed: seed, best: best });
    var keys = Object.keys(fresh);
    for (var i = 0; i < keys.length; i += 1) state[keys[i]] = fresh[keys[i]];
    state.status = 'playing';
  }

  function cloneSnake(snake) {
    var out = new Array(snake.length);
    for (var i = 0; i < snake.length; i += 1) out[i] = { x: snake[i].x, y: snake[i].y };
    return out;
  }

  function interpolate(prev, next, alpha) {
    if (!prev) return { x: next.x, y: next.y };
    var a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    return {
      x: prev.x + (next.x - prev.x) * a,
      y: prev.y + (next.y - prev.y) * a
    };
  }

  return {
    COLS: COLS, ROWS: ROWS, START_LEN: START_LEN,
    BASE_MS: BASE_MS, MIN_MS: MIN_MS, RAMP_LEN: RAMP_LEN, BUFFER: BUFFER,
    SLOW_MS: SLOW_MS, FAST_MS: FAST_MS, DOUBLE_MS: DOUBLE_MS,
    SLOW_MUL: SLOW_MUL, FAST_MUL: FAST_MUL, SHRINK_AMOUNT: SHRINK_AMOUNT,
    MAX_SPECIAL: MAX_SPECIAL, SPAWN_INTERVAL_MS: SPAWN_INTERVAL_MS,
    SPECIAL_TTL_MS: SPECIAL_TTL_MS, FADE_MS: FADE_MS, WEIGHTS: WEIGHTS,
    DIRS: DIRS, OPPOSITE: OPPOSITE,
    makeRandom: makeRandom,
    stepMsFor: stepMsFor,
    cellsPerSecond: cellsPerSecond,
    currentStepMs: currentStepMs,
    scoreMul: scoreMul,
    createGame: createGame,
    spawnApple: spawnApple,
    spawnSpecial: spawnSpecial,
    turn: turn,
    step: step,
    updateTimers: updateTimers,
    advance: advance,
    start: start, pause: pause, resume: resume, restart: restart,
    cloneSnake: cloneSnake,
    interpolate: interpolate
  };
});
