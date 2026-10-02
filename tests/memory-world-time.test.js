const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const json = value => JSON.parse(JSON.stringify(value));

function fixture() {
  let now = Date.parse('2026-10-01T22:11:00+08:00');
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const storage = new Map();
  const localStorage = { getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const hooks = {}, requests = [], writes = [];
  const chat = { id: 'a', name: 'A', originalName: 'A', settings: { memoryMode: 'vector' },
    history: [{ role: 'user', content: '旧聊天', timestamp: Date.parse('2026-09-01T12:00:00+08:00') }] };
  const state = { activeChatId: 'a', chats: { a: chat }, globalSettings: { id: 'main' }, worldBooks: [],
    apiConfig: { proxyUrl: 'https://mock.invalid', apiKey: 'mock', model: 'mock' } };
  const db = { chats: { hook: (name, fn) => { hooks[name] = fn; }, put: async value => { writes.push(json(value)); } },
    globalSettings: { put: async value => { writes.push(json(value)); } } };
  const document = { getElementById: () => null, createElement: () => ({ textContent: '', get innerHTML() {
    return this.textContent.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); } }) };
  const context = vm.createContext({ Date: ClockDate, Intl, Map, WeakMap, WeakSet, Set, AbortController, setTimeout, clearTimeout,
    setInterval, clearInterval, localStorage, document, db, state, window: { state, db },
    console: { log() {}, error() {}, warn() {} }, showToast() {}, showCustomConfirm: async () => true,
    openManualSummaryModal() {}, closeManualSummaryModal() {}, executeManualSummary() {}, convertLongTermMemoryToVector() {}, handleExportLongTermMemory() {},
    fetch: async (url, request) => {
      requests.push(JSON.parse(request.body));
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify([
        { content: '我们一起去了图书馆', category: 'E', tags: ['图书馆'], sourceMessageIds: [1], timeBasis: 'message' }
      ]) } }] }) };
    } });
  for (const file of ['extraction-support', 'vector-memory', 'extraction-runner', 'variable-memory-summary', 'summary-orchestration', 'world-memory-time', 'world-memory-time-ui']) {
    vm.runInContext(read(`modules/memory/${file}.js`), context);
  }
  const e = context.window.MemoryWorldTime, s = context.window.MemoryExtractionSupport, manager = context.window.vectorMemoryManager;
  manager.getEmbedding = async () => null;
  function world(value = '2021-10-16T10:00', paused = false, rate = 1) {
    e.flush();
    const date = new Date(value);
    for (const [key, data] of Object.entries({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      hour: date.getHours(), minute: date.getMinutes(), anchor: now, enabled: true, paused, rate })) localStorage.setItem(`custom-time-${key}`, data);
    localStorage.setItem('custom-time-paused-value', date.getTime());
  }
  function push(content = '今天一起去图书馆', extra = {}) {
    const message = { role: 'user', content, timestamp: now, ...extra };
    chat.history.push(message); return message;
  }
  function resolve(message, basis = 'message', extra = {}) {
    return s.resolveTime({ content: message.content, category: 'E', sourceMessageIds: [1], timeBasis: basis, ...extra }, [message]);
  }
  e.observe(chat);
  return { context, e, s, manager, chat, state, db, hooks, storage, localStorage, requests, writes, world, push, resolve,
    tick: ms => { now += ms; }, now: () => now };
}

test('新消息自动保存世界快照，旧消息、现实排序和提取源编号保持原样', () => {
  const f = fixture(); const old = json(f.chat.history[0]); f.world();
  const message = f.push(); const timestamp = message.timestamp;
  assert.equal(message.memoryClock.timeSource, 'world');
  assert.equal(f.e.toInput(message.memoryClock.worldTime, message.memoryClock.timeZone), '2021-10-16T10:00');
  assert.equal(message.timestamp, timestamp);
  assert.deepEqual(json(f.chat.history[0]), old);
  assert.equal(Object.keys(f.chat.history).includes('push'), false);
  assert.equal(JSON.stringify(f.chat.history).includes('function'), false);
  assert.equal(f.s.sourceKey(message), f.s.sourceKey({ ...message, memoryClock: undefined }));
});

