-- LSO Overall Monthly Report native shared-data upgrade (optional but recommended)
-- The website also includes compatibility storage, so the Monthly Report works
-- even before this script is run. Run this in Supabase > SQL Editor to give the
-- report its own native JSONB column.

alter table public.system_state
  add column if not exists monthly_reports jsonb not null
  default '{"version":1,"reports":{},"civilStatusByMember":{},"traineeFiles":{}}'::jsonb;

-- Migrate any compatibility-stored Monthly Report data from system settings.
update public.system_state
set monthly_reports = settings -> '__lso_monthly_reports_v1'
where jsonb_typeof(settings -> '__lso_monthly_reports_v1') = 'object'
  and coalesce(jsonb_object_length(settings -> '__lso_monthly_reports_v1'), 0) > 0;

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
begin
  v_account_id := public.lso_session_account_id(p_token, true);

  if p_column in ('members', 'events', 'attendance', 'instruments', 'activity_log')
     and jsonb_typeof(p_value) <> 'array' then
    raise exception 'The selected data collection must be a JSON array.' using errcode = '22023';
  end if;

  if p_column in ('settings', 'duty_hours', 'monthly_reports')
     and jsonb_typeof(p_value) <> 'object' then
    raise exception 'The selected data collection must be a JSON object.' using errcode = '22023';
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

revoke all on function public.lso_get_state(text) from public;
revoke all on function public.lso_update_state(text, text, jsonb) from public;
revoke all on function public.lso_replace_state(text, jsonb) from public;
grant execute on function public.lso_get_state(text) to anon, authenticated;
grant execute on function public.lso_update_state(text, text, jsonb) to anon, authenticated;
grant execute on function public.lso_replace_state(text, jsonb) to anon, authenticated;

-- Ask PostgREST to refresh its function/schema cache immediately.
notify pgrst, 'reload schema';
