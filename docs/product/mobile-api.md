# 移动客户端 API 契约

当前合同版本：`2026-10-mobile-v1`。适用于 Web、iOS/Android 原生、Flutter、React Native；这是同一套 JSON API，不要求客户端运行 CLI 或访问数据库。独立产品服务默认前缀 `/api/v1`，预览环境应读取其部署配置，不要将主站 API 与预览 Cookie 混用。

## 认证与能力发现

`GET /auth/capabilities` 无须登录，返回 `contractVersion`、`authentication`、`session`、`recovery`、`features`。响应头也带 `X-Api-Contract`。字段可增补，客户端应忽略未知字段，不以字段缺省推断功能已经开通。

- Web 默认使用同站 HttpOnly、SameSite=Lax Cookie；HTTPS 部署启用 Secure。
- 原生客户端使用 `Authorization: Bearer <sessionToken>`。令牌是可撤销的不透明会话凭据，不是客户端自行解析的 JWT。
- `POST /auth/register` / `/auth/login` 接收原有邮箱、密码字段，可另传 `device: {name,platform,appVersion}`。设备字段均为最长 100 字符的自报文本，不能用于可信设备认证。
- 登录返回 `{ok,user,sessionToken,expiresAt}`，同时设置 Cookie。原生端用系统 Keychain / Keystore 支持的安全存储；Web 不将凭据放在 localStorage、URL、日志或分析事件中。
- `user.emailVerifiedAt` 是 ISO 时间或 `null`；注册不等于邮箱已验证。
- `POST /auth/refresh` 必须携带仍有效的 Cookie 或 Bearer，可传新 `device`。它原子撤销本次旧会话并创建新会话，返回登录相同字段。其他设备不受影响，旧令牌再次使用返回 401。未传设备沿用旧设备信息。
- 当前默认有效期 30 天，以 `capabilities.session.ttlSeconds` 和返回的 `expiresAt` 为准。这不是“过期 access token + 长期 refresh token”双令牌系统；已过期必须重新登录。多个并发请求不要各自触发 refresh，客户端需共用一个进行中的续期请求。
- `POST /auth/logout` 撤销当前会话并清 Cookie。`GET /me/sessions?metadata=1` 返回本人会话 `id,createdAt,expiresAt,current,device,lastSeenAt`，不返回 token/hash。旧请求未要求 metadata 时，空设备会话保持旧字段集合。lastSeenAt 最多约五分钟刷新一次。
- `DELETE /me/sessions/:id` 只能撤销本人指定会话；`DELETE /me/sessions` 撤销其他设备。响应 `revokedCurrent` 为 true 时，客户端清理本地会话。`POST /me/password {currentPassword,newPassword}` 验证当前密码，撤销全部旧登录并返回一个新的当前会话。

## 画像与考试的并发编辑

`GET /me/profile` 的 `profile.version` 是整数。`PUT /me/profile` 在原有字段外支持 `expectedVersion`。版本一致才原子保存并递增版本；不一致返回：

```json
{"ok":false,"code":"VERSION_CONFLICT","detail":{"resource":"profile","expectedVersion":3,"currentVersion":4}}
```

考试 `session.version` 同样为整数。`PUT /exams/sessions/:id` 保存 `answers`、`flagged`、`currentIndex`、`elapsedSeconds`，并支持 `expectedVersion`；`POST /exams/sessions/:id/submit` 支持相同字段和版本检查。版本冲突 `detail.resource` 为 `exam_session`，该次请求不会部分保存答案、覆盖草稿或生成成绩。提供的 `answers` 是完整答案映射而非单题增量，应先合并本地草稿再发送。

`expectedVersion` 为兼容旧客户端仍可省略；省略意味着旧的最后写入行为，不能宣称有跨设备冲突保护。新客户端应始终带读取到的版本。显式 null、字符串、零或负数返回 `400 INVALID_VERSION`。

保存应串行：一次成功后用返回的最新版本发送下一次。遇到 409 停止自动同步，重新 GET 云端并展示冲突，让用户选择加载云端，或确认保留本机后以新版本保存；禁止静默去掉 expectedVersion 重试。超时不代表失败，可先 GET 判断最新内容再重试。

已交卷会话不可再保存（`409 EXAM_ALREADY_SUBMITTED`）。交卷响应包括 `session,submittedNow,result`；再次交卷返回既有结果、`submittedNow:false`，不重新计分或重复写练习记录。`GET /exams/sessions/:id` 对已交卷会话也返回完整 `result`：

