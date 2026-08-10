# 发布四：私密社交与站内通知 Design

日期：2026-08-10
状态：已批准（负责人逐节确认）

## 目标

为文苑平台加入私密社交层：社员之间可以关注（follow）、收藏作品（bookmark）、点赞评论（comment_like），并为「有人评论/回复、点赞作品、关注我、收藏我的作品、点赞我的评论」生成站内通知。通知按同类事件聚合（+N）。**不做社员间 1:1 私信**——「站内消息」即系统事件通知流。

## 范围

- **新增 4 张表**：`follows`、`bookmarks`、`comment_likes`、`notifications`。
- **新增/修改 10 个写 RPC + 10 个读/状态 RPC**（全部受保护/作用域收口，见 §4）。
- **迁移 2 条既有写路径**进通知引擎：作品点赞（`likes` 从直接 RLS 表操作改为 RPC）、评论/回复（`comments` 从直接 RLS 表操作改为 RPC）。
- **前端**：4 个新路由页（通知、我关注的人、关注我的人、我的收藏）、作品页社交操作条、评论点赞、作者页关注、通知未读角标。
- **测试**：SQL RPC 测试、Node 单元、浏览器 demo+staging 全流程。
- **迁移**：`supabase/migrations/20260810_social_and_notifications.sql`。

不改动：生产/主分支基线、`browse_works`/`browse_discussions` 只读契约、展示串/码点契约、账号安全门禁语义。

## 1. 架构总览（方案 A）

所有交互写入走 `SECURITY DEFINER` RPC，与发布3（create_quoted_comment 等）同一套模式（10 写 + 10 读/状态 RPC）：

- 每个写 RPC 开头：`auth.uid()` 登录校验 + `is_account_write_allowed()` 找回邮箱门禁。
- 「写交互 + 聚合通知 + 去重 + 禁止自我通知 + 计数原子更新」全部在同一事务内完成。
- 私密列表（关注/收藏/评论点赞/通知）仅经 owner 作用域 RPC 读取；聚合计数经公开读 RPC 暴露。
- 直接表级 RLS 不做写授权：4 张新表对 anon/authenticated 一律 revoke，仅 RPC 可达。

## 2. 数据模型（4 张新表）

```sql
create table public.follows (
  follower_id  uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
create index follows_following_id_idx on public.follows (following_id);

create table public.bookmarks (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  work_id  uuid not null references public.works(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, work_id)
);
create index bookmarks_work_id_idx on public.bookmarks (work_id);

create table public.comment_likes (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  comment_id uuid not null references public.comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, comment_id)
);
create index comment_likes_comment_id_idx on public.comment_likes (comment_id);

create table public.notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade, -- 接收者
  event_type       text not null check (event_type in (
    'work_comment', 'comment_reply', 'work_like', 'follow', 'work_bookmark', 'comment_like'
  )),
  target_work_id   uuid references public.works(id) on delete cascade,
  target_comment_id uuid references public.comments(id) on delete cascade,
  actor_ids        uuid[] not null default '{}',  -- 最近预览 actor（cap 3），读取时实时解析笔名
  actor_count      integer not null default 0 check (actor_count >= 1),
  last_event_at    timestamptz not null default now(),
  is_read          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  agg_key          text not null  -- event_type + 目标复合串，见 §3
);
create unique index notifications_user_agg_key_idx on public.notifications (user_id, agg_key);
create index notifications_user_read_idx on public.notifications (user_id, is_read);
create index notifications_user_event_idx on public.notifications (user_id, last_event_at desc);
```

## 3. 通知引擎（同类聚合 +N）

**聚合键** `agg_key`：`event_type` + 目标标识，`follow` 无目标时以哨兵串占位（如 `'follow:'`），解决 NULL 目标下唯一约束失效问题：

| event_type | agg_key 组成 | 目标解析（读侧） |
|---|---|---|
| work_comment | `work_comment:<work_id>` | 作品 |
| comment_reply | `comment_reply:<comment_id>` | 父评论所在作品 |
| work_like | `work_like:<work_id>` | 作品 |
| follow | `follow:`（无目标） | 关注我的个人页 |
| work_bookmark | `work_bookmark:<work_id>` | 作品 |
| comment_like | `comment_like:<comment_id>` | 评论所在作品 |

**共享 helper（全部写 RPC 内部调用）**：

