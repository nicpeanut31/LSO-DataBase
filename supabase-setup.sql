-- LASALLIAN SYMPHONY ORCHESTRA — SHARED ONLINE DATABASE
-- Run this complete file once in Supabase > SQL Editor > New query.
-- This version uses username/password accounts stored securely in PostgreSQL.
-- It does not use Supabase email authentication, so no verification email is sent.

begin;

create extension if not exists pgcrypto;

create table if not exists public.lso_accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  contact_email text,
  display_name text not null,
  password_hash text not null,
  role text not null default 'Staff Account'
    check (role in ('Administrator', 'Staff Account')),
  approval_status text not null default 'Pending'
    check (approval_status in ('Pending', 'Approved', 'Rejected')),
  disabled boolean not null default false,
  is_default boolean not null default false,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by text,
  rejected_at timestamptz,
  rejected_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lso_accounts_username_format
    check (username ~ '^[A-Za-z0-9._-]{4,30}$'),
  constraint lso_accounts_display_name_length
    check (char_length(display_name) between 2 and 60),
  constraint lso_accounts_contact_email_format
    check (
      contact_email is null
      or btrim(contact_email) = ''
      or contact_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
);

create unique index if not exists lso_accounts_username_lower_unique
  on public.lso_accounts (lower(username));

create unique index if not exists lso_one_default_account
  on public.lso_accounts (is_default)
  where is_default = true;

