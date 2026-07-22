-- LSO ACCOUNT ROLES: MEMBERSHIP + GENERAL SECRETARY
-- Run once in Supabase SQL Editor for an existing LSO installation.
-- This migration preserves all existing accounts and system records.

begin;

alter table public.lso_accounts drop constraint if exists lso_accounts_role_check;
alter table public.lso_accounts add constraint lso_accounts_role_check
  check (role in ('Administrator', 'Staff Account', 'Membership', 'General Secretary', 'Trainee/Probationary'));

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
  v_role text;
  v_existing jsonb;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_value jsonb;
  v_event jsonb;
  v_allowed boolean;
begin
  v_account_id := public.lso_session_account_id(p_token, false);
  select role into v_role from public.lso_accounts where id = v_account_id;

  if p_column in ('members', 'events', 'attendance', 'instruments', 'activity_log')
     and jsonb_typeof(p_value) <> 'array' then
    raise exception 'The selected data collection must be a JSON array.' using errcode = '22023';
  end if;
  if p_column in ('settings', 'duty_hours', 'monthly_reports')
     and jsonb_typeof(p_value) <> 'object' then
    raise exception 'The selected data collection must be a JSON object.' using errcode = '22023';
  end if;

  v_allowed := case
    when v_role = 'Administrator' then p_column in ('members','events','attendance','duty_hours','monthly_reports','instruments','settings','activity_log')
    when v_role = 'Membership' then p_column in ('members','events','attendance','duty_hours','monthly_reports','settings','activity_log')
    when v_role = 'General Secretary' then p_column in ('events','attendance','activity_log')
    else false
  end;
  if not v_allowed then
    raise exception 'This account role cannot update the selected system area.' using errcode = '42501';
  end if;

  select case p_column
    when 'members' then members
    when 'events' then events
    when 'attendance' then attendance
    when 'duty_hours' then duty_hours
    when 'monthly_reports' then monthly_reports
    when 'instruments' then instruments
    when 'settings' then settings
    when 'activity_log' then activity_log
  end
  into v_existing
  from public.system_state
  where id = 1
  for update;

  -- Non-administrator attendance roles may create and edit activities, but may
  -- not delete them or alter an already finalized/unlocked attendance workflow.
  if v_role in ('Membership', 'General Secretary') and p_column = 'events' then
    for v_old in select value from jsonb_array_elements(coalesce(v_existing, '[]'::jsonb)) loop
      select value into v_new
      from jsonb_array_elements(p_value)
      where value ->> 'id' = v_old ->> 'id'
      limit 1;
      if v_new is null then
        raise exception 'Only the Administrator can delete activities.' using errcode = '42501';
      end if;
      for v_key, v_value in
        select key, value from jsonb_each(coalesce(v_old -> 'attendanceWorkflows', '{}'::jsonb))
        where value ->> 'state' = 'Finalized'
           or nullif(value ->> 'unlockedAt', '') is not null
           or nullif(value ->> 'finalizedAt', '') is not null
      loop
        if coalesce(v_new -> 'attendanceWorkflows' -> v_key, 'null'::jsonb) is distinct from v_value then
          raise exception 'Only the Administrator can finalize, unlock, or modify a protected attendance workflow.' using errcode = '42501';
        end if;
      end loop;
      for v_key, v_value in
        select key, value from jsonb_each(coalesce(v_new -> 'attendanceWorkflows', '{}'::jsonb))
        where value ->> 'state' = 'Finalized'
           or nullif(value ->> 'unlockedAt', '') is not null
           or nullif(value ->> 'finalizedAt', '') is not null
      loop
        if coalesce(v_old -> 'attendanceWorkflows' -> v_key, 'null'::jsonb) is distinct from v_value then
          raise exception 'Only the Administrator can finalize, unlock, or modify a protected attendance workflow.' using errcode = '42501';
        end if;
      end loop;
    end loop;

    -- A newly created activity must begin with Draft attendance workflows.
    -- Existing protected workflow objects must remain byte-for-byte unchanged.
    for v_new in select value from jsonb_array_elements(p_value) loop
      select value into v_old
      from jsonb_array_elements(coalesce(v_existing, '[]'::jsonb))
      where value ->> 'id' = v_new ->> 'id'
      limit 1;
      for v_key, v_value in
        select key, value from jsonb_each(coalesce(v_new -> 'attendanceWorkflows', '{}'::jsonb))
        where value ->> 'state' = 'Finalized'
           or nullif(value ->> 'unlockedAt', '') is not null
           or nullif(value ->> 'finalizedAt', '') is not null
      loop
        if v_old is null
           or coalesce(v_old -> 'attendanceWorkflows' -> v_key, 'null'::jsonb) is distinct from v_value then
          raise exception 'Only the Administrator can create, finalize, unlock, or modify a protected attendance workflow.' using errcode = '42501';
        end if;
      end loop;
    end loop;
  end if;

  -- Draft editors cannot silently change attendance rows whose matching roster
  -- is currently Finalized. An Administrator must unlock the roster first.
  if v_role in ('Membership', 'General Secretary') and p_column = 'attendance' then
    for v_old in select value from jsonb_array_elements(coalesce(v_existing, '[]'::jsonb)) loop
      select value into v_event
      from public.system_state as state,
           jsonb_array_elements(coalesce(state.events, '[]'::jsonb)) as event
      where state.id = 1 and event ->> 'id' = v_old ->> 'eventId'
      limit 1;
      v_key := coalesce(nullif(v_old ->> 'attendanceGroup', ''), 'Official Members') || '::' ||
               coalesce(nullif(v_old ->> 'rosterModeAtEdit', ''), 'Current');
      if coalesce(v_event -> 'attendanceWorkflows' -> v_key ->> 'state', 'Draft') = 'Finalized'
         and not exists (select 1 from jsonb_array_elements(p_value) as item where item = v_old) then
        raise exception 'Finalized attendance is locked. The Administrator must unlock it before corrections.' using errcode = '42501';
      end if;
    end loop;
    for v_new in select value from jsonb_array_elements(p_value) loop
      select value into v_event
      from public.system_state as state,
           jsonb_array_elements(coalesce(state.events, '[]'::jsonb)) as event
      where state.id = 1 and event ->> 'id' = v_new ->> 'eventId'
      limit 1;
      v_key := coalesce(nullif(v_new ->> 'attendanceGroup', ''), 'Official Members') || '::' ||
               coalesce(nullif(v_new ->> 'rosterModeAtEdit', ''), 'Current');
      if coalesce(v_event -> 'attendanceWorkflows' -> v_key ->> 'state', 'Draft') = 'Finalized'
         and not exists (select 1 from jsonb_array_elements(coalesce(v_existing, '[]'::jsonb)) as item where item = v_new) then
        raise exception 'Finalized attendance is locked. The Administrator must unlock it before corrections.' using errcode = '42501';
      end if;
    end loop;
  end if;

  -- Membership attendance editing is limited to Trainee and Probationary rows.
  if v_role = 'Membership' and p_column = 'attendance' then
    for v_old in
      select value from jsonb_array_elements(coalesce(v_existing, '[]'::jsonb))
      where coalesce(value ->> 'attendanceGroup', '') not in ('Trainee Members', 'Probationary Members')
    loop
      if not exists (select 1 from jsonb_array_elements(p_value) as item where item = v_old) then
        raise exception 'Membership attendance access is limited to Trainee and Probationary rosters.' using errcode = '42501';
      end if;
    end loop;
    for v_new in
      select value from jsonb_array_elements(p_value)
      where coalesce(value ->> 'attendanceGroup', '') not in ('Trainee Members', 'Probationary Members')
    loop
      if not exists (select 1 from jsonb_array_elements(coalesce(v_existing, '[]'::jsonb)) as item where item = v_new) then
        raise exception 'Membership attendance access is limited to Trainee and Probationary rosters.' using errcode = '42501';
      end if;
    end loop;
  end if;

  -- Membership may update the report payload stored in settings, but cannot
  -- change system-wide automation settings.
  if v_role = 'Membership' and p_column = 'settings' then
    if (p_value - '__lso_monthly_reports_v1') is distinct from (coalesce(v_existing, '{}'::jsonb) - '__lso_monthly_reports_v1') then
      raise exception 'Only the Administrator can change system settings.' using errcode = '42501';
    end if;
  end if;

  -- Membership Duty Hours changes are restricted to people who are currently
  -- in the Trainee or Probationary Period. Historical/official records are kept exact.
  if v_role = 'Membership' and p_column = 'duty_hours' then
    for v_old in select value from jsonb_array_elements(coalesce(v_existing -> 'entries', '[]'::jsonb)) loop
      select exists (
        select 1 from public.system_state as st,
          jsonb_array_elements(coalesce(st.members, '[]'::jsonb)) as member
        where st.id = 1 and member ->> 'id' = v_old ->> 'memberId'
          and public.lso_member_period_on_date(member, public.lso_local_date()) in ('Trainee Period', 'Probationary Period')
      ) into v_allowed;
      if not v_allowed and not exists (select 1 from jsonb_array_elements(coalesce(p_value -> 'entries', '[]'::jsonb)) as item where item = v_old) then
        raise exception 'Membership Duty Hours access is limited to current Trainee and Probationary members.' using errcode = '42501';
      end if;
    end loop;
    for v_new in select value from jsonb_array_elements(coalesce(p_value -> 'entries', '[]'::jsonb)) loop
      select exists (
        select 1 from public.system_state as st,
          jsonb_array_elements(coalesce(st.members, '[]'::jsonb)) as member
        where st.id = 1 and member ->> 'id' = v_new ->> 'memberId'
          and public.lso_member_period_on_date(member, public.lso_local_date()) in ('Trainee Period', 'Probationary Period')
      ) into v_allowed;
      if not v_allowed and not exists (select 1 from jsonb_array_elements(coalesce(v_existing -> 'entries', '[]'::jsonb)) as item where item = v_new) then
        raise exception 'Membership Duty Hours access is limited to current Trainee and Probationary members.' using errcode = '42501';
      end if;
    end loop;
    for v_key, v_value in select key, value from jsonb_each(coalesce(v_existing -> 'commitments', '{}'::jsonb)) loop
      select exists (
        select 1 from public.system_state as st,
          jsonb_array_elements(coalesce(st.members, '[]'::jsonb)) as member
        where st.id = 1 and member ->> 'id' = v_key
          and public.lso_member_period_on_date(member, public.lso_local_date()) in ('Trainee Period', 'Probationary Period')
      ) into v_allowed;
      if not v_allowed and coalesce(p_value -> 'commitments' -> v_key, 'null'::jsonb) is distinct from v_value then
        raise exception 'Membership Duty Hours access is limited to current Trainee and Probationary members.' using errcode = '42501';
      end if;
    end loop;
    for v_key, v_value in select key, value from jsonb_each(coalesce(p_value -> 'commitments', '{}'::jsonb)) loop
      select exists (
        select 1 from public.system_state as st,
          jsonb_array_elements(coalesce(st.members, '[]'::jsonb)) as member
        where st.id = 1 and member ->> 'id' = v_key
          and public.lso_member_period_on_date(member, public.lso_local_date()) in ('Trainee Period', 'Probationary Period')
      ) into v_allowed;
      if not v_allowed and coalesce(v_existing -> 'commitments' -> v_key, 'null'::jsonb) is distinct from v_value then
        raise exception 'Membership Duty Hours access is limited to current Trainee and Probationary members.' using errcode = '42501';
      end if;
    end loop;
  end if;

  case p_column
    when 'members' then update public.system_state set members = p_value, updated_at = now() where id = 1;
    when 'events' then update public.system_state set events = p_value, updated_at = now() where id = 1;
    when 'attendance' then update public.system_state set attendance = p_value, updated_at = now() where id = 1;
    when 'duty_hours' then update public.system_state set duty_hours = p_value, updated_at = now() where id = 1;
    when 'monthly_reports' then update public.system_state set monthly_reports = p_value, updated_at = now() where id = 1;
    when 'instruments' then update public.system_state set instruments = p_value, updated_at = now() where id = 1;
    when 'settings' then update public.system_state set settings = p_value, updated_at = now() where id = 1;
    when 'activity_log' then update public.system_state set activity_log = p_value, updated_at = now() where id = 1;
    else raise exception 'Unsupported shared-data column.' using errcode = '22023';
  end case;

  return public.lso_get_state(p_token);
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
      when v_item ->> 'role' = 'Membership' then 'Membership'
      when v_item ->> 'role' = 'General Secretary' then 'General Secretary'
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
  v_reviewer_role text;
  v_duty_hours jsonb;
  v_entries jsonb;
  v_next_entries jsonb;
  v_target jsonb;
  v_activity_log jsonb;
  v_activity jsonb;
