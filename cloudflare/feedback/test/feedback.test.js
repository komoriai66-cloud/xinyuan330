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
  return { prepare: wrap, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }, close() { sqlite.close(); } };
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
test('existing feedback records are assigned to EPhone by the product migration', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, kind TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)');
    sqlite.prepare('INSERT INTO threads (id, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('existing', 'public', 'visible', 1, 1);
    sqlite.exec(fs.readFileSync(new URL('../migrations/2026-09-29-product.sql', import.meta.url), 'utf8'));
    assert.equal(sqlite.prepare('SELECT product FROM threads WHERE id = ?').get('existing').product, 'ephone');
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

test('UWU and EPhone feedback have separate public boards and one filtered admin inbox', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: 'example.test' }), { status: 200 });
  const env = environment();
  try {
    const ephoneId = crypto.randomUUID();
    const uwuId = crypto.randomUUID();
    const ephoneForm = body('public', ephoneId, 'ab'.repeat(32));
    const uwuForm = body('public', uwuId, 'cd'.repeat(32));
    uwuForm.set('product', 'uwu');
    assert.equal((await publicCall(env, '/threads', { method: 'POST', body: ephoneForm })).status, 201);
    assert.equal((await publicCall(env, '/threads', { method: 'POST', body: uwuForm })).status, 201);
    for (const id of [ephoneId, uwuId]) {
      assert.equal((await adminCall(env, `/api/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'visible' }) })).status, 200);
    }
    const ephone = await (await publicCall(env, '/public/threads')).json();
    const uwu = await (await publicCall(env, '/public/threads?product=uwu')).json();
    assert.deepEqual(ephone.threads.map(row => row.id), [ephoneId]);
    assert.deepEqual(uwu.threads.map(row => row.id), [uwuId]);
    const adminUwu = await (await adminCall(env, '/api/threads?product=uwu&kind=public&status=visible')).json();
    assert.deepEqual(adminUwu.threads.map(row => row.id), [uwuId]);
    assert.equal((await publicCall(env, '/public/threads?product=other')).status, 400);
  } finally { env.DB.close(); globalThis.fetch = originalFetch; }
});

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

const jsonOptions = (value, method = 'POST') => ({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
async function scenario(run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({success:true,hostname:'example.test'}));
  const env = environment();
  try { await run(env); } finally { env.DB.close();globalThis.fetch=originalFetch; }
}
async function createThread(env,kind='private',image=false,product='ephone') {
  const id=crypto.randomUUID(),token='ab'.repeat(32),form=body(kind,id,token,image);form.set('product',product);
  assert.equal((await publicCall(env,'/threads',{method:'POST',body:form})).status,201);
  return {id,token,content:await (await publicCall(env,'/threads/'+id,{},token)).json()};
}
function editForm(message,bodyText,image=false){const form=new FormData();form.set('version',message.version);form.set('body',bodyText);form.set('turnstileToken','test-token');if(image)form.set('image',new File([new Uint8Array([137,80,78,71,13,10,26,10,1])],'new.png',{type:'image/png'}));return form;}

test('message ownership, optimistic versions and closed-conversation edits are enforced',()=>scenario(async env=>{
  const {id,token,content}=await createThread(env,'private',true);const message=content.messages[0],path=`/threads/${id}/messages/${message.id}`;
  assert.equal((await publicCall(env,path,{method:'PATCH',body:editForm(message,'恶意修改')},'cd'.repeat(32))).status,403);
  assert.equal((await adminCall(env,'/api'+path,{method:'PATCH',body:editForm(message,'改写用户的话')})).status,403);
  await publicCall(env,'/threads/'+id,{method:'PATCH'},token);
  const form=editForm(message,'修正内容');form.set('removeImage','1');
  assert.equal((await publicCall(env,path,{method:'PATCH',body:form},token)).status,200);
  assert.equal((await publicCall(env,'/attachments/'+message.attachment_key,{},token)).status,404);
  assert.equal((await publicCall(env,path,{method:'PATCH',body:editForm(message,'旧版本覆盖')},token)).status,409);
  const changed=await (await publicCall(env,'/threads/'+id,{},token)).json();assert.equal(changed.messages[0].body,'修正内容');assert.equal(changed.messages[0].version,2);
  assert.equal(changed.thread.title,'修正内容');
  assert.equal((await publicCall(env,path+'/retract',jsonOptions({version:2}),token)).status,200);
  const withdrawn=await (await publicCall(env,'/threads/'+id,{},token)).json();assert.equal(withdrawn.messages[0].body,'');assert.equal(withdrawn.messages[0].state,'retracted');assert.ok(!withdrawn.thread.title.includes('修正内容'));
  assert.equal((await publicCall(env,path,jsonOptions({version:3},'DELETE'),token)).status,200);
  assert.equal((await (await publicCall(env,'/threads/'+id,{},token)).json()).messages.length,0);
}));

test('public additions and edits hide text, titles and attachments until message approval',()=>scenario(async env=>{
  const {id,token,content}=await createThread(env,'public');await adminCall(env,'/api/threads/'+id,jsonOptions({status:'visible'},'PATCH'));
  const first=content.messages[0];const form=editForm(first,'不能泄漏的修改正文',true);
  assert.equal((await publicCall(env,`/threads/${id}/messages/${first.id}`,{method:'PATCH',body:form},token)).status,200);
  const own=await (await publicCall(env,'/threads/'+id,{},token)).json();const publicView=await (await publicCall(env,'/threads/'+id)).json();
  assert.equal(publicView.messages[0].body,'');assert.equal(publicView.messages[0].attachment_key,null);assert.equal(publicView.thread.title,'内容待审核');
  assert.equal((await publicCall(env,'/attachments/'+own.messages[0].attachment_key)).status,403);
  assert.equal((await (await publicCall(env,'/public/threads?q='+encodeURIComponent('不能泄漏'))).json()).threads.length,0);
  assert.equal((await adminCall(env,`/api/threads/${id}/messages/${first.id}/approve`,jsonOptions({version:1}))).status,409);
  assert.equal((await adminCall(env,`/api/threads/${id}/messages/${first.id}/approve`,jsonOptions({version:2}))).status,200);
  assert.equal((await publicCall(env,'/attachments/'+own.messages[0].attachment_key)).status,200);
  assert.equal((await (await publicCall(env,'/public/threads?q='+encodeURIComponent('不能泄漏'))).json()).threads.length,1);
  const reply=new FormData();reply.set('messageId',crypto.randomUUID());reply.set('body','补充敏感内容');reply.set('turnstileToken','test-token');
  assert.equal((await publicCall(env,'/threads/'+id+'/messages',{method:'POST',body:reply},token)).status,201);
  const publicMessages=(await (await publicCall(env,'/threads/'+id)).json()).messages;assert.equal(publicMessages.at(-1).moderation,'pending');assert.equal(publicMessages.at(-1).body,'');
}));

test('admin image replies deduplicate retries, cannot be edited by visitors and revoke images on removal',()=>scenario(async env=>{
  const {id,token}=await createThread(env);const messageId=crypto.randomUUID();
  const form=new FormData();form.set('messageId',messageId);form.set('body','作者附图');form.set('image',new File([new Uint8Array([137,80,78,71,13,10,26,10,1])],'admin.png',{type:'image/png'}));
  assert.equal((await adminCall(env,'/api/threads/'+id+'/reply',{method:'POST',body:form})).status,201);
  assert.equal((await adminCall(env,'/api/threads/'+id+'/reply',{method:'POST',body:form})).status,200);
  const content=await (await publicCall(env,'/threads/'+id,{},token)).json(),m=content.messages.find(v=>v.id===messageId);
  assert.equal(content.messages.length,2);assert.equal((await publicCall(env,'/attachments/'+m.attachment_key,{},token)).status,200);
  assert.equal((await publicCall(env,`/threads/${id}/messages/${m.id}`,jsonOptions({version:m.version},'DELETE'),token)).status,403);
  assert.equal((await adminCall(env,`/api/threads/${id}/messages/${m.id}/retract`,jsonOptions({version:m.version}))).status,200);
  assert.equal((await adminCall(env,'/api/attachments/'+m.attachment_key)).status,404);
  const visitor=content.messages[0];assert.equal((await adminCall(env,`/api/threads/${id}/messages/${visitor.id}/remove`,jsonOptions({version:visitor.version}))).status,200);
  const removed=await (await publicCall(env,'/threads/'+id,{},token)).json();assert.equal(removed.messages[0].state,'removed');assert.equal(removed.messages[0].body,'');
}));

test('ending an author conversation does not remove its public visibility',()=>scenario(async env=>{
  const {id,token}=await createThread(env,'public');await adminCall(env,'/api/threads/'+id,jsonOptions({status:'visible'},'PATCH'));
  await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({author_closed:true},'PATCH'));
  assert.equal((await publicCall(env,'/threads/'+id)).status,200);
  assert.equal((await (await publicCall(env,'/public/threads')).json()).threads.length,1);
  assert.equal((await adminCall(env,'/api/threads/'+id+'/reply',jsonOptions({body:'不能继续'}))).status,409);
  assert.equal((await (await adminCall(env,'/api/threads?status=needs_reply')).json()).threads.length,0);
  await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({author_closed:false},'PATCH'));
  assert.equal((await adminCall(env,'/api/threads/'+id+'/reply',jsonOptions({body:'重新开启'}))).status,201);
  await publicCall(env,'/threads/'+id,{method:'PATCH'},token);
  await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({author_closed:false},'PATCH'));
  assert.equal((await adminCall(env,'/api/threads/'+id+'/reply',jsonOptions({body:'尊重用户结束'}))).status,409);
}));

test('read state, triage and snoozing are separate from replies and body search',()=>scenario(async env=>{
  const {id,token}=await createThread(env);assert.equal((await (await adminCall(env,'/api/dashboard')).json()).counts.unread,1);
  await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({read:true},'PATCH'));
  let dashboard=await (await adminCall(env,'/api/dashboard')).json();assert.equal(dashboard.counts.unread,0);assert.equal(dashboard.counts.reply,1);
  await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({triage:'none'},'PATCH'));
  assert.equal((await (await adminCall(env,'/api/threads?status=needs_reply')).json()).threads.length,0);
  await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({triage:'reply',snoozed_until:Date.now()+86400000},'PATCH'));
  assert.equal((await (await adminCall(env,'/api/dashboard')).json()).counts.reply,0);
  assert.equal((await (await adminCall(env,'/api/threads?q='+encodeURIComponent('希望能收到'))).json()).threads.length,1);
  const reply=new FormData();reply.set('messageId',crypto.randomUUID());reply.set('body','补充资料');reply.set('turnstileToken','test-token');await publicCall(env,'/threads/'+id+'/messages',{method:'POST',body:reply},token);
  dashboard=await (await adminCall(env,'/api/dashboard')).json();assert.equal(dashboard.counts.unread,1);assert.equal(dashboard.counts.reply,1);
}));

test('tasks retain author summaries after feedback deletion and batch notifications retry safely',()=>scenario(async env=>{
  const first=await createThread(env),second=await createThread(env),closed=await createThread(env),other=await createThread(env,'private',false,'uwu');
  const created=await adminCall(env,'/api/tasks',jsonOptions({product:'ephone',title:'作者整理的任务',body:'下一步',thread_id:first.id,review_at:Date.now()-1000}));assert.equal(created.status,201);const taskId=(await created.json()).id;
  for(const t of [second,closed])assert.equal((await adminCall(env,'/api/tasks/'+taskId+'/links',jsonOptions({thread_id:t.id}))).status,200);
  assert.equal((await adminCall(env,'/api/tasks/'+taskId+'/links',jsonOptions({thread_id:other.id}))).status,400);
  await publicCall(env,'/threads/'+closed.id,{method:'PATCH'},closed.token);
  const preview=await (await adminCall(env,'/api/tasks/'+taskId+'/notify')).json();assert.equal(preview.total,2);
  const notify={body:'已修复，请更新',batch_id:crypto.randomUUID()};
  for(let i=0;i<2;i++)assert.equal((await adminCall(env,'/api/tasks/'+taskId+'/notify',jsonOptions(notify))).status,200);
  assert.equal((await (await publicCall(env,'/threads/'+first.id,{},first.token)).json()).messages.length,2);
  await publicCall(env,'/threads/'+first.id,{method:'DELETE'},first.token);
  const remaining=await (await adminCall(env,'/api/tasks/'+taskId)).json();assert.equal(remaining.task.body,'下一步');assert.equal(remaining.threads.length,2);
  assert.equal((await (await adminCall(env,'/api/tasks?state=due')).json()).tasks.length,1);
  assert.equal((await publicCall(env,'/api/tasks')).status,404);
}));

test('published knowledge is product-scoped and result confirmations require the owner',()=>scenario(async env=>{
  for(const [product,published] of [['ephone',true],['ephone',false],['uwu',true]])assert.equal((await adminCall(env,'/api/knowledge',jsonOptions({product,published,category:'faq',title:'公开解答',body:'请更新应用'}))).status,201);
  assert.equal((await (await publicCall(env,'/public/knowledge')).json()).entries.length,1);
  assert.equal((await (await publicCall(env,'/public/knowledge?product=uwu')).json()).entries.length,1);
  const {id,token}=await createThread(env);
  await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({outcome:'resolved',outcome_note:'请更新',resolved_version:'1.2'},'PATCH'));
  assert.equal((await publicCall(env,'/threads/'+id+'/result',jsonOptions({result:'resolved'}))).status,403);
  assert.equal((await publicCall(env,'/threads/'+id+'/result',jsonOptions({result:'problem'}),token)).status,200);
  const content=await (await adminCall(env,'/api/threads/'+id)).json();assert.equal(content.thread.outcome,'received');assert.equal(content.thread.visitor_result,'problem');
  assert.equal((await (await adminCall(env,'/api/threads?status=unread')).json()).threads.length,1);
}));

test('public payloads never include triage, environment, notes or linked tasks',()=>scenario(async env=>{
  const {id,token}=await createThread(env,'public');await adminCall(env,'/api/threads/'+id,jsonOptions({status:'visible',note:'内部备注'},'PATCH'));
  const content=await (await publicCall(env,'/threads/'+id)).json();
  for(const key of ['secret_hash','note','admin_seen_at','triage','snoozed_until','environment','tasks'])assert.ok(!(key in content.thread));
  const message=content.messages[0];assert.equal((await publicCall(env,`/threads/${id}/messages/${message.id}/remove`,jsonOptions({version:message.version}),token)).status,403);
}));

test('workbench migration preserves old content and keeps legacy closed public feedback hidden',()=>{
  const sqlite=new DatabaseSync(':memory:');try{
    sqlite.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, product TEXT, kind TEXT, status TEXT, title TEXT,
      created_at INTEGER, updated_at INTEGER, last_admin_at INTEGER DEFAULT 0, last_visitor_at INTEGER DEFAULT 0);
      CREATE TABLE messages(id TEXT PRIMARY KEY,thread_id TEXT,sender TEXT,body TEXT,attachment_key TEXT,attachment_type TEXT,created_at INTEGER);`);
    sqlite.prepare('INSERT INTO threads(id,product,kind,status,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('old','uwu','public','closed','旧标题',1,1);
    sqlite.exec(fs.readFileSync(new URL('../migrations/2026-09-30-workbench.sql',import.meta.url),'utf8'));
    const row=sqlite.prepare('SELECT * FROM threads').get();assert.equal(row.author_closed,1);assert.equal(row.status,'hidden');assert.equal(row.public_title,'旧标题');
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get());
  }finally{sqlite.close();}
});

test('correcting legacy product keeps credentials valid and requires unlinking incompatible tasks',()=>scenario(async env=>{
  const {id,token}=await createThread(env);
  const response=await adminCall(env,'/api/tasks',jsonOptions({product:'ephone',title:'原来源任务',thread_id:id}));
  const taskId=(await response.json()).id;
  assert.equal((await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({product:'uwu'},'PATCH'))).status,409);
  assert.equal((await adminCall(env,'/api/tasks/'+taskId+'/links',jsonOptions({thread_id:id},'DELETE'))).status,200);
  assert.equal((await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({product:'uwu'},'PATCH'))).status,200);
  assert.equal((await (await publicCall(env,'/threads/'+id,{},token)).json()).thread.product,'uwu');
  assert.equal((await adminCall(env,'/api/threads/'+id+'/manage',jsonOptions({product:'invalid'},'PATCH'))).status,400);
}));