```json
{"score":80,"correctCount":4,"total":5,"wrongCount":1,"summary":"...","items":[{"questionId":"...","prompt":"...","response":"...","score":100,"correct":true,"explanation":"...","referenceAnswer":"...","provenance":{}}]}
```

提交时完整逐题反馈作为结果快照持久化；题库后续改版不改变该历史成绩/反馈。升级前没有结果快照的记录，使用当时已冻结的题目版本及保存答案生成反馈，不用当前题库补造历史来源。未交卷 GET 不返回标准答案或解析。

移动系统会暂停后台定时器：考试用时应根据开始时间、上次持久化时间与前后台切换时间差计算，不以每次 `setInterval` 加一累积。当前 API 的 elapsedSeconds 是客户端上报、范围有限制的练习记录，不是可信监考计时。离线草稿只存本人作答，不存答案键；按用户 ID + session ID 隔离，退出/切换账号后不得展示另一人的缓存。

## 练习提交幂等

`POST /prep/attempts` 兼容单题 `{questionId,response}` / `{questionId,answer}` 和批量 `{answers:[...]}`（1–20 题）。新客户端必须为一次逻辑提交生成稳定键，放 `Idempotency-Key` 头或 JSON `idempotencyKey`。

- 键允许 1–128 位英文字母、数字、`.`、`_`、`:`、`-`，推荐随机 UUID。头与正文同时提供时必须相同，否则 400。
- 键范围为“当前用户 + 练习提交接口”，单题/批量共用此范围；不同账户可以使用同名键，彼此不可访问。
- 相同键和相同规范化请求持久重放原反馈，返回 `replayed:true`，不新建记录、不重复扣当日额度；服务器重启或额度用完也可以重放。第一次成功返回 `replayed:false`。
- 不同答案、题目或批次使用相同键返回 `409 IDEMPOTENCY_CONFLICT`。规范化只统一 answer/response 字段及 JSON 对象键顺序，不把不同答案表示、不同批次顺序当作相同请求。
- 校验失败、无权限、额度不足不记录成功幂等结果；整个批次的保存和额度扣减是同一事务。
- 不带键保留旧行为，每个成功请求都会计入一次/一批。客户端网络超时应以原键原内容重试；用户编辑答案后视作新提交，生成新键。不要在每次 HTTP 重试时重建键。

## 找回密码与邮箱验证

`capabilities.recovery.passwordResetConfigured/emailVerificationConfigured` 表示发送函数和可信应用地址已配置，不保证外部邮件一定送达收件箱。

| 接口 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /auth/forgot-password` | `{email}` | 202，通用 accepted/message，不披露账户是否存在 |
| `POST /auth/reset-password` | `{token,newPassword}` | 200，`{reset:true,requiresLogin:true}` |
| `POST /me/email-verification` | 已登录 | 202，accepted；已验证可直接返回 verified |
| `POST /auth/verify-email` | `{token}` | 200，`{verified:true}` |

未配置发送渠道返回 `503 AUTH_DELIVERY_UNAVAILABLE`，不创建可用令牌、不假装已发送。发送失败也返回该错误且使本次链接不可用。密码重设链接有效 30 分钟，验证链接有效 24 小时，均只能使用一次；同用途新链接成功发送后旧链接失效。无效、过期、已消费、用途不符返回 `400 INVALID_AUTH_TOKEN`。密码重设成功撤销该用户全部登录，客户端引导重新登录。账户删除/停用后不能使用旧链接。

令牌只存哈希；发送链接使用管理员配置的 `publicAppUrl`，不接受请求 Host 拼接。Web 路由为 `<publicAppUrl>/reset-password#token=...` 与 `/verify-email#token=...`，客户端读取 fragment 后调用 API；不要记录或转发完整链接。原生深链接收尚未在服务端自动注册，需平台应用端自行关联同一 HTTPS 域名并正确处理 fragment。

邮件请求按邮箱（每小时 5 次）和来源（每小时 20 次）限制，超限 `429 AUTH_DELIVERY_RATE_LIMIT`。发送请求不能作为账户存在性查询工具。

## CORS、分页与错误策略

`PRODUCT_CORS_ORIGINS` / `ProductPlatform({corsOrigins})` 是显式 HTTP(S) origin 白名单，不含路径，不允许 `*`。同域请求无需额外白名单；来自白名单的浏览器可携带 Cookie/Bearer，并获预检响应。未知 Origin 返回 `403 ORIGIN_NOT_ALLOWED`。原生 HTTP 客户端通常不发送 Origin，不受浏览器 CORS 限制，但仍必须正常鉴权；CORS 不是 API 认证机制。代理部署必须保留并正确解释外部协议/Host，不要让客户端伪造转发头作为配置方法。

