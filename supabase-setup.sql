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
  member_id text,
  password_hash text not null,
  role text not null default 'Staff Account'
    check (role in ('Administrator', 'Staff Account', 'Trainee/Probationary')),
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
  monthly_reports jsonb not null default '{"version":1,"reports":{},"civilStatusByMember":{},"traineeFiles":{}}'::jsonb,
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

-- Upgrade existing projects with the Overall Monthly Report shared filing.
alter table public.system_state
  add column if not exists monthly_reports jsonb not null
  default '{"version":1,"reports":{},"civilStatusByMember":{},"traineeFiles":{}}'::jsonb;

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
    'monthly_reports', state.monthly_reports,
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

  if p_column in ('settings', 'duty_hours', 'monthly_reports') and jsonb_typeof(p_value) <> 'object' then
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
    when 'monthly_reports' then
      update public.system_state set monthly_reports = p_value, updated_at = now() where id = 1;
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
      monthly_reports = case when jsonb_typeof(p_state -> 'monthly_reports') = 'object' then p_state -> 'monthly_reports' else monthly_reports end,
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

-- Monthly Report compatibility migration and PostgREST cache refresh.
update public.system_state
set monthly_reports = settings -> '__lso_monthly_reports_v1'
where jsonb_typeof(settings -> '__lso_monthly_reports_v1') = 'object'
  and coalesce(jsonb_object_length(settings -> '__lso_monthly_reports_v1'), 0) > 0;
notify pgrst, 'reload schema';
-- LSO TRAINEE / PROBATIONARY DUTY-HOURS ROLE UPDATE
-- Run this once in Supabase SQL Editor for an existing installation.
-- The same migration is also appended to the complete supabase-setup.sql.

begin;

alter table public.lso_accounts
  add column if not exists member_id text;

alter table public.lso_accounts
  drop constraint if exists lso_accounts_role_check;

alter table public.lso_accounts
  add constraint lso_accounts_role_check
  check (role in ('Administrator', 'Staff Account', 'Trainee/Probationary'));

create index if not exists lso_accounts_member_id_index
  on public.lso_accounts (member_id)
  where member_id is not null;

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
    'memberId', coalesce(account.member_id, ''),
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

-- Trainee/Probationary accounts receive only their linked member record and
-- that member's duty-hours data. Administrators and Staff retain their prior view.
create or replace function public.lso_get_state(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_role text;
  v_member_id text;
  v_state jsonb;
  v_members jsonb := '[]'::jsonb;
  v_entries jsonb := '[]'::jsonb;
  v_commitments jsonb := '{}'::jsonb;
  v_duty_hours jsonb;
  v_monthly_reports jsonb;
begin
  v_account_id := public.lso_session_account_id(p_token, false);

  select role, member_id
  into v_role, v_member_id
  from public.lso_accounts
  where id = v_account_id;

  select to_jsonb(state)
  into v_state
  from public.system_state as state
  where state.id = 1;

  if v_state is null then
    raise exception 'The shared system state is missing.' using errcode = 'P0002';
  end if;

  v_duty_hours := case
    when jsonb_typeof(v_state -> 'duty_hours') = 'object'
      then v_state -> 'duty_hours'
    else '{"version":6,"commitments":{},"entries":[]}'::jsonb
  end;

  v_monthly_reports := case
    when jsonb_typeof(v_state -> 'monthly_reports') = 'object'
      then v_state -> 'monthly_reports'
    when jsonb_typeof(v_state -> 'settings' -> '__lso_monthly_reports_v1') = 'object'
      then v_state -> 'settings' -> '__lso_monthly_reports_v1'
    else '{"version":1,"reports":{},"civilStatusByMember":{},"traineeFiles":{}}'::jsonb
  end;

  if v_role = 'Trainee/Probationary' then
    select coalesce(jsonb_agg(item), '[]'::jsonb)
    into v_members
    from jsonb_array_elements(
      case when jsonb_typeof(v_state -> 'members') = 'array'
        then v_state -> 'members' else '[]'::jsonb end
    ) as item
    where nullif(btrim(coalesce(v_member_id, '')), '') is not null
      and item ->> 'id' = v_member_id;

    select coalesce(jsonb_agg(item), '[]'::jsonb)
    into v_entries
    from jsonb_array_elements(
      case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
        then v_duty_hours -> 'entries' else '[]'::jsonb end
    ) as item
    where nullif(btrim(coalesce(v_member_id, '')), '') is not null
      and item ->> 'memberId' = v_member_id;

    if nullif(btrim(coalesce(v_member_id, '')), '') is not null
       and jsonb_typeof(v_duty_hours -> 'commitments' -> v_member_id) = 'object' then
      v_commitments := jsonb_build_object(
        v_member_id,
        v_duty_hours -> 'commitments' -> v_member_id
      );
    end if;

    return jsonb_build_object(
      'id', coalesce(v_state -> 'id', '1'::jsonb),
      'members', v_members,
      'events', '[]'::jsonb,
      'attendance', '[]'::jsonb,
      'duty_hours', jsonb_build_object(
        'version', coalesce(v_duty_hours -> 'version', '4'::jsonb),
        'commitments', v_commitments,
        'entries', v_entries
      ),
      'monthly_reports', '{}'::jsonb,
      'instruments', '[]'::jsonb,
      'settings', '{}'::jsonb,
      'activity_log', '[]'::jsonb,
      'updated_at', coalesce(v_state -> 'updated_at', to_jsonb(now()))
    );
  end if;

  return jsonb_build_object(
    'id', coalesce(v_state -> 'id', '1'::jsonb),
    'members', case when jsonb_typeof(v_state -> 'members') = 'array' then v_state -> 'members' else '[]'::jsonb end,
    'events', case when jsonb_typeof(v_state -> 'events') = 'array' then v_state -> 'events' else '[]'::jsonb end,
    'attendance', case when jsonb_typeof(v_state -> 'attendance') = 'array' then v_state -> 'attendance' else '[]'::jsonb end,
    'duty_hours', v_duty_hours,
    'monthly_reports', v_monthly_reports,
    'instruments', case when jsonb_typeof(v_state -> 'instruments') = 'array' then v_state -> 'instruments' else '[]'::jsonb end,
    'settings', case when jsonb_typeof(v_state -> 'settings') = 'object' then v_state -> 'settings' else '{}'::jsonb end,
    'activity_log', case when jsonb_typeof(v_state -> 'activity_log') = 'array' then v_state -> 'activity_log' else '[]'::jsonb end,
    'updated_at', coalesce(v_state -> 'updated_at', to_jsonb(now()))
  );
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
  v_member_id text;
  v_disabled boolean;
  v_old_role text;
  v_old_member_id text;
  v_old_status text;
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

    select role, member_id, approval_status
    into v_old_role, v_old_member_id, v_old_status
    from public.lso_accounts
    where id = v_target_id;

    v_status := case
      when v_item ->> 'approvalStatus' in ('Pending', 'Approved', 'Rejected')
        then v_item ->> 'approvalStatus'
      else 'Pending'
    end;

    v_role := case
      when v_item ->> 'role' = 'Administrator' then 'Administrator'
      when v_item ->> 'role' = 'Trainee/Probationary' then 'Trainee/Probationary'
      else 'Staff Account'
    end;

    v_member_id := case
      when v_role = 'Trainee/Probationary' then nullif(btrim(v_item ->> 'memberId'), '')
      else null
    end;

    -- Any change to an already approved role or linked member must be
    -- reviewed and approved again. This also invalidates active sessions below.
    if v_old_status = 'Approved'
       and (
         v_old_role is distinct from v_role
         or coalesce(v_old_member_id, '') <> coalesce(v_member_id, '')
       ) then
      v_status := 'Pending';
    end if;

    if v_role = 'Trainee/Probationary' and v_member_id is not null and not exists (
      select 1
      from public.system_state as state,
           jsonb_array_elements(coalesce(state.members, '[]'::jsonb)) as member
      where state.id = 1
        and member ->> 'id' = v_member_id
        and (
          member ->> 'periodGroup' in ('Trainee Period', 'Probationary Period')
          or member ->> 'membershipStage' in ('Trainee', 'Probationary')
        )
    ) then
      raise exception 'The selected linked member is not an active Trainee or Probationary member.' using errcode = '22023';
    end if;

    if v_role = 'Trainee/Probationary' and v_status = 'Approved' and v_member_id is null then
      raise exception 'A Trainee/Probationary account must be linked to a member before approval.' using errcode = '22023';
    end if;

    v_disabled := coalesce((v_item ->> 'disabled')::boolean, false);

    update public.lso_accounts
    set role = v_role,
        member_id = v_member_id,
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

    if v_status <> 'Approved'
       or v_disabled
       or v_old_role is distinct from v_role
       or coalesce(v_old_member_id, '') <> coalesce(v_member_id, '') then
      delete from public.lso_sessions where account_id = v_target_id;
    end if;
  end loop;

  return public.lso_list_accounts(p_token);
end;
$$;

create or replace function public.lso_submit_duty_entry(
  p_token text,
  p_semester text,
  p_period text,
  p_date text,
  p_time_in text,
  p_time_out text,
  p_description text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_account public.lso_accounts%rowtype;
  v_member jsonb;
  v_member_period text;
  v_minutes integer;
  v_entry jsonb;
  v_entry_id text := gen_random_uuid()::text;
begin
  v_account_id := public.lso_session_account_id(p_token, false);
  select * into v_account from public.lso_accounts where id = v_account_id;

  if v_account.role <> 'Trainee/Probationary' then
    raise exception 'Only a Trainee/Probationary account may submit a self-service duty entry.' using errcode = '42501';
  end if;

  if v_account.member_id is null or btrim(v_account.member_id) = '' then
    raise exception 'This account is not linked to a member record.' using errcode = '42501';
  end if;

  if p_semester not in ('First Semester', 'Second Semester') then
    raise exception 'Invalid duty semester.' using errcode = '22023';
  end if;

  if p_period not in ('Trainee Period', 'Probationary Period') then
    raise exception 'Invalid duty period.' using errcode = '22023';
  end if;

  if p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Enter a valid duty date.' using errcode = '22023';
  end if;

  begin
    perform p_date::date;
  exception when others then
    raise exception 'Enter a valid duty date.' using errcode = '22023';
  end;

  if p_time_in !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or p_time_out !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Enter valid Time In and Time Out values.' using errcode = '22023';
  end if;

  if p_time_out::time <= p_time_in::time then
    raise exception 'Time Out must be later than Time In for a same-day duty entry.' using errcode = '22023';
  end if;

  v_minutes := floor(extract(epoch from (p_time_out::time - p_time_in::time)) / 60)::integer;

  select member
  into v_member
  from public.system_state as state,
       jsonb_array_elements(coalesce(state.members, '[]'::jsonb)) as member
  where state.id = 1
    and member ->> 'id' = v_account.member_id
  limit 1;

  if v_member is null then
    raise exception 'The linked member record could not be found.' using errcode = '42501';
  end if;

  v_member_period := coalesce(
    nullif(v_member ->> 'periodGroup', ''),
    case v_member ->> 'membershipStage'
      when 'Trainee' then 'Trainee Period'
      when 'Probationary' then 'Probationary Period'
      else ''
    end
  );

  if v_member_period not in ('Trainee Period', 'Probationary Period') then
    raise exception 'The linked member is not currently in the Trainee or Probationary Period.' using errcode = '42501';
  end if;

  if p_period <> v_member_period then
    raise exception 'The submitted duty period does not match the linked member''s current period.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.system_state as state,
         jsonb_array_elements(coalesce(state.duty_hours -> 'entries', '[]'::jsonb)) as entry
    where state.id = 1
      and entry ->> 'memberId' = v_account.member_id
      and entry ->> 'date' = p_date
      and entry ->> 'timeIn' = p_time_in
      and entry ->> 'timeOut' = p_time_out
      and coalesce(entry ->> 'approvalStatus', 'Approved') <> 'Rejected'
  ) then
    raise exception 'This Time In and Time Out entry was already submitted.' using errcode = '23505';
  end if;

  v_entry := jsonb_build_object(
    'id', v_entry_id,
    'memberId', v_account.member_id,
    'semester', p_semester,
    'period', p_period,
    'entryType', 'Duty',
    'date', p_date,
    'minutes', v_minutes,
    'timeIn', p_time_in,
    'timeOut', p_time_out,
    'description', left(btrim(coalesce(p_description, '')), 160),
    'approvalStatus', 'Pending',
    'submittedByAccountId', v_account.id,
    'submittedByUsername', v_account.username,
    'submittedByRole', v_account.role,
    'createdAt', now(),
    'createdBy', v_account.display_name,
    'createdByUsername', v_account.username
  );

  update public.system_state
  set duty_hours = jsonb_set(
        coalesce(duty_hours, '{"version":6,"commitments":{},"entries":[]}'::jsonb),
        '{entries}',
        coalesce(duty_hours -> 'entries', '[]'::jsonb) || jsonb_build_array(v_entry),
        true
      ),
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

create or replace function public.lso_review_duty_entry(
  p_token text,
  p_entry_id text,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admin_id uuid;
  v_admin_username text;
  v_entries jsonb;
  v_found boolean := false;
begin
  v_admin_id := public.lso_session_account_id(p_token, true);
  select username into v_admin_username from public.lso_accounts where id = v_admin_id;

  if p_decision not in ('Approved', 'Rejected') then
    raise exception 'Decision must be Approved or Rejected.' using errcode = '22023';
  end if;

  select exists (
    select 1
    from public.system_state as state,
         jsonb_array_elements(coalesce(state.duty_hours -> 'entries', '[]'::jsonb)) as entry
    where state.id = 1
      and entry ->> 'id' = p_entry_id
      and coalesce(entry ->> 'approvalStatus', 'Approved') = 'Pending'
  ) into v_found;

  if not v_found then
    raise exception 'The pending duty entry could not be found.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
    case
      when entry ->> 'id' = p_entry_id and p_decision = 'Approved' then
        (entry - 'rejectedAt' - 'rejectedBy') || jsonb_build_object(
          'approvalStatus', 'Approved',
          'approvedAt', now(),
          'approvedBy', v_admin_username
        )
      when entry ->> 'id' = p_entry_id and p_decision = 'Rejected' then
        (entry - 'approvedAt' - 'approvedBy') || jsonb_build_object(
          'approvalStatus', 'Rejected',
          'rejectedAt', now(),
          'rejectedBy', v_admin_username
        )
      else entry
    end
    order by ordinal_position
  ), '[]'::jsonb)
  into v_entries
  from public.system_state as state,
       jsonb_array_elements(coalesce(state.duty_hours -> 'entries', '[]'::jsonb))
         with ordinality as records(entry, ordinal_position)
  where state.id = 1;

  update public.system_state
  set duty_hours = jsonb_set(duty_hours, '{entries}', v_entries, true),
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

