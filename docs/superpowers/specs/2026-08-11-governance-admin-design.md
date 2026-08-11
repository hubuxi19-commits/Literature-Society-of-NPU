# 发布5 治理与管理员编辑能力 · 设计文档

> 日期：2026-08-11
> 范围：举报、处置与审计（治理）+ 管理员编辑能力（推荐理由/编辑点评/优质评论）+ 投稿引导清单 + 整站视觉与无障碍复核。
> 合并为一个发布5（负责人 2026-08-11 确认）。
> 前置基线：发布1–4 已上线复验；HEAD/main `69cfa0c`。设计依据：`docs/superpowers/specs/2026-08-02-community-platform-upgrade-design.md` 阶段 E 与 5.10/5.11/第10节，以及任务账本「发布5」节。

## 1. 目标

让社区具备自我治理能力：任何已验证成员可以举报违规内容；管理员可以在不增加独立编辑角色的前提下完成举报处置、撰写作品推荐理由与编辑点评、推荐优质评论；所有处置与编辑行为都有独立审计记录。同时为投稿页提供不阻断发布的提醒清单，并完成整站视觉与无障碍复核。

## 2. 关键决策（负责人确认）

- **范围**：治理数据库层 + 前端处置台/举报入口 + 投稿引导清单 + 视觉无障碍复核，合并为**一个发布5**。
- **管理员任命**：不新增管理界面/RPC；负责人在 Supabase SQL Editor 手动 `update profiles set role='admin'`。复用现有 `is_admin()`。
- **处置落地**：处置成立时执行**真实动作**（隐藏作品/隐藏评论/警告账号），处置记录写入独立审计 `moderation_actions`；被举报者通过「内容隐藏可见状态 + 站内通知（`moderation_outcome`，只含最终处置结果）」获知结果。
- **治理模型**：单一管理员处置台（`#/admin`）+ 编辑类操作在作品页就地编辑（方案 A）。

## 3. 现状与复用

- `is_admin()`：读 `profiles.role = 'admin'`（`schema.sql` 129）。
- `is_account_write_allowed()`：`write_gate <> 'enforce'` 或 `is_recovery_email_verified()`（`schema.sql` 563）。所有写 RPC 与 RLS 写策略先校验它。
- `works.status` 已允许 `('published','hidden')`；`browse_works`/搜索/阅读页均按 `status='published'` 过滤 —— 隐藏动作落地后自动排除。
- `soft_delete_comment`：评论软删已存在，隐藏评论可复用它（注意其副作用：撤评论点赞、聚合等）。
- `upsert_notification` / `remove_notification_actor`：发布4 聚合通知辅助，优质评论推荐与处置结果通知复用。
- 前端 hash 路由 `renderCurrentRoute`（`js/app.js` 3282）；`routeToAccountSecurityIfUnverified`（313）处理未验证写操作跳转；现有 dialog 模式（如 `#annotateDialog`）。

## 4. 数据库设计

### 4.1 新表

**`work_editorial_notes`** —— 作品推荐理由与编辑点评。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk default gen_random_uuid() | |
| work_id | uuid references works(id) | |
| note_type | text check ('recommendation_reason','editorial_note') | |
| content | text not null | |
| admin_id | uuid references profiles(id) | |
| created_at | timestamptz default now() | |
| updated_at | timestamptz default now() | |

`UNIQUE (work_id, note_type)`。作品页只显示当前内容（最新覆盖）。

**`comment_highlights`** —— 优质评论。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| comment_id | uuid references comments(id) unique | 一条评论最多被推荐一次 |
| work_id | uuid references works(id) | 冗余，便于列表查询与公开可见性判断 |
| reason | text not null | 推荐理由 |
| admin_id | uuid references profiles(id) | |
| created_at | timestamptz default now() | |

**`reports`** —— 举报。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| reporter_id | uuid references profiles(id) | 举报者身份仅管理员可见 |
| target_type | text check ('work','comment','profile') | |
| target_id | uuid | 作品/评论/账号 UUID |
| reason_type | text check ('violation','infringement','spam','other') | 举报类型 |
| detail | text | 详细说明（可空） |
| status | text check ('pending','resolved','dismissed') default 'pending' | |
| created_at | timestamptz default now() | |
| handled_at | timestamptz | 处置时间 |
| handled_by | uuid references profiles(id) | 处置管理员 |

`UNIQUE (reporter_id, target_type, target_id)` —— 同人对同一目标幂等，重复举报返回既有状态。

