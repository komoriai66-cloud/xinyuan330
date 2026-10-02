const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function fixture(count = 10, options = {}) {
  const requests = [], notices = [], writes = [];
  const chat = { id: 'a', name: 'A', originalName: 'A', settings: { enableAutoMemory: true, memoryMode: 'vector' },
    history: Array.from({ length: count }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', content: `事件${i}`, timestamp: new Date(2026, 8, 1, 22).getTime() + i * 60000 })) };
  const state = { activeChatId: 'a', chats: { a: chat }, apiConfig: { proxyUrl: 'https://mock.invalid', apiKey: 'test', model: 'test' }, worldBooks: [] };
  const context = vm.createContext({ Date, Map, WeakMap, Set, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} }, state, window: { state },
    document: { getElementById: () => null, createElement: () => ({ textContent: '', get innerHTML() { return this.textContent.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); } }) }, showToast: (...args) => notices.push(args),
    showCustomConfirm: async () => true,
    openManualSummaryModal() {}, closeManualSummaryModal() {}, executeManualSummary() {}, convertLongTermMemoryToVector() {}, handleExportLongTermMemory() {},
    db: { chats: { put: async value => { writes.push(JSON.parse(JSON.stringify(value))); if (options.put) await options.put(value, writes.length); } } },
    fetch: async (url, request) => {
      requests.push({ url, request, body: JSON.parse(request.body) });
      if (options.fetch) return options.fetch(url, request, requests.length, chat, context);
      return response(options.result ?? '[]');
    }
  });
  for (const file of ['extraction-support', 'vector-memory', 'extraction-runner', 'variable-memory-summary', 'summary-orchestration']) vm.runInContext(source(`modules/memory/${file}.js`), context);
  const manager = context.window.vectorMemoryManager;
  if (!options.realEmbedding) manager.getEmbedding = async () => null;
  return { context, chat, manager, support: context.window.MemoryExtractionSupport, requests, notices, writes };
}

function response(content, extra = {}) {
  return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: extra.finish || 'stop' }], ...extra }) };
}

test('330、500、1000条及超过4万字符，默认均只有一次提取请求', async () => {
  for (const count of [330, 500, 1000]) {
    const f = fixture(count);
    f.chat.history[0].content = '长'.repeat(45000);
    await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.chat.variableMemory.extractionTask.status, 'completed');
    assert.equal(f.chat.variableMemory.settings.lastExtractedMsgIndex, count - 1);
    assert.match(f.requests[0].body.messages[0].content, new RegExp(`消息${count}`));
  }
});

test('每批数量可自定义；关闭分批后重新使用单次请求', async () => {
  const f = fixture(1000);
  Object.assign(f.manager.getVariableMemory(f.chat).settings, { extractionBatchEnabled: true, extractionBatchSize: 200 });
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  assert.equal(f.requests.length, 5);
  assert.equal(f.chat.variableMemory.extractionTask.offset, 1000);
  f.chat.variableMemory.settings.extractionBatchEnabled = false;
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, false);
  assert.equal(f.requests.length, 6);
});

test('无效JSON、无效条目、非法来源和输出截断都不推进进度', async () => {
  for (const result of ['没有内容', '[{"content":"x",}]', '[{}]', '[{"content":"x","sourceMessageIds":[999],"timeBasis":"message"}]']) {
    const f = fixture(10, { result });
    await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
    assert.equal(f.chat.variableMemory.extractionTask.status, 'failed');
    assert.equal(f.chat.variableMemory.settings.lastExtractedMsgIndex, -1);
    assert.equal(f.chat.variableMemory.fragments.length, 0);
    await f.context.checkAndTriggerAutoSummary('a');
    assert.equal(f.requests.length, 1, '失败不会随下一次自动检查重发');
  }
  const f = fixture(10, { fetch: async () => response('[]', { finish: 'length' }) });
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  assert.equal(f.chat.variableMemory.extractionTask.status, 'failed');
  assert.equal(f.chat.variableMemory.settings.lastExtractedMsgIndex, -1);
});