revoke all on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) from public;
revoke all on function public.lso_review_duty_entry(text, text, text) from public;
grant execute on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.lso_review_duty_entry(text, text, text) to anon, authenticated;

commit;
notify pgrst, 'reload schema';

-- ============================================================================
-- FINAL TRAINEE / PROBATIONARY DUTY HOURS HARDENING
-- The block below is intentionally included in the complete setup so new
-- projects receive the same validated workflow as existing-project upgrades.
-- ============================================================================
-- LASALLIAN SYMPHONY ORCHESTRA
-- FINAL TRAINEE / PROBATIONARY DUTY HOURS WORKFLOW
--
-- Run this entire file once in Supabase > SQL Editor > New query.
-- It is safe to run again. Existing members, accounts, attendance, and duty
-- records are preserved.
--
-- Workflow installed by this script:
--   1. Administrator approves an account as Trainee/Probationary and links it
--      to one current Trainee or Probationary member.
--   2. That account sees only Duty Hours.
--   3. The member submits their own date, Time In, Time Out, and description.
--   4. The entry is Pending and contributes zero credited minutes.
--   5. Only an Administrator can Approve or Reject it.
--   6. Only Approved duty entries are included in the member's totals.

begin;

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.lso_accounts') is null then
    raise exception 'public.lso_accounts does not exist. Run the complete supabase-setup.sql first.';
  end if;
  if to_regclass('public.lso_sessions') is null then
    raise exception 'public.lso_sessions does not exist. Run the complete supabase-setup.sql first.';
  end if;
  if to_regclass('public.system_state') is null then
    raise exception 'public.system_state does not exist. Run the complete supabase-setup.sql first.';
  end if;
end;
$$;

-- Compatibility for projects created before this role existed.
alter table public.lso_accounts
  add column if not exists member_id text;

alter table public.system_state
  add column if not exists members jsonb,
  add column if not exists duty_hours jsonb,
  add column if not exists activity_log jsonb,
  add column if not exists updated_at timestamptz;

insert into public.system_state (id)
values (1)
on conflict (id) do nothing;

update public.system_state
set members = coalesce(members, '[]'::jsonb),
    duty_hours = coalesce(duty_hours, '{"version":6,"commitments":{},"entries":[]}'::jsonb),
    activity_log = coalesce(activity_log, '[]'::jsonb),
    updated_at = coalesce(updated_at, now())
where id = 1;

-- Normalize the Duty Hours container without deleting legacy entries.
update public.system_state
set duty_hours = jsonb_set(
      jsonb_set(
        jsonb_set(
          case when jsonb_typeof(duty_hours) = 'object'
            then duty_hours
            else '{"version":6,"commitments":{},"entries":[]}'::jsonb
          end,
          '{version}', '6'::jsonb, true
        ),
        '{commitments}',
        case when jsonb_typeof(duty_hours -> 'commitments') = 'object'
          then duty_hours -> 'commitments' else '{}'::jsonb end,
        true
      ),
      '{entries}',
      case when jsonb_typeof(duty_hours -> 'entries') = 'array'
        then duty_hours -> 'entries' else '[]'::jsonb end,
      true
    ),
    updated_at = now()
where id = 1;

-- Replace an older role check safely.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.lso_accounts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
      and (
        pg_get_constraintdef(oid) ilike '%Administrator%'
        or pg_get_constraintdef(oid) ilike '%Staff Account%'
      )
  loop
    execute format('alter table public.lso_accounts drop constraint %I', v_constraint.conname);
  end loop;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.lso_accounts'::regclass
      and conname = 'lso_accounts_role_check'
  ) then
    alter table public.lso_accounts
      add constraint lso_accounts_role_check
      check (role in ('Administrator', 'Staff Account', 'Trainee/Probationary'));
  end if;
end;
$$;

create index if not exists lso_accounts_member_id_index
  on public.lso_accounts (member_id)
  where member_id is not null;


-- One canonical calendar date for all LSO duty-hour validation.
-- Supabase/PostgreSQL sessions commonly use UTC, while LSO operates in the Philippines.
create or replace function public.lso_local_date()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (now() at time zone 'Asia/Manila')::date;
$$;