begin
  v_admin_id := public.lso_session_account_id(p_token, false);
  select username, display_name, role
  into v_admin_username, v_admin_display_name, v_reviewer_role
  from public.lso_accounts
  where id = v_admin_id;

  if v_reviewer_role not in ('Administrator', 'Membership') then
    raise exception 'Administrator or Membership access is required to review Duty Hours entries.' using errcode = '42501';
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
  v_reviewer_role text;
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
  v_admin_id := public.lso_session_account_id(p_token, false);
  select username, display_name, role
  into v_admin_username, v_admin_display_name, v_reviewer_role
  from public.lso_accounts
  where id = v_admin_id;

  if v_reviewer_role not in ('Administrator', 'Membership') then
    raise exception 'Administrator or Membership access is required to review Duty Hours punches.' using errcode = '42501';
  end if;

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

revoke all on function public.lso_update_state(text, text, jsonb) from public;
revoke all on function public.lso_save_accounts(text, jsonb) from public;
revoke all on function public.lso_review_duty_entry(text, text, text) from public;
revoke all on function public.lso_review_duty_punch(text, text, text, text) from public;
grant execute on function public.lso_update_state(text, text, jsonb) to anon, authenticated;
grant execute on function public.lso_save_accounts(text, jsonb) to anon, authenticated;
grant execute on function public.lso_review_duty_entry(text, text, text) to anon, authenticated;
grant execute on function public.lso_review_duty_punch(text, text, text, text) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
