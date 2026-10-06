-- Run against a migrated database. All test records are rolled back.
begin;

do $test$
declare
  v_send jsonb;
  v_cool jsonb;
  v_pending jsonb;
  v_ready jsonb;
  v_complete jsonb;
begin
  if has_function_privilege('anon', 'public.bot_login_request_code(text,text,text,text)', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.bot_login_request_code(text,text,text,text)', 'EXECUTE') or
     has_function_privilege('anon', 'public.bot_login_pending_for_telegram(bigint,text)', 'EXECUTE') then
    raise exception 'Browser roles can call server-only login functions';
  end if;

  insert into private.members(full_name, telegram_username, telegram_user_id)
  values ('Codex linked test', 'codexlinked', 900000000001);
  v_send := private.bot_login_request_code(repeat('a', 64), repeat('b', 64), repeat('c', 64), '@CODEXLINKED');
  if v_send->>'status' <> 'send' or (v_send->>'chat_id')::bigint <> 900000000001 then
    raise exception 'Bound member did not receive a direct-code target';
  end if;
  v_cool := private.bot_login_request_code(repeat('d', 64), repeat('e', 64), repeat('f', 64), 'codexlinked');
  if v_cool->>'status' <> 'cooldown' then raise exception 'Per-member cooldown failed'; end if;
  v_ready := private.bot_login_start(repeat('a', 64), 900000000002, 'codexlinked', repeat('0', 64));
  if v_ready->>'status' <> 'claimed' then raise exception 'Foreign Telegram ID was accepted'; end if;
  v_complete := private.bot_login_complete(repeat('a', 64), repeat('e', 64), repeat('c', 64), repeat('f', 64));
  if v_complete->>'status' <> 'invalid' then raise exception 'Foreign browser token was accepted'; end if;
  v_complete := private.bot_login_complete(repeat('a', 64), repeat('b', 64), repeat('c', 64), repeat('f', 64));
  if v_complete->>'status' <> 'ok' then raise exception 'Bound member could not complete login'; end if;
  update private.members set telegram_user_id = 900000000004 where telegram_username = 'codexlinked';
  if private.bot_session_resolve(repeat('f', 64)) is not null then
    raise exception 'Rebound Telegram account kept an old site session';
  end if;

  insert into private.members(full_name, telegram_username)
  values ('Codex unlinked test', 'codexunlinked');
  v_send := private.bot_login_request_code(repeat('1', 64), repeat('2', 64), repeat('3', 64), 'codexunlinked');
  if v_send->>'status' <> 'needs_start' or v_send->>'chat_id' is not null then
    raise exception 'First-time challenge was not pending';
  end if;
  v_pending := private.bot_login_pending_for_telegram(900000000003, 'codexunlinked');
  if v_pending->>'status' <> 'pending' or v_pending->>'start_hash' <> repeat('1', 64) then
    raise exception 'Plain Start did not find the matching challenge';
  end if;
  v_ready := private.bot_login_start(repeat('1', 64), 900000000003, 'codexunlinked', repeat('3', 64));
  if v_ready->>'status' <> 'ready' then raise exception 'Plain Start did not prepare the code'; end if;
  v_ready := private.bot_login_start(repeat('1', 64), 900000000003, 'codexunlinked', repeat('9', 64));
  if v_ready->>'status' <> 'already_sent' then raise exception 'Duplicate Start replaced an issued code'; end if;
  v_complete := private.bot_login_complete(repeat('1', 64), repeat('2', 64), repeat('3', 64), repeat('4', 64));
  if v_complete->>'status' <> 'ok' then raise exception 'First-time member could not complete login'; end if;
  v_complete := private.bot_login_complete(repeat('1', 64), repeat('2', 64), repeat('3', 64), repeat('5', 64));
  if v_complete->>'status' <> 'expired' then raise exception 'One-time code was reused'; end if;
end;
$test$;

rollback;
select 'PASS direct Telegram login SQL' as result;