-- Determine the person's actual period from the timeline on a specific date.
-- This avoids depending only on a possibly stale periodGroup value.
create or replace function public.lso_member_period_on_date(
  p_member jsonb,
  p_on_date date default public.lso_local_date()
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_trainee_start date;
  v_probationary_start date;
  v_membership_start date;
  v_skipped boolean := false;
  v_period text;
  v_stage text;
begin
  if p_member is null or jsonb_typeof(p_member) <> 'object' then
    return '';
  end if;

  begin
    v_trainee_start := nullif(coalesce(p_member ->> 'traineeStartDate', p_member ->> 'dateRegistered'), '')::date;
  exception when others then
    v_trainee_start := null;
  end;

  begin
    v_probationary_start := nullif(p_member ->> 'probationaryStartDate', '')::date;
  exception when others then
    v_probationary_start := null;
  end;

  begin
    v_membership_start := nullif(coalesce(p_member ->> 'regularMemberDate', p_member ->> 'membershipStartDate'), '')::date;
  exception when others then
    v_membership_start := null;
  end;

  v_skipped := lower(coalesce(p_member ->> 'probationarySkipped', 'false')) in ('true', '1', 'yes');
  v_period := coalesce(p_member ->> 'periodGroup', '');
  v_stage := coalesce(p_member ->> 'membershipStage', '');

  if v_membership_start is not null and p_on_date >= v_membership_start then
    return 'Membership Period';
  end if;

  if not v_skipped
     and v_probationary_start is not null
     and p_on_date >= v_probationary_start then
    return 'Probationary Period';
  end if;

  if v_trainee_start is not null and p_on_date >= v_trainee_start then
    return 'Trainee Period';
  end if;

  -- Fallback for older member records that do not yet have complete timeline dates.
  if v_period in ('Trainee Period', 'Probationary Period', 'Membership Period') then
    return v_period;
  end if;

  if v_stage = 'Trainee' then return 'Trainee Period'; end if;
  if v_stage = 'Probationary' then return 'Probationary Period'; end if;
  if v_stage in ('Regular Member', 'Member', 'Official Member') then return 'Membership Period'; end if;

  return '';
end;
$$;

-- Ensure the browser receives memberId with every account profile.
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
    'memberId', coalesce(account.member_id, ''),
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

-- Administrator account approval with mandatory, validated member linking.
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
  v_member_id text;
  v_disabled boolean;
  v_old_role text;
  v_old_member_id text;
  v_old_status text;
  v_member jsonb;
  v_current_period text;
begin
  v_admin_id := public.lso_session_account_id(p_token, true);
  select username into v_admin_username
  from public.lso_accounts
  where id = v_admin_id;

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

    if not exists (select 1 from public.lso_accounts where id = v_target_id)
       or exists (select 1 from public.lso_accounts where id = v_target_id and is_default = true) then
      continue;
    end if;

    select role, member_id, approval_status
    into v_old_role, v_old_member_id, v_old_status
    from public.lso_accounts
    where id = v_target_id;

    v_status := case
      when v_item ->> 'approvalStatus' in ('Pending', 'Approved', 'Rejected')
        then v_item ->> 'approvalStatus'
      else 'Pending'
    end;

    v_role := case
      when v_item ->> 'role' = 'Administrator' then 'Administrator'
      when v_item ->> 'role' = 'Trainee/Probationary' then 'Trainee/Probationary'
      else 'Staff Account'
    end;

    v_member_id := case
      when v_role = 'Trainee/Probationary'
        then nullif(btrim(coalesce(v_item ->> 'memberId', '')), '')
      else null
    end;

    -- Changing an approved role or member link always requires fresh approval.
    if v_old_status = 'Approved'
       and (
         v_old_role is distinct from v_role
         or coalesce(v_old_member_id, '') <> coalesce(v_member_id, '')
       ) then
      v_status := 'Pending';
    end if;

    begin
      v_disabled := coalesce((v_item ->> 'disabled')::boolean, false);
    exception when others then
      v_disabled := false;
    end;

    if v_role = 'Trainee/Probationary' and v_member_id is not null then
      select member
      into v_member
      from public.system_state as state,
           jsonb_array_elements(coalesce(state.members, '[]'::jsonb)) as member
      where state.id = 1
        and member ->> 'id' = v_member_id
      limit 1;

      if v_member is null then
        raise exception 'The selected linked member record could not be found.' using errcode = '22023';
      end if;

      v_current_period := public.lso_member_period_on_date(v_member, public.lso_local_date());
      if v_current_period not in ('Trainee Period', 'Probationary Period') then
        raise exception 'The selected member is not currently in the Trainee or Probationary Period.' using errcode = '22023';
      end if;
    end if;

    if v_role = 'Trainee/Probationary'
       and v_status = 'Approved'
       and v_member_id is null then
      raise exception 'Select a Trainee or Probationary member before approving this account.' using errcode = '22023';
    end if;

    -- One active approved account per member prevents entries from being
    -- submitted under two different usernames.
    if v_role = 'Trainee/Probationary'
       and v_status = 'Approved'
       and not v_disabled
       and exists (
         select 1
         from public.lso_accounts as other_account
         where other_account.id <> v_target_id
           and other_account.role = 'Trainee/Probationary'
           and other_account.approval_status = 'Approved'
           and other_account.disabled = false
           and other_account.member_id = v_member_id
       ) then
      raise exception 'This member is already linked to another active approved Trainee/Probationary account.' using errcode = '23505';
    end if;

    update public.lso_accounts
    set role = v_role,
        member_id = v_member_id,
        approval_status = v_status,
        disabled = v_disabled,
        approved_at = case
          when v_status = 'Approved'
            then coalesce(nullif(v_item ->> 'approvedAt', '')::timestamptz, approved_at, now())
          else null
        end,
        approved_by = case
          when v_status = 'Approved'
            then coalesce(nullif(v_item ->> 'approvedBy', ''), v_admin_username)
          else null
        end,
        rejected_at = case
          when v_status = 'Rejected'
            then coalesce(nullif(v_item ->> 'rejectedAt', '')::timestamptz, rejected_at, now())
          else null
        end,
        rejected_by = case
          when v_status = 'Rejected'
            then coalesce(nullif(v_item ->> 'rejectedBy', ''), v_admin_username)
          else null
        end
    where id = v_target_id;

    if v_status <> 'Approved'
       or v_disabled
       or v_old_role is distinct from v_role
       or coalesce(v_old_member_id, '') <> coalesce(v_member_id, '') then
      delete from public.lso_sessions where account_id = v_target_id;
    end if;
  end loop;

  return public.lso_list_accounts(p_token);
end;
$$;

-- Member self-service submission. The server derives the member, duty period,
-- and duration; the browser cannot choose another member or credited minutes.
create or replace function public.lso_submit_duty_entry(
  p_token text,
  p_semester text,
  p_period text,
  p_date text,
  p_time_in text,
  p_time_out text,
  p_description text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_account public.lso_accounts%rowtype;
  v_member jsonb;
  v_current_period text;
  v_entry_period text;
  v_duty_date date;
  v_minutes integer;
  v_description text;
  v_entry jsonb;
  v_entry_id text := gen_random_uuid()::text;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_activity_log jsonb;
  v_activity jsonb;
begin
  v_account_id := public.lso_session_account_id(p_token, false);
  select * into v_account
  from public.lso_accounts
  where id = v_account_id;

  if v_account.role <> 'Trainee/Probationary' then
    raise exception 'Only a Trainee/Probationary account may submit a self-service duty entry.' using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(v_account.member_id, '')), '') is null then
    raise exception 'This account is not linked to a member record.' using errcode = '42501';
  end if;

  if p_semester not in ('First Semester', 'Second Semester') then
    raise exception 'Select a valid duty semester.' using errcode = '22023';
  end if;

  if p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Enter a valid duty date.' using errcode = '22023';
  end if;

  begin
    v_duty_date := p_date::date;
  exception when others then
    raise exception 'Enter a valid duty date.' using errcode = '22023';
  end;

  if v_duty_date > public.lso_local_date() then
    raise exception 'A future duty date cannot be submitted.' using errcode = '22023';
  end if;

  if p_time_in !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or p_time_out !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Enter valid Time In and Time Out values.' using errcode = '22023';
  end if;

  if p_time_out::time <= p_time_in::time then
    raise exception 'Time Out must be later than Time In for a same-day duty entry.' using errcode = '22023';
  end if;

  v_minutes := floor(extract(epoch from (p_time_out::time - p_time_in::time)) / 60)::integer;
  if v_minutes <= 0 or v_minutes > 960 then
    raise exception 'A duty entry must be longer than 0 minutes and no longer than 16 hours.' using errcode = '22023';
  end if;

  v_description := left(btrim(coalesce(p_description, '')), 160);
  if char_length(v_description) < 3 then
    raise exception 'Enter a duty assignment or description with at least 3 characters.' using errcode = '22023';
  end if;

  -- Lock the shared row. This prevents two simultaneous submissions from
  -- passing duplicate/overlap validation and overwriting each other.
  select duty_hours, activity_log
  into v_duty_hours, v_activity_log
  from public.system_state
  where id = 1
  for update;

  if v_duty_hours is null or jsonb_typeof(v_duty_hours) <> 'object' then
    v_duty_hours := '{"version":6,"commitments":{},"entries":[]}'::jsonb;
  end if;
  v_entries := case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
    then v_duty_hours -> 'entries' else '[]'::jsonb end;

  select member
  into v_member
  from public.system_state as state,
       jsonb_array_elements(coalesce(state.members, '[]'::jsonb)) as member
  where state.id = 1
    and member ->> 'id' = v_account.member_id
  limit 1;

  if v_member is null then
    raise exception 'The linked member record could not be found.' using errcode = '42501';
  end if;

  v_current_period := public.lso_member_period_on_date(v_member, public.lso_local_date());
  if v_current_period not in ('Trainee Period', 'Probationary Period') then
    raise exception 'The linked member is no longer in the Trainee or Probationary Period.' using errcode = '42501';
  end if;

  v_entry_period := public.lso_member_period_on_date(v_member, v_duty_date);
  if v_entry_period not in ('Trainee Period', 'Probationary Period') then
    raise exception 'The selected date is outside this member''s Trainee or Probationary period.' using errcode = '22023';
  end if;

  -- Reject exact duplicates and any overlapping non-rejected duty interval.
  if exists (
    select 1
    from jsonb_array_elements(v_entries) as entry
    where entry ->> 'memberId' = v_account.member_id
      and entry ->> 'entryType' = 'Duty'
      and entry ->> 'date' = p_date
      and coalesce(entry ->> 'approvalStatus', 'Approved') <> 'Rejected'
      and entry ->> 'timeIn' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and entry ->> 'timeOut' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and (entry ->> 'timeIn')::time < p_time_out::time
      and (entry ->> 'timeOut')::time > p_time_in::time
  ) then
    raise exception 'This duty time overlaps an existing pending or approved entry for the same date.' using errcode = '23505';
  end if;

  v_entry := jsonb_build_object(
    'id', v_entry_id,
    'memberId', v_account.member_id,
    'semester', p_semester,
    'period', v_entry_period,
    'entryType', 'Duty',
    'date', p_date,
    'minutes', v_minutes,
    'timeIn', p_time_in,
    'timeOut', p_time_out,
    'description', v_description,
    'approvalStatus', 'Pending',
    'submittedByAccountId', v_account.id,
    'submittedByUsername', v_account.username,
    'submittedByRole', v_account.role,
    'submittedAt', now(),
    'createdAt', now(),
    'createdBy', v_account.display_name,
    'createdByUsername', v_account.username
  );

  v_duty_hours := jsonb_set(
    jsonb_set(v_duty_hours, '{version}', '6'::jsonb, true),
    '{entries}',
    v_entries || jsonb_build_array(v_entry),
    true
  );

  v_activity := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'timestamp', now(),
    'action', 'Submitted duty entry',
    'category', 'Duty Hours',
    'details', p_date || ' • ' || p_time_in || '–' || p_time_out || ' • Pending approval',
    'account', v_account.display_name,
    'username', v_account.username
  );

  v_activity_log := jsonb_build_array(v_activity) ||
    case when jsonb_typeof(v_activity_log) = 'array' then v_activity_log else '[]'::jsonb end;

  if jsonb_array_length(v_activity_log) > 500 then
    select coalesce(jsonb_agg(item order by ordinal_position), '[]'::jsonb)
    into v_activity_log
    from jsonb_array_elements(v_activity_log) with ordinality as records(item, ordinal_position)
    where ordinal_position <= 500;
  end if;

  update public.system_state
  set duty_hours = v_duty_hours,
      activity_log = v_activity_log,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

