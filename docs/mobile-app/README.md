# 职路 · 移动求职

手机端现已升级为连接现有后端的移动 Web/PWA，使用真实账户和岗位数据。它不是已上架的 Android/iOS 原生应用，不能将浏览器兼容测试等同真机或商店验收。当前实施与发布说明见 [真实接入说明](./live-integration.md)。

正式入口：[手机端](https://zlkjob.com/app/mobile/index.html#/discover)；隔离测试站：[测试手机端](https://zlkjob.com/usertest/mobile/index.html#/discover)。旧 `/usertest/mobile-design/index.html` 入口跳转至测试手机端。是否已发布以当次发布确认结果为准。手机端与相应环境的完整网页版共用账户；正式站和测试站账号、数据相互隔离。

## 以下为早期原型设计存档

下文保留原型阶段的设计基准、屏幕清单和视觉验收记录，仅用于设计对照。其中“演示”“未接入”“3 个岗位/5 道题”等描述均为历史状态，不代表当前实现；不要按历史说明在真实手机端填写虚构资料或创建测试订单。

## 设计基准

本轮采用的 5 张 ImageGen 概念位于 `concepts/`：

- [发现机会](./concepts/discovery.png)
- [岗位详情](./concepts/detail.png)
- [投递进度](./concepts/pipeline.png)
- [专项练习](./concepts/practice.png)
- [我的](./concepts/account.png)

每张概念原生尺寸为 853 × 1844。实现优先 390 × 844 CSS 视口，并用 853/390 的设备像素比输出 853 × 1844 对照图；只裁去视口底端不足 1 CSS px 的余量，不缩放或拼贴界面图。

设计系统保持纯白 `#FFFFFF`、深墨色 `#112141`、职路蓝 `#0759ED`、浅底色 `#F4F7FC`，18–20 px 内容边距，14–16 px 正文、28–32 px 页面标题。以线性图标、开放详情分区、轻描边岗位卡片、底部四导航、底部动作栏和焦点受控的操作面板组织内容；不额外添加宣传插画或品牌渐变。

顶部“界面示例”标识随页面滚动保持可见。桌面额外提供不进入手机画布的演示导航，手机保持概念中的四导航：发现 / 进度 / 备考 / 我的。练习、考试和二级详情隐藏底部主导航，避免误触。

## 信息架构与屏幕清单

路由采用 HashRouter。以下路径位于 `index.html#` 后，支持独立静态托管；不会进入主业务 App 路由。

| 入口 | 页面 / 状态 | 可点击行为 |
| --- | --- | --- |
| `/discover` | 为你推荐、全部岗位、搜索结果 | 3 个虚构岗位；搜索、城市、专业、已公开薪资筛选；明确应用、清除、保存搜索；收藏与跨页同步 |
| 发现筛选面板 | 地点、专业、筛选 | 草稿条件不提前生效；应用或重置；Esc 关闭；Tab 焦点环绕并回到触发按钮 |
| `/jobs/:id` | 岗位详情 | 职位条件、薪酬、来源与招聘状态；收藏；投递方式演示面板 |
| `/jobs/:id/source` | 公告正文与核验记录 | 明确虚构原文、字段证据和待确认项；不伪造真实公告链接或核验认证 |
| `/ai` | AI 推荐确认、运行、结果 | 先同意，再执行本地计时模拟；可取消、重新演示；建议分明确不是录用概率 |
| `/pipeline` | 收藏、已投递、面试、Offer | 阶段切换；本地下一步、日期、时间、私人演示备注；自维护进度声明 |
| `/prep` | 备考首页 | 专项练习、错题、收藏、计时考试入口；真实显示原型仅内置 5 道示例题 |
| `/prep/sections` | 行测板块 | 数量关系可练；其余板块明确未内置题目，不虚构题数 |
| `/practice` | 练习与答案解析 | 选答、提交后解析、收藏、下一题；刷新恢复当前本地草稿与解析 |
| `/practice/result` | 练习小结 | 正确数 / 已答数；错题入口；再练一次清空旧答案 |
| `/wrongbook`、`/bookmarks` | 错题、收藏题 | 根据本次演示实际作答更新；重新练习、移除 |
| `/exam` | 考试说明 / 继续考试 | 5 题 / 5 分钟本地演示；继续或重新开始 |
| `/exam/session` | 计时考试 | 墙钟计时、切题、草稿恢复、交卷确认、超时结束；不含主导航 |
| `/exam/result` | 试卷结果 / 逐题解析 | 刷新恢复已交卷结果；再做一次、返回备考 |
| `/account` | 我的 | 画像、会员入口、4 + 3 两组功能列表，与概念对应 |
| `/onboarding` | 三步求职画像 | 教育背景、意向城市 / 职位、薪资；本地保存、上一步、跳过 |
| `/auth/login`、`/auth/register`、`/auth/forgot` | 登录 / 注册 / 忘记密码 | 表单校验、演示身份、引导；输入不会发送；密码不进入持久状态 |
| `/membership` | 会员方案 / 周期 / 申请记录 | 本地申请、相同方案防重复、撤回；不展示可收取的真实价格，不扣费、不续费 |
| `/saved-searches` | 保存的搜索 | 使用条件返回发现页、删除；不冒充自动订阅 |
| `/attachments` | 简历与附件 | 选择文件仅读取元数据；5 MB 限制；删除记录；不读取、上传、下载或解析真实内容 |
| `/messages` | 消息与提醒 | 示例消息、全部已读、模拟提醒、演示渠道偏好；不申请系统通知权限 |
| `/settings` | 账号与安全 | 密码填写校验、邮箱状态模拟、退出演示、界面状态选择、重置本地数据 |
| `/support` | 帮助反馈 / 详情 | 创建本地反馈、手动模拟客服回复；未实际发送给客服 |
| `/about` | 产品与能力说明 | 真实边界、数据存储方式、反馈入口 |
| 设置 → 发现 | 加载 / 空 / 断网 / 异常 | 可选择状态并恢复；“恢复连接”只结束本地演示，不修改设备网络 |

## 建议体验流程

1. 发现 → 地点选杭州 → 应用条件 → 保存搜索 → 我的 → 保存的搜索 → 使用条件。
2. 发现 → 前端开发工程师 → 公告与核验 → 返回详情 → 查看投递方式 → 标记已投递 → 更新为面试。
3. 个人 AI 推荐 → 阅读同意说明 → 演示评估 → 查看示例解释。无真实模型调用。
4. 备考 → 数量关系 → 故意答错一题 → 查看解析 → 错题本 → 重练 → 小结 → 再练一次。
5. 模拟考试 → 作答一题 → 刷新 → 继续 → 交卷 → 刷新已交卷解析。
6. 我的 → 登录与画像引导 → 会员申请 / 撤回 → 附件名称整理 → 创建反馈 → 模拟收到回复。
7. 设置 → 状态演示 → 发现 → 恢复；设置 → 重置演示数据。

## 与现有服务的 API 映射

这些映射供后续真实 App 实现使用；原型没有导入业务 API 客户端，未调用下列接口。

| 原型流程 | 现有服务接口族 | 接真实 App 时仍需落实的事项 |
| --- | --- | --- |
| 登录 / 画像 | `/auth/login`、`/auth/register`、`/auth/refresh`、`/auth/forgot-password`、`/auth/reset-password`、`/me/profile` | 邮件发送配置、401 / 断网区分、受信任链接；原生令牌只放安全存储，不放 Web localStorage |
| 发现 / 岗位证据 | `/jobs`、`/jobs/:id`、`PUT /me/jobs/:id` | 用 facets / appliedFilters 驱动真实筛选；字段证据、过期 / 未知语义、个人状态部分更新与别名链接 |
| 个人 AI | `/me/ai`、`/me/ai/runs`、运行状态 / resume / cancel、`/me/ai/recommendations` | 明确数据外发同意、动态服务状态与额度、长任务恢复、过期画像结果，不以规则分代替模型结果 |
| 投递进度 | `/me/pipeline`、`PUT /me/jobs/:id` | 阶段与下一步是用户维护状态；当前没有独立招聘方回执或完整阶段事件流水接口 |
| 提醒 / 搜索 | `/me/notifications`、`/me/delivery-preferences`、`/me/delivery-status`、`/me/devices`、`/me/saved-searches` | 真实发送配置、邮箱验证、设备注册 / 撤销；站内通知目前以最近记录和全部已读为主，不假设已实现逐条已读与分页 |
| 练习 / 考试 | `/prep/library`、`/prep/questions`、`/prep/attempts`、`/exams/packs`、`/exams/sessions`、会话 save / submit | 题源与实际数量、稳定幂等键、expectedVersion 冲突、离线草稿与服务器结果的明确同步 |
| 会员 | `/plans`、`/me/entitlements`、`/me/orders`、`/billing/status` | 真实渠道状态、人工核验说明、动态权益 / 额度；没有原生 IAP 与恢复购买实现，不用原型按钮承诺支付可用 |
| 简历附件 | `/me/attachments`、附件 detail / download / delete | 归属与安全下载；正式服务 TXT 可读文本，PDF / Word 仅存储下载，不能伪称已做简历 AI 解析 |
| 反馈 / 安全 | `/me/tickets`、replies、`/me/sessions`、`/me/email-verification`、账号导出 / 注销 | 真实工单状态、会话管理、邮件依赖、交易账本保留和附件清理结果 |

## 能力边界

- 演示企业、岗位、薪资、公告和用户均为虚构信息。岗位卡片“公告原文已提取”属于已批准视觉稿中的示例文案；来源页明确它不是已核验的真实公告。
- 内置只有 3 个虚构岗位、5 道原创基础示例题，不把外链、模块入口或线上题数计入原型数量。
- 只使用当前标签页的 `sessionStorage` 键 `zhilu-mobile-design:demo:v1`。仅保存演示资料；密码不保存。关闭会话可能丢失，在设置可重置。没有跨用户共享、真实登录态或主站数据访问。
- 邮件、设备推送、AI、会员、客服等均为本地演示。没有后台队列、模型调用、付款、实际投递或通知发送。
- 没有离线题库下载、原生推送、系统深链、文件分享桥、App Store / Play 上架、安装包、短信 / 微信 / Apple 登录，也没有原生内购。离线状态页只展示沟通设计，不注册 service worker。
- 浏览器尺寸验收不等于 Android / iPhone 真机、Safari / WebKit、键盘遮挡、读屏或原生壳的完整验收。后续开发应补设备矩阵与平台能力测试。

## 代码组织与本地运行

源码完全隔离在 `web/mobile-design/`，不导入 `web/src/App.jsx`、业务 AuthProvider、API 客户端或生产样式。

```text
web/mobile-design/
  index.html, vite.config.mjs
  src/App.jsx                  独立 HashRouter、四导航、延迟加载
  src/demo/                    3 岗位 / 5 题种子与版本化本地状态
  src/components/              TopBar / Sheet / Field / Button / Icon 等
  src/screens/                 发现、详情、进度、备考、账户与引导
  src/tokens.css               统一颜色 / 字体
  src/styles.css               共享组件与响应式
  src/visual-refinements.css    五概念对照后校准
```

复用仓库已有 React、Vite 与 Playwright，不安装新依赖。在 `web/mobile-design/` 目录执行：

```powershell
# 本地预览，端口 4185
node ../node_modules/vite/bin/vite.js --config vite.config.mjs

# 面向独立预览子路径构建；环境变量只影响此构建
$env:MOBILE_DESIGN_BASE = '/usertest/mobile-design/'
$env:MOBILE_DESIGN_OUT_DIR = 'E:/job-sync-qa-20261023/mobile-design/release'
node ../node_modules/vite/bin/vite.js build --config vite.config.mjs
```

默认 base 为 `/mobile-design/`，默认输出为本目录下已忽略的 `dist/`；用 `MOBILE_DESIGN_OUT_DIR` 或 `--outDir` 指定其他目录。此次验收和发布输出保存在 E 盘 QA 目录，不会覆盖 `server/public/app` 或主站构建。服务器关闭目录索引时，使用 `index.html#/discover` 明确入口。

## 验证与视觉对照记录

Browser / IAB 返回 `Browser is not available: iab`，因此使用仓库现有 Playwright Chromium；未安装浏览器或依赖。所有 QA 产物按要求保存在 `E:/job-sync-qa-20261023/mobile-design/`，不放入业务发布目录。

- 主流程自动检查 141 项通过，包含 22 路由 × 5 宽度（320 / 390 / 412 / 820 / 1440）的 110 项横向溢出检查；页面异常 0，外部请求 0。
- 账户辅助流程 10 组通过：会员去重 / 撤回、5 MB 附件边界与删除、提醒偏好 / 已读、反馈回复、保存搜索、登录 / 画像、忘密、设置与重置；页面和控制台异常 0，外部请求 0。
- 练习与考试检查了正确 / 错误分支、刷新解析恢复、重新练习清空、墙钟计时、考试草稿恢复、交卷结果恢复；面板检查 Tab 环绕、Esc 关闭和触发器焦点恢复。
- 截图包含五主屏的 `*-390.png` 与 `*-native.png`，并保留 `qa.cjs`、`qa-result.json`、`account-qa.cjs` 与账户专项截图。

| 对照点 | 概念与实现证据 | 修正 / 结论 |
| --- | --- | --- |
| 发现首屏层级 | `discovery.png` ↔ `discovery-390.png` / `discovery-native.png` | 保留品牌、标题、搜索、3 筛选、2 岗位卡、4 导航；校正标题上距、元数据字号和来源行 |
| 详情结构 | `detail.png` ↔ `detail-390.png` / `detail-native.png` | 保留公司、蓝色薪资、公告条、开放事实分区与固定 CTA；压缩分区上下距，保留状态警示和未知信息 |
| 投递卡片 | `pipeline.png` ↔ `pipeline-390.png` / `pipeline-native.png` | 保留阶段 tabs、跟进条、日期 / 下一步和右下更新按钮；修正纵向间距；免责声明未删除，短屏滚动可见 |
| 练习答案态 | `practice.png` ↔ `practice-390.png` / `practice-native.png` | C 选项蓝色反馈、进度条、底部提交一致；将题干从意外三行调整为可读两行，保留空选 / 已答真实状态 |
| 我的首页 | `account.png` ↔ `account-final-390.png` / `account-final-native.png` | 头像、会员横幅、4 + 3 行结构和入口不变；校正顶部与横幅内距，使首组位置接近原图 |
| 色彩 / 图标 / 字体 | 五概念与五最新实屏均经 `view_image` 并排审核 | 纯白、蓝 / 墨色、线性图标和轻描边保持；使用系统中文字体与可缩放 SVG，非生成图片像素描摹 |

首屏文案对照：发现、详情、进度、“我的”的标题、主要按钮、导航和栏目沿用批准概念；没有新增促销指标、编造服务或额外营销标签。练习页额外保留“界面示例”这一常驻标记，属于明确要求的功能性偏差。概念里的 C 已选在视觉截图中通过真实点击产生，实际初始练习没有替用户选答案。

可接受的实现差异：系统字体字形、少量紧凑间距、次级状态的真实文字换行；桌面额外的演示导航不属于手机主屏。较长详情、进度免责声明和次级表单允许滚动，未为硬塞首屏删除说明。真实交互所需的选择、错误、加载、空、断网、确认与重置状态沿用相同组件系统。五屏已按批准视觉基准完成对应验证，不把静态概念图充作可点击界面。
