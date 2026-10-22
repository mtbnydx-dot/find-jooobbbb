# 外部服务接入与能力边界

更新：2026-10-23。本文描述代码接入能力，不代表商户、SMTP、推送服务已经开通或完成真实联调。当前没有实际支付、邮件、推送服务账号；人工会员申请继续可用。

## 一、支付与交易账本

### 已实现

- `GET /api/v1/billing/status`：是否装配完整支付适配器、人工核验可用性、退款模式。`configured` 只代表适配器存在，不能代替真实商户联调或实际付款成功。
- `POST /api/v1/billing/checkout`：登录后提交 `{planId, termId, idempotencyKey}`。金额、币种、期限和权益来自服务端套餐快照；客户端不能指定收款金额。未配置返回 `503 PAYMENT_NOT_CONFIGURED`，不会伪造成功订单。
- `GET /api/v1/me/transactions`：仅本人交易；`GET /api/v1/admin/transactions`：管理员账本，支持 `cursor`、`limit` 分页。
- 人工申请、人工核验仍走 `/me/orders`、`/admin/orders/:id`。核验成功同步记入独立 `payment_ledger`，旧的已核验申请会幂等补账。
- 独立账本不与账户级联删除，不自动保存邮箱或姓名。注销前，关联账户 ID 转为单向摘要；交易、退款及必要审计保留，个人资料、私有附件另行删除。

### 支付适配器契约

向 `ProductPlatform` 注入 `paymentProvider`，不是向浏览器传入商户密钥。标准运行入口尚未安装任何真实渠道驱动。适配器必须提供：

```js
{
  id: 'provider_name', // 小写字母开头，最多 40 位字母、数字、下划线或短横线
  async createCheckout({ transactionId, idempotencyKey, userId, amount, currency, planId, days }) {
    // 使用真实商户接口，严格使用同一个 idempotencyKey 避免超时重试重复收费。
    return { url: 'https://真实渠道返回的结账地址' };
  },
  async verifyWebhook({ rawBody, headers }) {
    // 必须先验证签名、时间戳、商户归属及渠道真实状态，再返回标准事件。
    return { id, type, transactionId, amount, currency, reference };
  }
}
```

标准事件 `type` 为 `payment.succeeded`、`payment.failed` 或 `refund.succeeded`。`amount` 是整数分；付款事件必须与账本金额/币种完全一致；退款事件金额为本次退款金额，`reference` 为唯一渠道退款号。回调路径为 `POST /api/v1/billing/webhooks/:provider`。

路由保留原始请求体交给适配器验签。验签失败不能返回“已验证事件”；不能仅凭 JSON 中的 `status=success`、网页跳转、截图或客户端回执开通权益。服务端按渠道事件 ID 去重，检查同 ID 内容冲突；同一渠道退款号的重复通知不会重复扣减。付款与权益更新、退款与权益重算、事件入账在数据库事务内执行。

交易状态：`pending → succeeded / failed`；成功交易可以进入 `partially_refunded → refunded`。迟到的失败事件不回退成功交易；已退款交易不会因为重复付款成功事件重新开通。状态不同于原人工申请的审批状态。

### 退款边界

管理员 `POST /api/v1/admin/transactions/:id/refunds` 提交 `{amount, reference, reason, idempotencyKey}`，**只记录已经在线下或渠道后台完成的退款，不会执行打款**。必须先核实退款事实，再记录凭据；操作有权限校验、金额限制、幂等和审计。

- 部分退款保留现有会员期限；累计全额退款撤销这笔交易的会员授权，并根据其他未全退交易重算，不覆盖后来单独的管理员授权。
- 没有自动退款请求接口、真实支付结算对账、发票或自动续费。后台金额是独立账本净额，不是银行实际结算证明。
- 接真实渠道前，必须在其沙箱覆盖支付失败/取消、重复及乱序通知、金额/币种错误、退款重放、用户已注销、回调期间重启等情况，并对账。

### iOS / Android 不是网页支付换壳

当前未接 StoreKit / App Store Server API、Google Play Billing 或购买凭据/退款通知验证；通用 webhook 不等于商店 receipt 已接通。未来需做商店商品映射、账户绑定、购买恢复、服务端验单与渠道权益同步。

