-- A session belongs to the Telegram identity that obtained it, not merely to
-- the mutable team-member row. Existing valid sessions keep working.
alter table private.bot_sessions add column telegram_user_id bigint;

update private.bot_sessions s
set telegram_user_id = m.telegram_user_id
from private.members m
where m.id = s.member_id;

alter table private.bot_sessions alter column telegram_user_id set not null;

create or replace function private.bot_login_complete(
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
  select * into v_member from private.members where id = v_challenge.member_id;
  if not found or v_member.telegram_user_id is null then
    raise exception 'Профиль не подключён';
  end if;
  update private.bot_login_challenges set consumed_at = now() where start_hash = p_start_hash;
  insert into private.bot_sessions (token_hash, member_id, telegram_user_id)
  values (p_session_hash, v_member.id, v_member.telegram_user_id)
  returning expires_at into v_session_expires_at;
  return jsonb_build_object(
    'status', 'ok', 'expires_at', v_session_expires_at,
    'profile', jsonb_build_object('id', v_member.id, 'name', v_member.full_name, 'username', v_member.telegram_username)
  );
end;
$$;

create or replace function private.bot_session_resolve(p_token_hash text)
returns jsonb language sql security definer
set search_path = pg_catalog, private
as $$
  select jsonb_build_object('id', m.id, 'name', m.full_name, 'username', m.telegram_username, 'telegram_user_id', m.telegram_user_id)
  from private.bot_sessions s join private.members m on m.id = s.member_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
    and s.telegram_user_id = m.telegram_user_id
$$;