- `upsert_notification(p_recipient, p_type, p_work_id, p_comment_id, p_actor)`：
  - `p_recipient = p_actor` 或 `p_recipient is null` → 直接返回（禁止自我通知）。
  - 显式 `select ... for update` 现聚合行；无行则插入（actor_ids=[actor], count=1）；有行且 actor 已在列表 → 仅刷新 `last_event_at`；否则 `actor_count+1`、actor_ids 头部插入并去重、截断到 3。
- `remove_notification_actor(p_recipient, p_type, p_work_id, p_comment_id, p_actor)`：
  - 把 actor 从 actor_ids 移除、`actor_count-1`；`actor_count` 归 0 或 list 为空 → 删除整行。
- `set_notification_read(p_recipient, p_notification_id)` / `set_all_notifications_read(p_recipient)`：仅 owner 可改，`is_read = true`。

**事件 ↔ 通知 ↔ 撤销映射**：

| 用户动作（写 RPC） | 通知（接收者, 聚合键） | 撤销动作 | 撤销副作用 |
|---|---|---|---|
| `create_comment` 顶层 | work_comment（作品作者, 作品） | `soft_delete_comment` 删该评论 | 从 work_comment 聚合移除该 actor |
| `create_comment` 回复 | comment_reply（被回复者, 父评论） | 同上 | 从 comment_reply 聚合移除 |
| `create_quoted_comment` | work_comment（作品作者, 作品） | 同上 | 同上 |
| `toggle_like_work` 点赞 | work_like（作者, 作品） | 同一 RPC 取消赞 | 从 work_like 聚合移除 |
| `follow_user` | follow（被关注者, 无目标） | `unfollow_user` | 从 follow 聚合移除 |
| `bookmark_work` | work_bookmark（作者, 作品） | `unbookmark_work` | 从 work_bookmark 聚合移除 |
| `like_comment` | comment_like（评论作者, 评论） | `unlike_comment` | 从 comment_like 聚合移除 |

删除评论时除撤销上表聚合外，另删除该评论上的 `comment_like` 通知（`target_comment_id = 被删评论`）。

## 4. RPC 面

全部写 RPC 签名以 `p_` 开头、`security definer`、`set search_path = public`、开头 `auth.uid() is null → '请先登录'`、`not is_account_write_allowed() → '请先验证找回邮箱后再进行此操作'`。

**写（10）**：

| RPC | 行为 | 通知 |
|---|---|---|
| `create_comment(p_work_id, p_content, p_parent_id)` | 校验作品可见/父评论归属（沿用 validate_comment_parent 语义）、长度 1..2000；插入 comments；根据 parent 有无发 work_comment / comment_reply | upsert |
| `create_quoted_comment(...)`（改） | 现有逻辑尾部追加 work_comment upsert（actor=当前用户，recipient=作品作者） | upsert |
| `soft_delete_comment(p_comment_id)`（改） | 现有逻辑尾部追加：撤销 work_comment / comment_reply 聚合；删除该评论的 comment_like 通知 | remove |
| `toggle_like_work(p_work_id)` | 校验作品存在/可见；likes 有则删+remove、无则插+upsert（返回 `{liked, like_count}`） | upsert/remove |
| `follow_user(p_target_user_id)` | 校验目标存在、非本人；插 follows（幂等 on conflict do nothing）；upsert follow | upsert |
| `unfollow_user(p_target_user_id)` | 删 follows；remove follow 聚合 | remove |
| `bookmark_work(p_work_id)` | 校验作品存在/可见；插 bookmarks（幂等）；upsert work_bookmark | upsert |
| `unbookmark_work(p_work_id)` | 删 bookmarks；remove work_bookmark | remove |
| `like_comment(p_comment_id)` | 校验评论存在、非本人评论；插 comment_likes（幂等）；upsert comment_like | upsert |
| `unlike_comment(p_comment_id)` | 删 comment_likes；remove comment_like | remove |

**读 / owner 状态（10）**：