-- Administrator review. A pending entry can be decided only once.
create or replace function public.lso_review_duty_entry(
  p_token text,
  p_entry_id text,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admin_id uuid;
  v_admin_username text;
  v_admin_display_name text;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_next_entries jsonb;
  v_target jsonb;
  v_activity_log jsonb;
  v_activity jsonb;
begin
  v_admin_id := public.lso_session_account_id(p_token, true);
  select username, display_name
  into v_admin_username, v_admin_display_name
  from public.lso_accounts
  where id = v_admin_id;

  if p_decision not in ('Approved', 'Rejected') then
    raise exception 'Decision must be Approved or Rejected.' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_entry_id, '')), '') is null then
    raise exception 'The duty entry identifier is missing.' using errcode = '22023';
  end if;

  select duty_hours, activity_log
  into v_duty_hours, v_activity_log
  from public.system_state
  where id = 1
  for update;

  if v_duty_hours is null or jsonb_typeof(v_duty_hours) <> 'object' then
    raise exception 'The Duty Hours database is unavailable.' using errcode = 'P0002';
  end if;

  v_entries := case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
    then v_duty_hours -> 'entries' else '[]'::jsonb end;

  select entry
  into v_target
  from jsonb_array_elements(v_entries) as entry
  where entry ->> 'id' = p_entry_id
  limit 1;

  if v_target is null then
    raise exception 'The duty entry could not be found.' using errcode = '22023';
  end if;

  if coalesce(v_target ->> 'approvalStatus', 'Approved') <> 'Pending' then
    raise exception 'This duty entry has already been reviewed.' using errcode = '22023';
  end if;

  if coalesce(v_target ->> 'entryType', 'Duty') <> 'Duty' then
    raise exception 'Only a pending duty entry can be reviewed here.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
    case
      when entry ->> 'id' = p_entry_id and p_decision = 'Approved' then
        (entry - 'rejectedAt' - 'rejectedBy') || jsonb_build_object(
          'approvalStatus', 'Approved',
          'approvedAt', now(),
          'approvedBy', v_admin_username,
          'reviewedAt', now(),
          'reviewedBy', v_admin_username
        )
      when entry ->> 'id' = p_entry_id and p_decision = 'Rejected' then
        (entry - 'approvedAt' - 'approvedBy') || jsonb_build_object(
          'approvalStatus', 'Rejected',
          'rejectedAt', now(),
          'rejectedBy', v_admin_username,
          'reviewedAt', now(),
          'reviewedBy', v_admin_username
        )
      else entry
    end
    order by ordinal_position
  ), '[]'::jsonb)
  into v_next_entries
  from jsonb_array_elements(v_entries)
    with ordinality as records(entry, ordinal_position);

  v_duty_hours := jsonb_set(
    jsonb_set(v_duty_hours, '{version}', '6'::jsonb, true),
    '{entries}', v_next_entries, true
  );

  v_activity := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'timestamp', now(),
    'action', p_decision || ' duty entry',
    'category', 'Duty Hours',
    'details', coalesce(v_target ->> 'submittedByUsername', 'member') || ' • ' ||
               coalesce(v_target ->> 'date', '') || ' • ' ||
               coalesce(v_target ->> 'timeIn', '') || '–' || coalesce(v_target ->> 'timeOut', ''),
    'account', v_admin_display_name,
    'username', v_admin_username
  );

  v_activity_log := jsonb_build_array(v_activity) ||
    case when jsonb_typeof(v_activity_log) = 'array' then v_activity_log else '[]'::jsonb end;

  if jsonb_array_length(v_activity_log) > 500 then
    select coalesce(jsonb_agg(item order by ordinal_position), '[]'::jsonb)
    into v_activity_log
    from jsonb_array_elements(v_activity_log) with ordinality as records(item, ordinal_position)
    where ordinal_position <= 500;
  end if;

  update public.system_state
  set duty_hours = v_duty_hours,
      activity_log = v_activity_log,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

revoke all on function public.lso_local_date() from public;
revoke all on function public.lso_member_period_on_date(jsonb, date) from public;
revoke all on function public.lso_account_json(uuid) from public;
revoke all on function public.lso_save_accounts(text, jsonb) from public;
revoke all on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) from public;
revoke all on function public.lso_review_duty_entry(text, text, text) from public;

grant execute on function public.lso_local_date() to anon, authenticated;
grant execute on function public.lso_member_period_on_date(jsonb, date) to anon, authenticated;
grant execute on function public.lso_account_json(uuid) to anon, authenticated;
grant execute on function public.lso_save_accounts(text, jsonb) to anon, authenticated;
grant execute on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.lso_review_duty_entry(text, text, text) to anon, authenticated;

commit;
notify pgrst, 'reload schema';

-- LSO DUTY PUNCH BUTTONS UPDATE (2026-07-21)
-- LASALLIAN SYMPHONY ORCHESTRA
-- TRAINEE / PROBATIONARY DUTY HOURS: SERVER TIME IN / TIME OUT BUTTONS
-- Existing-project migration. This preserves existing records.

begin;

create extension if not exists pgcrypto;

alter table if exists public.lso_accounts
  add column if not exists member_id text;

alter table if exists public.system_state
  add column if not exists duty_hours jsonb not null default '{"version":6,"commitments":{},"entries":[]}'::jsonb,
  add column if not exists activity_log jsonb not null default '[]'::jsonb,
  add column if not exists members jsonb not null default '[]'::jsonb;

-- One calendar date for the orchestra. The database server, rather than the
-- member's phone or computer clock, is the authoritative time source.
create or replace function public.lso_local_date()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (now() at time zone 'Asia/Manila')::date;
$$;


-- Resolve the member's stage from their recorded timeline. Recreated here so
-- this installer also repairs older projects that do not yet have the helper.
create or replace function public.lso_member_period_on_date(
  p_member jsonb,
  p_on_date date default public.lso_local_date()
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_trainee_start date;
  v_probationary_start date;
  v_membership_start date;
  v_skipped boolean := false;
  v_period text;
  v_stage text;
begin
  if p_member is null or jsonb_typeof(p_member) <> 'object' then return ''; end if;

  begin
    v_trainee_start := nullif(coalesce(p_member ->> 'traineeStartDate', p_member ->> 'dateRegistered'), '')::date;
  exception when others then v_trainee_start := null;
  end;
  begin
    v_probationary_start := nullif(p_member ->> 'probationaryStartDate', '')::date;
  exception when others then v_probationary_start := null;
  end;
  begin
    v_membership_start := nullif(coalesce(p_member ->> 'regularMemberDate', p_member ->> 'membershipStartDate'), '')::date;
  exception when others then v_membership_start := null;
  end;

  v_skipped := lower(coalesce(p_member ->> 'probationarySkipped', 'false')) in ('true', '1', 'yes');
  v_period := coalesce(p_member ->> 'periodGroup', '');
  v_stage := coalesce(p_member ->> 'membershipStage', '');

  if v_membership_start is not null and p_on_date >= v_membership_start then return 'Membership Period'; end if;
  if not v_skipped and v_probationary_start is not null and p_on_date >= v_probationary_start then return 'Probationary Period'; end if;
  if v_trainee_start is not null and p_on_date >= v_trainee_start then return 'Trainee Period'; end if;
  if v_period in ('Trainee Period', 'Probationary Period', 'Membership Period') then return v_period; end if;
  if v_stage = 'Trainee' then return 'Trainee Period'; end if;
  if v_stage = 'Probationary' then return 'Probationary Period'; end if;
  if v_stage in ('Regular Member', 'Member', 'Official Member') then return 'Membership Period'; end if;
  return '';
end;
$$;

-- Start a new same-day duty session. Only one open session is permitted for
-- the linked member. Completed sessions from the same day do not block a new
-- session unless their actual intervals overlap.
create or replace function public.lso_duty_time_in(
  p_token text,
  p_semester text,
  p_description text default '',
  p_member_approvers text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_account public.lso_accounts%rowtype;
  v_now timestamptz;
  v_local_timestamp timestamp;
  v_duty_date date;
  v_time_in text;
  v_member jsonb;
  v_period text;
  v_members jsonb;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_activity_log jsonb;
  v_description text;
  v_member_approvers text;
  v_entry_id text := gen_random_uuid()::text;
  v_entry jsonb;
  v_activity jsonb;
begin
  v_account_id := public.lso_session_account_id(p_token, false);
  select * into v_account
  from public.lso_accounts
  where id = v_account_id;

  if v_account.role <> 'Trainee/Probationary' then
    raise exception 'Only a Trainee/Probationary account may use Duty Hours Time In.' using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(v_account.member_id, '')), '') is null then
    raise exception 'This account is not linked to a member record.' using errcode = '42501';
  end if;

  if p_semester not in ('First Semester', 'Second Semester') then
    raise exception 'Select a valid duty semester.' using errcode = '22023';
  end if;

  v_description := left(btrim(coalesce(p_description, '')), 160);
  v_member_approvers := left(btrim(coalesce(p_member_approvers, '')), 200);
  v_now := clock_timestamp();
  v_local_timestamp := v_now at time zone 'Asia/Manila';
  v_duty_date := v_local_timestamp::date;
  v_time_in := to_char(v_local_timestamp, 'HH24:MI');

  select members, duty_hours, activity_log
  into v_members, v_duty_hours, v_activity_log
  from public.system_state
  where id = 1
  for update;

  if not found then
    raise exception 'The shared system state is missing.' using errcode = 'P0002';
  end if;

  if v_members is null or jsonb_typeof(v_members) <> 'array' then v_members := '[]'::jsonb; end if;
  if v_duty_hours is null or jsonb_typeof(v_duty_hours) <> 'object' then
    v_duty_hours := '{"version":6,"commitments":{},"entries":[]}'::jsonb;
  end if;
  v_entries := case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
    then v_duty_hours -> 'entries' else '[]'::jsonb end;

  select item into v_member
  from jsonb_array_elements(v_members) as item
  where item ->> 'id' = v_account.member_id
  limit 1;

  if v_member is null then
    raise exception 'The linked member record could not be found.' using errcode = '42501';
  end if;

  v_period := public.lso_member_period_on_date(v_member, v_duty_date);
  if v_period not in ('Trainee Period', 'Probationary Period') then
    raise exception 'The linked member is not currently in the Trainee or Probationary Period.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_entries) as entry
    where entry ->> 'memberId' = v_account.member_id
      and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
      and coalesce(entry ->> 'approvalStatus', 'Approved') = 'Active'
  ) then
    raise exception 'You are already clocked in. Record Time Out before starting another duty session.' using errcode = '23505';
  end if;

  -- A prior completed interval may coexist on the same day, but the new Time
  -- In cannot fall inside a pending or approved interval.
  if exists (
    select 1
    from jsonb_array_elements(v_entries) as entry
    where entry ->> 'memberId' = v_account.member_id
      and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
      and entry ->> 'date' = to_char(v_duty_date, 'YYYY-MM-DD')
      and coalesce(entry ->> 'approvalStatus', 'Approved') <> 'Rejected'
      and entry ->> 'timeIn' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and entry ->> 'timeOut' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and (entry ->> 'timeIn')::time <= v_time_in::time
      and (entry ->> 'timeOut')::time > v_time_in::time
  ) then
    raise exception 'The current time overlaps an existing pending or approved duty session.' using errcode = '23505';
  end if;

  v_entry := jsonb_build_object(
    'id', v_entry_id,
    'memberId', v_account.member_id,
    'semester', p_semester,
    'period', v_period,
    'entryType', 'Duty',
    'date', to_char(v_duty_date, 'YYYY-MM-DD'),
    'minutes', 0,
    'timeIn', v_time_in,
    'timeOut', '',
    'clockInAt', v_now,
    'clockOutAt', '',
    'timeSource', 'Supabase server / Asia/Manila',
    'description', v_description,
    'memberApprovers', v_member_approvers,
    'approvalStatus', 'Active',
    'submittedByAccountId', v_account.id,
    'submittedByUsername', v_account.username,
    'submittedByRole', v_account.role,
    'createdAt', v_now,
    'createdBy', v_account.display_name,
    'createdByUsername', v_account.username
  );

  v_duty_hours := jsonb_set(
    jsonb_set(v_duty_hours, '{version}', '6'::jsonb, true),
    '{entries}', v_entries || jsonb_build_array(v_entry), true
  );

  v_activity := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'timestamp', v_now,
    'action', 'Duty Time In',
    'category', 'Duty Hours',
    'details', to_char(v_duty_date, 'YYYY-MM-DD') || ' • ' || v_time_in || ' • Server time',
    'account', v_account.display_name,
    'username', v_account.username
  );

  v_activity_log := jsonb_build_array(v_activity) ||
    case when jsonb_typeof(v_activity_log) = 'array' then v_activity_log else '[]'::jsonb end;

  if jsonb_array_length(v_activity_log) > 500 then
    select coalesce(jsonb_agg(item order by ordinal_position), '[]'::jsonb)
    into v_activity_log
    from jsonb_array_elements(v_activity_log) with ordinality as records(item, ordinal_position)
    where ordinal_position <= 500;
  end if;

  update public.system_state
  set duty_hours = v_duty_hours,
      activity_log = v_activity_log,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

