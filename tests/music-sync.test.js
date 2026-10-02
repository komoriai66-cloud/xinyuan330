const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function element() {
  const classes = new Set();
  return {
    children: [], dataset: {}, style: {}, listeners: {}, checked: false, disabled: false,
    classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
      contains: x => classes.has(x), toggle: (x, force) => { const on = force ?? !classes.has(x); on ? classes.add(x) : classes.delete(x); } },
    addEventListener(event, handler) { this.listeners[event] = handler; },
    append(...xs) { this.children.push(...xs); }, appendChild(x) { this.children.push(x); },
    replaceChildren(...xs) { this.children = xs; }, setAttribute(key, value) { this[key] = value; },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
    async emit(event, props = {}) { await this.listeners[event]?.({ target: this, ...props }); }
  };
}

function fixture() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const chats = Object.fromEntries(['a', 'b', 'c', 'group'].map((id, index) => [id,
    { id, name: id, originalName: id, isGroup: id === 'group', settings: { enableMusicTimeAwareness: true },
      history: [], musicData: { totalTime: index * 100 } }]));
  const musicState = { isActive: false, activeChatId: null, isPlaying: false, currentIndex: -1,
    totalElapsedTime: 0, playlist: [], playlists: [], activePlaylistId: 'default', parsedLyrics: [], currentLyricIndex: -1 };
  const writes = [];
  const window = { state: { activeChatId: 'a', chats }, musicState,
    audioPlayer: { currentTime: 12, pause() {}, paused: false } };
  const context = vm.createContext({ window, document: { getElementById: get, querySelector: () => get('listen-icon'), createElement: element },
    db: { chats: { async put(chat) { writes.push(chat.id); } } }, defaultAvatar: 'avatar.png', console,
    navigator: {}, Set, Date, Math, URL, setInterval: fn => { context.tick = fn; return 1; }, clearInterval() {},
    setTimeout: fn => { fn(); return 1; }, addLongPressListener() {},
    showCustomConfirm: async () => { context.confirmations++; return false; } });
  context.confirmations = 0;
  vm.runInContext(source('modules/music-player.js'), context);
  return { context, window, chats, musicState, get, writes };
}

async function select(f, ids, enabled = true) {
  f.window.openMusicSyncSettings();
  f.get('music-sync-enabled').checked = enabled;
  await f.get('music-sync-enabled').emit('change');
  if (enabled) {
    await f.get('music-sync-clear-all').emit('click');
    for (const id of ids) {
      const input = f.get('music-sync-role-list').children.find(row => row.children[0].value === id)?.children[0];
      assert.ok(input, `角色 ${id} 必须可选`);
      input.checked = true;
      await f.get('music-sync-role-list').emit('change', { target: input });
    }
  }
  await f.get('music-sync-apply-btn').emit('click');
}

function contextFor(f, chatId) {
  const request = source('src/js-bundles/trigger-response/request-setup.jsfrag');
  const block = request.slice(request.indexOf("      let musicContext = '';"), request.indexOf('      const maxMemory'));
  return vm.runInContext(`(() => { const musicState = window.musicState; const chatId = ${JSON.stringify(chatId)}; const chat = window.state.chats[chatId]; ${block} return musicContext; })()`, f.context);
}

test('默认关闭：单人感知、切歌旁白、时长与取消行为保持原状', async () => {
  const f = fixture();
  await f.window.startListenTogetherSession('a');
  assert.equal(f.musicState.multiSyncEnabled, false);
  assert.equal(f.window.isMusicAwareChat('a'), true);
  assert.equal(f.window.isMusicAwareChat('b'), false);
  f.window.openMusicSyncSettings();
  assert.equal(f.get('music-sync-enabled').checked, false);
  assert.equal(f.get('music-sync-options').hidden, true);
  assert.equal(f.get('music-sync-modal').classList.contains('visible'), true);
  f.get('music-sync-enabled').checked = true;
  await f.get('music-sync-enabled').emit('change');
  await f.get('music-sync-select-all').emit('click');
  await f.get('music-sync-cancel-btn').emit('click');
  assert.equal(f.musicState.multiSyncEnabled, false);
  await f.window.addMusicActionSystemMessage('将歌曲切换为了《测试》');
  assert.equal(f.chats.a.history[0].content, '[系统提示：用户 (我) 将歌曲切换为了《测试》]');
  assert.equal(f.chats.a.history[0].isHidden, true);
  assert.equal(f.chats.b.history.length, 0);
  f.musicState.isPlaying = true; f.context.tick();
  assert.equal(f.window.getMusicElapsedTime('a'), 1);
  assert.equal(f.chats.b.musicData.totalTime, 100);
});

