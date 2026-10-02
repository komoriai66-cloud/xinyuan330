const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../modules/voice-recording.js'), 'utf8');

function fixture(readyState) {
  const listeners = new Map();
  const button = { style: {}, addEventListener() {} };
  const notices = [];
  const window = { addEventListener() {} };
  const context = vm.createContext({
    window,
    document: {
      readyState,
      getElementById: id => id === 'voice-record-btn' ? button : null,
      addEventListener: (event, callback) => listeners.set(event, callback)
    },
    showToast: message => notices.push(message),
    console
  });
  vm.runInContext(source, context);
  return { window, button, listeners, notices };
}

test('状态尚未创建时，在 interactive/complete 阶段初始化仍会导出录音 API', async () => {
  for (const readyState of ['interactive', 'complete']) {
    const f = fixture(readyState);
    assert.equal(typeof f.window.voiceRecording.startRecording, 'function');
    assert.equal(f.button.title, '录制真实语音');
    assert.equal(await f.window.voiceRecording.startCallRecording(), false);
    assert.deepEqual(f.notices, ['请先打开一个聊天']);
  }
});

test('loading 阶段等待 DOMContentLoaded，回调在状态缺失时也能完成', () => {
  const f = fixture('loading');
  assert.equal(f.button.title, undefined);
  assert.doesNotThrow(() => f.listeners.get('DOMContentLoaded')());
  assert.equal(f.button.title, '录制真实语音');
});

test('初始化后创建、替换状态和切换聊天时，读取当前 window.state', async () => {
  const f = fixture('interactive');
  f.window.state = { activeChatId: 'a', chats: { a: { settings: { enableRealVoice: false } } } };
  f.window.voiceRecording.refreshAvailability();
  assert.equal(f.button.style.display, 'none');
  assert.equal(await f.window.voiceRecording.startRecording('chat'), false);
  assert.deepEqual(f.notices, ['当前聊天未启用真实语音']);
  f.window.state = {
    activeChatId: 'b', chats: { b: { settings: { enableRealVoice: true, realVoiceOperation: 'hold' } } }
  };
  f.window.voiceRecording.refreshAvailability();
  assert.equal(f.button.style.display, '');
  assert.equal(f.button.title, '按住发送真实语音');
  f.window.state.activeChatId = null;
  assert.doesNotThrow(() => f.window.voiceRecording.refreshAvailability());
  assert.equal(f.button.title, '录制真实语音');
});
