// 部署 Cloudflare Worker 后填写公开 API 地址和 Turnstile site key。
// 这两个值是公开配置；不要在前端填写 Turnstile secret 或管理员凭证。
window.EPHONE_FEEDBACK_CONFIG = {
  apiUrl: 'https://ephone-feedback-public.zrb9080.workers.dev',
  turnstileSiteKey: '0x4AAAAAAFGVGxOUkCwKUOiV'
};