test('多选角色获得相同歌曲和歌词，未选角色及其他 PA 不串入情景', async () => {
  const f = fixture(); await f.window.startListenTogetherSession('a');
  await select(f, ['a', 'b']);
  f.musicState.playlist = [{ name: '雨天', artist: '歌手' }]; f.musicState.currentIndex = 0;
  f.musicState.parsedLyrics = [{ text: '当前歌词' }, { text: '下一句' }, { text: '再下一句' }]; f.musicState.currentLyricIndex = 0;
  for (const id of ['a', 'b']) {
    const content = contextFor(f, id);
    assert.match(content, /正在和用户一起听歌/); assert.match(content, /《雨天》 - 歌手/);
    assert.match(content, /当前歌词/); assert.match(content, /下一句.*再下一句/);
    assert.doesNotMatch(content, /syncedChatIds|参与角色|其他 PA/);
  }
  assert.equal(contextFor(f, 'c'), '');
  const roleList = f.get('music-sync-role-list'); const oldRows = roleList.children;
  await f.window.addMusicActionSystemMessage('将歌曲切换为了《雨天》');
  assert.equal(f.chats.a.history.length, 1); assert.equal(f.chats.b.history.length, 1); assert.equal(f.chats.c.history.length, 0);
  assert.equal(f.get('music-sync-btn')['aria-pressed'], 'true');
  assert.equal(roleList.children, oldRows);
});

test('全选、空选择校验、删除失效 ID，切换名单不触碰播放进度或触发 AI', async () => {
  const f = fixture(); await f.window.startListenTogetherSession('a');
  f.window.openMusicSyncSettings(); f.get('music-sync-enabled').checked = true;
  await f.get('music-sync-enabled').emit('change');
  await f.get('music-sync-select-all').emit('click');
  await f.get('music-sync-apply-btn').emit('click');
  assert.deepEqual(Array.from(f.musicState.syncedChatIds), ['a', 'b', 'c']);
  assert.equal(f.window.audioPlayer.currentTime, 12);
  await select(f, []);
  assert.equal(f.get('music-sync-status').textContent, '请至少选择一个角色');
  assert.deepEqual(Array.from(f.musicState.syncedChatIds), ['a', 'b', 'c']);
  await f.get('music-sync-cancel-btn').emit('click');
  delete f.chats.c; f.musicState.syncedChatIds.push('b', 'missing');
  await f.window.addMusicActionSystemMessage('切歌');
  assert.equal(f.chats.b.history.length, 1);
  assert.equal(f.window.isMusicAwareChat('missing'), false);
  assert.equal('triggerAiResponse' in f.context, false);
});

test('加入、移除、暂停、关闭同步：每个角色仅累计实际参与时间，恢复原对象', async () => {
  const f = fixture(); await f.window.startListenTogetherSession('a');
  f.musicState.isPlaying = true; f.context.tick();
  await select(f, ['a', 'b']); f.context.tick(); f.context.tick();
  assert.equal(f.window.getMusicElapsedTime('a'), 3); assert.equal(f.window.getMusicElapsedTime('b'), 102);
  f.musicState.isPlaying = false; f.context.tick(); assert.equal(f.window.getMusicElapsedTime('b'), 102);
  await select(f, ['b', 'c']);
  f.musicState.isPlaying = true; f.context.tick();
  assert.equal(f.window.getMusicElapsedTime('a'), 3); assert.equal(f.window.getMusicElapsedTime('b'), 103);
  assert.equal(f.window.getMusicElapsedTime('c'), 201);
  await select(f, [], false);
  assert.equal(f.chats.b.musicData.totalTime, 103); assert.equal(f.chats.c.musicData.totalTime, 201);
  f.context.tick(); assert.equal(f.window.getMusicElapsedTime('a'), 4);
  assert.equal(f.window.isMusicAwareChat('a'), true); assert.equal(f.window.isMusicAwareChat('b'), false);
  assert.equal(f.window.audioPlayer.currentTime, 12);
});

test('已选聊天可直接打开同一播放器，未选聊天仍保留旧切换确认', async () => {
  const f = fixture(); await f.window.startListenTogetherSession('a'); await select(f, ['a', 'b']);
  f.window.state.activeChatId = 'b'; await f.window.handleListenTogetherClick();
  assert.equal(f.context.confirmations, 0); assert.equal(f.musicState.activeChatId, 'a');
  f.window.state.activeChatId = 'c'; await f.window.handleListenTogetherClick();
  assert.equal(f.context.confirmations, 1); assert.equal(f.musicState.activeChatId, 'a');
});

