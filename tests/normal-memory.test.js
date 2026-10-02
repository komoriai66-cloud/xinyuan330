const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const chat = { id: 'a', name: '角色A', originalName: '角色A', settings: { memoryMode: 'diary' }, history: [], longTermMemory: options.memories || [
    { content: '我们约定2026年7月一起出去玩。', timestamp: Date.parse('2026-06-01T12:00:00+08:00'), source: 'auto' },
    { content: '2026年7月，我们已经完成旅行，旅行结束。', timestamp: Date.parse('2026-07-25T12:00:00+08:00'), source: 'auto' }
  ], normalMemory: { settings: { automatic: 'off', ...(options.settings || {}) }, entries: [], journal: [], task: null } };
  const requests = [], writes = [], notices = [];
  let failWrite = false;
  const context = vm.createContext({ Date, Math, Map, WeakMap, WeakSet, Set, Promise, AbortController, setTimeout, clearTimeout,
    window: {}, state: { chats: { a: chat }, activeChatId: 'a', qzoneSettings: {}, apiConfig: { proxyUrl: 'https://mock.invalid', apiKey: 'mock', model: 'mock' } },
    console: { warn() {}, log() {}, error() {} },
    showToast: (...args) => notices.push(args), showCustomConfirm: async () => true, showCustomPrompt: async () => '用户修改的记忆', renderLongTermMemoryList() {},
    db: { chats: { put: async value => { if (failWrite) { failWrite = false; throw new Error('写入失败'); } writes.push(copy(value)); } } },
    fetch: async (url, request) => {
      const body = JSON.parse(request.body); requests.push(body);
      const result = options.fetch ? await options.fetch(chat.normalMemory.task, requests.length, body, context, request) : oldTrip(chat.normalMemory.task);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) };
    }
  });
  vm.runInContext(read('modules/memory/normal-memory.js'), context);
  const manager = context.window.normalMemoryManager;
  manager.ensure(chat);
  return { chat, context, manager, requests, writes, notices, failNextWrite: () => { failWrite = true; } };
}
function update(task, values = {}) {
  const source = task.records[0];
  return { text: '我们曾约定七月出游，后来已经履行了这项约定。', status: 'completed', certainty: 'clear', eventTime: '2026年7月',
    sourceIds: task.records.map(r => r.id), replaces: [], evidence: task.records.map(r => ({ sourceId: r.id, kind: 'memory', quote: r.text })), note: '同一次旅行的约定与结果', ...values };
}
function oldTrip(task) { return { updates: [update(task)] }; }
function value(f, text = '手动确认的经历', sourceIds = f.chat.longTermMemory.map(m => m.normalMemoryId)) {
  return { text, status: 'fact', certainty: 'clear', eventTime: '时间不明', sourceIds };
}
async function settle(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('后台任务没有在预期的微任务周期内结束');
}

test('普通模式默认自动应用，可通过设置改为手动或关闭；其他记忆模式不触发整理', async () => {
  const f = fixture();
  assert.equal(f.manager.defaults.automatic, 'apply');
  assert.equal(f.manager.defaults.interpretation, true);
  await f.manager.saveSettings(f.chat, { ...f.manager.settings(f.chat), automatic: 'preview' });
  assert.equal(f.manager.settings(f.chat).automatic, 'preview');
  f.chat.settings.enableStructuredMemory = true;
  await f.manager.afterSummary(f.chat, f.chat.longTermMemory[0]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.manager.mode(f.chat), 'structured');
  f.chat.settings.memoryMode = 'vector';
  assert.equal(f.manager.mode(f.chat), 'vector');
});

test('旧约定与完成结果可合并成文字概况，原记录与聊天总结进度不变', async () => {
  const f = fixture(); f.chat.lastMemorySummaryTimestamp = 123;
  const before = copy(f.chat.longTermMemory);
  await f.manager.start(f.chat, null);
  const proposal = f.manager.proposals(f.chat)[0];
  assert.equal(proposal.autoEligible, false, '旧摘要缺少原聊天证据，状态变化应交由用户确认');
  await f.manager.apply(f.chat, [proposal.id]);
  assert.deepEqual(copy(f.chat.longTermMemory), before);
  assert.equal(f.chat.lastMemorySummaryTimestamp, 123);
  assert.equal(f.manager.active(f.chat)[0].status, 'completed');
  const prompt = f.manager.serialize(f.chat);
  assert.match(prompt, /曾约定七月出游，后来已经履行/);
  assert.match(prompt, /保存于 2026/);
  assert.match(prompt, /日期已过不能证明完成或未完成/);
  assert.match(prompt, /关联概况：已履行/);
});

