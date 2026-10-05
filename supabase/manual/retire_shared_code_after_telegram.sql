-- Run ONLY after every teammate can sign in through Telegram and after the
-- GitHub Pages UI no longer offers shared-code access. This intentionally
-- disables the legacy browser API; it is not part of the automatic migrations.
revoke execute on function public.get_tracker_state(text) from anon, authenticated;
revoke execute on function public.claim_stand(text, text, text, text, timestamptz) from anon, authenticated;
revoke execute on function public.claim_stand_with_priority(text, text, text, text, timestamptz, text) from anon, authenticated;
revoke execute on function public.release_stand(text, text, text) from anon, authenticated;
revoke execute on function public.request_release(text, text, text, timestamptz, text) from anon, authenticated;
revoke execute on function public.withdraw_release_request(text, text) from anon, authenticated;

revoke execute on function private.get_tracker_state(text) from anon, authenticated;
revoke execute on function private.claim_stand(text, text, text, text, timestamptz) from anon, authenticated;
revoke execute on function private.claim_stand_with_priority(text, text, text, text, timestamptz, text) from anon, authenticated;
revoke execute on function private.release_stand(text, text, text) from anon, authenticated;
revoke execute on function private.request_release(text, text, text, timestamptz, text) from anon, authenticated;
revoke execute on function private.withdraw_release_request(text, text) from anon, authenticated;