| RPC | 作用域 | 返回 |
|---|---|---|
| `list_notifications(p_cursor, p_page_size)` | owner | 聚合条目 + 每条的 actor 笔名数组（实时 join profiles）+ 目标标题/类型，`last_event_at desc` 游标分页 |
| `get_notification_unread_count()` | owner | `{ unread_count }` |
| `mark_notification_read(p_notification_id)` | owner（校验 user_id） | void |
| `mark_all_notifications_read()` | owner | void |
| `list_my_following(p_cursor, p_page_size)` | owner | 我关注的人（pen_name、bio、id）分页 |
| `list_my_followers(p_cursor, p_page_size)` | owner | 关注我的人 分页 |
| `list_my_bookmarks(p_cursor, p_page_size)` | owner | 我收藏的作品（标题/摘要/作者/分类）分页 |
| `get_work_social_counts(p_work_id)` | 公开 | `{ bookmark_count, bookmarked_by_current_user }`（like/comment 计数沿用 browse_works/getWork） |
| `get_profile_social_counts(p_profile_id)` | 公开 | `{ following_count, followers_count }` |
| `get_comment_like_state(p_comment_ids uuid[])` | 公开 | 每评论 `{ comment_id, like_count, liked_by_current_user }` |

## 5. 安全 / RLS

- 4 张新表 `enable row level security`；防御性 owner-only policy（`using (user_id = auth.uid())` 等，见实现）；对 `anon, authenticated` `revoke all`（无直接表访问），仅经 RPC 可达。
- `notifications`、`follows`、`bookmarks`、`comment_likes` 均为私密：私密列表永不经公开查询暴露；聚合计数经 §4 公开读 RPC 暴露。
- 写路径统一过 `is_account_write_allowed()`（生产现 `warn`、staging `enforce`）：门禁逻辑照常生效，不因当前 gate 值而省略。
- 禁止自我通知由 `upsert_notification` 的 `recipient = actor` 短路保证；自我关注由 `follows` 的 `CHECK` + RPC 双重拒绝。

## 6. 前端

**路由**（`parseRoute` 新增）：`#/notifications`、`#/my/following`、`#/my/followers`、`#/my/bookmarks`。

**入口**：
- 桌面用户菜单（我的主页/账号安全/退出登录 之上）新增：通知（未读角标）、我的收藏、我关注的人、关注我的人。
- 移动端底部导航「我的」区新增以上入口；底部导航加通知入口（未读角标）。

**作品页**：正文后加社交操作条——点赞（现有，改为调 `toggle_like_work`）、收藏（计数+激活态）、关注作者（仅非本人时显示，计数为作者粉丝数）。评论树每行加「赞」按钮 + 计数。

**作者页**：展示粉丝数/关注数（公开计数）+ 关注/取关按钮（非本人时）。

**通知页**：聚合条目渲染「A、B、C 等 N 人 赞了你的作品《title》」+ 相对时间；未读高亮；点击条目 → `mark_notification_read` + 跳转目标（作品/评论所在作品/作者页）；「全部已读」按钮；未读角标在登录、路由切换、写操作后刷新。

**数据服务**：新增对应 RPC 方法；`toggleLike` 与 `addComment` 从直接表操作改为调新 RPC；demo 数据服务同步镜像全部新 RPC 内存实现。

## 7. 测试

- **SQL RPC 测试**（`supabase/tests/`）：无自我通知；未授权读拦截（他人不可读我的关注/收藏/通知）；聚合计数公开 / 列表私密；幂等（重复关注/收藏/点赞不重复计数）；未验证找回邮箱时写被拒（staging enforce 下）；关注/收藏/点赞往返；撤销时聚合正确收缩、归零删行。
- **Node 单元**：相对时间格式化、通知条目模型（+N 折叠文案）、社交按钮状态逻辑、`parseRoute` 新路由。
- **浏览器（demo + staging）**：关注 → 对方通知出现；收藏 → 计数+通知；评论点赞 → 计数+通知；通知页渲染与未读角标；标记已读/全部已读；评论/回复产生通知。
- 基线：全量 `npm test` 保持绿。

## 8. 边界与已知限制

- 作品被隐藏/删除后，指向它的旧通知点击跳转 404，本轮不做清理。
- 通知存 actor uuid，读取时实时解析笔名（笔名变更不产生陈旧快照）。
- 评论软删除保留行（`is_deleted=true`），其上的 comment_like 通知在删评论时清除。
- 不做实时推送（无 Supabase Realtime 依赖）；未读角标随登录/路由/写操作刷新。
- 生产 `write_gate` 仍 `warn`：门禁代码照常部署，切 `enforce` 时自动生效。