-- Close the member's one active duty session using the current database time.
-- The completed session becomes Pending and contributes zero credited minutes
-- until an Administrator approves it.
create or replace function public.lso_duty_time_out(
  p_token text,
  p_description text default '',
  p_member_approvers text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_account public.lso_accounts%rowtype;
  v_now timestamptz;
  v_local_timestamp timestamp;
  v_time_out text;
  v_today date;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_next_entries jsonb;
  v_activity_log jsonb;
  v_target jsonb;
  v_target_count integer;
  v_start_at timestamptz;
  v_start_date date;
  v_start_time text;
  v_minutes integer;
  v_description text;
  v_member_approvers text;
  v_final_description text;
  v_final_member_approvers text;
  v_activity jsonb;
begin
  v_account_id := public.lso_session_account_id(p_token, false);
  select * into v_account
  from public.lso_accounts
  where id = v_account_id;

  if v_account.role <> 'Trainee/Probationary' then
    raise exception 'Only a Trainee/Probationary account may use Duty Hours Time Out.' using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(v_account.member_id, '')), '') is null then
    raise exception 'This account is not linked to a member record.' using errcode = '42501';
  end if;

  v_description := left(btrim(coalesce(p_description, '')), 160);
  v_member_approvers := left(btrim(coalesce(p_member_approvers, '')), 200);
  v_now := clock_timestamp();
  v_local_timestamp := v_now at time zone 'Asia/Manila';
  v_today := v_local_timestamp::date;
  v_time_out := to_char(v_local_timestamp, 'HH24:MI');

  select duty_hours, activity_log
  into v_duty_hours, v_activity_log
  from public.system_state
  where id = 1
  for update;

  if not found then
    raise exception 'The shared system state is missing.' using errcode = 'P0002';
  end if;

  if v_duty_hours is null or jsonb_typeof(v_duty_hours) <> 'object' then
    raise exception 'The Duty Hours database is unavailable.' using errcode = 'P0002';
  end if;
  v_entries := case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
    then v_duty_hours -> 'entries' else '[]'::jsonb end;

  select count(*)::integer
  into v_target_count
  from jsonb_array_elements(v_entries) as entry
  where entry ->> 'memberId' = v_account.member_id
    and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
    and coalesce(entry ->> 'approvalStatus', 'Approved') = 'Active';

  if v_target_count = 0 then
    raise exception 'There is no active duty session to time out.' using errcode = '22023';
  elsif v_target_count > 1 then
    raise exception 'More than one active duty session was found. Ask the Administrator to correct the duty ledger.' using errcode = 'P0001';
  end if;

  select entry into v_target
  from jsonb_array_elements(v_entries) as entry
  where entry ->> 'memberId' = v_account.member_id
    and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
    and coalesce(entry ->> 'approvalStatus', 'Approved') = 'Active'
  limit 1;

  begin
    v_start_date := (v_target ->> 'date')::date;
  exception when others then
    raise exception 'The active duty session has an invalid start date. Ask the Administrator to correct it.' using errcode = '22023';
  end;

  v_start_time := coalesce(v_target ->> 'timeIn', '');
  if v_start_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'The active duty session has an invalid Time In. Ask the Administrator to correct it.' using errcode = '22023';
  end if;

  begin
    v_start_at := nullif(v_target ->> 'clockInAt', '')::timestamptz;
  exception when others then
    v_start_at := null;
  end;
  if v_start_at is null then
    v_start_at := ((v_start_date::text || ' ' || v_start_time)::timestamp at time zone 'Asia/Manila');
  end if;

  if v_today <> v_start_date then
    raise exception 'This duty session crossed midnight. Ask the Administrator to close or correct the record.' using errcode = '22023';
  end if;

  v_minutes := floor(extract(epoch from (v_now - v_start_at)) / 60)::integer;
  if v_minutes <= 0 then
    raise exception 'Time Out must be later than Time In.' using errcode = '22023';
  end if;
  if v_minutes > 960 then
    raise exception 'A single duty session cannot exceed 16 hours. Ask the Administrator to correct the active record.' using errcode = '22023';
  end if;

  -- Recheck the completed interval against every other non-rejected session.
  if exists (
    select 1
    from jsonb_array_elements(v_entries) as entry
    where (entry ->> 'id') <> (v_target ->> 'id')
      and entry ->> 'memberId' = v_account.member_id
      and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
      and (entry ->> 'date') = (v_target ->> 'date')
      and coalesce(entry ->> 'approvalStatus', 'Approved') <> 'Rejected'
      and entry ->> 'timeIn' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and entry ->> 'timeOut' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and (entry ->> 'timeIn')::time < v_time_out::time
      and (entry ->> 'timeOut')::time > v_start_time::time
  ) then
    raise exception 'This completed duty session overlaps another pending or approved session.' using errcode = '23505';
  end if;

  v_final_description := v_description;
  v_final_member_approvers := v_member_approvers;

  select coalesce(jsonb_agg(
    case
      when (entry ->> 'id') = (v_target ->> 'id') then
        entry || jsonb_build_object(
          'timeOut', v_time_out,
          'clockOutAt', v_now,
          'minutes', v_minutes,
          'description', v_final_description,
          'memberApprovers', v_final_member_approvers,
          'approvalStatus', 'Pending',
          'submittedAt', v_now
        )
      else entry
    end
    order by ordinal_position
  ), '[]'::jsonb)
  into v_next_entries
  from jsonb_array_elements(v_entries) with ordinality as records(entry, ordinal_position);

  v_duty_hours := jsonb_set(
    jsonb_set(v_duty_hours, '{version}', '6'::jsonb, true),
    '{entries}', v_next_entries, true
  );

  v_activity := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'timestamp', v_now,
    'action', 'Duty Time Out',
    'category', 'Duty Hours',
    'details', (v_target ->> 'date') || ' • ' || v_start_time || '–' || v_time_out || ' • Pending approval',
    'account', v_account.display_name,
    'username', v_account.username
  );

  v_activity_log := jsonb_build_array(v_activity) ||
    case when jsonb_typeof(v_activity_log) = 'array' then v_activity_log else '[]'::jsonb end;

  if jsonb_array_length(v_activity_log) > 500 then
    select coalesce(jsonb_agg(item order by ordinal_position), '[]'::jsonb)
    into v_activity_log
    from jsonb_array_elements(v_activity_log) with ordinality as records(item, ordinal_position)
    where ordinal_position <= 500;
  end if;

  update public.system_state
  set duty_hours = v_duty_hours,
      activity_log = v_activity_log,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

revoke all on function public.lso_member_period_on_date(jsonb, date) from public;
grant execute on function public.lso_member_period_on_date(jsonb, date) to anon, authenticated;

