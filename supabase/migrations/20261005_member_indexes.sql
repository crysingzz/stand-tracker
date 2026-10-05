create index if not exists sessions_occupant_member_id_idx
  on private.sessions (occupant_member_id)
  where occupant_member_id is not null;

create index if not exists release_requests_requester_member_id_idx
  on private.release_requests (requester_member_id)
  where requester_member_id is not null;
