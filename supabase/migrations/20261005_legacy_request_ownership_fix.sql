-- Legacy requests have no verified author, so a team member must not be able
-- to withdraw one by calling the server API directly. Releasing the stand still
-- resolves such requests through the existing member_release workflow.
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
  if v_requester_member_id is distinct from p_member_id then
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

revoke all on function private.member_withdraw_release_request(bigint, text) from public, anon, authenticated;
grant execute on function private.member_withdraw_release_request(bigint, text) to service_role;