test('关闭解释并只读历史时保持原正文与现有条数限制', () => {
  const f = fixture({ settings: { interpretation: false, readMode: 'history' } });
  f.chat.settings.limitLongTermMemory = true; f.chat.settings.longTermMemoryLimit = 1;
  assert.equal(f.manager.serialize(f.chat), '- 2026年7月，我们已经完成旅行，旅行结束。');
  const stamped = f.manager.serialize(f.chat, { includeTimestamp: true });
  assert.match(stamped, /2026/);
  assert.equal(f.manager.date(null), '时间不明');
});

test('默认概况加历史保留同一摘要中的其他约定与经历', async () => {
  const f = fixture({ memories: [{ content: '七月旅行结束；另约定八月去看演唱会。', timestamp: 10 }] });
  await f.manager.manual(f.chat, value(f, '七月旅行已经结束'));
  assert.match(f.manager.serialize(f.chat), /八月去看演唱会/);
  f.chat.normalMemory.settings.readMode = 'overview';
  assert.doesNotMatch(f.manager.serialize(f.chat), /另约定八月/);
  assert.equal(f.chat.longTermMemory[0].content, '七月旅行结束；另约定八月去看演唱会。');
});

test('不同旅行结果能分别选择，部分应用后仍可继续应用其他建议', async () => {
  const f = fixture({ fetch: async task => ({ updates: [update(task, { text: '七月旅行完成' }), update(task, { text: '八月约定仍待核对', status: 'uncertain', certainty: 'uncertain' })] }) });
  await f.manager.start(f.chat, null);
  const proposals = f.manager.proposals(f.chat);
  await f.manager.apply(f.chat, [proposals[0].id]);
  assert.equal(f.manager.proposals(f.chat).length, 1);
  assert.equal(f.manager.active(f.chat).length, 1);
  await f.manager.apply(f.chat, [proposals[1].id]);
  assert.equal(f.manager.proposals(f.chat).length, 0);
  assert.equal(f.manager.active(f.chat).length, 2);
});

test('建议可编辑正文、状态、时间和来源，再由用户选择应用', async () => {
  const f = fixture(); await f.manager.start(f.chat, null);
  const entry = f.manager.proposals(f.chat)[0];
  await f.manager.editProposal(f.chat, entry.id, { ...value(f, '这次旅行仅完成一部分'), status: 'ongoing' });
  await f.manager.apply(f.chat, [entry.id]);
  assert.equal(f.manager.active(f.chat)[0].status, 'ongoing');
  assert.equal(f.manager.active(f.chat)[0].text, '这次旅行仅完成一部分');
});

test('伪造来源编号、原文引用和替换目标均被拒绝，不修改原记忆', async () => {
  for (const edit of [u => { u.sourceIds = ['不存在']; }, u => { u.evidence[0].quote = '编造的引用'; }, u => { u.replaces = ['不存在']; }]) {
    const f = fixture({ fetch: async task => { const result = update(task); edit(result); return { updates: [result] }; } });
    const before = copy(f.chat.longTermMemory);
    await assert.rejects(f.manager.start(f.chat, null), /来源|原文|概况/);
    assert.deepEqual(copy(f.chat.longTermMemory), before);
    assert.equal(f.manager.active(f.chat).length, 0);
    assert.equal(f.chat.normalMemory.task.status, 'failed');
  }
});

test('来源被编辑、删除或被精炼替换后，旧结论停止参与读取', async () => {
  for (const mutate of [f => { f.chat.longTermMemory[0].content = '现在已经取消'; }, f => { f.chat.longTermMemory.splice(0, 1); }, f => { f.chat.longTermMemory = [{ content: '精炼后的另一条记录', timestamp: 20, originalMemories: f.chat.longTermMemory }]; }]) {
    const f = fixture(); await f.manager.manual(f.chat, value(f, '不可继续使用的旧结论'));
    mutate(f);
    assert.equal(f.manager.active(f.chat).length, 0);
    assert.doesNotMatch(f.manager.serialize(f.chat), /不可继续使用的旧结论/);
    assert.match(f.manager.serialize(f.chat), /失效/);
  }
});