create table if not exists public.lso_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.lso_accounts(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists lso_sessions_account_index
  on public.lso_sessions (account_id);

create index if not exists lso_sessions_expiry_index
  on public.lso_sessions (expires_at);

create table if not exists public.system_state (
  id integer primary key check (id = 1),
  members jsonb not null default '[]'::jsonb,
  events jsonb not null default '[]'::jsonb,
  attendance jsonb not null default '[]'::jsonb,
  duty_hours jsonb not null default '{"version":2,"commitments":{},"entries":[]}'::jsonb,
  instruments jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  activity_log jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.system_state (id)
values (1)
on conflict (id) do nothing;

-- Upgrade existing projects created before Duty Hours was added.
alter table public.system_state
  add column if not exists duty_hours jsonb not null
  default '{"version":2,"commitments":{},"entries":[]}'::jsonb;

create or replace function public.lso_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists lso_accounts_set_updated_at on public.lso_accounts;
create trigger lso_accounts_set_updated_at
before update on public.lso_accounts
for each row execute function public.lso_set_updated_at();

-- Internal helper. It validates a session token and returns the account id.
create or replace function public.lso_session_account_id(
  p_token text,
  p_require_admin boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'Invalid or expired session.' using errcode = '42501';
  end if;

  select account.id
  into v_account_id
  from public.lso_sessions as session
  join public.lso_accounts as account on account.id = session.account_id
  where session.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and session.expires_at > now()
    and account.approval_status = 'Approved'
    and account.disabled = false
    and (not p_require_admin or account.role = 'Administrator')
  limit 1;

  if v_account_id is null then
    raise exception 'Invalid or expired session.' using errcode = '42501';
  end if;

  update public.lso_sessions
  set last_seen_at = now()
  where token_hash = encode(digest(p_token, 'sha256'), 'hex');

  return v_account_id;
end;
$$;

create or replace function public.lso_account_json(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', account.id,
    'username', account.username,
    'email', coalesce(account.contact_email, ''),
    'displayName', account.display_name,
    'role', account.role,
    'approvalStatus', account.approval_status,
    'disabled', account.disabled,
    'isDefault', account.is_default,
    'requestedAt', account.requested_at,
    'approvedAt', account.approved_at,
    'approvedBy', coalesce(account.approved_by, ''),
    'rejectedAt', account.rejected_at,
    'rejectedBy', coalesce(account.rejected_by, ''),
    'createdAt', account.created_at,
    'updatedAt', account.updated_at
  )
  from public.lso_accounts as account
  where account.id = p_account_id;
$$;

-- Creates the fixed administrator only when it does not exist.
create or replace function public.lso_bootstrap_default_admin()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id uuid;
  v_created boolean := false;
begin
  select id into v_id
  from public.lso_accounts
  where lower(username) = 'sna1161'
  limit 1;

  if v_id is null then
    insert into public.lso_accounts (
      username,
      contact_email,
      display_name,
      password_hash,
      role,
      approval_status,
      disabled,
      is_default,
      requested_at,
      approved_at,
      approved_by
    ) values (
      'SNA1161',
      null,
      'LSO Administrator',
      crypt('SNA1161', gen_salt('bf', 12)),
      'Administrator',
      'Approved',
      false,
      true,
      now(),
      now(),
      'SNA1161'
    )
    returning id into v_id;
    v_created := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'created', v_created,
    'account', public.lso_account_json(v_id)
  );
end;
$$;

create or replace function public.lso_register_account(
  p_username text,
  p_password text,
  p_display_name text,
  p_contact_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_username text := btrim(coalesce(p_username, ''));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_contact_email text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  v_id uuid;
begin
  if v_username !~ '^[A-Za-z0-9._-]{4,30}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_username');
  end if;

  if lower(v_username) = 'sna1161' then
    return jsonb_build_object('ok', false, 'code', 'reserved_username');
  end if;

  if char_length(v_display_name) < 2 or char_length(v_display_name) > 60 then
    return jsonb_build_object('ok', false, 'code', 'invalid_display_name');
  end if;

  if char_length(coalesce(p_password, '')) < 6 then
    return jsonb_build_object('ok', false, 'code', 'weak_password');
  end if;

  if v_contact_email is not null
     and v_contact_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_email');
  end if;

  if exists (
    select 1 from public.lso_accounts where lower(username) = lower(v_username)
  ) then
    return jsonb_build_object('ok', false, 'code', 'username_taken');
  end if;

  insert into public.lso_accounts (
    username,
    contact_email,
    display_name,
    password_hash,
    role,
    approval_status,
    disabled,
    is_default,
    requested_at
  ) values (
    v_username,
    v_contact_email,
    v_display_name,
    crypt(p_password, gen_salt('bf', 12)),
    'Staff Account',
    'Pending',
    false,
    false,
    now()
  ) returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'pending',
    'account', public.lso_account_json(v_id)
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'username_taken');
end;
$$;

create or replace function public.lso_login(
  p_username text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account public.lso_accounts%rowtype;
  v_token text;
  v_expires_at timestamptz;
begin
  delete from public.lso_sessions where expires_at <= now();

  select * into v_account
  from public.lso_accounts
  where lower(username) = lower(btrim(coalesce(p_username, '')))
  limit 1;

  if v_account.id is null
     or v_account.password_hash <> crypt(coalesce(p_password, ''), v_account.password_hash) then
    return jsonb_build_object('ok', false, 'code', 'invalid_credentials');
  end if;

  if v_account.approval_status = 'Pending' then
    return jsonb_build_object('ok', false, 'code', 'pending');
  end if;

  if v_account.approval_status = 'Rejected' then
    return jsonb_build_object('ok', false, 'code', 'rejected');
  end if;

  if v_account.disabled then
    return jsonb_build_object('ok', false, 'code', 'disabled');
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + interval '30 days';

  -- Keep a reasonable number of active devices per account.
  delete from public.lso_sessions
  where id in (
    select id
    from public.lso_sessions
    where account_id = v_account.id
    order by last_seen_at desc
    offset 10
  );

  insert into public.lso_sessions (account_id, token_hash, expires_at)
  values (v_account.id, encode(digest(v_token, 'sha256'), 'hex'), v_expires_at);

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expiresAt', v_expires_at,
    'account', public.lso_account_json(v_account.id)
  );
end;
$$;

create or replace function public.lso_resume_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_account public.lso_accounts%rowtype;
begin
  select account.*
  into v_account
  from public.lso_sessions as session
  join public.lso_accounts as account on account.id = session.account_id
  where session.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and session.expires_at > now()
  limit 1;

  v_account_id := v_account.id;

  if v_account_id is null then
    return jsonb_build_object('ok', false, 'code', 'session_expired');
  end if;

  if v_account.approval_status <> 'Approved' then
    delete from public.lso_sessions
    where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
    return jsonb_build_object('ok', false, 'code', lower(v_account.approval_status));
  end if;

  if v_account.disabled then
    delete from public.lso_sessions
    where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
    return jsonb_build_object('ok', false, 'code', 'disabled');
  end if;

  update public.lso_sessions
  set last_seen_at = now()
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');

  return jsonb_build_object(
    'ok', true,
    'account', public.lso_account_json(v_account_id)
  );
end;
$$;

create or replace function public.lso_logout(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  delete from public.lso_sessions
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  return true;
end;
$$;

create or replace function public.lso_get_state(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_state jsonb;
begin
  v_account_id := public.lso_session_account_id(p_token, false);

  select jsonb_build_object(
    'id', state.id,
    'members', state.members,
    'events', state.events,
    'attendance', state.attendance,
    'duty_hours', state.duty_hours,
    'instruments', state.instruments,
    'settings', state.settings,
    'activity_log', state.activity_log,
    'updated_at', state.updated_at
  ) into v_state
  from public.system_state as state
  where state.id = 1;

  return v_state;
end;
$$;

create or replace function public.lso_update_state(
  p_token text,
  p_column text,
  p_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_state jsonb;
begin
  v_account_id := public.lso_session_account_id(p_token, true);

  if p_column in ('members', 'events', 'attendance', 'instruments', 'activity_log')
     and jsonb_typeof(p_value) <> 'array' then
    raise exception 'The selected data collection must be a JSON array.' using errcode = '22023';
  end if;

  if p_column in ('settings', 'duty_hours') and jsonb_typeof(p_value) <> 'object' then
    raise exception 'The selected data collection must be a JSON object.' using errcode = '22023';
  end if;

  case p_column
    when 'members' then
      update public.system_state set members = p_value, updated_at = now() where id = 1;
    when 'events' then
      update public.system_state set events = p_value, updated_at = now() where id = 1;
    when 'attendance' then
      update public.system_state set attendance = p_value, updated_at = now() where id = 1;
    when 'duty_hours' then
      update public.system_state set duty_hours = p_value, updated_at = now() where id = 1;
    when 'instruments' then
      update public.system_state set instruments = p_value, updated_at = now() where id = 1;
    when 'settings' then
      update public.system_state set settings = p_value, updated_at = now() where id = 1;
    when 'activity_log' then
      update public.system_state set activity_log = p_value, updated_at = now() where id = 1;
    else
      raise exception 'Unsupported shared-data column.' using errcode = '22023';
  end case;

  return public.lso_get_state(p_token);
end;
$$;

create or replace function public.lso_replace_state(
  p_token text,
  p_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
begin
  v_account_id := public.lso_session_account_id(p_token, true);

  update public.system_state
  set members = case when jsonb_typeof(p_state -> 'members') = 'array' then p_state -> 'members' else members end,
      events = case when jsonb_typeof(p_state -> 'events') = 'array' then p_state -> 'events' else events end,
      attendance = case when jsonb_typeof(p_state -> 'attendance') = 'array' then p_state -> 'attendance' else attendance end,
      duty_hours = case when jsonb_typeof(p_state -> 'duty_hours') = 'object' then p_state -> 'duty_hours' else duty_hours end,
      instruments = case when jsonb_typeof(p_state -> 'instruments') = 'array' then p_state -> 'instruments' else instruments end,
      settings = case when jsonb_typeof(p_state -> 'settings') = 'object' then p_state -> 'settings' else settings end,
      activity_log = case when jsonb_typeof(p_state -> 'activity_log') = 'array' then p_state -> 'activity_log' else activity_log end,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

create or replace function public.lso_list_accounts(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admin_id uuid;
  v_result jsonb;
begin
  v_admin_id := public.lso_session_account_id(p_token, true);

  select coalesce(jsonb_agg(public.lso_account_json(account.id) order by account.created_at desc), '[]'::jsonb)
  into v_result
  from public.lso_accounts as account;

  return v_result;
end;
$$;

create or replace function public.lso_save_accounts(
  p_token text,
  p_accounts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admin_id uuid;
  v_admin_username text;
  v_item jsonb;
  v_target_id uuid;
  v_status text;
  v_role text;
  v_disabled boolean;
begin
  v_admin_id := public.lso_session_account_id(p_token, true);
  select username into v_admin_username from public.lso_accounts where id = v_admin_id;

  if jsonb_typeof(p_accounts) <> 'array' then
    raise exception 'Accounts payload must be a JSON array.' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_accounts)
  loop
    begin
      v_target_id := (v_item ->> 'id')::uuid;
    exception when others then
      continue;
    end;

    if not exists (select 1 from public.lso_accounts where id = v_target_id) then
      continue;
    end if;

    if exists (select 1 from public.lso_accounts where id = v_target_id and is_default = true) then
      continue;
    end if;

    v_status := case
      when v_item ->> 'approvalStatus' in ('Pending', 'Approved', 'Rejected')
        then v_item ->> 'approvalStatus'
      else 'Pending'
    end;

    v_role := case
      when v_item ->> 'role' = 'Administrator' then 'Administrator'
      else 'Staff Account'
    end;

    v_disabled := coalesce((v_item ->> 'disabled')::boolean, false);

    update public.lso_accounts
    set role = v_role,
        approval_status = v_status,
        disabled = v_disabled,
        approved_at = case
          when v_status = 'Approved' then coalesce(nullif(v_item ->> 'approvedAt', '')::timestamptz, approved_at, now())
          else null
        end,
        approved_by = case
          when v_status = 'Approved' then coalesce(nullif(v_item ->> 'approvedBy', ''), v_admin_username)
          else null
        end,
        rejected_at = case
          when v_status = 'Rejected' then coalesce(nullif(v_item ->> 'rejectedAt', '')::timestamptz, rejected_at, now())
          else null
        end,
        rejected_by = case
          when v_status = 'Rejected' then coalesce(nullif(v_item ->> 'rejectedBy', ''), v_admin_username)
          else null
        end
    where id = v_target_id;

    if v_status <> 'Approved' or v_disabled then
      delete from public.lso_sessions where account_id = v_target_id;
    end if;
  end loop;

  return public.lso_list_accounts(p_token);
end;
$$;

create or replace function public.lso_delete_account(
  p_token text,
  p_account_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admin_id uuid;
begin
  v_admin_id := public.lso_session_account_id(p_token, true);

  if p_account_id = v_admin_id then
    raise exception 'You cannot delete your own active account.' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.lso_accounts
    where id = p_account_id and is_default = true
  ) then
    raise exception 'The default administrator cannot be deleted.' using errcode = '42501';
  end if;

  delete from public.lso_accounts where id = p_account_id;
  return found;
end;
$$;

create or replace function public.lso_ping()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'serverTime', now());
$$;

-- The browser may call only the controlled functions above. Direct table access
-- is denied, so password hashes and session hashes are never readable publicly.
alter table public.lso_accounts enable row level security;
alter table public.lso_sessions enable row level security;
alter table public.system_state enable row level security;

revoke all on table public.lso_accounts from anon, authenticated;
revoke all on table public.lso_sessions from anon, authenticated;
revoke all on table public.system_state from anon, authenticated;

revoke all on function public.lso_session_account_id(text, boolean) from public, anon, authenticated;
revoke all on function public.lso_account_json(uuid) from public, anon, authenticated;

revoke all on function public.lso_bootstrap_default_admin() from public;
revoke all on function public.lso_register_account(text, text, text, text) from public;
revoke all on function public.lso_login(text, text) from public;
revoke all on function public.lso_resume_session(text) from public;
revoke all on function public.lso_logout(text) from public;
revoke all on function public.lso_get_state(text) from public;
revoke all on function public.lso_update_state(text, text, jsonb) from public;
revoke all on function public.lso_replace_state(text, jsonb) from public;
revoke all on function public.lso_list_accounts(text) from public;
revoke all on function public.lso_save_accounts(text, jsonb) from public;
revoke all on function public.lso_delete_account(text, uuid) from public;
revoke all on function public.lso_ping() from public;

grant execute on function public.lso_bootstrap_default_admin() to anon, authenticated;
grant execute on function public.lso_register_account(text, text, text, text) to anon, authenticated;
grant execute on function public.lso_login(text, text) to anon, authenticated;
grant execute on function public.lso_resume_session(text) to anon, authenticated;
grant execute on function public.lso_logout(text) to anon, authenticated;
grant execute on function public.lso_get_state(text) to anon, authenticated;
grant execute on function public.lso_update_state(text, text, jsonb) to anon, authenticated;
grant execute on function public.lso_replace_state(text, jsonb) to anon, authenticated;
grant execute on function public.lso_list_accounts(text) to anon, authenticated;
grant execute on function public.lso_save_accounts(text, jsonb) to anon, authenticated;
grant execute on function public.lso_delete_account(text, uuid) to anon, authenticated;
grant execute on function public.lso_ping() to anon, authenticated;

commit;

-- AFTER RUNNING THIS FILE:
-- 1. Upload all website files to the GitHub Pages repository.
-- 2. Open the website and log in with SNA1161 / SNA1161.
-- 3. Other registrations remain Pending until approved from Accounts.
-- 4. No email-confirmation setting is required because this version does not
--    use Supabase Auth email accounts.
