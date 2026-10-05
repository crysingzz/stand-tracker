-- Base schema. For a fresh installation, apply the migrations in the order
-- listed in README.md after this file. The shared code itself is not stored here.
-- All data tables are private; browsers can call only validated functions.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.team_config (
  id smallint primary key default 1 check (id = 1),
  code_hash bytea not null
);

insert into private.team_config (id, code_hash)
values (1, decode('97773e0482940876312a60435fc271cdafe6ed4d30e66370561ef254bc485074', 'hex'))
on conflict (id) do nothing;

create table if not exists private.sessions (
  id bigint generated always as identity primary key,
  stand_code text not null check (stand_code in ('AAV', 'ALP', 'OVD', 'TVE')),
  occupant_name text not null check (char_length(btrim(occupant_name)) between 1 and 80),
  purpose text not null default '' check (char_length(purpose) <= 200),
  started_at timestamptz not null default now(),
  planned_end_at timestamptz,
  ended_at timestamptz,
  released_by text check (released_by is null or char_length(btrim(released_by)) between 1 and 80),
  check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists sessions_one_active_per_stand
  on private.sessions (stand_code) where ended_at is null;
create index if not exists sessions_recent_history
  on private.sessions (ended_at desc) where ended_at is not null;

create table if not exists private.release_requests (
  id bigint generated always as identity primary key,
  stand_code text not null check (stand_code in ('AAV', 'ALP', 'OVD', 'TVE')),
  requester_name text not null check (char_length(btrim(requester_name)) between 1 and 80),
  needed_by timestamptz not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 300),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Defense in depth: browser roles have no policies on these private tables.
-- The five validated SECURITY DEFINER functions remain the only entry points.
alter table private.team_config enable row level security;
alter table private.sessions enable row level security;
alter table private.release_requests enable row level security;

create unique index if not exists one_open_release_request_per_stand
  on private.release_requests (stand_code) where resolved_at is null;

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

create or replace function private.require_team_code(p_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if p_code is null
     or char_length(p_code) > 128
     or not exists (
       select 1 from private.team_config
       where id = 1 and code_hash = sha256(convert_to(p_code, 'UTF8'))
     ) then
    raise exception using message = 'Неверный код команды', errcode = 'P0001';
  end if;
end;
$$;

revoke all on function private.require_team_code(text) from public, anon, authenticated;

create or replace function private.get_tracker_state(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  perform private.require_team_code(p_code);
  return jsonb_build_object(
    'server_time', now(),
    'active', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.stand_code)
      from private.sessions s where s.ended_at is null
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.needed_by)
      from private.release_requests r where r.resolved_at is null
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.ended_at desc)
      from (
        select * from private.sessions
        where ended_at is not null
        order by ended_at desc limit 40
      ) h
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function private.claim_stand(
  p_code text, p_stand text, p_name text,
  p_purpose text default '', p_planned_end timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  perform private.require_team_code(p_code);
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then
    raise exception 'Неизвестный стенд';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Укажите имя (до 80 символов)';
  end if;
  if char_length(coalesce(p_purpose, '')) > 200 then
    raise exception 'Описание слишком длинное';
  end if;
  if p_planned_end is not null and p_planned_end <= now() then
    raise exception 'Время освобождения должно быть в будущем';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_stand));
  if exists (select 1 from private.sessions where stand_code = p_stand and ended_at is null) then
    raise exception 'Стенд уже занят';
  end if;
  insert into private.sessions (stand_code, occupant_name, purpose, planned_end_at)
  values (p_stand, btrim(p_name), btrim(coalesce(p_purpose, '')), p_planned_end);
  return private.get_tracker_state(p_code);
end;
$$;

create or replace function private.release_stand(p_code text, p_stand text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  perform private.require_team_code(p_code);
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then
    raise exception 'Неизвестный стенд';
  end if;
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 80 then
    raise exception 'Укажите имя (до 80 символов)';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_stand));
  update private.sessions
  set ended_at = now(), released_by = btrim(p_actor)
  where stand_code = p_stand and ended_at is null;
  if not found then
    raise exception 'Стенд уже свободен';
  end if;
  update private.release_requests
  set resolved_at = now()
  where stand_code = p_stand and resolved_at is null;
  return private.get_tracker_state(p_code);
end;
$$;

create or replace function private.request_release(
  p_code text, p_stand text, p_name text,
  p_needed_by timestamptz, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  perform private.require_team_code(p_code);
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then
    raise exception 'Неизвестный стенд';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Укажите имя (до 80 символов)';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 300 then
    raise exception 'Укажите причину (до 300 символов)';
  end if;
  if p_needed_by is null or p_needed_by <= now() then
    raise exception 'Укажите будущее время';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_stand));
  if not exists (select 1 from private.sessions where stand_code = p_stand and ended_at is null) then
    raise exception 'Стенд уже свободен';
  end if;
  if exists (select 1 from private.release_requests where stand_code = p_stand and resolved_at is null) then
    raise exception 'Запрос на освобождение уже есть';
  end if;
  insert into private.release_requests (stand_code, requester_name, needed_by, reason)
  values (p_stand, btrim(p_name), p_needed_by, btrim(p_reason));
  return private.get_tracker_state(p_code);
end;
$$;

create or replace function private.withdraw_release_request(p_code text, p_stand text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  perform private.require_team_code(p_code);
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then
    raise exception 'Неизвестный стенд';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_stand));
  update private.release_requests
  set resolved_at = now()
  where stand_code = p_stand and resolved_at is null;
  if not found then
    raise exception 'Активного запроса нет';
  end if;
  return private.get_tracker_state(p_code);
end;
$$;

-- Public API wrappers have no elevated privileges. The implementation lives in
-- an unexposed schema, validates the shared code, and owns the private tables.
create or replace function public.get_tracker_state(p_code text)
returns jsonb language sql security invoker
set search_path = pg_catalog, private
as $$ select private.get_tracker_state(p_code) $$;

create or replace function public.claim_stand(
  p_code text, p_stand text, p_name text,
  p_purpose text default '', p_planned_end timestamptz default null
)
returns jsonb language sql security invoker
set search_path = pg_catalog, private
as $$ select private.claim_stand(p_code, p_stand, p_name, p_purpose, p_planned_end) $$;

create or replace function public.release_stand(p_code text, p_stand text, p_actor text)
returns jsonb language sql security invoker
set search_path = pg_catalog, private
as $$ select private.release_stand(p_code, p_stand, p_actor) $$;

create or replace function public.request_release(
  p_code text, p_stand text, p_name text,
  p_needed_by timestamptz, p_reason text
)
returns jsonb language sql security invoker
set search_path = pg_catalog, private
as $$ select private.request_release(p_code, p_stand, p_name, p_needed_by, p_reason) $$;

create or replace function public.withdraw_release_request(p_code text, p_stand text)
returns jsonb language sql security invoker
set search_path = pg_catalog, private
as $$ select private.withdraw_release_request(p_code, p_stand) $$;

revoke all on all functions in schema private from public, anon, authenticated;
revoke usage on schema private from anon, authenticated;

revoke all on function public.get_tracker_state(text) from public;
revoke all on function public.claim_stand(text, text, text, text, timestamptz) from public;
revoke all on function public.release_stand(text, text, text) from public;
revoke all on function public.request_release(text, text, text, timestamptz, text) from public;
revoke all on function public.withdraw_release_request(text, text) from public;

-- Legacy shared-code RPCs remain defined for historical compatibility but are
-- intentionally inaccessible to browser roles. Telegram-only API is the entrypoint.