test('生成期间来源改变，草稿不提交', async () => {
  const f = fixture({ fetch: async (task, _number, _body, context) => { context.state.chats.a.longTermMemory[0].content = '已经修改'; return oldTrip(task); } });
  await assert.rejects(f.manager.start(f.chat, null), /生成期间来源/);
  assert.equal(f.chat.normalMemory.task.cursor, 0);
  assert.equal(f.manager.proposals(f.chat).length, 0);
});

test('长记录分片，不因完整来源签名而撑破输入预算，失败后只继续未处理批次', async () => {
  let failed = false;
  const f = fixture({ memories: [{ content: '旧经历'.repeat(4000), timestamp: 10 }], settings: { batchChars: 4500 }, fetch: async (_task, count) => {
    if (count === 2 && !failed) { failed = true; throw new Error('临时接口错误'); }
    return { updates: [] };
  } });
  await assert.rejects(f.manager.start(f.chat, null), /临时接口错误/);
  const cursor = f.chat.normalMemory.task.cursor;
  assert.ok(cursor > 0);
  const firstPrompt = f.requests[0].messages[0].content;
  assert.ok(firstPrompt.length <= 4500);
  await f.manager.resume(f.chat);
  assert.equal(f.chat.normalMemory.task.status, 'ready');
  assert.equal(f.chat.normalMemory.task.cursor, f.chat.normalMemory.task.queue.length);
  assert.equal(f.requests.filter(r => r.messages[0].content === firstPrompt).length, 1);
});

test('暂停中断当前请求，保留进度，可以继续', async () => {
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  let first = true;
  const f = fixture({ fetch: async (_task, _count, _body, _context, request) => {
    if (first) { first = false; entered(); await new Promise((_, reject) => request.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true })); }
    return { updates: [] };
  } });
  const run = f.manager.start(f.chat, null);
  await entry; f.manager.pause(f.chat); await run;
  assert.equal(f.chat.normalMemory.task.status, 'paused');
  assert.equal(f.chat.normalMemory.task.cursor, 0);
  await f.manager.resume(f.chat);
  assert.equal(f.chat.normalMemory.task.status, 'ready');
});

test('刷新后运行中任务恢复为可继续状态，而不是永久锁住', () => {
  const f = fixture();
  f.chat.normalMemory.task = { status: 'running' };
  f.manager.ensure(f.chat);
  assert.equal(f.chat.normalMemory.task.status, 'paused');
});

test('应用后撤销不删除后来新增的原记忆', async () => {
  const f = fixture(); await f.manager.start(f.chat, null);
  await f.manager.apply(f.chat, f.manager.proposals(f.chat).map(e => e.id));
  const journal = f.chat.normalMemory.journal[0];
  f.chat.longTermMemory.push({ content: '后来新增的经历', timestamp: 999 });
  await f.manager.undo(f.chat, journal.id);
  assert.equal(f.manager.active(f.chat).length, 0);
  assert.equal(f.chat.longTermMemory.length, 3);
  assert.equal(f.chat.normalMemory.journal[0].undone, true);
});

test('有关概况后来被编辑，阻止旧撤销覆盖；依次撤销可以恢复', async () => {
  const f = fixture();
  const original = await f.manager.manual(f.chat, value(f, '原概况'));
  const first = f.chat.normalMemory.journal[0].id;
  await f.manager.manual(f.chat, value(f, '后来编辑'), original.id);
  await assert.rejects(f.manager.undo(f.chat, first), /后来已经修改/);
  await f.manager.undo(f.chat, f.chat.normalMemory.journal[1].id);
  assert.equal(f.manager.active(f.chat)[0].text, '原概况');
  await f.manager.undo(f.chat, first);
  assert.equal(f.manager.active(f.chat).length, 0);
});

