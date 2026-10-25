-- =====================================================================
-- CommercialBlock database setup for Supabase
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- It is safe to run more than once.
-- =====================================================================

-- ---------- Tables ----------

create table if not exists public.segments (
  id             uuid primary key default gen_random_uuid(),
  video_id       text not null check (video_id ~ '^[A-Za-z0-9_-]{6,32}$'),
  video_hash     text not null,
  start_time     numeric(8,2) not null check (start_time >= 0),
  end_time       numeric(8,2) not null,
  video_duration numeric(8,2),
  channel_id     text check (channel_id is null or length(channel_id) <= 64),
  user_hash      text not null,
  votes          integer not null default 0,
  hidden         boolean not null default false,  -- set true to remove a bad break by hand
  created_at     timestamptz not null default now(),
  constraint segment_length check (end_time - start_time >= 4 and end_time - start_time <= 900)
);

create index if not exists segments_hash_idx on public.segments (video_hash text_pattern_ops);
create index if not exists segments_user_idx on public.segments (user_hash, created_at);

create table if not exists public.votes (
  segment_id uuid not null references public.segments(id) on delete cascade,
  user_hash  text not null,
  value      smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (segment_id, user_hash)
);

create index if not exists votes_user_idx on public.votes (user_hash, created_at);

-- Add a user_hash here to block someone who submits junk.
create table if not exists public.banned_users (
  user_hash  text primary key,
  reason     text,
  created_at timestamptz not null default now()
);

-- ---------- Lock the tables down ----------
-- Nobody reads or writes the tables directly; the extension can only use the
-- three functions below.

alter table public.segments     enable row level security;
alter table public.votes        enable row level security;
alter table public.banned_users enable row level security;

revoke all on public.segments, public.votes, public.banned_users from anon, authenticated;

-- ---------- Helper ----------

create or replace function public.cb_hash(t text)
returns text
language sql
immutable
set search_path = public, pg_catalog
as $$
  select encode(sha256(convert_to(t, 'UTF8')), 'hex');
$$;

-- ---------- get_segments ----------
-- The extension sends only the first 4 characters of the recording's hash,
-- so the server never learns exactly which recording someone is watching.

create or replace function public.get_segments(hash_prefix text)
returns table (
  id uuid,
  video_id text,
  start_time numeric,
  end_time numeric,
  video_duration numeric,
  votes integer
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if hash_prefix is null or hash_prefix !~ '^[0-9a-f]{4,64}$' then
    raise exception 'invalid_prefix';
  end if;
  return query
    select s.id, s.video_id, s.start_time, s.end_time, s.video_duration, s.votes
    from public.segments s
    where s.video_hash like hash_prefix || '%'
      and s.hidden = false
      and s.votes > -2
    order by s.video_id, s.start_time
    limit 1000;
end;
$$;

-- ---------- submit_segment ----------

create or replace function public.submit_segment(
  p_user_id    text,
  p_video_id   text,
  p_start      numeric,
  p_end        numeric,
  p_duration   numeric default null,
  p_channel_id text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user     text;
  v_existing record;
  v_new_id   uuid;
begin
  if p_user_id is null or length(p_user_id) < 16 or length(p_user_id) > 128 then
    raise exception 'invalid_user';
  end if;
  if p_video_id is null or p_video_id !~ '^[A-Za-z0-9_-]{6,32}$' then
    raise exception 'invalid_video';
  end if;
  if p_start is null or p_end is null or p_start < 0
     or p_end - p_start < 4 or p_end - p_start > 900
     or (p_duration is not null and (p_duration <= 0 or p_end > p_duration + 1)) then
    raise exception 'invalid_times';
  end if;

  v_user := public.cb_hash('cb-user:' || p_user_id);

  if exists (select 1 from public.banned_users b where b.user_hash = v_user) then
    raise exception 'banned';
  end if;

  -- Rate limit: 30 breaks per browser per hour.
  if (select count(*) from public.segments s
      where s.user_hash = v_user and s.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'rate_limited';
  end if;

  -- If an almost identical break already exists, count this as a vote for it.
  select s.id, s.user_hash into v_existing
  from public.segments s
  where s.video_id = p_video_id
    and s.hidden = false
    and greatest(0, least(s.end_time, p_end) - greatest(s.start_time, p_start))
        >= 0.8 * least(s.end_time - s.start_time, p_end - p_start)
  order by s.votes desc
  limit 1;

  if found then
    if v_existing.user_hash <> v_user then
      insert into public.votes (segment_id, user_hash, value)
      values (v_existing.id, v_user, 1)
      on conflict (segment_id, user_hash) do update set value = 1, created_at = now();
      update public.segments s
        set votes = (select coalesce(sum(v.value), 0) from public.votes v where v.segment_id = s.id)
        where s.id = v_existing.id;
    end if;
    return v_existing.id;
  end if;

  if (select count(*) from public.segments s where s.video_id = p_video_id) >= 100 then
    raise exception 'too_many_segments';
  end if;

  insert into public.segments (video_id, video_hash, start_time, end_time, video_duration, channel_id, user_hash)
  values (p_video_id, public.cb_hash(p_video_id), p_start, p_end, p_duration, nullif(p_channel_id, ''), v_user)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ---------- vote_segment ----------
-- value: 1 = correct, -1 = wrong, 0 = remove my vote. Returns the new score.

create or replace function public.vote_segment(
  p_user_id    text,
  p_segment_id uuid,
  p_value      integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user  text;
  v_owner text;
  v_score integer;
begin
  if p_user_id is null or length(p_user_id) < 16 or length(p_user_id) > 128 then
    raise exception 'invalid_user';
  end if;
  if p_value is null or p_value not in (-1, 0, 1) then
    raise exception 'invalid_vote';
  end if;

  v_user := public.cb_hash('cb-user:' || p_user_id);

  if exists (select 1 from public.banned_users b where b.user_hash = v_user) then
    raise exception 'banned';
  end if;

  -- Rate limit: 200 votes per browser per hour.
  if (select count(*) from public.votes v
      where v.user_hash = v_user and v.created_at > now() - interval '1 hour') >= 200 then
    raise exception 'rate_limited';
  end if;

  select s.user_hash into v_owner from public.segments s where s.id = p_segment_id;
  if not found then
    raise exception 'invalid_segment';
  end if;

  -- You can't vote on your own break.
  if v_owner <> v_user then
    if p_value = 0 then
      delete from public.votes v where v.segment_id = p_segment_id and v.user_hash = v_user;
    else
      insert into public.votes (segment_id, user_hash, value)
      values (p_segment_id, v_user, p_value)
      on conflict (segment_id, user_hash) do update set value = excluded.value, created_at = now();
    end if;
    update public.segments s
      set votes = (select coalesce(sum(v.value), 0) from public.votes v where v.segment_id = s.id)
      where s.id = p_segment_id;
  end if;

  select s.votes into v_score from public.segments s where s.id = p_segment_id;
  return v_score;
end;
$$;

-- ---------- Permissions ----------

revoke all on function public.cb_hash(text) from public, anon, authenticated;
revoke all on function public.get_segments(text) from public;
revoke all on function public.submit_segment(text, text, numeric, numeric, numeric, text) from public;
revoke all on function public.vote_segment(text, uuid, integer) from public;

grant execute on function public.get_segments(text) to anon, authenticated;
grant execute on function public.submit_segment(text, text, numeric, numeric, numeric, text) to anon, authenticated;
grant execute on function public.vote_segment(text, uuid, integer) to anon, authenticated;