test('自动换歌仅向当前参与者记录一次原有隐藏旁白', async () => {
  const f = fixture(); await f.window.startListenTogetherSession('a'); await select(f, ['a', 'b']);
  f.musicState.playlist = [{ name: '下一首', artist: '歌手' }]; f.musicState.currentIndex = 0;
  f.context.musicState = f.musicState; f.context.state = f.window.state; f.context.playNext = () => {};
  const events = source('src/js-bundles/event-bindings-a/global-controls-and-music.jsfrag');
  const start = events.indexOf("    audioPlayer.addEventListener('ended', async () => {");
  const end = events.indexOf('\n    });', start) + '\n    });'.length;
  f.context.audioPlayer = { addEventListener: (type, fn) => { f.context.ended = fn; } };
  vm.runInContext(events.slice(start, end), f.context);
  await f.context.ended();
  assert.equal(f.chats.a.history[0].content, '[系统提示：上一首歌曲播放完毕，已自动为你切换到《下一首》 - 歌手]');
  assert.equal(f.chats.b.history.length, 1); assert.equal(f.chats.c.history.length, 0);
});

test('被选角色沿用切歌能力，其他聊天获得歌曲变化而不带入切歌角色身份', async () => {
  const f = fixture(); await f.window.startListenTogetherSession('a'); await select(f, ['a', 'b']);
  f.musicState.playlist = [{ name: '雨天', artist: '歌手' }];
  const calls = [];
  Object.assign(f.context, { musicState: f.musicState, state: f.window.state, chatId: 'b', chat: f.chats.b,
    isViewingThisChat: false, playSong: (...args) => calls.push(args) });
  const actions = source('src/js-bundles/trigger-response/response-actions.jsfrag');
  const block = actions.slice(actions.indexOf("          case 'change_music':"), actions.indexOf("          case 'create_memory':"));
  const run = id => { f.context.chatId = id; f.context.chat = f.chats[id];
    vm.runInContext(`for (const msgData of [{type:'change_music',song_name:'雨天'}]) { switch(msgData.type) { ${block} } }`, f.context); };
  run('b'); assert.deepEqual(calls[0], [0, false, 'character']);
  run('c'); assert.equal(calls.length, 1);
  await f.window.addMusicActionSystemMessage('歌曲已切换为《雨天》 - 歌手', false);
  assert.equal(f.chats.a.history[0].content, '[系统提示：歌曲已切换为《雨天》 - 歌手]');
  assert.match(f.chats.b.history[0].content, /b 为你切歌/);
});

test('结束保存参与角色时长，新会话重新默认关闭；群聊原会话可继续使用', async () => {
  const f = fixture(); await f.window.startListenTogetherSession('a'); await select(f, ['a', 'b']);
  f.musicState.isPlaying = true; f.context.tick();
  await f.window.endListenTogetherSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.musicState.isActive, false); assert.equal(f.chats.b.musicData.totalTime, 101);
  assert.equal(f.chats.a.musicData.totalTime, 1); assert.equal(contextFor(f, 'b'), '');
  await f.window.startListenTogetherSession('group');
  assert.equal(f.musicState.multiSyncEnabled, false); assert.equal(f.window.isMusicAwareChat('group'), true);
  await f.window.addMusicActionSystemMessage('切歌');
  assert.equal(f.chats.group.history[0].content, '[系统提示：用户 (我) 切歌]');
});

test('UI 入口只位于一起听，弹窗默认关闭且不移除现有操作', () => {
  const html = source('src/html/chat-interface.html');
  const playerStart = html.indexOf('id="music-player-overlay"');
  const playerEnd = html.indexOf('id="music-sync-modal"');
  assert.ok(html.indexOf('id="music-sync-btn"') > playerStart && html.indexOf('id="music-sync-btn"') < playerEnd);
  assert.match(html, /id="music-sync-enabled" type="checkbox" aria-labelledby/);
  assert.match(html, /id="music-sync-options" hidden/);
  for (const id of ['music-return-btn', 'music-exit-btn', 'toggle-fullscreen-btn', 'music-playlist-btn', 'show-avatars-btn',
    'music-play-pause-btn', 'music-next-btn', 'music-prev-btn', 'music-mode-btn', 'toggle-blur-btn']) assert.ok(html.includes(`id="${id}"`));
  const css = source('css/media/music-player.css');
  assert.match(css, /#music-sync-modal \{ z-index: 210 !important;/);
  assert.match(css, /width: calc\(100% - 32px\)/);
  assert.match(css, /\.music-sync-role span \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis/);
});
