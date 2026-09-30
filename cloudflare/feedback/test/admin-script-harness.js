import assert from 'node:assert/strict';
import vm from 'node:vm';

// Execute the embedded script without the Worker's module scope or a real admin key.
export async function checkAdminScript(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'The admin page must contain its browser script');
  const element = () => ({
    value: '', hidden: false, innerHTML: '', textContent: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    replaceChildren() { this.innerHTML = ''; }, focus() {},
  });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => ['#' + m[1], element()]));
  elements.set('main', element());
  elements.get('#filter').value = 'all';
  const groups = new Map(['product', 'view', 'kind'].map((key) => [
    `[data-${key}]`,
    [...html.matchAll(new RegExp(`data-${key}="([^"]+)"`, 'g'))].map((m) => ({ ...element(), dataset: { [key]: m[1] } })),
  ]));
  const storage = new Map();
  const requests = [];
  vm.runInNewContext(script, {
    document: {
      querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: (selector) => groups.get(selector) || [],
    },
    window: { addEventListener() {} },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    Headers, URLSearchParams, setTimeout, clearTimeout,
    fetch: async (path) => {
      requests.push(path);
      const route = new URL(path, 'https://fixture.invalid').pathname;
      const responses = {
        '/api/session': { ok: true },
        '/api/threads': { threads: [], nextCursor: null },
        '/api/tasks': { tasks: [], nextCursor: null },
        '/api/knowledge': { entries: [], nextCursor: null },
        '/api/dashboard': { counts: {} },
      };
      assert.ok(route in responses, `Unexpected request: ${route}`);
      return Response.json(responses[route]);
    },
  }, { timeout: 1000 });
  assert.equal(typeof elements.get('#login-form').onsubmit, 'function');
  assert.equal(requests.length, 0, 'Opening the login page must not require a key');
  await elements.get('#login-form').onsubmit({
    preventDefault() {}, target: { elements: { token: { value: 'a'.repeat(64) } } },
  });
  assert.equal(elements.get('#login-notice').textContent, '');
  assert.equal(elements.get('#notice').textContent, '');
  assert.equal(elements.get('#login').hidden, true);
  assert.equal(elements.get('#list').innerHTML, '暂无匹配内容');
  for (const view of ['tasks', 'knowledge', 'threads']) {
    const tab = groups.get('[data-view]').find((button) => button.dataset.view === view);
    assert.ok(tab, `Missing ${view} tab`);
    tab.onclick();
    await new Promise(setImmediate);
    assert.equal(elements.get('#notice').textContent, '');
    assert.ok(requests.some((path) => path.startsWith(`/api/${view}?`)));
  }
  elements.get('#logout').onclick();
  assert.equal(elements.get('#login').hidden, false);
  assert.equal(storage.size, 0);
}
