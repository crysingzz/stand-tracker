-- Browser-free Telegram login: one-time bot code and revocable opaque sessions.
create table private.bot_login_challenges (
  start_hash text primary key check (start_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null unique check (browser_hash ~ '^[0-9a-f]{64}$'),
  code_hash text check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  member_id bigint references private.members(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz,
  check ((code_hash is null) = (member_id is null))
);
create index bot_login_challenges_expires_at_idx on private.bot_login_challenges (expires_at);
create index bot_login_challenges_created_at_idx on private.bot_login_challenges (created_at);
alter table private.bot_login_challenges enable row level security;

create table private.bot_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  member_id bigint not null references private.members(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours'),
  revoked_at timestamptz
);
create index bot_sessions_expires_at_idx on private.bot_sessions (expires_at);
create index bot_sessions_member_id_idx on private.bot_sessions (member_id);
alter table private.bot_sessions enable row level security;

revoke all on private.bot_login_challenges, private.bot_sessions from public, anon, authenticated;

create function private.bot_login_begin(p_start_hash text, p_browser_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_expires_at timestamptz;
begin
  if p_start_hash !~ '^[0-9a-f]{64}$' or p_browser_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Неверный запрос на вход';
  end if;
  delete from private.bot_login_challenges where expires_at < now() - interval '1 day';
  delete from private.bot_sessions where expires_at < now() - interval '1 day';
  if (select count(*) from private.bot_login_challenges where created_at > now() - interval '1 minute') >= 120 then
    raise exception 'Слишком много попыток входа. Попробуйте позже';
  end if;
  insert into private.bot_login_challenges (start_hash, browser_hash)
  values (p_start_hash, p_browser_hash)
  returning expires_at into v_expires_at;
  return jsonb_build_object('expires_at', v_expires_at);
end;
$$;

create function private.bot_login_start(
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
  if v_challenge.member_id is not null and
     (select telegram_user_id from private.members where id = v_challenge.member_id) is distinct from p_telegram_user_id then
    return jsonb_build_object('status', 'claimed');
  end if;
  v_member := private.telegram_resolve_member(p_telegram_user_id, p_telegram_username);
  update private.bot_login_challenges
  set member_id = (v_member->>'id')::bigint, code_hash = p_code_hash, attempts = 0
  where start_hash = p_start_hash;
  return jsonb_build_object('status', 'ready', 'name', v_member->>'name');
end;
$$;

create function private.bot_login_complete(
  p_start_hash text, p_browser_hash text, p_code_hash text, p_session_hash text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  v_challenge private.bot_login_challenges%rowtype;
  v_member private.members%rowtype;
  v_session_expires_at timestamptz;
begin
  if p_start_hash !~ '^[0-9a-f]{64}$' or p_browser_hash !~ '^[0-9a-f]{64}$' or
     p_code_hash !~ '^[0-9a-f]{64}$' or p_session_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_challenge from private.bot_login_challenges
  where start_hash = p_start_hash and browser_hash = p_browser_hash for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if v_challenge.expires_at <= now() or v_challenge.consumed_at is not null then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_challenge.attempts >= 5 then return jsonb_build_object('status', 'locked'); end if;
  if v_challenge.code_hash is null or v_challenge.member_id is null then
    return jsonb_build_object('status', 'pending');
  end if;
  if v_challenge.code_hash <> p_code_hash then
    update private.bot_login_challenges set attempts = attempts + 1 where start_hash = p_start_hash;
    if v_challenge.attempts = 4 then return jsonb_build_object('status', 'locked'); end if;
    return jsonb_build_object('status', 'wrong', 'remaining', 4 - v_challenge.attempts);
  end if;
  update private.bot_login_challenges set consumed_at = now() where start_hash = p_start_hash;
  insert into private.bot_sessions (token_hash, member_id)
  values (p_session_hash, v_challenge.member_id)
  returning expires_at into v_session_expires_at;
  select * into v_member from private.members where id = v_challenge.member_id;
  return jsonb_build_object(
    'status', 'ok', 'expires_at', v_session_expires_at,
    'profile', jsonb_build_object('id', v_member.id, 'name', v_member.full_name, 'username', v_member.telegram_username)
  );
end;
$$;

create function private.bot_session_resolve(p_token_hash text)
returns jsonb language sql security definer
set search_path = pg_catalog, private
as $$
  select jsonb_build_object('id', m.id, 'name', m.full_name, 'username', m.telegram_username, 'telegram_user_id', m.telegram_user_id)
  from private.bot_sessions s join private.members m on m.id = s.member_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
    and m.telegram_user_id is not null
$$;

create function private.bot_session_revoke(p_token_hash text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, private
as $$
begin
  update private.bot_sessions set revoked_at = now()
  where token_hash = p_token_hash and revoked_at is null;
  return found;
end;
$$;

create function public.bot_login_begin(p_start_hash text, p_browser_hash text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.bot_login_begin(p_start_hash, p_browser_hash) $$;
create function public.bot_login_start(p_start_hash text, p_telegram_user_id bigint, p_telegram_username text, p_code_hash text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.bot_login_start(p_start_hash, p_telegram_user_id, p_telegram_username, p_code_hash) $$;
create function public.bot_login_complete(p_start_hash text, p_browser_hash text, p_code_hash text, p_session_hash text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.bot_login_complete(p_start_hash, p_browser_hash, p_code_hash, p_session_hash) $$;
create function public.bot_session_resolve(p_token_hash text)
returns jsonb language sql security invoker set search_path = pg_catalog, private
as $$ select private.bot_session_resolve(p_token_hash) $$;
create function public.bot_session_revoke(p_token_hash text)
returns boolean language sql security invoker set search_path = pg_catalog, private
as $$ select private.bot_session_revoke(p_token_hash) $$;

revoke all on function private.bot_login_begin(text, text) from public, anon, authenticated;
revoke all on function private.bot_login_start(text, bigint, text, text) from public, anon, authenticated;
revoke all on function private.bot_login_complete(text, text, text, text) from public, anon, authenticated;
revoke all on function private.bot_session_resolve(text) from public, anon, authenticated;
revoke all on function private.bot_session_revoke(text) from public, anon, authenticated;
revoke all on function public.bot_login_begin(text, text) from public, anon, authenticated;
revoke all on function public.bot_login_start(text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.bot_login_complete(text, text, text, text) from public, anon, authenticated;
revoke all on function public.bot_session_resolve(text) from public, anon, authenticated;
revoke all on function public.bot_session_revoke(text) from public, anon, authenticated;

grant execute on function private.bot_login_begin(text, text) to service_role;
grant execute on function private.bot_login_start(text, bigint, text, text) to service_role;
grant execute on function private.bot_login_complete(text, text, text, text) to service_role;
grant execute on function private.bot_session_resolve(text) to service_role;
grant execute on function private.bot_session_revoke(text) to service_role;
grant execute on function public.bot_login_begin(text, text) to service_role;
grant execute on function public.bot_login_start(text, bigint, text, text) to service_role;
grant execute on function public.bot_login_complete(text, text, text, text) to service_role;
grant execute on function public.bot_session_resolve(text) to service_role;
grant execute on function public.bot_session_revoke(text) to service_role;