test('分批第二次失败，继续只重发失败批次；不重跑第一批', async () => {
  const f = fixture(6, { fetch: async (_, __, count) => count === 2 ? { ok: false, status: 429, text: async () => '' } : response('[]') });
  Object.assign(f.manager.getVariableMemory(f.chat).settings, { extractionBatchEnabled: true, extractionBatchSize: 2 });
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  assert.equal(f.chat.variableMemory.extractionTask.offset, 2);
  assert.equal(f.requests.length, 2);
  await f.context.controlVectorExtraction(f.chat, 'resume');
  assert.equal(f.requests.length, 4);
  assert.equal(f.chat.variableMemory.extractionTask.status, 'completed');
  assert.equal(f.chat.variableMemory.extractionTask.offset, 6);
});

test('暂停后只继续未完成部分；取消中途请求不保存结果', async () => {
  const f = fixture(6, { fetch: async (_, __, count, chat, c) => {
    if (count === 1) await c.controlVectorExtraction(chat, 'pause');
    return response('[]');
  } });
  Object.assign(f.manager.getVariableMemory(f.chat).settings, { extractionBatchEnabled: true, extractionBatchSize: 2 });
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.chat.variableMemory.extractionTask.status, 'paused');
  await f.context.controlVectorExtraction(f.chat, 'resume');
  assert.equal(f.requests.length, 3);
  const cancelled = fixture(10, { fetch: async (_, __, ___, chat, c) => {
    await c.controlVectorExtraction(chat, 'cancel');
    return response('[{"content":"不应保存"}]');
  } });
  await cancelled.context.executeVectorExtractionInBatches(cancelled.chat, cancelled.chat.history, true);
  assert.equal(cancelled.chat.variableMemory.extractionTask.status, 'cancelled');
  assert.equal(cancelled.chat.variableMemory.fragments.length, 0);
  assert.equal(cancelled.chat.variableMemory.settings.lastExtractedMsgIndex, -1);
});

test('日期按对应消息、相对日期、明确日期和未知分别处理', async () => {
  const f = fixture(3);
  const first = new Date(2026, 8, 1, 22).getTime();
  f.chat.history[1].timestamp = new Date(2026, 8, 3, 9).getTime();
  f.chat.history[1].content = '昨天晚上和A偷偷吃炸鸡，后来被B发现';
  const message = f.support.resolveTime({ content: '共同经历', sourceMessageIds: [1], timeBasis: 'message' }, f.chat.history);
  assert.equal(message.memoryTime, first);
  const relative = f.support.resolveTime({ content: '和A偷吃炸鸡，被B发现', sourceMessageIds: [2], timeBasis: 'relative' }, f.chat.history);
  assert.equal(new Date(relative.memoryTime).getDate(), 2);
  const unknown = f.support.resolveTime({ content: '很久以前的事', sourceMessageIds: [1], timeBasis: 'unknown' }, f.chat.history);
  assert.equal(unknown.memoryTime, null);
  assert.equal(f.support.formatTime(unknown), '时间不明');
  assert.equal(new Date(f.support.datedText('[2609] [02]炸鸡事件')).getDate(), 2);
  assert.equal(new Date(f.support.datedText('喜好(260902)')).getMonth(), 8);
  assert.equal(f.support.datedText('(260231)'), null);
  const fiction = f.support.resolveTime({ content: '剧情事件', timeBasis: 'fictional', eventTimeText: '王历三年' }, f.chat.history);
  assert.match(f.support.formatTime(fiction), /王历三年/);
  const lastYear = f.support.resolveTime({ content: '旧事', sourceMessageIds: [2], timeBasis: 'relative' }, [{}, { ...f.chat.history[1], content: '去年去旅行' }]);
  assert.equal(new Date(lastYear.memoryTime).getFullYear(), 2025);
  assert.equal(new Date(lastYear.memoryTimeEnd).getMonth(), 11);
  const plan = f.support.resolveTime({ category: 'P', sourceMessageIds: [2], timeBasis: 'relative' }, [{}, { ...f.chat.history[1], content: '明天一起吃炸鸡' }]);
  assert.equal(plan.memoryTime, f.chat.history[1].timestamp);
  assert.equal(new Date(plan.plannedTime).getDate(), 4);
  assert.ok(!f.support.formatTime(relative).includes('12:00'), '只明确日期，不编造时分');
});