**`moderation_actions`** —— 管理员处置审计（不可由前端删除）。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| report_id | uuid references reports(id) nullable | 关联举报（若处置源于举报） |
| target_type | text check ('work','comment','profile') | |
| target_id | uuid | |
| decision | text check ('resolved','dismissed') | |
| action_type | text check ('hide_work','hide_comment','warn_user') nullable | 不成立驳回时为空 |
| internal_note | text | 内部说明（被举报者不可见） |
| admin_id | uuid references profiles(id) | |
| created_at | timestamptz default now() | |

### 4.2 RLS

- `work_editorial_notes`：SELECT 对 anon/authenticated 开放，但仅限 `works.status='published'` 的公开作品（JOIN 校验）；INSERT/UPDATE/DELETE 仅 `is_admin()`。
- `comment_highlights`：SELECT 对 anon/authenticated 开放，仅限公开作品上的评论（JOIN `works.status='published'` 且评论未软删）；INSERT/UPDATE/DELETE 仅 `is_admin()`。
- `reports`：SELECT 仅 `auth.uid() = reporter_id OR is_admin()`；INSERT 仅 `auth.uid() = reporter_id AND is_account_write_allowed()`；无 UPDATE/DELETE 策略（全部经 RPC）。
- `moderation_actions`：SELECT 仅 `is_admin()`；无 INSERT/UPDATE/DELETE 策略（仅 SECURITY DEFINER RPC 写入）。

### 4.3 受保护 RPC（SECURITY DEFINER，与既有模式一致）

| RPC | 门槛 | 行为 |
|---|---|---|
| `report_content(p_target_type, p_target_id, p_reason_type, p_detail)` | `is_account_write_allowed()` | 幂等写 `reports`（`on conflict (reporter_id,target_type,target_id) do nothing`）；已有举报时返回既有状态。目标必须存在（按类型校验：作品须存在、评论须存在且未删、账号须存在）。 |
| `moderate_report(p_report_id, p_decision, p_action_type, p_internal_note)` | `is_admin()` 且 `is_account_write_allowed()` | 校验举报为 pending；p_decision='dismissed' 时 p_action_type 必须为空；'resolved' 时必须给出 p_action_type 与 p_internal_note。成立时执行真实动作：`hide_work`→`update works set status='hidden'`；`hide_comment`→按 `soft_delete_comment` 同逻辑隐藏（撤聚合/点赞通知）；`warn_user`→不改内容仅记录。写 `moderation_actions` 审计；更新 `reports.status/handled_at/handled_by`。通知被举报者 `moderation_outcome`（载荷含 decision+action_type，**不含**举报者身份与 internal_note；被举报者=作品作者/评论作者/账号本人）。被举报者==管理员自己（自己处置自己的内容）不通知。 |
| `set_work_editorial_note(p_work_id, p_note_type, p_content)` | `is_admin()` 且 `is_account_write_allowed()` | upsert `work_editorial_notes`（`on conflict (work_id,note_type) do update`）。 |
| `highlight_comment(p_comment_id, p_reason)` | `is_admin()` 且 `is_account_write_allowed()` | upsert `comment_highlights`（评论须未软删且作品公开）；通知评论作者 `comment_highlight`（作者==管理员自己不通知）。 |
| `unhighlight_comment(p_comment_id)` | `is_admin()` 且 `is_account_write_allowed()` | 删除 `comment_highlights` 行。 |
| `list_reports(p_status)` | `is_admin()` | 返回举报 + 举报者公开笔名（管理员可见）+ 目标摘要。 |
| `list_moderation_actions()` | `is_admin()` | 返回只读审计记录（含管理员笔名、内部说明、时间）。 |
| `get_work_editorial(p_work_id)` | 公开 | 返回公开作品的推荐理由/编辑点评（若存在），供作品页渲染。只读不写，不校验写门槛。 |

所有新表写策略与上述 RPC 均双校验 `is_admin()` 与 `is_recovery_email_verified()`（管理员未验证同样被拒）。

### 4.4 通知集成

复用 `upsert_notification` 新增事件类型：

- `comment_highlight`：优质评论推荐 → 通知评论作者。work_id=评论所属作品，comment_id=评论，actor=管理员。
- `moderation_outcome`：处置结果 → 通知被举报者。work_id/comment_id 按目标类型填，actor=管理员。载荷只含最终处置结果。

沿用发布4 聚合（agg_key=event_type+target 复合、actor 头3）与「自己触发不通知自己」。

## 5. 前端设计

### 5.1 管理员处置台（`#/admin`）

