const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function table() {
  const rows = new Map();
  return { rows, get: async id => copy(rows.get(id)), put: async row => { rows.set(row.id, copy(row)); },
    toArray: async () => copy([...rows.values()]), delete: async id => rows.delete(id) };
}
function fixture(group = false) {
  const chat = { id: 'a', name: '角色', originalName: '角色', isGroup: group, settings: { aiPersona: '温柔，不替用户决定行动' },
    members: group ? [{ originalName: '甲', groupNickname: '甲' }, { originalName: '乙', groupNickname: '乙' }] : [],
    history: [{ role: 'user', content: '我困了', timestamp: 1 }, { role: 'assistant', type: 'text', senderName: group ? '甲' : '角色', content: '原回复', timestamp: 2 }] };
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, window: {}, JSON, Set, Date, Math, AbortController,
    state: { activeChatId: 'a', chats: { a: chat }, apiConfig: { proxyUrl: 'https://test.invalid', apiKey: 'test-key', model: 'mock' }, globalSettings: {} },
    db: { modelDiscussions: table(), generationPreferences: table(), chats: table() }, GEMINI_API_URL: 'https://gemini.invalid',
    currentApiController: null, renderChatInterface: async () => {}, renderChatList() {},
    triggerAiResponse: async () => {}, silentlyUpdateDbUrl() {}, alert() {},
    toGeminiRequestData: (model, key, system, messages) => ({ url: 'https://gemini.invalid/request', data: { method: 'POST', body: JSON.stringify({ model, system, messages }) } }),
    getGeminiResponseText: data => data.choices?.[0]?.message?.content || data.candidates?.[0]?.content?.parts?.[0]?.text
  });
  for (const file of ['modules/ai/response-parser.js', 'modules/ai/generation-adjustments.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  context.GenerationAdjustments = context.window.GenerationAdjustments;
  return { c: context, g: context.GenerationAdjustments, chat };
}
test('偏好隔离、默认无附加指令，下一次仅由主动请求消耗', async () => {
  const { c, g, chat } = fixture();
  assert.equal((await g.prepare(chat)).block, '');
  await g.savePreference('b', '只在另一个聊天生效', 'chat');
  await g.savePreference('a', '自然', 'global');
  const next = await g.savePreference('a', '温柔', 'next');
  const auto = await g.prepare(chat);
  assert.match(auto.block, /自然/); assert.doesNotMatch(auto.block, /只在另一个|温柔/);
  await g.consume(auto); assert.ok(await c.db.generationPreferences.get(next.id));
  const manual = await g.prepare(chat, { manual: true, guidance: '本次可爱' });
  assert.match(manual.block, /温柔/); assert.match(manual.block, /本次可爱/);
  await g.consume(manual); assert.equal(await c.db.generationPreferences.get(next.id), undefined);
});
test('生成进行期间编辑过的下一次要求不会被旧请求删除', async () => {
  const { c, g, chat } = fixture();
  const row = await g.savePreference('a', '温柔', 'next');
  const prepared = await g.prepare(chat, { manual: true });
  await c.db.generationPreferences.put({ ...row, text: '可爱', updatedAt: row.updatedAt + 1 });
  await g.consume(prepared);
  assert.equal((await c.db.generationPreferences.get(row.id)).text, '可爱');
});
test('编辑关闭的偏好保留关闭状态，主动重新应用相同要求会启用且不重复保存', async () => {
  const { c, g } = fixture();
  const row = await g.savePreference('a', '温柔', 'next');
  await c.db.generationPreferences.put({ ...row, enabled: false });
  const edited = await g.savePreference('a', '自然温柔', 'next', '', row.id);
  assert.equal(edited.enabled, false);
  const applied = await g.savePreference('a', '自然温柔', 'next');
  assert.equal(applied.enabled, true); assert.equal(applied.id, row.id);
  assert.equal(c.db.generationPreferences.rows.size, 1);
});
test('历史讨论可查看，新增消息或原回复编辑后候选不得覆盖记录', async () => {
  const { g, chat } = fixture();
  const target = g.targetFor(chat);
  chat.history[1].content = '已手动编辑';
  assert.throws(() => g.assertTarget(chat, target), /已发生变化/);
  chat.history.push({ role: 'user', content: '新的话', timestamp: 3 });
  assert.equal(g.targetFor(chat, 2).canGenerate, false);
});
test('候选使用聊天快照、原回复参考和临时指导，不写入角色历史', async () => {
  const { c, g, chat } = fixture();
  const original = copy(chat);
  const session = g.newSession(chat); session.guidance = '温柔一点';
  c.triggerAiResponse = async options => {
    assert.equal(options.preview, true);
    assert.equal(options.previewChat.history.length, 1);
    assert.match(options.guidance, /温柔一点/); assert.match(options.guidance, /原回复/);
    options.previewChat.history.push({ role: 'assistant', content: '不会污染原聊天' });
    return '[{"type":"text","content":"早点休息呀"}]';
  };
  const item = await g.candidate(chat, session, new AbortController().signal);
  assert.match(item.content, /早点休息/); assert.deepEqual(chat, original);
  assert.equal(c.db.chats.rows.size, 0);
});
test('候选不执行转账、动态、工具和未知角色行动', () => {
  const { g, chat } = fixture(true);
  for (const type of ['transfer', 'qzone_post', 'send_group_message', 'openaiimag', 'change_name']) assert.throws(() => g.validateCandidate(JSON.stringify([{ type, name: '甲', content: '行动' }]), chat), /非回复行动/);
  assert.throws(() => g.validateCandidate('[{"type":"text","name":"用户","content":"替用户说话"}]', chat), /未识别/);
});
test('采用仅替换回复、保留已发生行动，撤销恢复原回复且不覆盖后续聊天', async () => {
  const { c, g, chat } = fixture();
  chat.history.push({ role: 'assistant', type: 'transfer', amount: 10, content: '已转账', timestamp: 3 });
  const original = copy(chat.history), session = g.newSession(chat);
  const item = { content: '[{"type":"text","content":"新回复"}]', signature: session.target.signature };
  c.triggerAiResponse = async options => { chat.history.push({ role: 'assistant', type: 'text', content: '新回复', timestamp: 4 }); await c.db.chats.put(chat); options.onCommitted(); };
  await g.adopt(chat, session, item);
  assert.ok(chat.history.some(m => m.type === 'transfer')); assert.ok(!chat.history.some(m => m.content === '原回复'));
  await g.undo(chat, session); assert.deepEqual(chat.history, original);
  await g.adopt(chat, session, { ...item, signature: session.target.signature });
  chat.history.push({ role: 'user', content: '后续聊天', timestamp: 5 });
  await assert.rejects(g.undo(chat, session), /后续记录/);
});
test('指定群成员重生成保留其他成员原回复', async () => {
  const { c, g, chat } = fixture(true);
  chat.history.push({ role: 'assistant', type: 'text', senderName: '乙', content: '乙的原回复', timestamp: 3 });
  const session = g.newSession(chat);
  c.triggerAiResponse = async options => { chat.history.push({ role: 'assistant', type: 'text', senderName: '甲', content: '甲的新回复', timestamp: 4 }); options.onCommitted(); };
  await g.adopt(chat, session, { content: '[{"type":"text","name":"甲","content":"甲的新回复"}]', member: '甲', signature: session.target.signature });
  assert.ok(chat.history.some(m => m.content === '乙的原回复')); assert.ok(!chat.history.some(m => m.content === '原回复'));
});
test('采用失败恢复原回复，不丢失候选', async () => {
  const { c, g, chat } = fixture(); const original = copy(chat.history), session = g.newSession(chat);
  const item = { content: '[{"type":"text","content":"候选"}]', signature: session.target.signature }; session.candidates.push(item);
  c.triggerAiResponse = async () => { throw new Error('保存失败'); };
  await assert.rejects(g.adopt(chat, session, item), /保存失败/);
  assert.deepEqual(chat.history, original); assert.equal(session.candidates.length, 1);
});
test('模型沟通独立请求、继承角色配置，两类接口不污染角色记录', async () => {
  for (const gemini of [false, true]) {
    const { c, g, chat } = fixture(); const original = copy(chat);
    chat.apiOverride = { enabled: true, proxyUrl: gemini ? c.GEMINI_API_URL : 'https://override.invalid', model: 'override-model' };
    const session = g.newSession(chat); session.messages.push({ role: 'user', content: '烦死了，别把他写得这么凶' });
    let body;
    c.fetch = async (url, request) => { body = JSON.parse(request.body); return { ok: true, json: async () => gemini ? { candidates: [{ content: { parts: [{ text: '可以调整表达' }] } }] } : { choices: [{ message: { content: '可以调整表达' } }] } }; };
    assert.equal(await g.talk(chat, session, null, new AbortController().signal), '可以调整表达');
    assert.equal(body.model, 'override-model');
    const payload = JSON.stringify(body); assert.match(payload, /不扮演角色/); assert.match(payload, /烦死了/);
    assert.deepEqual(chat.history, original.history); assert.equal(c.db.chats.rows.size, 0);
  }
});
test('直接重生成仍一键调用，失败恢复，重复点击不重复请求', async () => {
  const { c, chat } = fixture(); const original = copy(chat.history);
  let requests = 0;
  c.triggerAiResponse = async options => { requests++; assert.equal(options.manual, true); assert.equal(chat.history.length, 1); };
  vm.runInContext(fs.readFileSync(path.join(root, 'modules/ai/response-actions.js'), 'utf8'), c);
  await Promise.all([c.window.handleRegenerateResponse(), c.window.handleRegenerateResponse()]);
  assert.equal(requests, 1); assert.deepEqual(chat.history, original);
  c.triggerAiResponse = async () => chat.history.push({ role: 'assistant', type: 'text', content: '新的直接回复', timestamp: 3 });
  await c.window.handleRegenerateResponse();
  assert.equal(chat.history.at(-1).content, '新的直接回复'); assert.equal(chat.history.length, 2);
});