test('暂停、加速、时间倒退和延迟提取不会改写已保存的日期', () => {
  const f = fixture(); f.world(); const first = f.push(); f.tick(3600000);
  assert.equal(f.e.toInput(f.e.clock(f.chat).time, f.e.clock(f.chat).timeZone), '2021-10-16T11:00');
  f.world('2021-11-20T08:00', true); const paused = f.push(); f.tick(86400000);
  assert.equal(f.resolve(paused).memoryTime, paused.memoryClock.worldTime);
  f.world('2020-01-01T08:00', false, 2); f.tick(3600000); const later = f.push();
  assert.equal(f.e.toInput(later.memoryClock.worldTime, later.memoryClock.timeZone), '2020-01-01T10:00');
  assert.equal(f.e.toInput(f.resolve(first).memoryTime, first.memoryClock.timeZone), '2021-10-16T10:00');
});

test('开关只影响之后消息，关闭自定义时间时自然使用现实时间', async () => {
  const f = fixture(); f.world(); const first = f.push();
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), linked: false });
  f.tick(60000); const real = f.push();
  assert.equal(f.resolve(first).memoryTime, first.memoryClock.worldTime);
  assert.equal(f.resolve(real).memoryTime, real.timestamp);
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), linked: true });
  f.localStorage.setItem('custom-time-enabled', 'false'); f.tick(60000); const fallback = f.push();
  assert.equal(f.resolve(fallback).memoryTime, fallback.timestamp);
});

test('相对日期以来源消息世界日期计算；未知、剧情纪年和明示日期各自保留', async () => {
  const f = fixture(); f.world('2021-03-01T00:05');
  const message = f.push('昨天一起去图书馆'); const yesterday = f.resolve(message, 'relative');
  assert.match(f.s.formatTime(yesterday), /2021\/02\/28/); assert.ok(!f.s.formatTime(yesterday).includes('12:00'));
  assert.equal(f.resolve(f.push('以前去过图书馆'), 'unknown').memoryTime, null);
  const explicit = f.resolve(f.push('2020年5月1日我们认识'), 'explicit');
  assert.match(f.s.formatTime(explicit), /2020\/05\/01/);
  const fiction = f.resolve(f.push('王历三年在城门相遇'), 'fictional', { eventTimeText: '王历三年' });
  assert.equal(f.s.formatTime(fiction), '剧情时间：王历三年');
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), explicitPriority: 'world', undated: 'unknown' });
  const priority = f.resolve(f.push('2020年5月1日我们认识'), 'explicit');
  assert.match(f.s.formatTime(priority), /2021\/03\/01/);
  assert.equal(f.resolve(f.push('现在一起喝茶')).memoryTime, null);
});

test('独立时区跨日、月底、闰日、夏令时和不存在的时刻均按真实日历处理', async () => {
  const f = fixture(); const timeZone = 'America/New_York';
  const anchorTime = f.e.parseInput('2024-03-11T00:15', timeZone);
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), clockMode: 'independent',
    clock: { anchorTime, anchorReal: f.now(), timeZone, rate: 1, paused: false } });
  const relative = f.resolve(f.push('昨天一起看电影'), 'relative');
  assert.match(f.s.formatTime(relative), /2024\/03\/10/);
  assert.throws(() => f.e.parseInput('2024-03-10T02:30', timeZone), /不存在/);
  assert.throws(() => f.e.parseInput('2024-02-30T08:00', timeZone), /不存在/);
  assert.equal(f.e.toInput(f.e.parseInput('2024-02-29T23:59', 'UTC'), 'UTC'), '2024-02-29T23:59');
  assert.equal(f.e.customTime(f.chat).day, 11);
});

test('提出计划与执行时间分开；日期未指定时分不显示伪造的中午', async () => {
  const f = fixture(); f.world();
  const message = f.push('明天一起去看电影');
  const plan = f.resolve(message, 'relative', { category: 'P' });
  assert.equal(plan.memoryTime, message.memoryClock.worldTime);
  assert.match(f.s.formatTime(plan), /计划执行：2021\/10\/17）/);
  const exact = f.resolve(f.push('明天下午三点半一起看电影'), 'message', { category: 'P' });
  assert.equal(f.e.toInput(exact.plannedTime, exact.memoryTimeZone), '2021-10-17T15:30');
  assert.equal(exact.plannedTimePrecision, 'minute');
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), relativeBasis: 'real' });
  const real = f.push('明天一起看电影');
  const configured = f.resolve(real, 'message', { category: 'P' });
  assert.equal(configured.memoryTime, real.memoryClock.worldTime);
  assert.match(f.s.formatTime(configured), /计划执行：2026\/10\/02/);
});