test('剧情、语音、表情、备注事件和背景不会遗漏，默认保留日常趣事规则', () => {
  const f = fixture();
  assert.match(f.support.formatMessage({ type: 'offline_text', dialogue: '偷偷吃炸鸡', description: '被B发现', timestamp: f.chat.history[0].timestamp }, f.chat), /偷偷吃炸鸡\n被B发现/);
  assert.match(f.support.content({ type: 'voice_message', content: '约定' }), /语音.*约定/);
  assert.match(f.support.content({ type: 'sticker', meaning: '委屈' }), /委屈/);
  f.chat.settings.aiPersona = '角色背景'; f.chat.settings.myPersona = '用户背景';
  f.context.window.state.worldBooks = [{ name: '总结设定', content: [{ content: '记住有趣经历' }] }];
  const prompt = f.manager.buildExtractionPrompt(f.chat, '对话', '范围', {});
  for (const text of ['角色背景', '用户背景', '记住有趣经历', '偷偷吃炸鸡', '被B发现', 'sourceMessageIds']) assert.ok(prompt.includes(text));
  f.chat.variableMemory.settings.useCustomExtractionPrompt = true;
  f.chat.variableMemory.settings.customExtractionPrompt = '自己的规则 {{对话记录}}';
  const custom = f.manager.buildExtractionPrompt(f.chat, '对话', '范围', {});
  assert.match(custom, /^自己的规则 对话/);
  assert.match(custom, /sourceMessageIds/);
});

test('同一天重复记忆不再向量化，不同日期的相同经历仍保留', async () => {
  const f = fixture();
  let embeddings = 0;
  f.manager.getEmbedding = async () => { embeddings++; return null; };
  const item = { content: '我和A偷偷吃炸鸡，后来被B发现', category: 'E', memoryTime: f.chat.history[0].timestamp, timeBasis: 'message' };
  await f.manager.mergeExtractedMemories(f.chat, [item]);
  await f.manager.mergeExtractedMemories(f.chat, [item]);
  assert.equal(embeddings, 1);
  await f.manager.mergeExtractedMemories(f.chat, [{ ...item, memoryTime: item.memoryTime + 86400000 }]);
  assert.equal(f.chat.variableMemory.fragments.length, 2);
});

test('日期修复先备份，撤销保留新增记忆；未知日期导入导出不变成今天', async () => {
  const f = fixture();
  f.manager.createFragment(f.chat, { content: '炸鸡事件(260902)', memoryTime: Date.now(), timeBasis: 'legacy' });
  const before = f.chat.variableMemory.fragments[0].memoryTime;
  await f.context.handleVectorDateRepair(f.chat);
  assert.equal(new Date(f.chat.variableMemory.fragments[0].memoryTime).getDate(), 2);
  assert.equal(f.chat.variableMemory.dateRepairBackups.length, 1);
  f.manager.createFragment(f.chat, { content: '后来新增', memoryTime: null, timeBasis: 'unknown' });
  await f.context.handleVectorDateRestore(f.chat);
  assert.equal(f.chat.variableMemory.fragments[0].memoryTime, before);
  assert.equal(f.chat.variableMemory.fragments.length, 2);
  const other = fixture();
  await other.manager.importMemory(other.chat, f.manager.exportMemory(f.chat), 'replace');
  assert.equal(other.chat.variableMemory.fragments[1].memoryTime, null);
});

test('同一聊天不重复启动；新增消息不会进入本次范围；已知超限不发请求', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture(10, { fetch: async () => { await waiting; return response('[]'); } });
  const first = f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  await Promise.resolve(); await Promise.resolve();
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  f.chat.history.push({ id: 'later', role: 'user', content: '新增消息', timestamp: Date.now() });
  release(); await first;
  assert.equal(f.requests.length, 1);
  assert.equal(f.chat.variableMemory.settings.lastExtractedMsgIndex, 9);
  const limited = fixture(10);
  limited.context.window.state.apiConfig.contextWindowTokens = 100;
  await limited.context.executeVectorExtractionInBatches(limited.chat, limited.chat.history, true);
  assert.equal(limited.requests.length, 0);
});

test('保存失败回滚记忆和进度；下次自动检查不重复请求', async () => {
  const f = fixture(10, { result: '[{"content":"事件","sourceMessageIds":[1],"timeBasis":"message"}]', put: async value => {
    if (value.variableMemory.fragments.length) throw new Error('磁盘失败');
  } });
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  assert.equal(f.chat.variableMemory.fragments.length, 0);
  assert.equal(f.chat.variableMemory.settings.lastExtractedMsgIndex, -1);
  await f.context.checkAndTriggerAutoSummary('a');
  assert.equal(f.requests.length, 1);
});

