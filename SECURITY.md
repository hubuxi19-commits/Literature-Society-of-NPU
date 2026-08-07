# 安全说明

## 安全边界

文苑是部署在 GitHub Pages 上的静态前端。浏览器中出现的代码、Supabase 项目 URL 和 `anon` 密钥都应视为公开信息。真正的授权边界必须位于 Supabase Auth、Postgres 约束、RPC 权限和 Row Level Security。

本项目不会：

- 在业务表保存登录凭据。
- 在浏览器中查询或比较登录凭据。
- 在公开资料表保存学号。
- 在作者主页、作品、评论或搜索结果展示学号。
- 将 `service_role` 或数据库连接信息写入前端。

## 学号登录方案的限制

当前界面将学号确定性转换为 Supabase Auth 的内部邮箱标识。这样可以继续使用“学号 + 密码”的交互，同时让 Supabase Auth 负责安全存储和校验凭据。

它仍有以下限制：

- 不能证明注册者确实拥有该学号。
- 不能通过内部标识接收确认或找回邮件。
- 学号空间可预测，需要防范账户枚举、撞库和暴力尝试。
- 关闭邮件确认降低了注册身份保证。

面向公开网络正式开放前，应至少完成以下一种升级：

1. 注册后绑定并验证学校邮箱，用真实邮箱完成确认和找回。
2. 使用 Supabase Edge Function 连接学校允许的身份系统，在服务端验证学号。
3. 使用由学校统一身份认证提供的 OAuth 或 SAML 流程。

## RLS 与数据库权限

`supabase/schema.sql` 为 `profiles`、`works`、`likes`、`comments` 和 `site_settings` 启用 RLS。

- 未登录用户只能读取公开社区信息。
- 成员只能修改自己的公开资料和内容。
- 点赞使用 `(work_id, user_id)` 复合主键。
- 删除评论通过受保护 RPC 进行软删除。
- 编辑推荐通过管理员 RPC 修改。
- `role` 不在普通成员可更新的列权限中。
- `pen_name` 不在普通成员可直接更新的列权限中；成员只能调用 `update_own_profile` RPC 修改自己的笔名。RPC 对资料行加锁，并以数据库时间强制每七天最多改名一次，避免绕过前端或并发请求突破冷却。`bio` 不受该冷却限制。

上线前必须在真实 Supabase 项目中验证策略。仅检查前端按钮是否隐藏不构成权限测试。

## 密钥处理

可以进入前端仓库：

- Supabase Project URL。
- Supabase `anon`（publishable）密钥。

不得进入前端仓库：

- Supabase `service_role` 密钥。
- 数据库连接密码。
- Supabase Management API Token。
- GitHub Personal Access Token。
- 其他可以绕过 RLS 的凭据。

`anon`/publishable 密钥可以出现在静态前端；它不绕过数据库权限。`service_role` 密钥绝不能出现在浏览器代码、前端配置、Git 历史、GitHub Pages 构建输入或截图中，因为它能绕过 RLS。每张业务表都必须持续启用 RLS；公开前端、隐藏界面入口或列级权限都不能替代各表的 RLS 策略。

## 账号安全与密码找回的密钥和部署

账号安全与密码找回依赖以下 Edge 环境变量。

非秘密配置（可写入 `supabase/functions/.env.example`）：

- `ALLOWED_ORIGINS`：允许调用函数的前端来源。
- `BREVO_SENDER_EMAIL`：Brevo 发件人地址。
- `BREVO_SENDER_NAME`：发件人显示名称。

秘密（只通过 Supabase Dashboard 的 Edge Functions → Secrets 设置，绝不写入文件、终端输出、聊天、截图或 Git 历史）：

- `BREVO_API_KEY`：Brevo 事务邮件 API 密钥。
- `TURNSTILE_SECRET_KEY`：Cloudflare Turnstile 服务端校验密钥。
- `ACCOUNT_TOKEN_PEPPER`：验证码令牌 HMAC 的静态胡椒。
- `AUTH_RATE_LIMIT_PEPPER`：速率限制桶名 HMAC 的静态胡椒。

`supabase/functions/.env.example` 只保留占位名和空值，用于提示需要的变量名；真实值不得进入该文件或任何入库文件。

### 上线状态分级

写保护由 `site_settings.account_security.write_gate` 控制，按以下顺序推进：

1. `off`：仅部署 Schema 与函数，不拦截任何写操作。
2. `warn`：界面提示绑定找回邮箱，但不阻止数据库写入。
3. `enforce`：未验证找回邮箱的账户不能写入（前端提示并跳转账号安全页，数据库层面 RLS/RPC 同样拒绝）。

