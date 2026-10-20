/* Node 逻辑断言（CommonJS）。运行：node test/node-test.js
 * 覆盖 PRD §9 验收剧本：6 种道具、计分翻倍、死亡归因、生成上限、输入缓冲、最高分。
 */
var G = require('../game.js');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; }
  else { fail += 1; console.error('  ✗ FAIL: ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name + ' (=' + b + ')', a === b, 'got ' + a); }

function placeItem(state, type, x, y) {
  state.items.push({ id: state.nextId++, type: type, x: x, y: y, ttl: G.SPECIAL_TTL_MS });
}
function headDir(state) { return G.DIRS[state.dir]; }

// 把苹果/道具放到蛇头正前方一格
function front(state) {
  var h = state.snake[0]; var d = headDir(state);
  return { x: h.x + d.x, y: h.y + d.y };
}

// ---------- 基础 ----------
(function () {
  var s = G.createGame({ seed: 12345 });
  eq('create: status', s.status, 'ready');
  eq('create: len', s.snake.length, G.START_LEN);
  ok('create: apple exists', !!s.apple);
  eq('create: items', s.items.length, 0);
})();

// ---------- 普通苹果：+1 分、+1 长、补新苹果 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var len0 = s.snake.length, sc0 = s.score;
  var f = front(s); s.apple = { x: f.x, y: f.y };
  var r = G.step(s);
  ok('apple: moved', r.moved);
  eq('apple: ate', r.ate, 'apple');
  eq('apple: score+1', s.score, sc0 + 1);
  eq('apple: len+1', s.snake.length, len0 + 1);
  ok('apple: respawned', !!s.apple);
})();

// ---------- 双倍分数：苹果 +2 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  s.double = G.DOUBLE_MS;
  eq('double: scoreMul', G.scoreMul(s), 2);
  var f = front(s); s.apple = { x: f.x, y: f.y };
  G.step(s);
  eq('double: apple+2', s.score, 2);
})();

// ---------- 减速：激活且步进间隔变大 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var base = G.currentStepMs(s);
  var f = front(s); placeItem(s, 'slow', f.x, f.y);
  G.step(s);
  ok('slow: activated', s.slow > 0);
  ok('slow: interval bigger', G.currentStepMs(s) > base, base + '→' + G.currentStepMs(s));
})();

// ---------- 加速：间隔变小 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var base = G.currentStepMs(s);
  var f = front(s); placeItem(s, 'fast', f.x, f.y);
  G.step(s);
  ok('fast: activated', s.fast > 0);
  ok('fast: interval smaller', G.currentStepMs(s) < base, base + '→' + G.currentStepMs(s));
})();

// ---------- 速度类互斥：吃到 fast 清除 slow ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var f = front(s); placeItem(s, 'slow', f.x, f.y); G.step(s);
  ok('mutex: slow set', s.slow > 0 && s.fast === 0);
  var f2 = front(s); placeItem(s, 'fast', f2.x, f2.y); G.step(s);
  ok('mutex: fast set, slow cleared', s.fast > 0 && s.slow === 0);
})();

// ---------- 减身：长度 -3（下限 3） ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  // 手动拉长到 10 节
  var tail = s.snake[s.snake.length - 1];
  for (var i = 0; i < 7; i += 1) s.snake.push({ x: tail.x, y: tail.y + 1 });
  var len0 = s.snake.length; // 10
  var f = front(s); placeItem(s, 'shrink', f.x, f.y);
  G.step(s);
  eq('shrink: len-3', s.snake.length, len0 - 3);
})();
(function () {
  // 最短蛇吃减身不应低于 3
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var len0 = s.snake.length; // 3
  var f = front(s); placeItem(s, 'shrink', f.x, f.y);
  G.step(s);
  ok('shrink: floor 3', s.snake.length >= G.START_LEN, 'len=' + s.snake.length);
  eq('shrink: no shrink at min', s.snake.length, len0);
})();

// ---------- 毒药：立即结束，cause=poison ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var f = front(s); placeItem(s, 'poison', f.x, f.y);
  var r = G.step(s);
  ok('poison: died', !s.alive);
  eq('poison: cause', s.cause, 'poison');
  eq('poison: status', s.status, 'over');
})();