- 仅 `state.session.profile.role === 'admin'` 可进入；否则渲染「无权限」。桌面账户菜单与移动端账户入口在管理员时显示「管理台」。
- 页签：
  1. **待处理举报**：举报目标摘要（作品标题/评论预览/笔名）、举报者笔名（仅管理员可见）、类型、说明、时间；处置动作——成立→选动作（隐藏作品/隐藏评论/警告账号）+ 写内部说明并确认；不成立→驳回+内部说明。处置后移入已处理。
  2. **已处理记录**：已处置举报 + `moderation_actions` 只读审计（动作、目标、管理员、内部说明、时间）。
  3. **编辑点评与推荐理由**：已点评/已推荐作品目录，点击跳转作品页就地编辑。
  4. **优质评论**：已推荐评论列表 + 理由，可取消推荐。

### 5.2 举报入口

- 作品页元信息区「举报」、每条评论「举报」、作者公开资料「举报此用户」。
- 点击弹对话框：选类型（如：违规内容/侵权/垃圾广告/其他）+ 写说明 + 提交。复用现有 dialog 模式。
- 未登录/未验证写操作走 `routeToAccountSecurityIfUnverified` 跳账号安全页。

### 5.3 作品页编辑展示

- 「编辑推荐」横幅：有推荐理由时显示理由 + 管理员笔名 + 时间。
- 「编辑点评」独立框：标注管理员身份与时间，与评论区分开。
- 优质评论：评论旁标「编辑推荐」标记 + 理由。
- 管理员登录时：对应区域旁显示「添加/修改」按钮，每条评论显示「设为优质评论」（弹窗填理由）。

### 5.4 投稿引导清单

- 写作页顶部非阻塞提示块：原创声明、引用来源注明、排版检查（分段/标点）、建议参与互评。
- 只提示不阻止发布，无校验门槛、无复选框。

## 6. 整站视觉与无障碍复核

对照以下标准全站核查并修正 CSS，保留米白/墨黑/暗红/宋体/留白/细线气质，不引入玻璃拟态、表情导航、商业卡片流、长期侧栏：

- 移动正文 ≥16px、行高 ≥1.9；关键元信息 ≥13px；触控目标 ≥44px；
- 正文文字对比度 ≥4.5:1；弱化文字对比度达标；
- 焦点可见态（`:focus-visible`）齐全；未读朱砂标记保留；
- 桌面 + 移动截图复核验证。

## 7. 测试策略

### 数据库（新增迁移 + DB 单测）

- 权限门槛：未验证成员举报/处置/点评/推荐均被拒；非管理员处置/点评/推荐/写审计均被拒；管理员未验证被拒。
- 越权读取：举报者不能读他人举报；普通用户读不到举报者身份；`moderation_actions` 无 INSERT/UPDATE/DELETE 策略（前端无权删审计）。
- 真实动作：`hide_work` 后 `works.status='hidden'` 且 `browse_works`/搜索/单作品查询排除；`hide_comment` 后评论不可见且点赞聚合撤销。
- 通知：`comment_highlight`/`moderation_outcome` 触发正确；自己触发不通知自己；重复举报/重复推荐幂等不产生重复记录。
- 迁移幂等：schema.sql 与迁移文件双载验证（沿用发布4 模式）。

### 前端（浏览器套件）

- 举报提交流程（demo 登录 → 作品页举报 → 对话框提交 → 已举报状态）。
- 管理员处置台全流程（demo 管理员登录 → `#/admin` → 见待处理举报 → 处置成立/驳回 → 已处理与审计可见）。
- 作品页编辑展示（推荐理由/编辑点评/优质评论可见；管理员就地添加）。
- 投稿页引导清单可见；普通用户 `#/admin` 显示无权限。
- 视觉无障碍：桌面 + 移动截图对比度/触控/焦点抽查。

## 8. 越权与隐私红线

- 举报者身份仅管理员可见；被举报者只能看到最终处置结果，读不到内部说明与举报者身份。
- `moderation_actions` 审计记录前端无权删除。
- 管理员未验证找回邮箱时，所有写操作（处置/点评/推荐/举报）仍被数据库拒绝。
- 前端永不出现 `service_role` 或任何密钥；不把内部说明放进公开查询/日志/通知。

## 9. 不在范围

- 生产 `write_gate` 切 `enforce`（负责人明确跳过）。
- 服务端学号身份映射（Edge Function）为后续可选项。
- 管理员提权/撤销界面（手动 SQL 任命）。
