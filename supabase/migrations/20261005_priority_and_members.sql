-- Additive migration: preserve every existing session and release request.
alter table private.sessions
  add column if not exists priority text not null default 'normal';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'private.sessions'::regclass
      and conname = 'sessions_priority_check'
  ) then
    alter table private.sessions
      add constraint sessions_priority_check
      check (priority in ('low', 'normal', 'high'));
  end if;
end $$;

create table if not exists private.members (
  id bigint generated always as identity primary key,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 80),
  telegram_username text not null check (telegram_username ~ '^[A-Za-z0-9_]{5,32}$'),
  telegram_user_id bigint unique,
  created_at timestamptz not null default now()
);

create unique index if not exists members_telegram_username_lower
  on private.members (lower(telegram_username));

insert into private.members (full_name, telegram_username)
values
  ('Глеб Сорвачев', 'crysingzz'),
  ('Илья Скворцов', 'fgtuioth'),
  ('Кирилл Долматов', 'kirill_dolmatov'),
  ('Артём Попов', 'appetrovich1'),
  ('Иван Черепенников', 'ivanya13'),
  ('Иван Штыров', 'Shtyroffid')
on conflict ((lower(telegram_username))) do update
  set full_name = excluded.full_name;

alter table private.members enable row level security;
revoke all on private.members from public, anon, authenticated;
revoke all on sequence private.members_id_seq from public, anon, authenticated;

create or replace function private.claim_stand_with_priority(
  p_code text, p_stand text, p_name text,
  p_purpose text, p_planned_end timestamptz, p_priority text
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
  if p_priority is null or p_priority not in ('low', 'normal', 'high') then
    raise exception 'Выберите приоритет задачи';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_stand));
  if exists (select 1 from private.sessions where stand_code = p_stand and ended_at is null) then
    raise exception 'Стенд уже занят';
  end if;
  insert into private.sessions (stand_code, occupant_name, purpose, planned_end_at, priority)
  values (p_stand, btrim(p_name), btrim(coalesce(p_purpose, '')), p_planned_end, p_priority);
  return private.get_tracker_state(p_code);
end;
$$;

revoke all on function private.claim_stand_with_priority(text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function private.claim_stand_with_priority(text, text, text, text, timestamptz, text) to anon, authenticated;

create or replace function public.claim_stand_with_priority(
  p_code text, p_stand text, p_name text,
  p_purpose text, p_planned_end timestamptz, p_priority text
)
returns jsonb language sql security invoker
set search_path = pg_catalog, private
as $$ select private.claim_stand_with_priority(p_code, p_stand, p_name, p_purpose, p_planned_end, p_priority) $$;

revoke all on function public.claim_stand_with_priority(text, text, text, text, timestamptz, text) from public;
grant execute on function public.claim_stand_with_priority(text, text, text, text, timestamptz, text) to anon, authenticated;
