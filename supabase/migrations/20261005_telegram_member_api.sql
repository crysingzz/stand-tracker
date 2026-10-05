-- Server-only API for Telegram-verified members. Existing shared-code API stays
-- available during the transition; revoke it after Telegram onboarding.
alter table private.sessions
  add column if not exists occupant_member_id bigint references private.members(id);
alter table private.release_requests
  add column if not exists requester_member_id bigint references private.members(id);

create or replace function private.telegram_resolve_member(
  p_telegram_user_id bigint, p_telegram_username text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_member private.members%rowtype;
  v_newly_linked boolean := false;
begin
  if p_telegram_user_id is null or p_telegram_user_id <= 0 then
    raise exception 'Некорректный Telegram ID';
  end if;

  select * into v_member from private.members
  where telegram_user_id = p_telegram_user_id for update;
  if not found then
    if p_telegram_username is null then
      raise exception 'Нужен Telegram @username из списка команды';
    end if;
    select * into v_member from private.members
    where lower(telegram_username) = lower(p_telegram_username) for update;
    if not found then
      raise exception 'Ваш Telegram @username не добавлен в команду';
    end if;
    if v_member.telegram_user_id is not null then
      raise exception 'Этот профиль уже связан с другим Telegram-аккаунтом';
    end if;
    update private.members set telegram_user_id = p_telegram_user_id
    where id = v_member.id returning * into v_member;
    v_newly_linked := true;
  end if;

  return jsonb_build_object(
    'id', v_member.id,
    'name', v_member.full_name,
    'username', v_member.telegram_username,
    'newly_linked', v_newly_linked
  );
end;
$$;

create or replace function private.member_state(p_member_id bigint)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_member private.members%rowtype;
begin
  select * into v_member from private.members where id = p_member_id;
  if not found or v_member.telegram_user_id is null then
    raise exception 'Профиль не подключён';
  end if;
  return jsonb_build_object(
    'server_time', now(),
    'profile', jsonb_build_object('id', v_member.id, 'name', v_member.full_name, 'username', v_member.telegram_username),
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
      from (select * from private.sessions where ended_at is not null order by ended_at desc limit 40) h
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function private.member_claim(
  p_member_id bigint, p_stand text, p_purpose text,
  p_planned_end timestamptz, p_priority text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_name text;
begin
  select full_name into v_name from private.members where id = p_member_id and telegram_user_id is not null;
  if not found then raise exception 'Профиль не подключён'; end if;
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then raise exception 'Неизвестный стенд'; end if;
  if char_length(coalesce(p_purpose, '')) > 200 then raise exception 'Описание слишком длинное'; end if;
  if p_planned_end is not null and p_planned_end <= now() then raise exception 'Время освобождения должно быть в будущем'; end if;
  if p_priority is null or p_priority not in ('low', 'normal', 'high') then raise exception 'Выберите приоритет задачи'; end if;

  perform pg_advisory_xact_lock(hashtext(p_stand));
  if exists (select 1 from private.sessions where stand_code = p_stand and ended_at is null) then
    raise exception 'Стенд уже занят';
  end if;
  insert into private.sessions (stand_code, occupant_name, occupant_member_id, purpose, planned_end_at, priority)
  values (p_stand, v_name, p_member_id, btrim(coalesce(p_purpose, '')), p_planned_end, p_priority);
  return jsonb_build_object('state', private.member_state(p_member_id));
end;
$$;

create or replace function private.member_request_release(
  p_member_id bigint, p_stand text, p_needed_by timestamptz, p_reason text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_name text;
  v_occupant_member_id bigint;
  v_recipient_id bigint;
begin
  select full_name into v_name from private.members where id = p_member_id and telegram_user_id is not null;
  if not found then raise exception 'Профиль не подключён'; end if;
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then raise exception 'Неизвестный стенд'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 300 then raise exception 'Укажите причину (до 300 символов)'; end if;
  if p_needed_by is null or p_needed_by <= now() then raise exception 'Укажите будущее время'; end if;

  perform pg_advisory_xact_lock(hashtext(p_stand));
  select occupant_member_id into v_occupant_member_id from private.sessions
  where stand_code = p_stand and ended_at is null;
  if not found then raise exception 'Стенд уже свободен'; end if;
  if v_occupant_member_id = p_member_id then raise exception 'Нельзя запросить освобождение своего стенда'; end if;
  if exists (select 1 from private.release_requests where stand_code = p_stand and resolved_at is null) then
    raise exception 'Запрос на освобождение уже есть';
  end if;
  insert into private.release_requests (stand_code, requester_name, requester_member_id, needed_by, reason)
  values (p_stand, v_name, p_member_id, p_needed_by, btrim(p_reason));
  select telegram_user_id into v_recipient_id from private.members where id = v_occupant_member_id;
  return jsonb_build_object('state', private.member_state(p_member_id), 'recipient_chat_id', v_recipient_id);
end;
$$;

create or replace function private.member_release(p_member_id bigint, p_stand text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_name text;
  v_occupant_member_id bigint;
  v_requester_member_id bigint;
  v_recipient_id bigint;
begin
  select full_name into v_name from private.members where id = p_member_id and telegram_user_id is not null;
  if not found then raise exception 'Профиль не подключён'; end if;
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then raise exception 'Неизвестный стенд'; end if;

  perform pg_advisory_xact_lock(hashtext(p_stand));
  select occupant_member_id into v_occupant_member_id from private.sessions
  where stand_code = p_stand and ended_at is null;
  if not found then raise exception 'Стенд уже свободен'; end if;
  if v_occupant_member_id is not null and v_occupant_member_id <> p_member_id then
    raise exception 'Освободить стенд может только занявший его участник';
  end if;
  select requester_member_id into v_requester_member_id from private.release_requests
  where stand_code = p_stand and resolved_at is null;
  update private.sessions set ended_at = now(), released_by = v_name
  where stand_code = p_stand and ended_at is null;
  update private.release_requests set resolved_at = now()
  where stand_code = p_stand and resolved_at is null;
  select telegram_user_id into v_recipient_id from private.members where id = v_requester_member_id;
  return jsonb_build_object('state', private.member_state(p_member_id), 'recipient_chat_id', v_recipient_id);
end;
$$;

create or replace function private.member_withdraw_release_request(p_member_id bigint, p_stand text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_requester_member_id bigint;
  v_occupant_member_id bigint;
  v_recipient_id bigint;
begin
  if not exists (select 1 from private.members where id = p_member_id and telegram_user_id is not null) then
    raise exception 'Профиль не подключён';
  end if;
  if p_stand not in ('AAV', 'ALP', 'OVD', 'TVE') then raise exception 'Неизвестный стенд'; end if;
  perform pg_advisory_xact_lock(hashtext(p_stand));
  select requester_member_id into v_requester_member_id from private.release_requests
  where stand_code = p_stand and resolved_at is null;
  if not found then raise exception 'Активного запроса нет'; end if;
  if v_requester_member_id is not null and v_requester_member_id <> p_member_id then
    raise exception 'Снять запрос может только его автор';
  end if;
  update private.release_requests set resolved_at = now()
  where stand_code = p_stand and resolved_at is null;
  select occupant_member_id into v_occupant_member_id from private.sessions
  where stand_code = p_stand and ended_at is null;
  select telegram_user_id into v_recipient_id from private.members where id = v_occupant_member_id;
  return jsonb_build_object('state', private.member_state(p_member_id), 'recipient_chat_id', v_recipient_id);
end;
$$;

create or replace function public.telegram_resolve_member(p_telegram_user_id bigint, p_telegram_username text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.telegram_resolve_member(p_telegram_user_id, p_telegram_username) $$;
create or replace function public.member_state(p_member_id bigint)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.member_state(p_member_id) $$;
create or replace function public.member_claim(p_member_id bigint, p_stand text, p_purpose text, p_planned_end timestamptz, p_priority text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.member_claim(p_member_id, p_stand, p_purpose, p_planned_end, p_priority) $$;
create or replace function public.member_request_release(p_member_id bigint, p_stand text, p_needed_by timestamptz, p_reason text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.member_request_release(p_member_id, p_stand, p_needed_by, p_reason) $$;
create or replace function public.member_release(p_member_id bigint, p_stand text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.member_release(p_member_id, p_stand) $$;
create or replace function public.member_withdraw_release_request(p_member_id bigint, p_stand text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.member_withdraw_release_request(p_member_id, p_stand) $$;

revoke all on function private.telegram_resolve_member(bigint, text) from public, anon, authenticated;
revoke all on function private.member_state(bigint) from public, anon, authenticated;
revoke all on function private.member_claim(bigint, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function private.member_request_release(bigint, text, timestamptz, text) from public, anon, authenticated;
revoke all on function private.member_release(bigint, text) from public, anon, authenticated;
revoke all on function private.member_withdraw_release_request(bigint, text) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.telegram_resolve_member(bigint, text) to service_role;
grant execute on function private.member_state(bigint) to service_role;
grant execute on function private.member_claim(bigint, text, text, timestamptz, text) to service_role;
grant execute on function private.member_request_release(bigint, text, timestamptz, text) to service_role;
grant execute on function private.member_release(bigint, text) to service_role;
grant execute on function private.member_withdraw_release_request(bigint, text) to service_role;

revoke all on function public.telegram_resolve_member(bigint, text) from public, anon, authenticated;
revoke all on function public.member_state(bigint) from public, anon, authenticated;
revoke all on function public.member_claim(bigint, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.member_request_release(bigint, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.member_release(bigint, text) from public, anon, authenticated;
revoke all on function public.member_withdraw_release_request(bigint, text) from public, anon, authenticated;
grant execute on function public.telegram_resolve_member(bigint, text) to service_role;
grant execute on function public.member_state(bigint) to service_role;
grant execute on function public.member_claim(bigint, text, text, timestamptz, text) to service_role;
grant execute on function public.member_request_release(bigint, text, timestamptz, text) to service_role;
grant execute on function public.member_release(bigint, text) to service_role;
grant execute on function public.member_withdraw_release_request(bigint, text) to service_role;
