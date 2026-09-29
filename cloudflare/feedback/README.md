# EPhone 许愿与反馈服务

此目录只服务设置页现有的「匿名许愿 / 反馈」和「公开反馈（可收到回复）」入口。用户不创建账号。浏览器本地保存随机会话凭证和未发送草稿；已发送的消息与可选截图保存在 Cloudflare D1。更换浏览器、清除网站数据或在 iOS 网页与主屏幕 PWA 之间切换后，旧对话不会自动出现。

## 组成

- `public-worker.js`：公开 API。匿名内容只有持本地凭证的人和管理员能读；公开内容在管理员改为 `visible` 后可被所有用户阅读。
- `admin-worker.js`：管理收件箱与 API。管理 API 只接受随机密钥；Cloudflare 仅保存密钥的 SHA-256 哈希。无密钥或错误密钥返回 401。
- `schema.sql`：同一个 D1 数据库，两名 Worker 共用。截图在 D1 BLOB 中，限制单张 1 MB，不需要 R2。
- `migrations/2026-09-29-visitor-close.sql`：已有数据库的增量迁移。首次建库直接使用更新后的 `schema.sql`；已有数据库先执行此迁移，再部署两个 Worker 和静态网页。
- `wrangler-public.jsonc`、`wrangler-admin.jsonc`：部署配置。两个文件内的数据库 ID 必须填写同一个真实 ID。

## 当前部署

- 公开 API：`https://ephone-feedback-public.zrb9080.workers.dev`
- 管理页：`https://ephone-feedback-admin.zrb9080.workers.dev`
- 静态网页：`https://wq70.github.io/xinyuan330/`；API 允许来源为 `https://wq70.github.io`。
- Turnstile site key：`0x4AAAAAAFGVGxOUkCwKUOiV`；secret key 只存于公开 Worker Secret。
- D1 数据库：`ephone-feedback`。两个 Worker 已部署；仓库的前端改动尚需发布到 GitHub Pages。
- 管理密钥：本机此目录的 `.admin-key.txt`，已被 `.gitignore` 排除。管理页只在当前标签页的 `sessionStorage` 保存它；关闭标签页后需重新输入。请勿提交或发送此密钥。

Cloudflare Zero Trust Free 在这个账号上要求银行卡、服务条款及超额扣费授权，因此管理页使用独立随机密钥，不依赖 Access。管理 API 还有每 IP 每分钟 60 次的限流。

`modules/feedback/config.js` 已填入公开 API 和 Turnstile site key。发布静态网页时应包含 `src/html`、`generated/html-fragments`、`asset-manifest.json`、`modules/feedback`、`css/feedback.css` 和 `sw.js` 中本功能的变动。若修改前端配置，调整 `src/html/document-head.html` 中 `config.js` 的查询版本号，并运行项目根目录的 `npm run build:index`，避免 PWA 沿用旧缓存。

若新增其他网站域名，先将其加入 Turnstile widget 的允许域名，再将完整 origin 加到 `wrangler-public.jsonc` 的 `ALLOWED_ORIGINS`、主机名加到 `TURNSTILE_HOSTNAMES`（都用逗号分隔），最后重新部署公开 Worker。不要把 `file://`、`null` 或任意来源通配符加入生产配置。本地开发可使用 Cloudflare 官方测试密钥与本地 Wrangler。

## 发布检查

- `npm run check`：接口权限、审核前不可见、作者回复、截图权限、删除及 CORS 测试。
- 关闭对话后消息仍可读，双方不能再回信；已公开的信仍留在公开列表，删除后才移除。
- 在手机上分别检查 iOS Safari、iOS 主屏幕 PWA、安卓浏览器、安卓 PWA：提交匿名内容 → 管理页回复 → 回到原入口显示新回复；提交公开内容 → 审核前别人看不到 → 发布后公开可见。
- 使用另一台设备或无痕窗口确认匿名内容不可读；清除原浏览器数据后确认旧凭证无法恢复。
- 检查管理 API 在没有密钥或密钥错误时返回 401，正确密钥能读取收件箱。
- 确认公开 Worker 的返回内容、运行日志、浏览器 URL 中都没有会话凭证。前端请求用 `X-EPhone-Feedback` 标记，让 EPhone 现有 Service Worker 不缓存反馈响应。

## 使用边界

回复通过打开网页或 PWA 时查询显示；此实现不发送系统推送。用户失去本地凭证后，作者仍能在管理页看到已提交内容，但用户不能重新访问原匿名对话。公开反馈被删除前可能已被别人看到或保存。

Cloudflare 免费额度有上限。单个免费 D1 数据库上限 500 MB；截图虽限制为 1 MB，仍会持续占用库容量。请定期查看 D1 大小和 Workers 请求数，按需要删除无用反馈或备份数据库。数据库内含用户主动发送的内容，备份也应只由你保管。