test('全球默认与聊天覆盖可切换，规则快照不会随之后设置改变', async () => {
  const f = fixture(); f.world(); const first = f.push('昨天旅行');
  await f.e.saveGlobal({ linked: false, halfLifeDays: 10 });
  assert.equal(f.e.config(f.chat).linked, false);
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), linked: true, relativeBasis: 'real' });
  assert.equal(f.e.config(f.chat).linked, true);
  assert.match(f.s.formatTime(f.resolve(f.push('昨天旅行'), 'relative')), /2026\/09\/30/);
  assert.match(f.s.formatTime(f.resolve(first, 'relative')), /2021\/10\/15/);
  await f.e.saveConfig(f.chat, { inherit: true }); assert.equal(f.e.config(f.chat).linked, false);
});

test('新增时间线的经历不误合并；设定和事件可分别选择共享', async () => {
  const f = fixture(); f.world();
  const fragment = f.resolve(f.push());
  const id = f.manager.createFragment(f.chat, { ...fragment, content: '图书馆共同经历', category: 'E', tags: ['图书馆'] });
  const previous = f.manager.getFragment(f.chat, id);
  const coreId = f.manager.addCoreMemory(f.chat, '共同设定');
  const oldId = f.manager.createFragment(f.chat, { content: '旧核心', category: 'C' });
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), timelineId: 'parallel', timelineName: '平行世界', includeOtherEvents: false, shareFacts: true });
  assert.equal(f.e.visible(f.chat, previous), false);
  assert.equal(f.e.visible(f.chat, f.manager.getFragment(f.chat, coreId)), true);
  assert.equal(f.e.visible(f.chat, f.manager.getFragment(f.chat, oldId)), true);
  const next = f.resolve(f.push());
  assert.equal(f.manager._isLikelyDuplicate(f.chat, { ...next, content: previous.content, category: 'E' }, previous), false);
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), shareFacts: false });
  assert.ok(!f.manager.serializeCoreMemories(f.chat).includes('共同设定'));
  assert.ok(f.manager.serializeCoreMemories(f.chat).includes('旧核心'));
  assert.throws(() => f.s.resolveTime({ timeBasis: 'message', sourceMessageIds: [1, 2] }, [f.chat.history[1], f.chat.history.at(-1)]), /不同时间线/);
});

test('同一天的新记忆按世界时间衰减，关闭衰减或改用现实时间都可配置', async () => {
  const f = fixture(); f.world();
  const fragment = f.resolve(f.push());
  assert.equal(f.e.decay(f.chat, fragment), 1);
  f.tick(30 * 86400000); assert.ok(Math.abs(f.e.decay(f.chat, fragment) - 0.5) < 0.001);
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), decayBasis: 'off' });
  assert.equal(f.e.decay(f.chat, fragment), 1);
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), decayBasis: 'real', halfLifeDays: 30 });
  assert.ok(Math.abs(f.e.decay(f.chat, fragment) - 0.5) < 0.001);
});

test('数据库补充新后台消息，编辑已有消息和读取导入数据均不会回填旧时间', () => {
  const f = fixture(); f.world();
  const previous = json(f.chat);
  const incoming = { role: 'assistant', content: '后台主动联系', timestamp: f.now() };
  const changes = { history: [...json(previous.history), incoming] };
  const result = f.hooks.updating(changes, f.chat.id, previous);
  assert.equal(result.history.at(-1).memoryClock.timeSource, 'world');
  const changedOld = { history: [{ ...previous.history[0], content: '改过的旧内容' }] };
  assert.equal(f.hooks.updating(changedOld, f.chat.id, previous), undefined);
  assert.equal(changedOld.history[0].memoryClock, undefined);
  const imported = { id: 'imported', settings: {}, history: [{ role: 'user', timestamp: f.now(), content: '导入原文' }] };
  f.hooks.reading(imported); f.e.flush(imported); assert.equal(imported.history[0].memoryClock, undefined);
});

test('语音、线下剧情、表情、群聊和隐藏背景消息都保存世界时间', () => {
  const f = fixture(); f.world(); f.chat.isGroup = true;
  for (const extra of [{ type: 'voice_message' }, { type: 'offline_text', dialogue: '一起喝茶' }, { type: 'sticker', meaning: '开心' },
    { role: 'assistant', senderName: 'B' }, { role: 'system', isHidden: true }]) {
    const message = f.push('今天在图书馆', extra);
    assert.equal(message.memoryClock.timeSource, 'world');
    assert.equal(f.resolve(message).memoryTime, message.memoryClock.worldTime);
  }
});

