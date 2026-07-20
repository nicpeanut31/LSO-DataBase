-- LSO DUTY DATE / PHILIPPINES TIMEZONE HOTFIX
-- Run this once in Supabase SQL Editor for an existing installation.
-- It preserves current records and only replaces date-sensitive functions.

begin;

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

revoke all on function public.lso_local_date() from public;
revoke all on function public.lso_member_period_on_date(jsonb, date) from public;
revoke all on function public.lso_account_json(uuid) from public;
revoke all on function public.lso_save_accounts(text, jsonb) from public;
revoke all on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) from public;

grant execute on function public.lso_local_date() to anon, authenticated;
grant execute on function public.lso_member_period_on_date(jsonb, date) to anon, authenticated;
grant execute on function public.lso_account_json(uuid) to anon, authenticated;
grant execute on function public.lso_save_accounts(text, jsonb) to anon, authenticated;
grant execute on function public.lso_submit_duty_entry(text, text, text, text, text, text, text) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