实际收费方案应按分发渠道和 storefront 确定，不能把美国或特定地区的外购例外套到所有地区。依据：[Apple 3.1 支付与 4.2 最低功能要求](https://developer.apple.com/app-store/review/guidelines/)、[Google Play Payments](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)。网页和国内安卓分发也应分别核对其适用要求；本文不保证商店审核通过。

## 二、邮件、推送与后台提醒

### 运行方式

`configureProductRuntime` 应在创建产品路由前完成，随后启动 `startProductWorkers`；它启动个人 AI 工作者及通知工作者。通知默认每 60 秒运行，用户不打开网页也会检查截止、跟进、Offer、学习计划与保存搜索。

- 站内通知持续可用，受现有相关画像提醒设置控制。
- 保存搜索提醒需单独启用 `savedSearchEnabled`。首次检查建立已见岗位基线，不把历史全部匹配项当成新增；后续新匹配岗位生成站内通知。单个搜索每轮最多遍历 50 页、每页 100 条，超大范围查询宜缩小筛选条件。
- 邮件、推送默认对每位用户关闭。邮箱必须经验证并且用户主动选择邮件提醒；推送需设备注册及用户主动选择。
- outbox 持久保存任务，按用户/通知/渠道/设备去重；发送租约避免多个工作者同时领取；异常重试最多 5 次，之后标记 `dead`。缺配置或邮箱未验证标记 `blocked`，不冒充发送成功；退订或注销设备取消未发送任务。
- **投递语义是至少一次，不是恰好一次。** 外部服务已经接受但本地尚未落账时进程崩溃，重试仍可能重复投递。推送适配器收到稳定幂等键；邮件带稳定 Message-ID，但 SMTP 不承诺按 Message-ID 去重。`sent` 表示发送接口接受，不保证用户读到。
- 停机先停止领取新任务，等待当前发送结束后再关闭数据库。未完成租约到期后可重试。

### SMTP 配置

仅使用产品专用配置，不复用旧系统 `EMAIL_TO`，也不把所有用户通知发给固定邮箱：

| 环境变量 | 用途 |
| --- | --- |
| `PRODUCT_SMTP_HOST` | 选定邮件服务的 SMTP 主机 |
| `PRODUCT_SMTP_PORT` | 端口，默认 587；按服务商要求设置 |
| `PRODUCT_SMTP_SECURE` | `true` 表示连接即使用 TLS（常见端口 465）；按服务商说明配置 |
| `PRODUCT_SMTP_USER` / `PRODUCT_SMTP_PASSWORD` | SMTP 凭据；仅保存在服务器环境/秘密配置中 |
| `PRODUCT_SMTP_FROM` | 服务商已允许的发件地址 |
| `PRODUCT_PUBLIC_URL` | 产品真实 HTTPS 入口，包含需要的路径前缀；用于验证/找回链接和提醒链接 |
| `PRODUCT_WORKERS_ENABLED` | `0` 停止后台工作者；不是删除既有任务 |

配置完成后重启该产品进程，先在本机/测试环境使用测试收件人验证：找回密码、邮箱验证、主动订阅提醒、发送失败重试和退订。`configured=true` 不能证明发件域名、凭据或实际送达均已验证。服务商需要的发件人/域名验证由运营者完成；系统不创建服务商账户。

### Push 适配器

通过 `initializeDelivery(platform, {pushProvider})` 在服务首次初始化前注入：

```js
{ id: 'provider_name', async send({ token, payload, idempotencyKey }) {
  // 调用已开通的真实服务；失败必须抛错；尽可能按稳定幂等键去重。
} }
```

`POST /me/devices` 接受 `{provider,token,label}`，最多 10 个设备；列表不返回 token，注销设备用 `DELETE /me/devices/:id`。未配置相应 provider 时注册返回 `PUSH_NOT_CONFIGURED`。这只是通用设备适配接口，当前尚无 APNs、FCM、国内厂商推送或 Web Push 的真实服务驱动。iOS PWA 的推送还要求加入主屏幕并经用户主动授权，[WebKit 官方说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。

### 管理与偏好接口

- 用户：`GET/PUT /me/delivery-preferences`、`GET /me/delivery-status`、`GET/POST /me/devices`。
- 管理员：`GET /admin/integrations` 查看配置状态与缺项；`PUT /admin/integrations/delivery` 控制邮件/推送全局开关并记审计。
- 浏览器管理页不接收或回显 SMTP、支付、推送密钥；全局开关也不能替代服务账号配置和用户授权。

## 三、私有简历/附件

接口：`GET/POST /me/attachments`，`GET/DELETE /me/attachments/:id`，`GET /me/attachments/:id/download`。上传为 `{name,contentBase64}`；列表和详情只对文件所属账户可见。手机 App 下载携带认证头，网页可认证请求后转 Blob；不要把 session token 放进下载 URL。

- 单个文件最多 5 MB、每账户最多 20 个文件、总计 50 MB；仅 TXT/PDF/DOC/DOCX，检查编码、扩展名与基本文件签名，不执行附件。
- 文件保存于该产品数据目录的 `private-attachments`，不在静态站点目录。采用随机文件 ID、独立用户目录、路径及符号链接检查；原文件名仅作元数据/下载名称。
- TXT 限 UTF-8，可读取前 100,000 个字符；超出会标记截断。读取文本不是 AI 简历分析，也不自动改写求职画像。
- PDF / Word 当前仅私有保存、下载，返回 `stored_only` 与明确说明；**没有 PDF OCR、DOC/DOCX 文本解析、格式保真转换或自动 AI 解析**。以后接入解析器需独立评估依赖、资源限制及恶意文件边界，不把“上传成功”当成“解析成功”。
- 相同账户内容摘要一致的上传复用已有附件，不跨用户暴露重复信息。账户注销先完成数据库删除，再清理私有文件；若磁盘清理失败会保留持久清理待办，并在后台每轮最多重试 20 个已注销账户的附件目录。异常目录不递归删除，保留给操作员核对；管理服务状态包含待清理数量，不把失败伪装成磁盘已清空。
- 个人导出包含本人财务记录及退款、提醒偏好、设备元数据（无设备 token）、投递状态元数据和附件元数据；附件原文件另行认证下载。已注销后收到的原支付/退款回调仍以交易 ID 入账，不会重新创建账户或授权。

## 本机验收

专属测试：`test/commerce_payments.test.js`、`test/delivery.test.js`、`test/attachments.test.js`。使用本地临时数据库和内存假适配器，不联系真实支付/邮件/推送服务、不实际扣费。真实渠道账号提供前，交付范围是接入接口、状态说明与可测试的业务闭环，不是“真实支付/推送已上线”。
