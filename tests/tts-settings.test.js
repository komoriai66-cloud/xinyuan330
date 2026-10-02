const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
function fixture() {
  const nodes = new Map(), writes = [];
  const element = () => ({ value: '', type: 'text', checked: false, hidden: false, disabled: false,
    dataset: {}, textContent: '', children: [], listeners: {},
    classList: { contains: () => true }, addEventListener(type, fn) { this.listeners[type] = fn; },
    replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); },
    removeAttribute() {}, pause() {}, async emit(type) { await this.listeners[type]?.({ target: this }); } });
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const c = { state: { apiConfig: { elevenlabsApiKey: 'key' }, ttsCache: new Map() },
    document: { getElementById: get, createElement: element, addEventListener() {} }, localStorage: { getItem: () => null },
    db: { apiConfig: { async put(value) { writes.push(value); } }, chats: { async put(value) { writes.push(value); } } },
    console, Map, Set, URL, Blob, DOMException, AbortController, setTimeout, clearTimeout,
    showCustomPrompt: async () => '声音预设', showCustomConfirm: async () => true, addEventListener() {} };
  c.window = c; vm.createContext(c);
  vm.runInContext(source('modules/tts-provider.js'), c); vm.runInContext(source('modules/tts-settings.js'), c);
  return { c, get, writes };
}
test('角色切换服务保留两家的音色与语速，保存后重新打开完整回显', async () => {
  const f = fixture(), chat = { id: 'a', settings: { minimaxVoiceId: 'mini-original', minimaxTtsSpeed: 1.7, elevenlabsVoiceId: 'eleven-original', elevenlabsTtsSpeed: 0.9 }, history: [] };
  f.c.ttsSettings.loadChat(chat);
  assert.equal(f.get('tts-provider-select').value, 'minimax'); assert.equal(f.get('ai-voice-id-input').value, 'mini-original');
  f.get('ai-voice-id-input').value = 'mini-new'; f.get('tts-provider-select').value = 'elevenlabs'; await f.get('tts-provider-select').emit('change');
  assert.equal(f.get('ai-voice-id-input').value, 'eleven-original'); assert.equal(f.get('ai-voice-speed-input').value, 0.9);
  f.get('ai-voice-id-input').value = 'eleven-new'; f.get('elevenlabs-stability').value = '0.35';
  f.c.ttsSettings.saveChat(chat);
  assert.equal(chat.settings.minimaxVoiceId, 'mini-new'); assert.equal(chat.settings.elevenlabsVoiceId, 'eleven-new');
  assert.equal(chat.settings.minimaxTtsSpeed, 1.7); assert.equal(chat.settings.elevenlabsTtsSpeed, 0.9);
  assert.equal(chat.settings.elevenlabsVoiceSettings.stability, 0.35);
  f.c.ttsSettings.loadChat(chat); assert.equal(f.get('ai-voice-id-input').value, 'eleven-new');
});
test('退出未保存不会修改角色；群聊新增语音选项隐藏，旧参数不被清空', async () => {
  const f = fixture(), chat = { id: 'a', settings: { minimaxVoiceId: 'keep' }, history: [] };
  f.c.ttsSettings.loadChat(chat); f.get('ai-voice-id-input').value = 'unsaved';
  assert.equal(chat.settings.minimaxVoiceId, 'keep');
  const group = { id: 'g', isGroup: true, settings: { minimaxVoiceId: 'group-keep' }, history: [] };
  f.c.ttsSettings.loadChat(group); assert.equal(f.get('tts-provider-group').hidden, true); assert.equal(f.get('tts-common-options').hidden, true);
  f.c.ttsSettings.saveChat(group); assert.equal(group.settings.minimaxVoiceId, 'group-keep');
});
test('连接未配置也能保存角色；无效声音参数明确拦截；API Key 通过原保存入口读取', () => {
  const f = fixture(), chat = { id: 'a', settings: { ttsProvider: 'elevenlabs' }, history: [] };
  f.c.ttsSettings.loadChat(chat); assert.doesNotThrow(() => f.c.ttsSettings.validateChat());
  f.get('elevenlabs-stability').value = '2'; assert.throws(() => f.c.ttsSettings.validateChat(), /0～1/);
  f.get('elevenlabs-api-key').value = 'saved-key'; f.get('elevenlabs-model-input').value = 'custom';
  assert.equal(f.c.ttsSettings.readApi().elevenlabsApiKey, 'saved-key'); assert.equal(f.c.ttsSettings.readApi().elevenlabsModel, 'custom');
});
test('音色收藏与参数预设只保存配置，不把 Key 放到角色参数中', async () => {
  const f = fixture(), chat = { id: 'a', settings: { ttsProvider: 'elevenlabs', elevenlabsVoiceId: 'voice' }, history: [] };
  f.c.ttsSettings.loadChat(chat); await f.get('elevenlabs-favorite-add').emit('click');
  assert.equal(f.c.state.apiConfig.elevenlabsVoiceLibrary[0].id, 'voice');
  f.get('elevenlabs-stability').value = '0.4'; await f.get('elevenlabs-preset-save').emit('click');
  f.get('elevenlabs-stability').value = ''; f.get('elevenlabs-sound-preset').value = '0'; await f.get('elevenlabs-preset-apply').emit('click');
  assert.equal(f.get('elevenlabs-stability').value, 0.4);
  assert.equal(JSON.stringify(chat.settings).includes('key'), false);
});
test('保存音频的清理入口保留聊天正文和真实录音；保存失败回滚音频', async () => {
  const f = fixture(), message = { content: '保留', audioData: '真实录音', ttsSavedAudio: [{ data: 'data:audio/mpeg;base64,AA==' }] };
  const chat = { id: 'a', settings: {}, history: [message] };
  f.c.ttsSettings.loadChat(chat); f.c.db.chats.put = async () => { throw new Error('quota'); };
  await f.get('tts-clear-saved-audio').emit('click'); assert.equal(message.ttsSavedAudio.length, 1);
  f.c.db.chats.put = async () => {}; await f.get('tts-clear-saved-audio').emit('click');
  assert.equal(message.ttsSavedAudio, undefined); assert.equal(message.content, '保留'); assert.equal(message.audioData, '真实录音');
});
