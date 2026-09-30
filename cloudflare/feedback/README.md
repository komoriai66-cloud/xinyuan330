# EPhone / UWU 许愿与反馈服务

此目录服务 EPhone 设置页及 UWU 教程页各自的私密、公开反馈入口。两个前端使用不同界面和本地存储键，共用 Cloudflare D1 和管理收件箱；管理页可按来源筛选。用户不创建账号。浏览器本地保存随机会话凭证和未发送草稿；已发送的消息与可选截图保存在 D1。更换浏览器或网页 / PWA 后，可通过“迁移我的信箱”导出、导入凭证恢复访问；没有凭证备份时，清除网站数据后无法恢复私密对话。

## 组成

- `public-worker.js`：公开 API。匿名内容只有持本地凭证的人和管理员能读；公开内容在管理员改为 `visible` 后可被所有用户阅读。
- `admin-worker.js`：管理收件箱与 API。管理 API 只接受随机密钥；Cloudflare 仅保存密钥的 SHA-256 哈希。无密钥或错误密钥返回 401。
- `workbench.js`：消息修订、独立待办、处理结果、队列统计、公开解答 API。
- `admin-client.js`、`admin-style.js`：管理页交互和样式，由 `admin-page.js` 生成 HTML。
- `schema.sql`：同一个 D1 数据库，两名 Worker 共用。截图在 D1 BLOB 中，限制单张 1 MB，不需要 R2。
- `migrations/2026-09-29-visitor-close.sql`：已有数据库补充用户关闭状态的增量迁移。
- `migrations/2026-09-29-product.sql`：已有数据库补充来源字段和索引的增量迁移；现有记录自动标为 `ephone`。首次建库直接使用 `schema.sql`；已有数据库先执行尚未执行的迁移，再部署两个 Worker 和静态网页。
- `migrations/2026-09-30-workbench.sql`：工作台增量迁移，增加消息审核与版本、作者结束状态、结果、队列、待办和解答。
- `wrangler-public.jsonc`、`wrangler-admin.jsonc`：部署配置。两个文件内的数据库 ID 必须填写同一个真实 ID。

## 当前部署

- 公开 API：`https://ephone-feedback-public.zrb9080.workers.dev`
- 管理页：`https://ephone-feedback-admin.zrb9080.workers.dev`
- 静态网页：EPhone `https://wq70.github.io/xinyuan330/`、UWU `https://wq70.github.io/xinOVO/`；API 允许来源为 `https://wq70.github.io`。
- Turnstile site key：`0x4AAAAAAFGVGxOUkCwKUOiV`；secret key 只存于公开 Worker Secret。
- D1 数据库：`ephone-feedback`。工作台数据库迁移与两个 Worker 已于 2026-09-30 发布；两站前端通过各自 main 分支的 GitHub Pages 发布。
- 管理密钥：本机此目录的 `.admin-key.txt`，已被 `.gitignore` 排除。管理页只在当前标签页的 `sessionStorage` 保存它；关闭标签页后需重新输入。请勿提交或发送此密钥。

Cloudflare Zero Trust Free 在这个账号上要求银行卡、服务条款及超额扣费授权，因此管理页使用独立随机密钥，不依赖 Access。管理 API 还有每 IP 每分钟 60 次的限流。

`modules/feedback/config.js` 已填入公开 API 和 Turnstile site key。发布静态网页时应包含 `src/html`、`generated/html-fragments`、`asset-manifest.json`、`modules/feedback`、`css/feedback.css` 和 `sw.js` 中本功能的变动。若修改前端配置，调整 `src/html/document-head.html` 中 `config.js` 的查询版本号，并运行项目根目录的 `npm run build:index`，避免 PWA 沿用旧缓存。

UWU 前端位于 `xinOVO` 仓库的 `js/modules/feedback.js`、`css/modules/feedback.css` 和教程页入口；发布前运行该仓库的 `npm run build`，一同发布生成的 `index.html` 与 `sw-assets.js`。部署顺序：先执行尚未执行的 visitor-close、product、workbench 三个增量迁移，再发布公开及管理 Worker，最后发布两站静态资源。迁移内包含 ALTER TABLE，已执行的文件不要重复执行。首次空库直接使用最新 schema.sql，不再执行增量文件。原有 EPhone 请求未传 `product`，服务端默认为 `ephone`，不需要修改旧入口。

若新增其他网站域名，先将其加入 Turnstile widget 的允许域名，再将完整 origin 加到 `wrangler-public.jsonc` 的 `ALLOWED_ORIGINS`、主机名加到 `TURNSTILE_HOSTNAMES`（都用逗号分隔），最后重新部署公开 Worker。不要把 `file://`、`null` 或任意来源通配符加入生产配置。本地开发可使用 Cloudflare 官方测试密钥与本地 Wrangler。

## 发布检查