test('真实提取调用包含世界日期、保存日期、进度源和回忆提示保持一致', async () => {
  const f = fixture(); f.world(); const message = f.push();
  await f.context.executeVectorExtractionInBatches(f.chat, [message], true);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].messages[0].content, /2021\/10\/16/);
  assert.match(f.requests[0].messages[0].content, /世界时间/);
  const fragment = f.chat.variableMemory.fragments[0];
  assert.equal(fragment.memoryTime, message.memoryClock.worldTime);
  assert.equal(fragment.sourceEvidence[0].timestamp, message.timestamp);
  assert.equal(f.chat.variableMemory.settings.lastExtractedMsgIndex, 1);
  const prompt = await f.manager.serializeForPrompt(f.chat, '图书馆');
  assert.match(prompt, /2021\/10\/16/); assert.ok(!prompt.includes('2026/10/01'));
});

test('新记忆不会覆盖旧记忆；手动日期不会被自动更新覆盖', async () => {
  const f = fixture(); f.world();
  const entities = [{ canonical: '小明', type: 'person', aliases: [] }];
  const oldId = f.manager.createFragment(f.chat, { content: '和小明约定看电影', category: 'P', entities, memoryTime: Date.parse('2020-01-01') });
  const old = json(f.manager.getFragment(f.chat, oldId));
  const data = { ...f.resolve(f.push('明天和小明看电影'), 'relative', { category: 'P' }), content: '和小明约定看电影', category: 'P', entities, replacesMemoryId: oldId };
  await f.manager.mergeExtractedMemories(f.chat, [data]);
  assert.deepEqual(json(f.manager.getFragment(f.chat, oldId)), old);
  const newer = f.chat.variableMemory.fragments.at(-1);
  f.manager.editFragment(f.chat, newer.id, { memoryTime: Date.parse('2021-10-10T12:00:00+08:00') });
  const manual = newer.memoryTime;
  await f.manager.mergeExtractedMemories(f.chat, [{ ...data, replacesMemoryId: newer.id, content: '和小明已完成看电影', status: 'completed' }]);
  assert.equal(newer.memoryTime, manual); assert.equal(newer.status, 'completed');
});

test('备份和导入保留时区、世界快照、自动日期、时间线与规则', async () => {
  const f = fixture(); f.world();
  f.manager.createFragment(f.chat, { ...f.resolve(f.push()), content: '图书馆经历', category: 'E' });
  await f.e.saveConfig(f.chat, { ...f.e.config(f.chat), halfLifeDays: 17 });
  const exported = f.manager.exportMemory(f.chat); const imported = fixture();
  await imported.manager.importMemory(imported.chat, exported, 'replace');
  const fragment = imported.chat.variableMemory.fragments[0];
  assert.equal(fragment.memoryTime, f.chat.variableMemory.fragments[0].memoryTime);
  assert.equal(fragment.sourceEvidence[0].memoryClock.worldTime, fragment.memoryTime);
  assert.equal(fragment.automaticTime.memoryTime, fragment.memoryTime);
  assert.equal(imported.e.config(imported.chat).halfLifeDays, 17);
});

test('批量平移可撤销，日期不明跳过，写入失败回滚', async () => {
  const f = fixture(); f.world();
  const id = f.manager.createFragment(f.chat, { ...f.resolve(f.push()), content: '图书馆经历', category: 'E' });
  const unknown = f.manager.createFragment(f.chat, { content: '以前的经历', memoryTime: null });
  const before = f.manager.getFragment(f.chat, id).memoryTime;
  await f.e.shiftDates(f.chat, [id, unknown], 3);
  assert.equal(f.manager.getFragment(f.chat, id).memoryTime, before + 3 * 86400000);
  assert.equal(f.manager.getFragment(f.chat, unknown).memoryTime, null);
  await f.e.shiftDates(f.chat, [], 0, true);
  assert.equal(f.manager.getFragment(f.chat, id).memoryTime, before);
  f.db.chats.put = async () => { throw new Error('写入失败'); };
  await assert.rejects(f.e.shiftDates(f.chat, [id], 3), /写入失败/);
  assert.equal(f.manager.getFragment(f.chat, id).memoryTime, before);
});

