-- A repeated first-login request for the same Telegram account is success,
-- including when it waited on another request binding the username row.
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
  where telegram_user_id = p_telegram_user_id;
  if not found then
    if p_telegram_username is null then
      raise exception 'Нужен Telegram @username из списка команды';
    end if;
    select * into v_member from private.members
    where lower(telegram_username) = lower(p_telegram_username) for update;
    if not found then
      raise exception 'Ваш Telegram @username не добавлен в команду';
    end if;
    if v_member.telegram_user_id is not null and v_member.telegram_user_id <> p_telegram_user_id then
      raise exception 'Этот профиль уже связан с другим Telegram-аккаунтом';
    end if;
    if v_member.telegram_user_id is null then
      update private.members set telegram_user_id = p_telegram_user_id
      where id = v_member.id returning * into v_member;
      v_newly_linked := true;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_member.id,
    'name', v_member.full_name,
    'username', v_member.telegram_username,
    'newly_linked', v_newly_linked
  );
end;
$$;

revoke all on function private.telegram_resolve_member(bigint, text) from public, anon, authenticated;
grant execute on function private.telegram_resolve_member(bigint, text) to service_role;
