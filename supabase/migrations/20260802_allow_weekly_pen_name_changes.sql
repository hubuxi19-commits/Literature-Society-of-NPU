begin;

alter table public.profiles
  add column if not exists pen_name_changed_at timestamptz;

create or replace function public.update_own_profile(
  requested_pen_name text,
  requested_bio text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.profiles;
  normalized_pen_name text;
  normalized_bio text;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  normalized_pen_name := btrim(coalesce(requested_pen_name, ''));
  normalized_bio := btrim(coalesce(requested_bio, ''));
  if char_length(normalized_pen_name) not between 1 and 24 then
    raise exception '笔名必须为 1 至 24 个字符';
  end if;
  if char_length(normalized_bio) > 240 then
    raise exception '简介不能超过 240 个字符';
  end if;

  select *
  into target
  from public.profiles
  where id = auth.uid()
  for update;

  if target.id is null then
    raise exception '作者不存在';
  end if;

  if target.pen_name <> normalized_pen_name then
    if target.pen_name_changed_at is not null
      and now() < target.pen_name_changed_at + interval '7 days' then
      raise exception '笔名每七天只能修改一次，请在冷却期结束后再试';
    end if;

    update public.profiles
    set
      pen_name = normalized_pen_name,
      pen_name_changed_at = now(),
      bio = normalized_bio
    where id = auth.uid()
    returning * into target;
  else
    update public.profiles
    set bio = normalized_bio
    where id = auth.uid()
    returning * into target;
  end if;

  return target;
end;
$$;

revoke update (pen_name, bio, updated_at) on table public.profiles
from authenticated;
revoke update on table public.profiles from authenticated;
grant update (bio, updated_at) on table public.profiles to authenticated;

revoke all on function public.update_own_profile(text, text) from public;
grant execute on function public.update_own_profile(text, text) to authenticated;

commit;