revoke all on function public.lso_duty_time_in(text, text, text, text) from public;
revoke all on function public.lso_duty_time_out(text, text, text) from public;
grant execute on function public.lso_duty_time_in(text, text, text, text) to anon, authenticated;
grant execute on function public.lso_duty_time_out(text, text, text) to anon, authenticated;

commit;
notify pgrst, 'reload schema';

-- ============================================================================
-- SEPARATE DUTY PUNCH APPROVAL UPDATE (Time In and Time Out reviewed separately)
-- ============================================================================
-- LASALLIAN SYMPHONY ORCHESTRA
-- DUTY HOURS: SEPARATE TIME IN / TIME OUT APPROVAL
-- Existing-project installer. Safe to run once after the prior stable LSO setup.
-- This does not delete members, accounts, attendance, reports, or prior duty records.

begin;

create extension if not exists pgcrypto;

alter table public.lso_accounts
  add column if not exists member_id text;

alter table public.system_state
  add column if not exists members jsonb not null default '[]'::jsonb,
  add column if not exists duty_hours jsonb not null
  default '{"version":7,"commitments":{},"entries":[]}'::jsonb;

alter table public.system_state
  add column if not exists activity_log jsonb not null default '[]'::jsonb;


create or replace function public.lso_local_date()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (now() at time zone 'Asia/Manila')::date;
$$;

create or replace function public.lso_member_period_on_date(
  p_member jsonb,
  p_on_date date default public.lso_local_date()
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_trainee_start date;
  v_probationary_start date;
  v_membership_start date;
  v_skipped boolean := false;
  v_period text;
  v_stage text;
begin
  if p_member is null or jsonb_typeof(p_member) <> 'object' then return ''; end if;
  begin
    v_trainee_start := nullif(coalesce(p_member ->> 'traineeStartDate', p_member ->> 'dateRegistered'), '')::date;
  exception when others then v_trainee_start := null;
  end;
  begin
    v_probationary_start := nullif(p_member ->> 'probationaryStartDate', '')::date;
  exception when others then v_probationary_start := null;
  end;
  begin
    v_membership_start := nullif(coalesce(p_member ->> 'regularMemberDate', p_member ->> 'membershipStartDate'), '')::date;
  exception when others then v_membership_start := null;
  end;
  v_skipped := lower(coalesce(p_member ->> 'probationarySkipped', 'false')) in ('true', '1', 'yes');
  v_period := coalesce(p_member ->> 'periodGroup', '');
  v_stage := coalesce(p_member ->> 'membershipStage', '');
  if v_membership_start is not null and p_on_date >= v_membership_start then return 'Membership Period'; end if;
  if not v_skipped and v_probationary_start is not null and p_on_date >= v_probationary_start then return 'Probationary Period'; end if;
  if v_trainee_start is not null and p_on_date >= v_trainee_start then return 'Trainee Period'; end if;
  if v_period in ('Trainee Period', 'Probationary Period', 'Membership Period') then return v_period; end if;
  if v_stage = 'Trainee' then return 'Trainee Period'; end if;
  if v_stage = 'Probationary' then return 'Probationary Period'; end if;
  if v_stage in ('Regular Member', 'Member', 'Official Member') then return 'Membership Period'; end if;
  return '';
end;
$$;

-- Upgrade existing Duty Hours entries to the separate-punch status shape.
-- Legacy completed records remain completed. Legacy open records remain usable.
update public.system_state
set duty_hours = jsonb_set(
  jsonb_set(
    case
      when duty_hours is null or jsonb_typeof(duty_hours) <> 'object'
        then '{"version":7,"commitments":{},"entries":[]}'::jsonb
      else duty_hours
    end,
    '{version}',
    '7'::jsonb,
    true
  ),
  '{entries}',
  coalesce((
    select jsonb_agg(
      case
        when coalesce(entry ->> 'entryType', 'Duty') <> 'Duty' then entry
        else entry || jsonb_build_object(
          'timeInApprovalStatus',
            case
              when entry ? 'timeInApprovalStatus' then entry ->> 'timeInApprovalStatus'
              when nullif(entry ->> 'timeIn', '') is null then 'Not Submitted'
              when coalesce(entry ->> 'approvalStatus', 'Approved') = 'Pending'
                   and nullif(entry ->> 'timeOut', '') is null then 'Pending'
              when coalesce(entry ->> 'approvalStatus', 'Approved') = 'Rejected'
                   and nullif(entry ->> 'timeOut', '') is null then 'Rejected'
              else 'Approved'
            end,
          'timeOutApprovalStatus',
            case
              when entry ? 'timeOutApprovalStatus' then entry ->> 'timeOutApprovalStatus'
              when nullif(entry ->> 'timeOut', '') is null then 'Not Submitted'
              when coalesce(entry ->> 'approvalStatus', 'Approved') = 'Approved' then 'Approved'
              when coalesce(entry ->> 'approvalStatus', 'Approved') = 'Rejected' then 'Rejected'
              else 'Pending'
            end,
          'timeInRequestedAt', coalesce(nullif(entry ->> 'timeInRequestedAt', ''), nullif(entry ->> 'clockInAt', ''), nullif(entry ->> 'createdAt', '')),
          'timeOutRequestedAt', coalesce(nullif(entry ->> 'timeOutRequestedAt', ''), nullif(entry ->> 'clockOutAt', ''), nullif(entry ->> 'submittedAt', '')),
          'punchAudit', case when jsonb_typeof(entry -> 'punchAudit') = 'array' then entry -> 'punchAudit' else '[]'::jsonb end
        )
      end
      order by ordinal_position
    )
    from jsonb_array_elements(
      case
        when jsonb_typeof(duty_hours -> 'entries') = 'array' then duty_hours -> 'entries'
        else '[]'::jsonb
      end
    ) with ordinality as records(entry, ordinal_position)
  ), '[]'::jsonb),
  true
),
updated_at = now()
where id = 1;

-- Submit a Time In request. It is NOT official until an Administrator approves
-- this specific punch. The secure database time in Asia/Manila is authoritative.
create or replace function public.lso_duty_time_in(
  p_token text,
  p_semester text,
  p_description text default '',
  p_member_approvers text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_account public.lso_accounts%rowtype;
  v_now timestamptz := clock_timestamp();
  v_local_timestamp timestamp;
  v_duty_date date;
  v_time_in text;
  v_member jsonb;
  v_period text;
  v_members jsonb;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_activity_log jsonb;
  v_entry_id text := gen_random_uuid()::text;
  v_entry jsonb;
  v_activity jsonb;
  v_description text := left(btrim(coalesce(p_description, '')), 160);
  v_member_approvers text := left(btrim(coalesce(p_member_approvers, '')), 200);
begin
  v_account_id := public.lso_session_account_id(p_token, false);
  select * into v_account from public.lso_accounts where id = v_account_id;

  if v_account.role <> 'Trainee/Probationary' then
    raise exception 'Only a Trainee/Probationary account may submit Duty Hours.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(v_account.member_id, '')), '') is null then
    raise exception 'This account is not linked to a member record.' using errcode = '42501';
  end if;
  if p_semester not in ('First Semester', 'Second Semester') then
    raise exception 'Select a valid duty semester.' using errcode = '22023';
  end if;

  v_local_timestamp := v_now at time zone 'Asia/Manila';
  v_duty_date := v_local_timestamp::date;
  v_time_in := to_char(v_local_timestamp, 'HH24:MI');

  select members, duty_hours, activity_log
  into v_members, v_duty_hours, v_activity_log
  from public.system_state
  where id = 1
  for update;

  if not found then
    raise exception 'The shared system state is missing.' using errcode = 'P0002';
  end if;
  if v_members is null or jsonb_typeof(v_members) <> 'array' then v_members := '[]'::jsonb; end if;
  if v_duty_hours is null or jsonb_typeof(v_duty_hours) <> 'object' then
    v_duty_hours := '{"version":7,"commitments":{},"entries":[]}'::jsonb;
  end if;
  v_entries := case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
    then v_duty_hours -> 'entries' else '[]'::jsonb end;

  select item into v_member
  from jsonb_array_elements(v_members) as item
  where item ->> 'id' = v_account.member_id
  limit 1;

  if v_member is null then
    raise exception 'The linked member record could not be found.' using errcode = '42501';
  end if;

  v_period := public.lso_member_period_on_date(v_member, v_duty_date);
  if v_period not in ('Trainee Period', 'Probationary Period') then
    raise exception 'The linked member is not currently in the Trainee or Probationary Period.' using errcode = '42501';
  end if;

  -- Only one punch may remain open without a Time Out request.
  if exists (
    select 1
    from jsonb_array_elements(v_entries) as entry
    where (entry ->> 'memberId') = v_account.member_id
      and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
      and nullif(entry ->> 'timeOut', '') is null
      and coalesce(
        nullif(entry ->> 'timeInApprovalStatus', ''),
        case when coalesce(entry ->> 'approvalStatus', 'Approved') in ('Pending', 'Active') then 'Pending' else 'Approved' end
      ) in ('Pending', 'Approved')
  ) then
    raise exception 'You already have an open Time In request. Submit Time Out before starting another session.' using errcode = '23505';
  end if;

  -- A new request may follow a prior Time Out request on the same day, but its
  -- server time cannot fall inside another non-rejected interval.
  if exists (
    select 1
    from jsonb_array_elements(v_entries) as entry
    where (entry ->> 'memberId') = v_account.member_id
      and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
      and entry ->> 'date' = to_char(v_duty_date, 'YYYY-MM-DD')
      and coalesce(nullif(entry ->> 'timeInApprovalStatus', ''), 'Approved') <> 'Rejected'
      and coalesce(nullif(entry ->> 'timeOutApprovalStatus', ''), 'Approved') not in ('Rejected', 'Cancelled')
      and entry ->> 'timeIn' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and entry ->> 'timeOut' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and (entry ->> 'timeIn')::time <= v_time_in::time
      and (entry ->> 'timeOut')::time > v_time_in::time
  ) then
    raise exception 'The current time overlaps an existing duty session.' using errcode = '23505';
  end if;

  v_entry := jsonb_build_object(
    'id', v_entry_id,
    'memberId', v_account.member_id,
    'semester', p_semester,
    'period', v_period,
    'entryType', 'Duty',
    'date', to_char(v_duty_date, 'YYYY-MM-DD'),
    'minutes', 0,
    'timeIn', v_time_in,
    'timeOut', '',
    'clockInAt', v_now,
    'clockOutAt', '',
    'timeSource', 'Supabase server / Asia/Manila',
    'description', v_description,
    'memberApprovers', v_member_approvers,
    'approvalStatus', 'Pending',
    'timeInApprovalStatus', 'Pending',
    'timeOutApprovalStatus', 'Not Submitted',
    'timeInRequestedAt', v_now,
    'timeInReviewedAt', '',
    'timeInReviewedBy', '',
    'timeOutRequestedAt', '',
    'timeOutReviewedAt', '',
    'timeOutReviewedBy', '',
    'punchAudit', jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'timestamp', v_now,
      'punchType', 'TimeIn',
      'action', 'Submitted',
      'by', v_account.username
    )),
    'submittedByAccountId', v_account.id,
    'submittedByUsername', v_account.username,
    'submittedByRole', v_account.role,
    'createdAt', v_now,
    'createdBy', v_account.display_name,
    'createdByUsername', v_account.username
  );

  v_duty_hours := jsonb_set(
    jsonb_set(v_duty_hours, '{version}', '7'::jsonb, true),
    '{entries}', v_entries || jsonb_build_array(v_entry), true
  );

  v_activity := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'timestamp', v_now,
    'action', 'Submitted Duty Time In',
    'category', 'Duty Hours',
    'details', to_char(v_duty_date, 'YYYY-MM-DD') || ' • ' || v_time_in || ' • Pending Administrator approval',
    'account', v_account.display_name,
    'username', v_account.username
  );
  v_activity_log := jsonb_build_array(v_activity) ||
    case when jsonb_typeof(v_activity_log) = 'array' then v_activity_log else '[]'::jsonb end;

  update public.system_state
  set duty_hours = v_duty_hours,
      activity_log = v_activity_log,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

