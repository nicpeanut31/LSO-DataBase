-- LASALLIAN SYMPHONY ORCHESTRA
-- MASTER DATABASE REPAIR — SAFE FOR EXISTING PROJECTS
--
-- Run this entire file once in Supabase > SQL Editor > New query.
-- It preserves existing records. It repairs older database schemas, the
-- Trainee/Probationary account role, account-to-member linking, login state
-- loading, and Duty Hours submission/approval.

begin;

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- 1. REQUIRED TABLE/COLUMN COMPATIBILITY
-- --------------------------------------------------------------------------

-- The account table already exists in an installed LSO project. This statement
-- makes the repair fail clearly rather than producing misleading follow-up errors.
do $$
begin
  if to_regclass('public.lso_accounts') is null then
    raise exception 'public.lso_accounts does not exist. Run the complete supabase-setup.sql first.';
  end if;
  if to_regclass('public.system_state') is null then
    raise exception 'public.system_state does not exist. Run the complete supabase-setup.sql first.';
  end if;
end;
$$;

alter table public.lso_accounts
  add column if not exists member_id text;

-- Add every shared-state column expected by the current website. Existing data
-- is retained; only missing fields are created.
alter table public.system_state
  add column if not exists members jsonb,
  add column if not exists events jsonb,
  add column if not exists attendance jsonb,
  add column if not exists duty_hours jsonb,
  add column if not exists monthly_reports jsonb,
  add column if not exists instruments jsonb,
  add column if not exists settings jsonb,
  add column if not exists activity_log jsonb,
  add column if not exists updated_at timestamptz;

insert into public.system_state (id)
values (1)
on conflict (id) do nothing;

update public.system_state
set members = coalesce(members, '[]'::jsonb),
    events = coalesce(events, '[]'::jsonb),
    attendance = coalesce(attendance, '[]'::jsonb),
    duty_hours = coalesce(duty_hours, '{"version":4,"commitments":{},"entries":[]}'::jsonb),
    monthly_reports = coalesce(
      monthly_reports,
      case
        when jsonb_typeof(settings -> '__lso_monthly_reports_v1') = 'object'
          then settings -> '__lso_monthly_reports_v1'
        else '{"version":1,"reports":{},"civilStatusByMember":{},"traineeFiles":{}}'::jsonb
      end
    ),
    instruments = coalesce(instruments, '[]'::jsonb),
    settings = coalesce(settings, '{}'::jsonb),
    activity_log = coalesce(activity_log, '[]'::jsonb),
    updated_at = coalesce(updated_at, now());

alter table public.system_state
  alter column members set default '[]'::jsonb,
  alter column members set not null,
  alter column events set default '[]'::jsonb,
  alter column events set not null,
  alter column attendance set default '[]'::jsonb,
  alter column attendance set not null,
  alter column duty_hours set default '{"version":4,"commitments":{},"entries":[]}'::jsonb,
  alter column duty_hours set not null,
  alter column monthly_reports set default '{"version":1,"reports":{},"civilStatusByMember":{},"traineeFiles":{}}'::jsonb,
  alter column monthly_reports set not null,
  alter column instruments set default '[]'::jsonb,
  alter column instruments set not null,
  alter column settings set default '{}'::jsonb,
  alter column settings set not null,
  alter column activity_log set default '[]'::jsonb,
  alter column activity_log set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

-- Replace any older role CHECK constraint with the current role list.
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

-- --------------------------------------------------------------------------
-- 2. ACCOUNT JSON
-- --------------------------------------------------------------------------

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

-- --------------------------------------------------------------------------
-- 3. COMPATIBILITY-SAFE STATE LOADER
-- --------------------------------------------------------------------------
-- Important: v_state is JSONB, not public.system_state%rowtype. This prevents
-- login from failing when an older database was created before a newer field.

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
    else '{"version":4,"commitments":{},"entries":[]}'::jsonb
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

-- --------------------------------------------------------------------------
-- 4. ADMIN ACCOUNT APPROVAL WITH ROLE + MEMBER LINK
-- --------------------------------------------------------------------------

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

    if v_role = 'Trainee/Probationary'
       and v_status = 'Approved'
       and v_member_id is null then
      raise exception 'A Trainee/Probationary account must be linked to a member before approval.' using errcode = '22023';
    end if;

    begin
      v_disabled := coalesce((v_item ->> 'disabled')::boolean, false);
    exception when others then
      v_disabled := false;
    end;

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

-- --------------------------------------------------------------------------
-- 5. TRAINEE/PROBATIONARY DUTY HOURS SUBMISSION
-- --------------------------------------------------------------------------

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

  if nullif(btrim(coalesce(v_account.member_id, '')), '') is null then
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
        coalesce(duty_hours, '{"version":4,"commitments":{},"entries":[]}'::jsonb),
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
  select username into v_admin_username
  from public.lso_accounts
  where id = v_admin_id;

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
  set duty_hours = jsonb_set(
        coalesce(duty_hours, '{"version":4,"commitments":{},"entries":[]}'::jsonb),
        '{entries}',
        v_entries,
        true
      ),
      updated_at = now()
  where id = 1;

  return public.lso_get_state(p_token);
end;
$$;

-- --------------------------------------------------------------------------
-- 6. PERMISSIONS, VALIDATION, AND POSTGREST CACHE REFRESH
-- --------------------------------------------------------------------------

revoke all on function public.lso_account_json(uuid) from public;
revoke all on function public.lso_get_state(text) from public;
revoke all on function public.lso_save_accounts(text, jsonb) from public;
revoke all on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) from public;
revoke all on function public.lso_review_duty_entry(text, text, text) from public;

grant execute on function public.lso_account_json(uuid) to anon, authenticated;
grant execute on function public.lso_get_state(text) to anon, authenticated;
grant execute on function public.lso_save_accounts(text, jsonb) to anon, authenticated;
grant execute on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.lso_review_duty_entry(text, text, text) to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lso_accounts' and column_name = 'member_id'
  ) then
    raise exception 'Repair failed: public.lso_accounts.member_id is missing.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_state' and column_name = 'monthly_reports'
  ) then
    raise exception 'Repair failed: public.system_state.monthly_reports is missing.';
  end if;
end;
$$;

commit;
notify pgrst, 'reload schema';
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
    duty_hours = coalesce(duty_hours, '{"version":5,"commitments":{},"entries":[]}'::jsonb),
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
            else '{"version":5,"commitments":{},"entries":[]}'::jsonb
          end,
          '{version}', '5'::jsonb, true
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
    v_duty_hours := '{"version":5,"commitments":{},"entries":[]}'::jsonb;
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
    jsonb_set(v_duty_hours, '{version}', '5'::jsonb, true),
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
    jsonb_set(v_duty_hours, '{version}', '5'::jsonb, true),
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