### 预演（staging）部署顺序

1. 确认目标项目是空白的 staging 项目，不是生产项目。
2. 依次执行 `supabase/migrations/20260731_split_poetry_categories_and_lock_pen_name.sql`、`20260802_allow_weekly_pen_name_changes.sql`、`20260802_account_recovery_security.sql` 和 `20260806_browse_works_and_discussions.sql`。最后一个提供首页分页、正文全文搜索与讨论分页所需的只读函数 `browse_works`、`browse_discussions`，是稳定数据读取功能，不需要改动 `write_gate`。
3. 确认全部业务/隐私表（`profiles`、`works`、`likes`、`comments`、`site_settings`、验证码令牌与账户安全相关表等）的 RLS 均为 `true`。
4. 通过 Dashboard 设置 Edge 秘密，不把真实值粘贴到聊天、终端输出、文件、截图或 Git。
5. 在 Brevo 注册一个发件人，将 provider 替换后的事务发件人地址写入成员帮助文案。
6. 本地使用 Turnstile 官方测试密钥；正式环境使用单独的生产 widget 密钥。
7. 部署 `account-email`（开启 JWT 校验）与 `password-recovery`（作为 publishable/public 端点）。
8. 只使用虚构的 staging 账户。
9. 将 staging 的 `account_security.write_gate` 设为 `enforce`。
10. 运行浏览器测试与人工 RLS 矩阵。

### 生产上线与回滚

生产保持 `off`，先部署 Schema 与函数。冒烟测试通过后切到 `warn`，让界面提示而不阻断数据库写入。以每天最多 200 个账户的批次开放绑定。只有抽样验证登录、发布、找回、重复邮箱、限速和隐私测试全部通过后，才可由负责人单独批准切到 `enforce`。

生产项目 ref 为 `odfjxtzgekhiaktzaxas`，站点为 `https://hubuxi19-commits.github.io/Literature-Society-of-NPU/`。截至 2026-08-06，生产已完成：三条迁移、Edge 秘密（含生产 Turnstile widget sitekey `0x4AAAAAAEH7aHbJJOgShIHC`）、`account-email` 与 `password-recovery` 函数部署、前端合并 `main` 并由 GitHub Pages 发布；`write_gate` 已推进到 `warn`。切 `enforce` 的操作与回滚预案见 [`docs/production-enforce-stepup.md`](./docs/production-enforce-stepup.md)。

回滚只需一条 SQL：

```sql
update public.site_settings
set value = jsonb_set(value, '{write_gate}', '"warn"'::jsonb, true)
where key = 'account_security';
```

回滚保留已验证的邮箱行与令牌，只停止强制执行写保护。

## 本地图片生成

阅读页导出的作品图片在用户浏览器本地完成：离屏模板使用仓库内的 `assets/student-literature-society-wordmark.png`，再生成 PNG Blob 并由浏览器分享或下载。作品正文、作者资料和生成的图片不会上传到第三方图片生成、渲染或存储服务。此性质依赖当前前端实现；今后若增加远程渲染、分析或存储服务，必须先更新隐私说明、威胁模型和 RLS/访问控制审查。

如果高权限密钥曾被提交到 Git：

1. 立即在对应平台撤销并轮换。
2. 不要只删除最新提交；历史记录仍可能包含密钥。
3. 清理 Git 历史后强制所有协作者重新同步。
4. 检查访问日志和数据库审计记录。

## 内容和滥用风险

正式运营还需要技术之外的治理：

- 登录和注册限速、CAPTCHA 与异常行为监控。
- 举报入口、管理员处置流程和申诉方式。
- 敏感内容、骚扰、抄袭和个人信息泄露处理规则。
- 管理员操作审计。
- 数据备份、恢复演练和内容保留期限。
- 隐私说明与用户注销流程。

## 报告安全问题

公开 GitHub 仓库启用后，优先使用 GitHub Security Advisories 私下报告漏洞。不要在公开 Issue 中粘贴真实学号、账户信息、访问令牌、数据库内容或可直接利用的攻击步骤。

报告内容应包括：

- 受影响页面或数据库对象。
- 复现所需的最小步骤。
- 使用的身份类型：未登录、普通成员或管理员。
- 实际结果和预期结果。
- 是否可能导致数据读取、修改、删除或身份冒用。

收到报告后，应先限制风险、保存必要日志并轮换可能泄露的凭据，再进行修复和披露。