test('概况移除可撤销，来源原文不变', async () => {
  const f = fixture(); const original = copy(f.chat.longTermMemory);
  const entry = await f.manager.manual(f.chat, value(f));
  await f.manager.removeEntry(f.chat, entry.id);
  assert.equal(f.manager.active(f.chat).length, 0);
  await f.manager.undo(f.chat, f.chat.normalMemory.journal[1].id);
  assert.equal(f.manager.active(f.chat).length, 1);
  assert.deepEqual(copy(f.chat.longTermMemory), original);
});

test('数据库提交失败回滚概况和操作记录', async () => {
  const f = fixture(); await f.manager.start(f.chat, null);
  f.failNextWrite();
  await assert.rejects(f.manager.apply(f.chat, f.manager.proposals(f.chat).map(e => e.id)), /写入失败/);
  assert.equal(f.manager.active(f.chat).length, 0);
  assert.equal(f.chat.normalMemory.journal.length, 0);
  assert.equal(f.chat.normalMemory.task.status, 'ready');
});

test('同时间戳记录获得不同编号，最后加载的编辑删除入口只操作选中记录', async () => {
  const f = fixture({ memories: [{ content: 'A', timestamp: 10 }, { content: 'B', timestamp: 10 }] });
  const [a, b] = f.chat.longTermMemory;
  assert.notEqual(a.normalMemoryId, b.normalMemoryId);
  vm.runInContext(read('modules/memory/long-term-migration.js'), f.context);
  await f.context.handleEditMemory('a', 10, b.normalMemoryId);
  assert.equal(a.content, 'A'); assert.equal(b.content, '用户修改的记忆');
  await f.context.handleDeleteMemory('a', 10, b.normalMemoryId);
  assert.equal(f.chat.longTermMemory.length, 1);
  assert.equal(f.chat.longTermMemory[0].content, 'A');
});

test('未选择的旧记忆不提交，自动关闭时也不额外请求', async () => {
  const f = fixture();
  await f.manager.start(f.chat, [f.chat.longTermMemory[0].normalMemoryId]);
  assert.equal(f.chat.normalMemory.task.records.length, 1);
  await f.manager.discard(f.chat);
  assert.equal(f.manager.active(f.chat).length, 0);
  const count = f.requests.length;
  await f.manager.afterSummary(f.chat, f.chat.longTermMemory[1]);
  await settle(() => f.chat.normalMemory.pendingIds.length === 1);
  assert.equal(f.requests.length, count);
});

test('自动应用有明确用户原聊天依据的完成结果，旧摘要单独不足以自动确认', async () => {
  const f = fixture({ settings: { automatic: 'apply' }, fetch: async task => {
    const r = task.records.find(r => r.messages.length);
    return { updates: [update(task, { evidence: [{ sourceId: r.id, kind: 'message', role: 'user', quote: r.messages[0].text }] })] };
  } });
  const message = { id: 'done', role: 'user', content: '我们已经完成2026年7月的旅行，昨天回来了。', timestamp: 1000 };
  f.chat.history.push(message);
  await f.manager.afterSummary(f.chat, f.chat.longTermMemory[1], [message]);
  await settle(() => f.manager.active(f.chat).length === 1 && !f.manager.locks.has(f.chat));
  assert.equal(f.manager.active(f.chat)[0].status, 'completed');
  assert.equal(f.chat.normalMemory.pendingIds.length, 0);
  assert.ok(f.chat.normalMemory.journal.length);
});

test('愿望、假设、否定的用户原文不能自动授权完成', async () => {
  for (const content of ['我想完成这次旅行', '如果我们已经完成旅行', '我们还没有完成旅行', '梦到我们已经完成旅行']) {
    const f = fixture({ settings: { automatic: 'apply' }, fetch: async task => {
      const r = task.records.find(r => r.messages.length);
      return { updates: [update(task, { evidence: [{ sourceId: r.id, kind: 'message', role: 'user', quote: content }] })] };
    } });
    const message = { id: 'm', role: 'user', content, timestamp: 1000 }; f.chat.history.push(message);
    await f.manager.afterSummary(f.chat, f.chat.longTermMemory[1], [message]);
    await settle(() => f.chat.normalMemory.task?.status === 'ready' && !f.manager.locks.has(f.chat));
    assert.equal(f.manager.active(f.chat).length, 0);
    assert.equal(f.manager.proposals(f.chat)[0].autoEligible, false);
  }
});

