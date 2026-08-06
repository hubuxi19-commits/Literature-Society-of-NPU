# 生产 write_gate 升级到 enforce 的操作文档

> 目标项目：Supabase 生产 ref `odfjxtzgekhiaktzaxas`
> 状态：本文件是**待执行**的切换预案。当前生产为 `warn`（提示不阻断）。只有负责人单独批准后才执行本文件第 4 步。
> 配套：功能说明与部署顺序见 `SECURITY.md`“账号安全与密码找回的密钥和部署”。

## 1. 背景

写保护由 `site_settings.account_security.write_gate` 控制，三档推进：

| 档位 | 行为 |
|---|---|
| `off` | 不提示、不拦截 |
| `warn` | 界面提示绑定找回邮箱，不阻断数据库写入 |
| `enforce` | 未验证找回邮箱的账号不能写入（前端跳转账号安全页，数据库 RLS/RPC 同样拒绝） |

生产已按序完成：三条迁移 → Edge 秘密 → 两个函数部署 → 前端上线 → 切 `warn`。

## 2. 切换 enforce 的前置条件（全部满足才执行）

- [ ] warn 已运行至少数天，老用户陆续完成找回邮箱绑定。
- [ ] 抽查生产：warn 阶段验证矩阵 A1–A9 全部通过（登录、绑定、掩码、重复邮箱拒绝、防枚举、验证码次数、限速、找回后身份不变、日志干净）。
- [ ] 已完成生产真实用户实测（本人在生产站点绑定一次找回邮箱成功）。
- [ ] 负责人确认绑定率/准备度足够，单独书面批准切 enforce。
- [ ] 当前无正在进行的生产维护/发布窗口冲突。

## 3. 切换前快照（只读，可选但建议）

```sql
-- 记录当前 write_gate（应为 warn）
select key, value ->> 'write_gate' as write_gate
from public.site_settings
where key = 'account_security';

-- 记录已绑定用户数，供切后对比
select count(*) as verified_users
from public.account_recovery_emails;
```

## 4. 切换 enforce（正式执行）

在**生产项目 SQL Editor** 执行，确认顶部 ref 是 `odfjxtzgekhiaktzaxas`：

```sql
update public.site_settings
set value = jsonb_set(value, '{write_gate}', '"enforce"'::jsonb, true)
where key = 'account_security';
```

成功返回 `UPDATE 1`。随后确认：

```sql
select key, value ->> 'write_gate' as write_gate
from public.site_settings
where key = 'account_security';
-- 期望：warn -> enforce
```

## 5. 切换后验证矩阵（B 阶段）

以下每项都要在生产站点的三个真实浏览器会话（未登录 / 普通成员 / 管理员）验证。**页面隐藏按钮不等于数据库拒绝**，必要时用浏览器控制台直接调用验证。

- [ ] B1 未登录：能阅读公开内容；任何写操作（发帖/评论/点赞）被拒。
- [ ] B2 未验证成员：登录后能阅读；**所有写操作被拒**，前端提示“请先验证找回邮箱”并跳转账号安全页；绕过前端直接调 RPC 同样被拒。
- [ ] B3 已验证成员：发帖、评论、点赞、改简介全部成功。
- [ ] B4 管理员未验证：不能进行管理写操作（设推荐/删任意作品评论）。
- [ ] B5 管理员已验证：可用现有管理写功能。
- [ ] B6 绑定流程回归：新老账号绑定+验证找回邮箱仍成功，掩码正常。
- [ ] B7 重复邮箱仍被拒绝且不泄露归属。
- [ ] B8 密码找回流程仍可用（防枚举文案一致）。
- [ ] B9 日志抽查：requestId 存在，无完整邮箱/学号/验证码/密码/作品正文。

## 6. 回滚（随时可用，单条 SQL）

回滚保留已验证邮箱行与令牌，只停止强制执行写保护：

```sql
update public.site_settings
set value = jsonb_set(value, '{write_gate}', '"warn"'::jsonb, true)
where key = 'account_security';
```

如需完全回到不提示（一般不需要）：把 `'warn'` 换成 `'off'`。

触发回滚的情形：切换后短时间内出现大量误拦截、绑定流程大面积失败、邮件或限速异常，或任何 B 矩阵关键项失败且无法立即修复。

## 7. 切换后运营提示

- 未绑定老用户在 enforce 下不能写，但能登录、能阅读、能在账号安全页绑定。如有成员反馈“发不了帖”，引导其绑定找回邮箱即可，勿降级整个站点。
- 生产每日限速：同用途每天 3 次、60 秒冷却、网络每日 20 次。批量引导绑定不会触发，个别手滑重试会短暂 429。