- `npm run check`：21 个接口回归测试，覆盖消息所有权、版本冲突、图片权限、公开编辑重新审核、待办关联、通知重试、结果确认、来源更正和迁移。
- `npm run check:bundle`：按管理服务器的部署配置实际打包，取出生成页面的脚本，在独立浏览器作用域中检查启动、模拟登录、工作台切换及退出，不使用真实密钥或线上数据库。此检查也包含在 `check` 和 `deploy:admin` 中。管理配置必须保持 `keep_names: false`，避免 `Function.toString()` 提取的脚本依赖 Worker 外层的打包辅助函数。
- `npm run preview`：使用内存 SQLite 启动本地假数据预览（Node 24）；访问 http://127.0.0.1:8790/qa?surface=admin，surface 也可选 ephone、uwu。无需真实密钥，不读写线上数据库。预览默认使用相邻 OVO-main 目录，或通过 UWU_SOURCE_ROOT 指定。
- 结束往来、公开展示、处理结果和待办状态相互独立。结束后双方不能新回信，但仍可修订自己的旧消息；已公开的信仍留在公开列表。
- 在手机上分别检查 iOS Safari、iOS 主屏幕 PWA、安卓浏览器、安卓 PWA：提交匿名内容 → 管理页回复 → 回到原入口显示新回复；提交公开内容 → 审核前别人看不到 → 发布后公开可见。
- 使用另一台设备或无痕窗口确认私密内容不可读；导出的凭证只在本地核验格式，经服务器确认后恢复同一应用的信件。
- 检查管理 API 在没有密钥或密钥错误时返回 401，正确密钥能读取收件箱。
- 确认公开 Worker 的返回内容、运行日志、浏览器 URL 中都没有会话凭证。前端请求用 `X-EPhone-Feedback` 标记，让 EPhone 现有 Service Worker 不缓存反馈响应。

## 使用边界

回复与结果变化通过打开网页或 PWA 时查询显示；回看日期出现在管理队列中，此实现不发送系统推送。用户失去本地凭证且没有导出备份时，作者仍能看到已提交内容，但用户不能重新访问原私密对话。公开反馈被删除前可能已被别人看到或保存。

Cloudflare 免费额度有上限。单个免费 D1 数据库上限 500 MB；截图虽限制为 1 MB，仍会持续占用库容量。请定期查看 D1 大小和 Workers 请求数，按需要删除无用反馈或备份数据库。数据库内含用户主动发送的内容，备份也应只由你保管。

## 工作台行为

- 待办可由作者独立建立，也可从反馈建立；有待办、进行中、暂缓、完成、优先级、下一步摘要和回看日期。删除原反馈只解除关联，不删除待办。多个同来源反馈可关联同一待办，统一通知先展示预览，各对话独立收信；已结束或已隐藏的公开对话跳过。
- 未读与待回复分开管理，可设置等用户补充、无需回复、回看日期。管理页搜索包括正文、标题和内部备注；公开搜索只包括已审核正文与公开标题。概览提供未读、待回、审核、待补、回看、待办到期、两周未推进数量。
- 作者和用户只能修改、撤回、删除自己发送的消息。作者可以移除用户内容并留下管理提示，但不能改写用户的话。修订有版本检查，旧页面不能覆盖新内容；撤回清空正文和附图但留下提示，删除移除整条消息及附图。首条消息改变时同步更新列表标题。
- 作者回复与修改支持附图、替换图片、移除图片。公开反馈的新补充和修改重新进入逐条审核，审核前其他人看不到新正文、标题或图片；私密内容只对持凭证的用户和作者开放。
- 处理结果含已收到、需要补充、已采纳、暂不采纳、已解决及版本说明；用户可确认解决或反馈仍有问题，后者回到待回复队列。
- 报错提供选填功能、步骤、预期、实际和可编辑环境信息。公开“已知问题与常见解答”由作者另行撰写，按应用发布，不自动抽取私密消息。
- 回复文字草稿按对话保存；未发送图片仅在当前页面会话内保留。用户正在写回复或修改消息时，后台刷新只提示新内容，不替换输入框。

## 旧记录兼容

workbench 迁移将旧 status=closed 转为作者已结束；旧公开关闭记录不具备可靠的历史展示状态，因此保持隐藏，作者确认后可重新公开。其他已有内容和会话凭证保留。

product 迁移默认将旧记录归入 EPhone。若旧 UWU 记录被误归类，可在管理页“处理 → 来源”更正；已有其他来源的关联待办需先解除。UWU 不再写入 EPhone 的本地存储键；“迁移我的信箱 → 查找旧版”只读取旧键，经服务器核验为 UWU 后加入，不覆盖 EPhone 信箱。

发布检查还包括：EPhone `npm run check:structure`；UWU `npm run check`；两站 320、375、390px 的长中文、无空格英文、数字标题、消息菜单、表单和弹窗检查。
