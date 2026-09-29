import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import publicWorker from '../public-worker.js';
import adminWorker from '../admin-worker.js';
import { ADMIN_HTML } from '../admin-page.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const wrap = sql => {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      first() { return sqlite.prepare(sql).get(...values) || null; },
      all() { return { results: sqlite.prepare(sql).all(...values) }; },
      run() { return sqlite.prepare(sql).run(...values); }
    };
  };
  return { prepare: wrap, async batch(statements) { return statements.map(statement => statement.run()); }, close() { sqlite.close(); } };
}
function environment() {
  return {
    DB: database(),
    RATE_LIMITER: { async limit() { return { success: true }; } },
    READ_LIMITER: { async limit() { return { success: true }; } },
    ADMIN_LIMITER: { async limit() { return { success: true }; } },
    ALLOWED_ORIGINS: 'https://example.test',
    TURNSTILE_SECRET: 'test-secret',
    TURNSTILE_HOSTNAMES: 'example.test',
    ADMIN_TOKEN_HASH: createHash('sha256').update('34'.repeat(32)).digest('hex')
  };
}
test('existing feedback databases can add the conversation closure field', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)');
    sqlite.exec(fs.readFileSync(new URL('../migrations/2026-09-29-visitor-close.sql', import.meta.url), 'utf8'));
    sqlite.prepare('INSERT INTO threads (id) VALUES (?)').run('existing');
    assert.equal(sqlite.prepare('SELECT visitor_closed FROM threads WHERE id = ?').get('existing').visitor_closed, 0);
  } finally { sqlite.close(); }
});
function body(kind, id, token, image) {
  const form = new FormData();
  Object.entries({ kind, id, token, category: 'wish', title: '一条心愿', body: '希望能收到回复', turnstileToken: 'test-token' })
    .forEach(([key, value]) => form.set(key, value));
  if (image) form.set('image', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], 'proof.png', { type: 'image/png' }));
  return form;
}
async function publicCall(env, path, options = {}, token) {
  const headers = new Headers(options.headers || {});
  headers.set('Origin', 'https://example.test');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return publicWorker.fetch(new Request(`https://api.example.test${path}`, { ...options, headers }), env);
}
async function adminCall(env, path, options = {}, token = '34'.repeat(32)) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return adminWorker.fetch(new Request(`https://admin.example.test${path}`, { ...options, headers }), env);
}