test('publishing first submission approves its current title while later edits need individual review',()=>scenario(async env=>{
  const {id,token,content}=await createThread(env,'public');const first=content.messages[0];
  assert.equal((await publicCall(env,`/threads/${id}/messages/${first.id}`,{method:'PATCH',body:editForm(first,'发布前修正的标题')},token)).status,200);
  await adminCall(env,'/api/threads/'+id,jsonOptions({status:'visible'},'PATCH'));
  let result=await (await publicCall(env,'/threads/'+id)).json();assert.equal(result.thread.title,'发布前修正的标题');assert.equal(result.messages[0].body,'发布前修正的标题');
  await adminCall(env,'/api/threads/'+id+'/reply',jsonOptions({body:'作者回复不应改变反馈标题'}));
  assert.equal((await (await publicCall(env,'/threads/'+id)).json()).thread.title,'发布前修正的标题');
  await publicCall(env,`/threads/${id}/messages/${first.id}`,{method:'PATCH',body:editForm(result.messages[0],'发布后重新修改的内容')},token);
  await adminCall(env,'/api/threads/'+id,jsonOptions({status:'visible'},'PATCH'));
  result=await (await publicCall(env,'/threads/'+id)).json();assert.equal(result.thread.title,'内容待审核');assert.equal(result.messages[0].body,'');
}));

test('editing the first message to an image-only message retains a readable title',()=>scenario(async env=>{
  const {id,token,content}=await createThread(env,'private');
  const m=content.messages[0];
  assert.equal((await publicCall(env,`/threads/${id}/messages/${m.id}`,{method:'PATCH',body:editForm(m,'',true)},token)).status,200);
  const result=await (await publicCall(env,'/threads/'+id,{},token)).json();
  assert.equal(result.thread.title,'附图反馈');assert.ok(result.messages[0].attachment_key);
}));