test('现有 UI 入口和配置保留，新规则两处可达、默认收起且不增加未样式化控件', () => {
  const f = fixture();
  const settings = f.manager.renderSettingsPanel(f.chat);
  for (const id of ['vm-auto-interval', 'vm-extraction-batch', 'vm-extraction-batch-size', 'vm-extraction-detail', 'vm-custom-prompt', 'vm-topn', 'vm-save-settings-btn']) assert.ok(settings.includes(`id="${id}"`));
  const html = f.context.window.MemoryWorldTimeUI.render(f.chat);
  for (const attribute of ['data-memory-time="linked"', 'data-memory-time="scope"', 'data-memory-clock-apply', 'data-memory-time-new-timeline', 'data-memory-time-save-global']) assert.ok(html.includes(attribute));
  assert.ok(html.includes('data-memory-time-advanced hidden'));
  assert.ok(read('src/html/chat-settings-extra.html').includes('memory-time-settings-host'));
  assert.ok(read('src/js-bundles/event-bindings-a/console-and-worldbook-editor.jsfrag').includes('MemoryWorldTimeUI?.mount(chat)'));
});

test('世界时钟允许公历早于1970年，新记忆可显示而旧的0时间仍视为未知', () => {
  const f = fixture(); f.world('1900-01-01T08:00'); const fragment = f.resolve(f.push());
  assert.match(f.s.formatTime(fragment), /1900\/01\/01/);
  assert.equal(f.s.formatTime({ memoryTime: 0 }), '时间不明');
});

test('世界时间设置的倍率应用、暂停和恢复保持精确锚点；独立暂停不影响全局', () => {
  const f = fixture(); f.world('2021-10-16T10:00'); f.tick(45000);
  const nodes = new Map();
  f.context.document.getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, style: {}, dataset: {}, textContent: '',
      addEventListener(name, callback) { this[name] = callback; }, getAttribute() { return 'false'; }, setAttribute() {} });
    return nodes.get(id);
  };
  f.context.setInterval = () => 1; f.context.clearInterval = () => {};
  vm.runInContext(read('js/time-system.js'), f.context);
  const before = f.e.globalClock().time;
  f.context.window.TimeAwareness.setClockRate(2);
  assert.equal(f.e.globalClock().time, before);
  f.tick(60000); assert.equal(f.e.globalClock().time, before + 120000);
  nodes.get('custom-time-pause-btn').click();
  const paused = f.e.globalClock().time;
  f.tick(3600000); assert.equal(f.e.globalClock().time, paused);
  nodes.get('custom-time-pause-btn').click();
  assert.equal(f.e.globalClock().time, paused);
  f.tick(60000); assert.equal(f.e.globalClock().time, paused + 120000);
  f.chat.settings.memoryTime = { inherit: false, clockMode: 'independent', clock: { anchorTime: paused, anchorReal: f.now(),
    timeZone: 'UTC', paused: true, pausedAt: f.now() - 60000, pauseHistory: [], rate: 1 } };
  assert.equal(f.context.window.TimeAwareness.isWorldPaused(f.chat), true);
  assert.equal(f.context.window.TimeAwareness.isWorldPaused(), false);
  assert.equal(f.context.window.TimeAwareness.getPausedDurationBetween(f.now() - 120000, f.now(), f.chat), 60000);
});

test('完整导入后的日期撤销重新对应新编号，公历早年日期不丢失；坏时钟配置不改数据', async () => {
  const f = fixture(); f.world('1900-01-01T08:00');
  const id = f.manager.createFragment(f.chat, { ...f.resolve(f.push()), content: '早年的共同经历', category: 'E' });
  const before = f.manager.getFragment(f.chat, id).memoryTime;
  await f.e.shiftDates(f.chat, [id], 2);
  const exported = f.manager.exportMemory(f.chat);
  const imported = fixture(); await imported.manager.importMemory(imported.chat, exported, 'replace');
  const newId = imported.chat.variableMemory.fragments[0].id;
  assert.equal(imported.chat.variableMemory.timeShiftBackup[0].id, newId);
  assert.match(imported.s.formatTime(imported.chat.variableMemory.fragments[0]), /1900\/01\/03/);
  await imported.e.shiftDates(imported.chat, [], 0, true);
  assert.equal(imported.chat.variableMemory.fragments[0].memoryTime, before);
  const bad = JSON.parse(exported); bad.memoryTimeConfig = { clockMode: 'independent', clock: { timeZone: 'bad-zone' } };
  const snapshot = json(imported.chat.variableMemory);
  await assert.rejects(imported.manager.importMemory(imported.chat, JSON.stringify(bad), 'replace'), /独立时钟配置/);
  assert.deepEqual(json(imported.chat.variableMemory), snapshot);
});