// ---------- 撞墙 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  // 强制把蛇头放到左边界并向左
  s.dir = 'left'; s.queue = [];
  s.snake = [{ x: 0, y: 10 }, { x: 1, y: 10 }, { x: 2, y: 10 }];
  s.apple = { x: 5, y: 5 };
  var r = G.step(s);
  ok('wall: died', !s.alive && s.cause === 'wall');
})();

// ---------- 撞自身 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  // 头(5,5)向右到(6,5)；(6,5)是 body 第 4 节（非尾节，尾节为(6,4)会让位）
  s.dir = 'right'; s.queue = [];
  s.snake = [
    { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 },
    { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 6, y: 4 }
  ];
  s.apple = null;
  var r = G.step(s); // 头(5,5)->(6,5)，落入非尾身体节
  ok('self: died', !s.alive && s.cause === 'self', 'cause=' + s.cause);
})();

// ---------- 输入缓冲：拒绝反向、限制 2 个 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  s.dir = 'right'; s.queue = [];
  eq('buf: up ok', G.turn(s, 'up'), 'ok');            // 队列 [up]
  eq('buf: up duplicate', G.turn(s, 'up'), 'duplicate');
  eq('buf: down reverse', G.turn(s, 'down'), 'reverse'); // 相对 up 的反向
  eq('buf: left ok', G.turn(s, 'left'), 'ok');        // 队列 [up, left]
  eq('buf: full', G.turn(s, 'up'), 'buffer_full');    // 相对 left 非反向，但已达 2 个上限
})();

// ---------- 生成上限 MAX_SPECIAL ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  for (var i = 0; i < 20; i += 1) G.spawnSpecial(s);
  ok('spawn: capped at MAX', s.items.length <= G.MAX_SPECIAL, 'len=' + s.items.length);
})();

// ---------- 周期生成（一个间隔生成一个） ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var before = s.items.length;
  G.updateTimers(s, G.SPAWN_INTERVAL_MS + 1);
  ok('spawn: one per interval', s.items.length === before + 1, 'len=' + s.items.length);
})();

// ---------- 到期消失（用负 spawnAcc 避免生成干扰） ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  s.spawnAcc = -1e9;
  placeItem(s, 'slow', 10, 10);
  s.items[0].ttl = 100;
  G.updateTimers(s, 200);
  eq('spawn: expired', s.items.length, 0);
})();

// ---------- 计时老化：双倍 8s 后失效 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  s.double = G.DOUBLE_MS;
  G.updateTimers(s, G.DOUBLE_MS - 100);
  ok('age: double still on', s.double > 0);
  G.updateTimers(s, 200);
  eq('age: double off', s.double, 0);
})();

// ---------- 最高分结算 ----------
(function () {
  var s = G.createGame({ seed: 7, best: 5 }); s.status = 'playing';
  var f = front(s); s.apple = { x: f.x, y: f.y }; G.step(s); // score 1
  s.score = 9; // 模拟更高分
  s.alive = false; s.status = 'over'; s.cause = 'wall';
  // 触发 finalizeBest 通过一次死亡 step 不便，这里直接再走一遍死亡流程
  // 重新构造：用 restart 前的 best 校验
  ok('best: preserved best', s.best >= 5);
})();
(function () {
  var s = G.createGame({ seed: 7, best: 0 }); s.status = 'playing';
  s.score = 12; s.alive = false; s.status = 'over'; s.cause = 'self';
  // 用 step 触发 finalize：让 step 在死亡分支里结算
  // 把状态复位为 playing 并制造撞墙
  s.status = 'playing'; s.alive = true; s.cause = null;
  s.dir = 'left'; s.queue = [];
  s.snake = [{ x: 0, y: 10 }, { x: 1, y: 10 }, { x: 2, y: 10 }];
  s.apple = { x: 5, y: 5 };
  G.step(s);
  ok('best: newBest set', s.newBest === true);
  eq('best: best updated', s.best, 12);
})();

// ---------- advance：真实 dt 推进 ----------
(function () {
  var s = G.createGame({ seed: 7 }); s.status = 'playing';
  var len0 = s.snake.length;
  for (var i = 0; i < 50; i += 1) G.advance(s, 16); // ~800ms
  ok('advance: stepped', s.steps > 0, 'steps=' + s.steps);
  // 没有吃苹果时长度应保持不变
  ok('advance: len stable w/o food', s.snake.length === len0 || s.status === 'over');
})();

console.log('\n逻辑断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