test('private messages require the local credential, and only the admin key can manage them', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: 'example.test' }), { status: 200 });
  const env = environment();
  try {
    const id = crypto.randomUUID();
    const token = 'ab'.repeat(32);
    const created = await publicCall(env, '/threads', { method: 'POST', body: body('private', id, token, true) });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).thread.kind, 'private');
    assert.equal((await publicCall(env, `/threads/${id}`)).status, 403);
    assert.equal((await publicCall(env, `/threads/${id}`, {}, 'cd'.repeat(32))).status, 403);
    const own = await publicCall(env, `/threads/${id}`, {}, token);
    const conversation = await own.json();
    assert.equal(conversation.messages[0].body, '希望能收到回复');
    assert.equal((await publicCall(env, `/attachments/${conversation.messages[0].attachment_key}`)).status, 403);
    assert.equal((await publicCall(env, `/attachments/${conversation.messages[0].attachment_key}`, {}, token)).status, 200);
    assert.equal((await adminWorker.fetch(new Request('https://admin.example.test/api/threads'), env)).status, 401);
    assert.equal((await adminCall(env, '/api/threads', {}, '56'.repeat(32))).status, 401);
    assert.equal((await adminCall(env, '/api/session')).status, 200);
    assert.equal((await adminCall(env, `/api/threads/${id}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: '已收到，谢谢你的建议。' })
    })).status, 201);
    const inbox = await publicCall(env, '/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threads: [{ id, token }] }) });
    assert.ok((await inbox.json()).threads[0].last_admin_at > 0);
    assert.equal((await publicCall(env, `/threads/${id}`, { method: 'DELETE' }, token)).status, 200);
    assert.equal((await publicCall(env, `/threads/${id}`, {}, token)).status, 404);
  } finally { env.DB.close(); globalThis.fetch = originalFetch; }
});

test('public feedback stays hidden until moderation, then becomes readable without a credential', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: 'example.test' }), { status: 200 });
  const env = environment();
  try {
    const id = crypto.randomUUID();
    const token = 'ef'.repeat(32);
    assert.equal((await publicCall(env, '/threads', { method: 'POST', body: body('public', id, token, true) })).status, 201);
    assert.equal((await publicCall(env, `/threads/${id}`)).status, 403);
    assert.equal((await (await publicCall(env, '/public/threads')).json()).threads.length, 0);
    assert.equal((await adminCall(env, `/api/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'visible' }) })).status, 200);
    const visible = await publicCall(env, `/threads/${id}`);
    assert.equal(visible.status, 200);
    const content = await visible.json();
    assert.ok(!('secret_hash' in content.thread));
    assert.equal((await publicCall(env, `/attachments/${content.messages[0].attachment_key}`)).status, 200);
    assert.equal((await (await publicCall(env, '/public/threads')).json()).threads[0].id, id);
    assert.equal((await adminCall(env, `/api/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'hidden' }) })).status, 200);
    assert.equal((await publicCall(env, `/threads/${id}`)).status, 403);
  } finally { env.DB.close(); globalThis.fetch = originalFetch; }
});

test('owners can close private and public conversations without changing public visibility', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: 'example.test' }), { status: 200 });
  const env = environment();
  try {
    for (const kind of ['private', 'public']) {
      const id = crypto.randomUUID();
      const token = kind === 'private' ? 'aa'.repeat(32) : 'bb'.repeat(32);
      assert.equal((await publicCall(env, '/threads', { method: 'POST', body: body(kind, id, token) })).status, 201);
      if (kind === 'public') {
        assert.equal((await adminCall(env, `/api/threads/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'visible' })
        })).status, 200);
      }
      assert.equal((await publicCall(env, `/threads/${id}`, { method: 'PATCH' })).status, 403);
      assert.equal((await publicCall(env, `/threads/${id}`, { method: 'PATCH' }, token)).status, 200);
      const own = await (await publicCall(env, `/threads/${id}`, {}, token)).json();
      assert.equal(own.thread.visitor_closed, 1);
      assert.equal(own.messages.length, 1);
      const inbox = await (await publicCall(env, '/inbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threads: [{ id, token }] })
      })).json();
      assert.equal(inbox.threads[0].visitor_closed, 1);
      const reply = new FormData();
      reply.set('messageId', crypto.randomUUID());
      reply.set('body', '再次补充');
      assert.equal((await publicCall(env, `/threads/${id}/messages`, { method: 'POST', body: reply }, token)).status, 409);
      assert.equal((await adminCall(env, `/api/threads/${id}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: '作者继续回复' })
      })).status, 409);
      if (kind === 'public') {
        assert.equal((await (await publicCall(env, '/public/threads')).json()).threads[0].id, id);
        assert.equal((await publicCall(env, `/threads/${id}`)).status, 200);
      }
      assert.equal((await publicCall(env, `/threads/${id}`, { method: 'DELETE' }, token)).status, 200);
    }
  } finally { env.DB.close(); globalThis.fetch = originalFetch; }
});

test('public API rejects unlisted browser origins', async () => {
  const env = environment();
  try {
    const response = await publicWorker.fetch(new Request('https://api.example.test/public/threads', {
      headers: { Origin: 'https://attacker.example' }
    }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  } finally { env.DB.close(); }
});

test('public API accepts loopback origins on any local port', async () => {
  const env = environment();
  try {
    for (const origin of ['http://localhost:5500', 'http://127.0.0.1:8080']) {
      const response = await publicWorker.fetch(new Request('https://api.example.test/health', {
        method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' }
      }), env);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    }
    for (const origin of ['http://localhost.attacker.example:5500', 'file://', 'null']) {
      const response = await publicWorker.fetch(new Request('https://api.example.test/health', {
        headers: { Origin: origin }
      }), env);
      assert.equal(response.status, 403);
    }
  } finally { env.DB.close(); }
});

test('admin page script parses and private metadata stays out of public responses', async () => {
  const script = ADMIN_HTML.split('<script>')[1]?.split('</script>')[0];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: 'example.test' }), { status: 200 });
  const env = environment();
  try {
    const id = crypto.randomUUID();
    const token = '12'.repeat(32);
    await publicCall(env, '/threads', { method: 'POST', body: body('public', id, token) });
    const result = await publicCall(env, `/threads/${id}`, {}, token);
    const thread = (await result.json()).thread;
    assert.ok(!Object.hasOwn(thread, 'secret_hash'));
    assert.ok(!Object.hasOwn(thread, 'note'));
  } finally { env.DB.close(); globalThis.fetch = originalFetch; }
});