test('用户设置保持原有间隔和其他能力；新增开关默认为关闭，状态反馈可理解', () => {
  const f = fixture();
  const settings = f.manager.getVariableMemory(f.chat).settings;
  settings.autoExtractionMsgInterval = 1000;
  assert.equal(settings.extractionBatchEnabled, false);
  const html = f.manager.renderSettingsPanel(f.chat);
  for (const id of ['vm-auto-interval', 'vm-extraction-batch', 'vm-extraction-batch-size', 'vm-extraction-detail', 'vm-custom-prompt', 'vm-topn', 'vm-custom-embedding', 'vm-multilingual-enabled', 'vm-save-settings-btn']) assert.ok(html.includes(`id="${id}"`));
  assert.ok(!/id="vm-extraction-batch" checked/.test(html));
  assert.match(html, /默认不分批/);
  f.chat.variableMemory.extractionTask = { status: 'failed', offset: 200, total: 1000, batchEnabled: true, batchSize: 200, requests: 2, plannedRequests: 5, embeddingRequests: 0, error: '格式错误' };
  const feedback = f.manager.renderExtractionStatus(f.chat);
  assert.match(feedback, /200\/1000条/); assert.match(feedback, /格式错误/);
  assert.match(feedback, /继续 \/ 重试/); assert.match(feedback, /用量未知/);
});

test('设置表单实际保存自定义批数、校验非法值；关闭后保留已填数量', () => {
  const f = fixture();
  const inputs = new Map([
    ['vm-auto-interval', { value: '1000' }], ['vm-extraction-batch', { checked: true }],
    ['vm-extraction-batch-size', { value: '250' }], ['vm-extraction-detail', { value: 'detailed' }]
  ]);
  f.context.document.getElementById = id => inputs.get(id) || null;
  f.manager.saveSettingsFromUI(f.chat);
  assert.equal(f.chat.variableMemory.settings.autoExtractionMsgInterval, 1000);
  assert.equal(f.chat.variableMemory.settings.extractionBatchSize, 250);
  assert.equal(f.chat.variableMemory.settings.extractionBatchEnabled, true);
  inputs.get('vm-extraction-batch-size').value = '0';
  assert.throws(() => f.manager.saveSettingsFromUI(f.chat), /每批消息数量/);
  assert.equal(f.chat.variableMemory.settings.extractionBatchSize, 250);
  inputs.get('vm-extraction-batch-size').value = '250';
  inputs.get('vm-extraction-batch').checked = false;
  f.manager.saveSettingsFromUI(f.chat);
  assert.equal(f.chat.variableMemory.settings.extractionBatchEnabled, false);
  assert.equal(f.chat.variableMemory.settings.extractionBatchSize, 250);
});

test('来源消息被编辑后不能使用旧任务恢复或错误推进进度', async () => {
  const f = fixture(6, { fetch: async (_, __, count) => count === 2 ? { ok: false, status: 500, text: async () => '' } : response('[]') });
  Object.assign(f.manager.getVariableMemory(f.chat).settings, { extractionBatchEnabled: true, extractionBatchSize: 2 });
  await f.context.executeVectorExtractionInBatches(f.chat, f.chat.history, true);
  f.chat.history[2].content = '被修改的内容';
  await f.context.controlVectorExtraction(f.chat, 'resume');
  assert.equal(f.requests.length, 2);
  assert.match(f.notices.at(-1)[0], /原消息已删除或修改/);
});

test('计划状态更新有历史记录，普通事件不同人物不能随意覆盖', async () => {
  const f = fixture();
  const entity = [{ type: 'person', canonical: '小明', aliases: [] }];
  const id = f.manager.createFragment(f.chat, { content: '我和小明计划看电影', category: 'P', status: 'plan', entities: entity, memoryTime: f.chat.history[0].timestamp });
  const ids = await f.manager.mergeExtractedMemories(f.chat, [{ content: '我和小明已经看完电影', category: 'P', status: 'completed', entities: entity, memoryTime: f.chat.history[0].timestamp, replacesMemoryId: id }]);
  assert.equal(ids.updated, 1);
  assert.equal(f.chat.variableMemory.fragments.length, 1);
  assert.equal(f.chat.variableMemory.fragments[0].previousVersions[0].status, 'plan');
});

