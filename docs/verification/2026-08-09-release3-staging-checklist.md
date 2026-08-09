# 发布3（版本与批注）staging 验证清单

> 目标环境：staging Supabase（ref `rcrqosnbkojaarppvcac`）
> 迁移文件：`supabase/migrations/20260808_work_versions_and_quotes.sql`
> 分支：`codex/wenyuan-community-upgrade`　HEAD：`8b7a4a1`
> 执行人：负责人（在 staging SQL Editor 手动执行）

## Part A：执行迁移（一次性写入）

1. 打开 staging SQL Editor（确认右上角 ref 为 `rcrqosnbkojaarppvcac`）。
2. 把 `supabase/migrations/20260808_work_versions_and_quotes.sql` 全文复制粘贴运行。
3. 期望：无报错，正常结束（DDL + 回填 + RPC 创建）。

## Part B：回填与结构验证（只读）

```sql
-- 每篇作品都应有第 1 版
select
  (select count(*) from public.works) as works_count,
  (select count(*) from public.work_versions) as versions_count,
  (select count(*) from public.works w
   where not exists (select 1 from public.work_versions v where v.work_id = w.id))
   as works_without_v1;

-- current_version_id 应全部指向第 1 版
select
  (select count(*) from public.works where current_version_id is null) as no_current,
  (select count(*) from public.works w
   join public.work_versions v on v.id = w.current_version_id
   where v.version_number <> 1) as wrong_current;

-- 抽查 3 篇：v1 快照与 works 一致、创建者=作者
select w.id, w.title,
       v.version_number, v.title = w.title as title_ok,
       v.content = w.content as content_ok,
       v.category = w.category as category_ok,
       (v.created_by = w.author_id) as same_author
from public.works w
join public.work_versions v on v.work_id = w.id and v.version_number = 1
order by w.id
limit 3;
```

期望：`works_without_v1 = 0`、`no_current = 0`、`wrong_current = 0`、抽查全为 t。

## Part C：RPC 行为验证（事务内回滚，不污染数据）

先取测试作者 ID（staging 测试数据笔名 `test`，如不同请改用实际笔名）：

```sql
select id, pen_name, role from public.profiles where pen_name = 'test';
```

把 `<AUTHOR_ID>` 换成上一步结果，整体复制运行（`rollback` 保证不落库）：

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "<AUTHOR_ID>", "role": "authenticated"}';

-- 前置：写入门禁应放行（staging 已 enforce；若返回 false，说明该账号找回邮箱未验证）
select public.is_account_write_allowed() as gate_ok;

-- 选一篇该作者的测试作品
select id, title from public.works where author_id = '<AUTHOR_ID>' order by created_at limit 1;

-- 1) 创建新版本：携带当前版本号 1 → 期望 version_number = 2，is_new = false
select public.create_work_version(
  '<WORK_ID>', 1, '测试标题-修订', '', '散文', '测试正文内容-修订', '补充一段'
);

-- 2) 版本冲突：携带错误版本号 → 期望报错「作品已被他人修改，请重新载入后重试」
select public.create_work_version(
  '<WORK_ID>', 99, 'x', '', '散文', 'y', 'z'
);

-- 3) 缺失修改说明 → 期望报错「请填写简短修改说明」
select public.create_work_version(
  '<WORK_ID>', 2, 'x', '', '散文', 'y', '  '
);

rollback;
```

非作者与未验证拒绝（换一个普通成员的 sub）：

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "<OTHER_MEMBER_ID>", "role": "authenticated"}';

-- 非作者 → 期望报错「只有作者可以修改自己的作品」
select public.create_work_version(
  '<WORK_ID>', 2, 'x', '', '散文', 'y', 'z'
);
rollback;
```

未验证账号（找回邮箱未验证时 gate 拒绝）：

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "<UNVERIFIED_ID>", "role": "authenticated"}';
select public.is_account_write_allowed() as gate_should_be_false;
select public.create_work_version(null, null, 't', '', '散文', '正文', ''); -- 期望报错「请先验证找回邮箱后再进行此操作」
rollback;
```

## Part D：批注与恢复（事务内回滚）

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "<AUTHOR_ID>", "role": "authenticated"}';

-- 取作品当前版本 ID
select id, version_number from public.work_versions
where work_id = '<WORK_ID>' order by version_number desc limit 1;

-- 1) 创建批注：quote 必须与展示串位置匹配。
--    展示串 = 正文按 空行分段、每段去首尾空白、去空段、以 \n 连接。
--    下面先看展示串，再按展示串里的文本填 start/end：
select public.create_quoted_comment(
  '<WORK_ID>', '<VERSION_ID>', '<展示串中的一段文字>', 0, <len>, '批注内容测试'
); -- 期望返回 comment + quote

-- 2) 引用不匹配 → 期望报错「引用原文与所选位置不符，请重新选择」
select public.create_quoted_comment(
  '<WORK_ID>', '<VERSION_ID>', '不存在的文字', 0, 3, 'x'
);

-- 3) 恢复版本：期望 version_number 递增，restored_from_version_id = 源
select public.restore_work_version(
  '<WORK_ID>', '<VERSION_ID>', <当前最大版本号>, '回到初稿'
);

rollback;
```

## Part E：列表 RPC（只读）

```sql
set local role anon;
set local request.jwt.claims = '{"sub": null, "role": "anon"}';
select public.list_work_versions('<WORK_ID>'); -- 期望按 version_number 降序的数组
select public.list_work_quotes('<WORK_ID>');   -- 期望引用数组（含 comment_content/user_pen_name）
```

## 通过后

- 回复本清单确认各 Part 结果（尤其 Part B 三个 0、Part C gate_ok、报错文案）。
- 随后我做 staging 前端浏览器端到端冒烟（需你提供 staging 前端访问方式与测试账号），并准备合入 main 的最终 review。
