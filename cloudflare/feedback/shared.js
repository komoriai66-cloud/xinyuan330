export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const tokenPattern = /^[0-9a-f]{64}$/i;
export const categories = new Set(['wish', 'feedback', 'bug', 'other']);

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}
export function fail(error, status = 400, headers = {}) { return json({ error }, status, headers); }
export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function bearer(request) {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(request.headers.get('Authorization') || '');
  return match?.[1] || null;
}
export async function owns(request, thread) {
  const token = bearer(request);
  return !!token && (await sha256(token)) === thread.secret_hash;
}
export function visibleThread(thread, privileged = true) {
  const fields = ['id','product','kind','category','title','nickname','status','visitor_closed','author_closed',
    'created_at','updated_at','last_admin_at','last_visitor_at','last_admin_change_at',
    'outcome','outcome_note','outcome_at','resolved_version','visitor_result'];
  const safe = Object.fromEntries(fields.map(key => [key, thread[key]]));
  if (privileged) safe.environment = thread.environment || '';
  else safe.title = thread.public_title || '反馈';
  return safe;
}
export function plain(value, max) {
  return String(value || '').trim().slice(0, max);
}
export async function verifyTurnstile(env, token) {
  if (!env.TURNSTILE_SECRET) return false;
  const hostnames = String(env.TURNSTILE_HOSTNAMES || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!hostnames.length) return false;
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', String(token || ''));
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form
  });
  if (!response.ok) return false;
  const result = await response.json();
  return !!result.success && hostnames.includes(String(result.hostname || '').toLowerCase());
}
export async function checkedImage(form) {
  const image = form.get('image');
  if (!image || typeof image === 'string' || !image.size) return null;
  if (image.size > 1024 * 1024) throw new Error('截图不能超过 1 MB。');
  const type = image.type;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('只支持 PNG、JPEG 或 WebP 截图。');
  const bytes = new Uint8Array(await image.arrayBuffer());
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!((type === 'image/png' && png) || (type === 'image/jpeg' && jpeg) || (type === 'image/webp' && webp))) {
    throw new Error('截图文件格式不正确。');
  }
  return { bytes, type, key: crypto.randomUUID() };
}
export function parseFormRequest(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) throw new Error('请求格式错误。');
  return request.formData();
}
export async function deleteThread(env, threadId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM task_threads WHERE thread_id = ?').bind(threadId),
    env.DB.prepare('DELETE FROM attachments WHERE thread_id = ?').bind(threadId),
    env.DB.prepare('DELETE FROM messages WHERE thread_id = ?').bind(threadId),
    env.DB.prepare('DELETE FROM threads WHERE id = ?').bind(threadId)
  ]);
}
