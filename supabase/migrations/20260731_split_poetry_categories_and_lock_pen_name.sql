begin;

alter table public.works
  drop constraint if exists works_category_check;

update public.works
set category = '新诗'
where category = '诗歌';

alter table public.works
  add constraint works_category_check
  check (category in ('新诗', '旧诗', '散文', '小说', '随笔', '其他'));

revoke update (pen_name, bio, updated_at) on table public.profiles from authenticated;
revoke update on table public.profiles from authenticated;
grant update (bio, updated_at) on table public.profiles to authenticated;

commit;
