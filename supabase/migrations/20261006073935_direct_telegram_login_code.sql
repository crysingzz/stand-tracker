-- Request a code from the site. Only the Edge Function sees the Telegram chat ID;
-- the browser receives two random challenge tokens and never receives the code.
alter table private.bot_login_challenges
  add column requested_username text
  check (requested_username is null or requested_username ~ '^[a-z0-9_]{5,32}$');

create index bot_login_challenges_requested_username_created_at_idx
  on private.bot_login_challenges (requested_username, created_at desc)
  where requested_username is not null;

create function private.bot_login_request_code(
  p_start_hash text, p_browser_hash text, p_code_hash text, p_username text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_username text := lower(regexp_replace(btrim(p_username), '^@', ''));
  v_member private.members%rowtype;
  v_last_created timestamptz;
  v_expires_at timestamptz;
begin
  if p_start_hash !~ '^[0-9a-f]{64}$' or p_browser_hash !~ '^[0-9a-f]{64}$' or
     p_code_hash !~ '^[0-9a-f]{64}$' or coalesce(v_username, '') !~ '^[a-z0-9_]{5,32}$' then
    raise exception 'Неверный запрос на вход';
  end if;

  -- A row lock makes the per-profile cooldown atomic across Edge isolates.
  select * into v_member from private.members
  where lower(telegram_username) = v_username for update;
  if not found then raise exception 'Профиль команды не найден. Проверьте выбранный аккаунт'; end if;

  delete from private.bot_login_challenges where expires_at < now() - interval '1 day';
  delete from private.bot_sessions where expires_at < now() - interval '1 day';
  if (select count(*) from private.bot_login_challenges where created_at > now() - interval '1 minute') >= 120 then
    raise exception 'Слишком много попыток входа. Попробуйте позже';
  end if;

  select max(created_at) into v_last_created from private.bot_login_challenges
  where requested_username = v_username and created_at > now() - interval '30 seconds';
  if v_last_created is not null then
    return jsonb_build_object('status', 'cooldown',
      'retry_after', greatest(1, ceil(extract(epoch from (v_last_created + interval '30 seconds' - now())))::integer));
  end if;

  update private.bot_login_challenges set consumed_at = now()
  where requested_username = v_username and consumed_at is null and expires_at > now();

  insert into private.bot_login_challenges
    (start_hash, browser_hash, requested_username, member_id, telegram_user_id, code_hash)
  values
    (p_start_hash, p_browser_hash, v_username,
     case when v_member.telegram_user_id is not null then v_member.id else null end,
     v_member.telegram_user_id,
     case when v_member.telegram_user_id is not null then p_code_hash else null end)
  returning expires_at into v_expires_at;

  return jsonb_build_object(
    'status', case when v_member.telegram_user_id is null then 'needs_start' else 'send' end,
    'chat_id', v_member.telegram_user_id,
    'expires_at', v_expires_at
  );
end;
$$;

-- A plain /start links the sender's own Telegram ID and finds only their own
-- most recent pending browser challenge. The code hash is set by bot_login_start.
create function private.bot_login_pending_for_telegram(
  p_telegram_user_id bigint, p_telegram_username text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_member jsonb;
  v_start_hash text;
begin
  v_member := private.telegram_resolve_member(p_telegram_user_id, p_telegram_username);
  select start_hash into v_start_hash from private.bot_login_challenges
  where requested_username = lower(v_member->>'username')
    and code_hash is null and consumed_at is null and expires_at > now()
    and attempts < 5
  order by created_at desc limit 1;
  if v_start_hash is null then
    return jsonb_build_object('status', 'connected', 'name', v_member->>'name');
  end if;
  return jsonb_build_object('status', 'pending', 'start_hash', v_start_hash, 'name', v_member->>'name');
end;
$$;

-- A duplicate /start must not replace a code that was already sent to the
-- same Telegram account while a second webhook invocation was waiting.
create or replace function private.bot_login_start(
  p_start_hash text, p_telegram_user_id bigint, p_telegram_username text, p_code_hash text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_challenge private.bot_login_challenges%rowtype;
  v_member jsonb;
begin
  if p_start_hash !~ '^[0-9a-f]{64}$' or p_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_challenge from private.bot_login_challenges
  where start_hash = p_start_hash for update;
  if not found or v_challenge.expires_at <= now() or v_challenge.consumed_at is not null or v_challenge.attempts >= 5 then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_challenge.telegram_user_id is not null and v_challenge.telegram_user_id <> p_telegram_user_id then
    return jsonb_build_object('status', 'claimed');
  end if;
  if v_challenge.requested_username is not null and v_challenge.code_hash is not null then
    return jsonb_build_object('status', 'already_sent');
  end if;
  v_member := private.telegram_resolve_member(p_telegram_user_id, p_telegram_username);
  update private.bot_login_challenges
  set member_id = (v_member->>'id')::bigint, telegram_user_id = p_telegram_user_id,
      code_hash = p_code_hash, attempts = 0
  where start_hash = p_start_hash;
  return jsonb_build_object('status', 'ready', 'name', v_member->>'name');
end;
$$;

create function public.bot_login_request_code(
  p_start_hash text, p_browser_hash text, p_code_hash text, p_username text
)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.bot_login_request_code(p_start_hash, p_browser_hash, p_code_hash, p_username) $$;

create function public.bot_login_pending_for_telegram(
  p_telegram_user_id bigint, p_telegram_username text
)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.bot_login_pending_for_telegram(p_telegram_user_id, p_telegram_username) $$;

revoke all on function private.bot_login_request_code(text, text, text, text) from public, anon, authenticated;
revoke all on function private.bot_login_pending_for_telegram(bigint, text) from public, anon, authenticated;
revoke all on function public.bot_login_request_code(text, text, text, text) from public, anon, authenticated;
revoke all on function public.bot_login_pending_for_telegram(bigint, text) from public, anon, authenticated;
grant execute on function private.bot_login_request_code(text, text, text, text) to service_role;
grant execute on function private.bot_login_pending_for_telegram(bigint, text) to service_role;
grant execute on function public.bot_login_request_code(text, text, text, text) to service_role;
grant execute on function public.bot_login_pending_for_telegram(bigint, text) to service_role;
