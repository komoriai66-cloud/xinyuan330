const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)) };
    this.style = {};
    this.dataset = {};
    this.innerHTML = '';
  }

  appendChild(child) { this.children.push(child); }
  addEventListener() {}
  querySelector() { return null; }
}

function loadRenderer(rules) {
  const context = vm.createContext({
    window: {},
    document: { readyState: 'loading', createElement: () => new Element(), addEventListener: () => {} },
    db: { renderingRules: { toArray: async () => rules } },
    formatTimestamp: () => '21:08',
    defaultAvatar: 'avatar.png',
    defaultMyGroupAvatar: 'avatar.png',
    defaultGroupMemberAvatar: 'avatar.png',
    STICKER_REGEX: /^https?:\/\/.*\.gif$/,
    processMentions: text => text,
    parseMarkdown: text => text,
    addLongPressListener: () => {},
    isSelectionMode: false,
    state: {},
    console
  });
  context.window.renderSafeRichText = text => String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const file of ['modules/rendering-rules.js', 'modules/chat/message-element.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  context.applyRenderingRulesDetailed = context.window.applyRenderingRulesDetailed;
  return context;
}

function bubbleFrom(wrapper) {
  return wrapper.children[0].children[0];
}

test('plain-text rules clean user and character messages without changing bubble layout', async () => {
  const context = loadRenderer([{ name: '去八股', chatId: ['global'], regex: '八股', template: '', isEnabled: true }]);
  const chat = { id: 'chat-1', settings: { offlineContinuousLayout: false } };

  for (const role of ['user', 'assistant']) {
    for (const type of ['text', 'offline_text']) {
      const wrapper = await context.createMessageElement({ role, type, content: '「八股你好」\n八股描写', timestamp: 1 }, chat);
      const bubble = bubbleFrom(wrapper);
      assert.doesNotMatch(bubble.innerHTML, /八股/);
      assert.equal(bubble.classes.has('is-card-like'), false);
      if (type === 'offline_text') {
        assert.match(bubble.innerHTML, /offline-dialogue/);
        assert.match(bubble.innerHTML, /offline-description/);
      }
    }
  }

  chat.settings.offlineContinuousLayout = true;
  const continuous = bubbleFrom(await context.createMessageElement({ role: 'assistant', type: 'offline_text', content: '「八股你好」\n八股描写', timestamp: 2 }, chat));
  assert.match(continuous.innerHTML, /offline-continuous/);
  assert.doesNotMatch(continuous.innerHTML, /八股/);
  assert.equal(continuous.classes.has('is-card-like'), false);

  const legacy = bubbleFrom(await context.createMessageElement({ role: 'assistant', type: 'offline_text', dialogue: '「八股你好」', description: '八股描写', timestamp: 3 }, chat));
  assert.doesNotMatch(legacy.innerHTML, /八股/);
  assert.equal(legacy.classes.has('is-card-like'), false);
});

test('plain-text replacement stays in the normal bubble', async () => {
  const context = loadRenderer([{ name: '替换', chatId: ['global'], regex: '八股', template: '自然', isEnabled: true }]);
  const chat = { id: 'chat-1', settings: {} };
  const bubble = bubbleFrom(await context.createMessageElement({ role: 'assistant', type: 'offline_text', content: '「八股表达」', timestamp: 1 }, chat));
  assert.match(bubble.innerHTML, /自然表达/);
  assert.equal(bubble.classes.has('is-card-like'), false);
});

test('HTML rendering templates retain card behavior', async () => {
  const context = loadRenderer([{ name: '卡片', chatId: ['global'], regex: '卡片', template: '<div class="card">内容</div>', isEnabled: true }]);
  const chat = { id: 'chat-1', settings: {} };
  for (const type of ['text', 'offline_text']) {
    const bubble = bubbleFrom(await context.createMessageElement({ role: 'assistant', type, content: '卡片', timestamp: 1 }, chat));
    assert.match(bubble.innerHTML, /<div class="card">内容<\/div>/);
    assert.equal(bubble.classes.has('is-card-like'), true);
  }
});