test('模型不能用通用事实状态绕过完成依据要求', async () => {
  const f = fixture({ fetch: async task => ({ updates: [update(task, { text: '我们已经完成七月旅行', status: 'fact' })] }) });
  await f.manager.start(f.chat, null);
  assert.equal(f.manager.proposals(f.chat)[0].autoEligible, false);
});

test('只预览模式不自动应用，后台失败不丢失原总结', async () => {
  const preview = fixture({ settings: { automatic: 'preview' } });
  await preview.manager.afterSummary(preview.chat, preview.chat.longTermMemory[1]);
  await settle(() => preview.chat.normalMemory.task?.status === 'ready');
  assert.equal(preview.manager.active(preview.chat).length, 0);
  const failed = fixture({ settings: { automatic: 'apply' }, fetch: async () => { throw new Error('接口离线'); } });
  await failed.manager.afterSummary(failed.chat, failed.chat.longTermMemory[1]);
  await settle(() => failed.chat.normalMemory.task?.status === 'failed');
  assert.equal(failed.chat.longTermMemory.length, 2);
  assert.match(failed.manager.serialize(failed.chat), /新增历史等待梳理/);
});

test('自动候选数量可配置，旧数据不会默认全量上传', async () => {
  const f = fixture({ memories: Array.from({ length: 100 }, (_, i) => ({ content: `约定出游地点${i}`, timestamp: i + 1 })), settings: { automatic: 'preview', autoHistoryLimit: 3 }, fetch: async () => ({ updates: [] }) });
  const recent = { content: '这次出游已经结束', timestamp: 1001 }; f.chat.longTermMemory.push(recent);
  await f.manager.afterSummary(f.chat, recent);
  await settle(() => f.chat.normalMemory.task?.status === 'applied');
  assert.equal(f.chat.normalMemory.task.records.length, 4);
  assert.equal(f.chat.longTermMemory.length, 101);
});

test('整理期间新增记录排队，完成后处理新增部分，不覆盖它', async () => {
  let entered = false;
  const f = fixture({ settings: { automatic: 'apply' }, fetch: async (_task, count) => {
    if (count === 1) {
      const extra = { content: '后来又约了旅行', timestamp: 2000 }; f.chat.longTermMemory.push(extra);
      await f.manager.afterSummary(f.chat, extra);
      entered = true;
    }
    return { updates: [] };
  } });
  await f.manager.afterSummary(f.chat, f.chat.longTermMemory[1]);
  await settle(() => entered && f.requests.length >= 2 && f.chat.normalMemory.pendingIds.length === 0 && !f.manager.locks.has(f.chat));
  assert.equal(f.chat.longTermMemory.length, 3);
});

test('角色间概况与设置独立', async () => {
  const f = fixture();
  const other = { id: 'b', name: 'B', settings: {}, longTermMemory: [{ content: '另一个角色的记忆', timestamp: 1 }] };
  f.context.state.chats.b = other; f.manager.ensure(other);
  await f.manager.manual(f.chat, value(f));
  assert.equal(f.manager.active(other).length, 0);
  assert.doesNotMatch(f.manager.serialize(other), /手动确认的经历/);
  assert.equal(f.manager.settings(other).automatic, 'apply');
});

test('导出替换恢复概况、设置和撤销信息，旧文件替换不会残留旧概况', async () => {
  const f = fixture(); await f.manager.manual(f.chat, value(f));
  const exported = f.manager.transfer(f.chat);
  const restored = { id: 'b', settings: {}, longTermMemory: copy(f.chat.longTermMemory) };
  f.manager.importState(restored, exported, 'replace');
  assert.equal(f.manager.active(restored).length, 1);
  assert.equal(restored.normalMemory.journal.length, 1);
  assert.equal(f.manager.settings(restored).automatic, 'off');
  f.manager.importState(restored, null, 'replace');
  assert.equal(f.manager.active(restored).length, 0);
  assert.equal(f.manager.settings(restored).automatic, 'off');
});