test('智能转换默认一次提交超过100条，日期取原文；无效输出立即停止后续批次', async () => {
  const f = fixture(1, { result: '[{"content":"和A吃炸鸡","category":"E","sourceMessageIds":[1],"timeBasis":"explicit"}]' });
  f.context.document.querySelectorAll = () => [];
  f.context.document.querySelector = () => null;
  vm.runInContext(source('modules/memory/legacy-memory-conversion.js'), f.context);
  const items = Array.from({ length: 150 }, (_, i) => ({ type: 'longTerm', authorId: 'a', id: i, content: '旧记忆(260902)', timestamp: Date.now() }));
  await f.context.doSmartConvertWithAI(f.chat, items, items.map((_, i) => i), true);
  assert.equal(f.requests.length, 1);
  assert.equal(new Date(f.chat.variableMemory.fragments[0].memoryTime).getDate(), 2);
  assert.equal(f.manager._extractionLocks.has(f.chat), false);
  const broken = fixture(1, { result: '格式错误' });
  broken.context.document.querySelectorAll = () => [];
  broken.context.document.querySelector = () => null;
  vm.runInContext(source('modules/memory/legacy-memory-conversion.js'), broken.context);
  Object.assign(broken.manager.getVariableMemory(broken.chat).settings, { extractionBatchEnabled: true, extractionBatchSize: 20 });
  await broken.context.doSmartConvertWithAI(broken.chat, items, items.map((_, i) => i), true);
  assert.equal(broken.requests.length, 1);
  assert.equal(broken.chat.variableMemory.fragments.length, 0);
});

test('真实入口的设置事件：开启分批显示数量，保存后反馈一致，返回可退出', async () => {
  const f = fixture();
  class Element {
    constructor() { this.nodes = new Map(); this.listeners = new Map(); this.style = {}; this.dataset = {}; this.value = ''; this.checked = false; this.classList = { add() {}, remove() {} }; }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const element = new Element();
        element.id = match[3];
        element.value = match[2].match(/\bvalue="([^"]*)"/)?.[1] || '';
        element.checked = /\bchecked\b/.test(match[2]);
        if (match[1] === 'select') {
          const body = html.slice(match.index).split('</select>')[0];
          element.value = body.match(/<option value="([^"]+)" selected/)?.[1] || body.match(/<option value="([^"]+)"/)?.[1] || '';
        }
        this.nodes.set(element.id, element);
      }
    }
    get innerHTML() { return this.html || String(this.textContent || ''); }
    querySelector(selector) { return this.nodes.get(selector.slice(1)) || null; }
    querySelectorAll() { return []; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    remove() { this.removed = true; }
  }
  let panel;
  let renders = 0;
  f.context.document = {
    getElementById: id => id === 'vm-settings-screen' ? panel : panel?.nodes.get(id) || null,
    createElement: () => new Element(), body: { appendChild: element => { panel = element; } }
  };
  vm.runInContext(source('modules/memory/vector-memory-view.js'), f.context);
  f.context.renderVectorMemoryView = () => { renders++; };
  await f.context.openVectorMemorySettings(f.chat);
  assert.equal(panel.nodes.get('vm-extraction-batch').checked, false);
  panel.nodes.get('vm-extraction-batch').checked = true;
  panel.nodes.get('vm-extraction-batch').listeners.get('change')();
  assert.equal(panel.nodes.get('vm-extraction-batch-fields').style.display, 'block');
  panel.nodes.get('vm-auto-interval').value = '1000';
  panel.nodes.get('vm-extraction-batch-size').value = '250';
  await panel.nodes.get('vm-save-settings-btn').listeners.get('click')();
  assert.equal(f.chat.variableMemory.settings.extractionBatchSize, 250);
  assert.equal(f.chat.variableMemory.settings.extractionBatchEnabled, true);
  assert.equal(panel.removed, true);
  assert.equal(renders, 1);
  assert.match(f.notices.at(-1)[0], /间隔1000条，每批250条/);
  await f.context.openVectorMemorySettings(f.chat);
  panel.nodes.get('vm-settings-back').listeners.get('click')();
  assert.equal(panel.removed, true);
});
