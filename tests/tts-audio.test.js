const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const requests = [], toasts = [], alerts = [];
  const player = { dataset: {}, paused: true, src: '', async play() { this.paused = false; }, pause() { this.paused = true; }, removeAttribute() {}, load() {} };
  const c = { state: { activeChatId: 'a', chats: { a: { id: 'a', settings: { ttsProvider: 'elevenlabs', elevenlabsVoiceId: 'a-voice' } } },
    apiConfig: { elevenlabsApiKey: 'key' }, ttsCache: new Map() },
    localStorage: { getItem: () => null }, document: { getElementById: () => player, querySelectorAll: () => [] },
    Map, Set, URL, Blob, DOMException, AbortController, Uint8Array, console: { error() {} }, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return new Response(Uint8Array.of(1, 2), { headers: { 'Content-Type': 'audio/mpeg' } }); },
    showCustomAlert: (title, text) => alerts.push({ title, text }),
    showToast: text => { const toast = { text, addEventListener: (_event, fn) => { toast.click = fn; } }; toasts.push(toast); return toast; }, addEventListener() {} };
  c.window = c; vm.createContext(c);
  vm.runInContext(source('modules/tts-provider.js'), c); vm.runInContext(source('modules/tts-audio.js'), c);
  return { c, player, requests, toasts, alerts };
}
test('通话队列保持顺序和原角色配置；切换当前聊天不会串音色，删除只取消对应消息', async () => {
  const f = fixture();
  f.c.playVideoCallPureTTS('保留一', '', 'a', 1);
  f.c.playVideoCallPureTTS('删除二', '', 'a', 2);
  f.c.playVideoCallPureTTS('保留三', '', 'a', 3);
  await turn();
  f.c.state.activeChatId = 'b'; f.c.state.chats.a.settings.elevenlabsVoiceId = 'changed';
  f.c.cancelCallMessageTts('a', 2); f.player.onended(); await turn();
  assert.deepEqual(f.requests.map(r => r.text), ['保留一', '保留三']);
  assert.equal(f.player.dataset.currentText, '保留三');
  f.c.stopTtsQueue(); assert.equal(f.player.paused, true); assert.equal(f.player.onended, null);
});
test('ElevenLabs 音频解码失败停止队列，并可查看经过转义的完整原因；不自动多次付费请求', async () => {
  const f = fixture(); f.c.playVideoCallPureTTS('失败一', '', 'a', 1); f.c.playVideoCallPureTTS('不应提交二', '', 'a', 2);
  await turn(); f.player.onerror(); await turn();
  assert.equal(f.requests.length, 1); assert.match(f.toasts[0].text, /点击查看原因/);
  f.toasts[0].click(); assert.match(f.alerts[0].text, /浏览器无法播放/);
  assert.equal(f.player.paused, true);
});
test('保存设置模板时保留旧角色语速和默认语言，以及各服务独立语速', () => {
  const f = fixture(); vm.runInContext(source('modules/chat-settings-presets.js'), f.c);
  f.c.state.chats.a.settings = { minimaxVoiceId: 'old', ttsSpeed: 1.6 };
  let preset = f.c.getCurrentChatSettings(); assert.equal(preset.minimaxTtsSpeed, 1.6); assert.equal(preset.ttsLanguage, 'zh-CN');
  f.c.state.chats.a.settings = { ttsProvider: 'elevenlabs', elevenlabsVoiceId: 'voice', ttsSpeed: 0.8, minimaxTtsSpeed: 1.7 };
  preset = f.c.getCurrentChatSettings(); assert.equal(preset.elevenlabsTtsSpeed, 0.8); assert.equal(preset.minimaxTtsSpeed, 1.7);
});
