-- Close the shared-code impersonation path. Keep sessions and history intact.
revoke usage on schema private from anon, authenticated;

revoke all on function private.get_tracker_state(text) from public, anon, authenticated;
revoke all on function private.claim_stand(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function private.claim_stand_with_priority(text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function private.release_stand(text, text, text) from public, anon, authenticated;
revoke all on function private.request_release(text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function private.withdraw_release_request(text, text) from public, anon, authenticated;

revoke all on function public.get_tracker_state(text) from public, anon, authenticated;
revoke all on function public.claim_stand(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_stand_with_priority(text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.release_stand(text, text, text) from public, anon, authenticated;
revoke all on function public.request_release(text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.withdraw_release_request(text, text) from public, anon, authenticated;