`GET /jobs` 支持 `availability=active|all|expired`，默认 active：隐藏已明确截止的岗位，保留未知截止日期和长期招聘，不承诺未知岗位仍在招。返回岗位 `availability` 与整体 `dataQuality`。截止日按北京时间、包含截止当天计算。收藏/流程/单岗位详情仍可查历史岗位，不删除用户记录。

岗位新 `nextCursor` 绑定筛选条件、用户画像、目录版本和北京时间日期；条件或目录变化返回 `409 CURSOR_STALE`，客户端清空游标从第一页重载。旧 offset 游标仍接受，但服务端不再生成它。`limit` 上限 100。备考题列表继续使用既有 `nextCursor/total`，客户端必须读完所有页，不能将首页题量当作题库总量。

统一错误外形为 `{ok:false,error,code,detail?}`。处理建议：

- 400：修正输入；版本字段或幂等键不合法不要盲重试。
- 401：凭据失效，清理本地登录并引导登录；网络断线/超时不是 401，不能误退出账户。
- 403：按具体 code 显示权限、用量或来源问题；不要自动升级套餐、重发扣费或反复调用。
- 409：按 VERSION_CONFLICT / IDEMPOTENCY_CONFLICT / CURSOR_STALE 区分处理，不将所有冲突简单覆盖。
- 429：遵守 Retry-After（若提供），退避重试；不要多个页面同时形成续期或发送风暴。
- 503/网络超时：保留草稿与幂等键，可显式重试；未配置邮件/支付/AI 时展示未开通，不显示伪成功。

JSON 普通接口上限 128 KiB；编辑导入独立上限 4 MiB；私有附件接口独立上限 8 MiB（实际文件限额、格式以附件接口返回为准）。当前私有附件是文件保存/TXT 提取能力，不等于 PDF/Word 全文解析。原生推送需真实供应商注入与设备注册；未配置时不得承诺后台消息已送达。

## 本机验证

`node --test test/mobile.test.js test/recovery.test.js test/account.test.js` 覆盖幂等、事务冲突、历史结果、跨账户访问、会话轮换、设备信息、CORS、邮箱令牌/投递失败/限流；与 product、provenance、workspace、maintenance 回归联合通过。测试使用临时数据库和注入的发送函数，不会发送真实邮件、调用收费模型或修改线上账户。

## 个人 AI 任务补充合同

AI 任务是异步的，不要通过重复创建任务轮询进度。创建需明确 consent 和稳定 idempotencyKey，进度读取 `/me/ai/runs/:id`。用户、画像版本、岗位内容、模型服务指纹共同决定缓存有效性；服务指纹包括规范化服务地址、模型名和提示词版本，不包含密钥。轮换密钥不会重算全部缓存，换服务地址或模型会使旧缓存失效。运行中的任务不会悄悄切换到另一服务；未完成部分标为 stale，需用户重新发起。

任务 `retry` 返回 `{used,limit:3,remaining}`。一次任务至多人工 resume 三次；同时有持久 `budget:{calls,totalTokens}`。调用预算为 `max(8,本次新评估岗位数×4)`，Token 预算为 `max(20000,新评估岗位数×8000)`。达到任一上限后不派发新的上游请求，resume 返回 `409 AI_RETRY_LIMIT`。预算是请求之间的硬停止条件，正在处理的单个响应可能使累计 Token 超过预算；已发生的用量如实保留，不声称已退款。

取消会停止未派发内容并返还相应岗位额度，已派发部分的用量与有效结果保留；无法撤回已经到达模型供应商的请求。等待中的岗位若已合并、改版、下架或过期，派发前跳过，并释放尚未派发的额度，`skipped` 记录该数量。

每个产品数据库使用一个 AI worker 租约：有效期五分钟、执行中约三十秒续租。其他进程不能重置正在工作的任务或同时派发。正常停止等在途响应落盘后释放租约；异常退出可能要等租约过期再恢复。供应商未返回或进程在收到响应前异常退出时，上游是否收费无法绝对判定，恢复属于至少一次尝试，不承诺外部网络调用 exactly-once。

个人数据导出包含本人 AI 任务摘要、使用量及结果缓存，不包含模型服务密钥，也不混入全局画像或其他用户数据。`test/personal_ai.test.js` 专项覆盖这些边界，均使用注入模型响应，不产生真实模型费用。