-- Submit Time Out for the member's one open punch. Time In may still be
-- pending. Time Out is a separate request and is not official automatically.
create or replace function public.lso_duty_time_out(
  p_token text,
  p_description text default '',
  p_member_approvers text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account_id uuid;
  v_account public.lso_accounts%rowtype;
  v_now timestamptz := clock_timestamp();
  v_local_timestamp timestamp;
  v_today date;
  v_time_out text;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_next_entries jsonb;
  v_activity_log jsonb;
  v_target jsonb;
  v_target_count integer;
  v_start_at timestamptz;
  v_start_date date;
  v_start_time text;
  v_minutes integer;
  v_description text := left(btrim(coalesce(p_description, '')), 160);
  v_member_approvers text := left(btrim(coalesce(p_member_approvers, '')), 200);
  v_final_description text;
  v_final_member_approvers text;
  v_in_status text;
  v_next_overall text;
  v_activity jsonb;
begin
  v_account_id := public.lso_session_account_id(p_token, false);
  select * into v_account from public.lso_accounts where id = v_account_id;

  if v_account.role <> 'Trainee/Probationary' then
    raise exception 'Only a Trainee/Probationary account may submit Duty Hours.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(v_account.member_id, '')), '') is null then
    raise exception 'This account is not linked to a member record.' using errcode = '42501';
  end if;

  v_local_timestamp := v_now at time zone 'Asia/Manila';
  v_today := v_local_timestamp::date;
  v_time_out := to_char(v_local_timestamp, 'HH24:MI');

  select duty_hours, activity_log
  into v_duty_hours, v_activity_log
  from public.system_state
  where id = 1
  for update;

  if not found then
    raise exception 'The shared system state is missing.' using errcode = 'P0002';
  end if;
  if v_duty_hours is null or jsonb_typeof(v_duty_hours) <> 'object' then
    raise exception 'The Duty Hours database is unavailable.' using errcode = 'P0002';
  end if;
  v_entries := case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
    then v_duty_hours -> 'entries' else '[]'::jsonb end;

  select count(*)::integer
  into v_target_count
  from jsonb_array_elements(v_entries) as entry
  where (entry ->> 'memberId') = v_account.member_id
    and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
    and nullif(entry ->> 'timeOut', '') is null
    and coalesce(
      nullif(entry ->> 'timeInApprovalStatus', ''),
      case when coalesce(entry ->> 'approvalStatus', 'Approved') in ('Pending', 'Active') then 'Pending' else 'Approved' end
    ) in ('Pending', 'Approved');

  if v_target_count = 0 then
    raise exception 'There is no open Time In request to close.' using errcode = '22023';
  elsif v_target_count > 1 then
    raise exception 'More than one open Time In request was found. Ask the Administrator to correct the duty ledger.' using errcode = 'P0001';
  end if;

  select entry into v_target
  from jsonb_array_elements(v_entries) as entry
  where (entry ->> 'memberId') = v_account.member_id
    and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
    and nullif(entry ->> 'timeOut', '') is null
    and coalesce(
      nullif(entry ->> 'timeInApprovalStatus', ''),
      case when coalesce(entry ->> 'approvalStatus', 'Approved') in ('Pending', 'Active') then 'Pending' else 'Approved' end
    ) in ('Pending', 'Approved')
  order by coalesce(entry ->> 'createdAt', '') desc
  limit 1;

  begin
    v_start_date := (v_target ->> 'date')::date;
  exception when others then
    raise exception 'The open duty session has an invalid start date.' using errcode = '22023';
  end;
  v_start_time := coalesce(v_target ->> 'timeIn', '');
  if v_start_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'The open duty session has an invalid Time In.' using errcode = '22023';
  end if;
  begin
    v_start_at := nullif(v_target ->> 'clockInAt', '')::timestamptz;
  exception when others then
    v_start_at := null;
  end;
  if v_start_at is null then
    v_start_at := ((v_start_date::text || ' ' || v_start_time)::timestamp at time zone 'Asia/Manila');
  end if;
  if v_today <> v_start_date then
    raise exception 'This duty request crossed midnight. Ask the Administrator to correct the record.' using errcode = '22023';
  end if;

  v_minutes := floor(extract(epoch from (v_now - v_start_at)) / 60)::integer;
  if v_minutes <= 0 then
    raise exception 'Time Out must be later than Time In.' using errcode = '22023';
  end if;
  if v_minutes > 960 then
    raise exception 'A single duty session cannot exceed 16 hours.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_entries) as entry
    where (entry ->> 'id') <> (v_target ->> 'id')
      and (entry ->> 'memberId') = v_account.member_id
      and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
      and (entry ->> 'date') = (v_target ->> 'date')
      and coalesce(nullif(entry ->> 'timeInApprovalStatus', ''), 'Approved') <> 'Rejected'
      and coalesce(nullif(entry ->> 'timeOutApprovalStatus', ''), 'Approved') not in ('Rejected', 'Cancelled')
      and entry ->> 'timeIn' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and entry ->> 'timeOut' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and (entry ->> 'timeIn')::time < v_time_out::time
      and (entry ->> 'timeOut')::time > v_start_time::time
  ) then
    raise exception 'This Time Out would overlap another duty session.' using errcode = '23505';
  end if;

  v_final_description := case when v_description <> '' then v_description else coalesce(v_target ->> 'description', '') end;
  v_final_member_approvers := case when v_member_approvers <> '' then v_member_approvers else coalesce(v_target ->> 'memberApprovers', '') end;
  v_in_status := coalesce(nullif(v_target ->> 'timeInApprovalStatus', ''), 'Pending');
  v_next_overall := case when v_in_status = 'Approved' then 'Active' else 'Pending' end;

  select coalesce(jsonb_agg(
    case
      when (entry ->> 'id') = (v_target ->> 'id') then
        entry || jsonb_build_object(
          'timeOut', v_time_out,
          'clockOutAt', v_now,
          'minutes', v_minutes,
          'description', v_final_description,
          'memberApprovers', v_final_member_approvers,
          'timeOutApprovalStatus', 'Pending',
          'timeOutRequestedAt', v_now,
          'timeOutReviewedAt', '',
          'timeOutReviewedBy', '',
          'approvalStatus', v_next_overall,
          'submittedAt', v_now,
          'punchAudit', (case when jsonb_typeof(entry -> 'punchAudit') = 'array' then entry -> 'punchAudit' else '[]'::jsonb end) ||
            jsonb_build_array(jsonb_build_object(
              'id', gen_random_uuid()::text,
              'timestamp', v_now,
              'punchType', 'TimeOut',
              'action', 'Submitted',
              'by', v_account.username
            ))
        )
      else entry
    end
    order by ordinal_position
  ), '[]'::jsonb)
  into v_next_entries
  from jsonb_array_elements(v_entries) with ordinality as records(entry, ordinal_position);

  v_duty_hours := jsonb_set(
    jsonb_set(v_duty_hours, '{version}', '7'::jsonb, true),
    '{entries}', v_next_entries, true
  );

  v_activity := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'timestamp', v_now,
    'action', 'Submitted Duty Time Out',
    'category', 'Duty Hours',
    'details', (v_target ->> 'date') || ' • ' || v_start_time || '–' || v_time_out || ' • Pending separate approval',
    'account', v_account.display_name,
    'username', v_account.username
  );
  v_activity_log := jsonb_build_array(v_activity) ||
    case when jsonb_typeof(v_activity_log) = 'array' then v_activity_log else '[]'::jsonb end;

  update public.system_state
  set duty_hours = v_duty_hours,
      activity_log = v_activity_log,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