test('合并导入不覆盖接收角色设置，重复导入不重复增加概况', async () => {
  const f = fixture(); await f.manager.manual(f.chat, value(f));
  const restored = { id: 'b', settings: {}, longTermMemory: copy(f.chat.longTermMemory), normalMemory: { settings: { automatic: 'preview' }, entries: [], journal: [] } };
  f.manager.importState(restored, f.manager.transfer(f.chat), 'merge');
  f.manager.importState(restored, f.manager.transfer(f.chat), 'merge');
  assert.equal(f.manager.active(restored).length, 1);
  assert.equal(f.manager.settings(restored).automatic, 'preview');
  assert.throws(() => f.manager.importState(restored, { entries: [{ text: '坏数据' }] }, 'replace'), /格式无效/);
});

test('原始记忆导入失败回滚原文与概况，JSON和可导入TXT保留概况', async () => {
  const f = fixture(); await f.manager.manual(f.chat, value(f));
  Object.assign(f.context, { document: { getElementById: () => null }, showChoiceModal: async () => 'replace' });
  vm.runInContext(read('modules/memory/memory-transfer.js'), f.context);
  const transfer = f.context.window.EPhoneMemoryTransfer;
  const exported = transfer.envelope(f.chat, 'original');
  assert.ok(Array.isArray(exported.data));
  assert.equal(exported.normalMemory.entries.length, 1);
  assert.equal(transfer.normalizeImported(transfer.parseImportText('# EPhone Memory Import Text\n' + JSON.stringify(exported))).normalMemory.entries.length, 1);
  const before = copy(f.chat.longTermMemory), overview = copy(f.chat.normalMemory);
  await assert.rejects(transfer.importFile(f.chat, { text: async () => JSON.stringify({ ...exported, data: [{ content: '被替换的原文' }], normalMemory: { entries: [{ text: '坏数据' }] } }) }), /格式无效/);
  assert.deepEqual(copy(f.chat.longTermMemory), before);
  assert.deepEqual(copy(f.chat.normalMemory), overview);
});

test('公共读取保留结构化和向量模式分支，普通分支才进入新机制', () => {
  const f = fixture(); const text = read('modules/utils.js');
  vm.runInContext(text.slice(text.indexOf('function getMemoryContextForPrompt('), text.indexOf('async function getMemoryContextForPromptAsync(')), f.context);
  f.context.window.structuredMemoryManager = { serializeForPrompt: () => 'structured' };
  f.context.window.vectorMemoryManager = { serializeForPromptSync: () => 'vector' };
  f.chat.settings.memoryMode = 'vector'; assert.equal(f.context.getMemoryContextForPrompt(f.chat), 'vector');
  f.chat.settings.memoryMode = 'structured'; assert.equal(f.context.getMemoryContextForPrompt(f.chat), 'structured');
  f.chat.settings.memoryMode = 'diary'; assert.match(f.context.getMemoryContextForPrompt(f.chat), /记忆的时间与状态解释/);
});

test('UI操作入口与执行分支对应，移动端约束局限于新增区域，旧顶部操作保留', () => {
  const source = read('modules/memory/normal-memory-view.js');
  const actions = new Set([...source.matchAll(/data-action="([a-z-]+)"/g)].map(m => m[1]));
  for (const action of actions) assert.ok(source.includes(`action === '${action}'`) || action === 'edit-proposal', `缺少操作分支：${action}`);
  for (const tab of ['overview', 'history', 'proposals', 'settings', 'journal']) assert.ok(source.includes(`data-tab="${tab}"`));
  const css = read('css/memory/normal-memory.css');
  assert.match(css, /max-width:390px/); assert.match(css, /min-width:0/); assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /input\[type=checkbox\].*appearance:none/);
  const oldUI = read('src/html/calls-and-social.html');
  for (const entry of ['refine-memory-btn-header', 'summarize-recent-btn-header', 'add-manual-memory-btn-header', 'export-original-memory-btn', 'original-memory-list', 'memory-tab-structured', 'memory-tab-vector']) assert.ok(oldUI.includes(entry));
  const sourceHead = read('src/html/document-head.html');
  for (const file of ['normal-memory.js', 'normal-memory-view.js', 'normal-memory.css']) assert.ok(sourceHead.includes(file));
});