-- Review one punch only. Time Out approval is blocked until Time In has been
-- approved. Duty minutes are credited only after both punch statuses are Approved.
create or replace function public.lso_review_duty_punch(
  p_token text,
  p_entry_id text,
  p_punch_type text,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admin_id uuid;
  v_admin_username text;
  v_admin_display_name text;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_next_entries jsonb;
  v_target jsonb;
  v_activity_log jsonb;
  v_activity jsonb;
  v_in_status text;
  v_out_status text;
  v_current_status text;
  v_next_overall text;
  v_now timestamptz := clock_timestamp();
  v_punch_label text;
  v_punch_time text;
begin
  v_admin_id := public.lso_session_account_id(p_token, true);
  select username, display_name
  into v_admin_username, v_admin_display_name
  from public.lso_accounts
  where id = v_admin_id;

  if p_punch_type not in ('TimeIn', 'TimeOut') then
    raise exception 'Punch type must be TimeIn or TimeOut.' using errcode = '22023';
  end if;
  if p_decision not in ('Approved', 'Rejected') then
    raise exception 'Decision must be Approved or Rejected.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_entry_id, '')), '') is null then
    raise exception 'The duty entry identifier is missing.' using errcode = '22023';
  end if;

  select duty_hours, activity_log
  into v_duty_hours, v_activity_log
  from public.system_state
  where id = 1
  for update;

  if v_duty_hours is null or jsonb_typeof(v_duty_hours) <> 'object' then
    raise exception 'The Duty Hours database is unavailable.' using errcode = 'P0002';
  end if;
  v_entries := case when jsonb_typeof(v_duty_hours -> 'entries') = 'array'
    then v_duty_hours -> 'entries' else '[]'::jsonb end;

  select entry into v_target
  from jsonb_array_elements(v_entries) as entry
  where (entry ->> 'id') = p_entry_id
  limit 1;

  if v_target is null then
    raise exception 'The duty entry could not be found.' using errcode = '22023';
  end if;
  if coalesce(v_target ->> 'entryType', 'Duty') <> 'Duty' then
    raise exception 'Only Duty Hours punches can be reviewed here.' using errcode = '22023';
  end if;

  v_in_status := coalesce(nullif(v_target ->> 'timeInApprovalStatus', ''),
    case
      when coalesce(v_target ->> 'approvalStatus', 'Approved') = 'Pending' and nullif(v_target ->> 'timeOut', '') is null then 'Pending'
      when coalesce(v_target ->> 'approvalStatus', 'Approved') = 'Rejected' and nullif(v_target ->> 'timeOut', '') is null then 'Rejected'
      else 'Approved'
    end);
  v_out_status := coalesce(nullif(v_target ->> 'timeOutApprovalStatus', ''),
    case
      when nullif(v_target ->> 'timeOut', '') is null then 'Not Submitted'
      when coalesce(v_target ->> 'approvalStatus', 'Approved') = 'Approved' then 'Approved'
      when coalesce(v_target ->> 'approvalStatus', 'Approved') = 'Rejected' then 'Rejected'
      else 'Pending'
    end);
  v_current_status := case when p_punch_type = 'TimeIn' then v_in_status else v_out_status end;

  if v_current_status <> 'Pending' then
    raise exception 'This punch request is no longer pending.' using errcode = '22023';
  end if;
  if p_punch_type = 'TimeOut' and p_decision = 'Approved' and v_in_status <> 'Approved' then
    raise exception 'Approve the linked Time In request before approving Time Out.' using errcode = '22023';
  end if;

  if p_punch_type = 'TimeIn' and p_decision = 'Approved' then
    -- Approval order is chronological. A later Time In cannot become official
    -- while an earlier approved Time In is still missing an approved Time Out.
    if exists (
      select 1
      from jsonb_array_elements(v_entries) as entry
      where (entry ->> 'id') <> p_entry_id
        and (entry ->> 'memberId') = (v_target ->> 'memberId')
        and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
        and coalesce(nullif(entry ->> 'timeInApprovalStatus', ''),
          case when coalesce(entry ->> 'approvalStatus', '') in ('Active', 'Approved') then 'Approved' else 'Pending' end) = 'Approved'
        and coalesce(nullif(entry ->> 'timeOutApprovalStatus', ''),
          case when coalesce(entry ->> 'approvalStatus', '') = 'Approved' then 'Approved' else 'Not Submitted' end) not in ('Approved', 'Rejected', 'Cancelled')
        and coalesce(nullif(entry ->> 'timeInApprovalStatus', ''), 'Approved') <> 'Rejected'
        and coalesce(nullif(entry ->> 'clockInAt', ''), nullif(entry ->> 'createdAt', '')) <
            coalesce(nullif(v_target ->> 'clockInAt', ''), nullif(v_target ->> 'createdAt', ''))
    ) then
      raise exception 'Approve or resolve the earlier session Time Out before approving this Time In.' using errcode = '22023';
    end if;
  end if;

  if p_punch_type = 'TimeOut' and p_decision = 'Approved' then
    -- Prevent an approved session from overlapping another approved session.
    if exists (
      select 1
      from jsonb_array_elements(v_entries) as entry
      where (entry ->> 'id') <> p_entry_id
        and (entry ->> 'memberId') = (v_target ->> 'memberId')
        and coalesce(entry ->> 'entryType', 'Duty') = 'Duty'
        and (entry ->> 'date') = (v_target ->> 'date')
        and coalesce(nullif(entry ->> 'timeInApprovalStatus', ''), 'Approved') = 'Approved'
        and coalesce(nullif(entry ->> 'timeOutApprovalStatus', ''),
          case when coalesce(entry ->> 'approvalStatus', '') = 'Approved' then 'Approved' else 'Not Submitted' end) = 'Approved'
        and entry ->> 'timeIn' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and entry ->> 'timeOut' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and (v_target ->> 'timeIn') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and (v_target ->> 'timeOut') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and (entry ->> 'timeIn')::time < (v_target ->> 'timeOut')::time
        and (entry ->> 'timeOut')::time > (v_target ->> 'timeIn')::time
    ) then
      raise exception 'This approved Time Out would create an overlapping duty session.' using errcode = '23505';
    end if;
  end if;

  v_punch_label := case when p_punch_type = 'TimeOut' then 'Time Out' else 'Time In' end;
  v_punch_time := case when p_punch_type = 'TimeOut' then v_target ->> 'timeOut' else v_target ->> 'timeIn' end;

  select coalesce(jsonb_agg(
    case
      when (entry ->> 'id') <> p_entry_id then entry
      when p_punch_type = 'TimeIn' and p_decision = 'Approved' then
        entry || jsonb_build_object(
          'timeInApprovalStatus', 'Approved',
          'timeInReviewedAt', v_now,
          'timeInReviewedBy', v_admin_username,
          'approvalStatus', case when v_out_status = 'Approved' then 'Approved' else 'Active' end,
          'approvedAt', case when v_out_status = 'Approved' then v_now::text else coalesce(nullif(entry ->> 'approvedAt', ''), '') end,
          'approvedBy', case when v_out_status = 'Approved' then v_admin_username else coalesce(entry ->> 'approvedBy', '') end,
          'reviewedAt', v_now,
          'reviewedBy', v_admin_username,
          'punchAudit', (case when jsonb_typeof(entry -> 'punchAudit') = 'array' then entry -> 'punchAudit' else '[]'::jsonb end) ||
            jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'timestamp', v_now, 'punchType', 'TimeIn', 'action', 'Approved', 'by', v_admin_username))
        )
      when p_punch_type = 'TimeIn' and p_decision = 'Rejected' then
        entry || jsonb_build_object(
          'timeInApprovalStatus', 'Rejected',
          'timeInReviewedAt', v_now,
          'timeInReviewedBy', v_admin_username,
          'approvalStatus', 'Rejected',
          'rejectedAt', v_now,
          'rejectedBy', v_admin_username,
          'reviewedAt', v_now,
          'reviewedBy', v_admin_username,
          'punchAudit', (case when jsonb_typeof(entry -> 'punchAudit') = 'array' then entry -> 'punchAudit' else '[]'::jsonb end) ||
            jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'timestamp', v_now, 'punchType', 'TimeIn', 'action', 'Rejected', 'by', v_admin_username))
        )
      when p_punch_type = 'TimeOut' and p_decision = 'Approved' then
        entry || jsonb_build_object(
          'timeOutApprovalStatus', 'Approved',
          'timeOutReviewedAt', v_now,
          'timeOutReviewedBy', v_admin_username,
          'approvalStatus', 'Approved',
          'approvedAt', v_now,
          'approvedBy', v_admin_username,
          'reviewedAt', v_now,
          'reviewedBy', v_admin_username,
          'punchAudit', (case when jsonb_typeof(entry -> 'punchAudit') = 'array' then entry -> 'punchAudit' else '[]'::jsonb end) ||
            jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'timestamp', v_now, 'punchType', 'TimeOut', 'action', 'Approved', 'by', v_admin_username))
        )
      when p_punch_type = 'TimeOut' and p_decision = 'Rejected' then
        entry || jsonb_build_object(
          'timeOutApprovalStatus', 'Rejected',
          'timeOutReviewedAt', v_now,
          'timeOutReviewedBy', v_admin_username,
          'approvalStatus', 'Rejected',
          'rejectedAt', v_now,
          'rejectedBy', v_admin_username,
          'reviewedAt', v_now,
          'reviewedBy', v_admin_username,
          'punchAudit', (case when jsonb_typeof(entry -> 'punchAudit') = 'array' then entry -> 'punchAudit' else '[]'::jsonb end) ||
            jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'timestamp', v_now, 'punchType', 'TimeOut', 'action', 'Rejected', 'by', v_admin_username))
        )
      else entry
    end
    order by ordinal_position
  ), '[]'::jsonb)
  into v_next_entries
  from jsonb_array_elements(v_entries) with ordinality as records(entry, ordinal_position);

  v_duty_hours := jsonb_set(
    jsonb_set(v_duty_hours, '{version}', '7'::jsonb, true),
    '{entries}', v_next_entries, true
  );

  v_activity := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'timestamp', v_now,
    'action', p_decision || ' Duty ' || v_punch_label,
    'category', 'Duty Hours',
    'details', coalesce(v_target ->> 'submittedByUsername', 'member') || ' • ' ||
               coalesce(v_target ->> 'date', '') || ' • ' || coalesce(v_punch_time, ''),
    'account', v_admin_display_name,
    'username', v_admin_username
  );
  v_activity_log := jsonb_build_array(v_activity) ||
    case when jsonb_typeof(v_activity_log) = 'array' then v_activity_log else '[]'::jsonb end;

  update public.system_state
  set duty_hours = v_duty_hours,
      activity_log = v_activity_log,
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

revoke all on function public.lso_local_date() from public;
revoke all on function public.lso_member_period_on_date(jsonb, date) from public;
grant execute on function public.lso_local_date() to anon, authenticated;
grant execute on function public.lso_member_period_on_date(jsonb, date) to anon, authenticated;

revoke all on function public.lso_duty_time_in(text, text, text, text) from public;
revoke all on function public.lso_duty_time_out(text, text, text) from public;
revoke all on function public.lso_review_duty_punch(text, text, text, text) from public;

grant execute on function public.lso_duty_time_in(text, text, text, text) to anon, authenticated;
grant execute on function public.lso_duty_time_out(text, text, text) to anon, authenticated;
grant execute on function public.lso_review_duty_punch(text, text, text, text) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
