-- LSO DUTY PUNCH STATE-SYNC REPAIR
-- Safe compatibility repair for existing projects. Does not delete records.
begin;

alter table public.system_state
  add column if not exists duty_hours jsonb not null default '{"version":7,"commitments":{},"entries":[]}'::jsonb;

update public.system_state
set duty_hours = jsonb_set(
  jsonb_set(
    case when jsonb_typeof(duty_hours)='object' then duty_hours else '{"version":7,"commitments":{},"entries":[]}'::jsonb end,
    '{version}','7'::jsonb,true
  ),
  '{entries}',
  coalesce((
    select jsonb_agg(
      case when coalesce(entry->>'entryType','Duty')<>'Duty' then entry else
        entry || jsonb_build_object(
          'timeInApprovalStatus', status_values.in_status,
          'timeOutApprovalStatus', status_values.out_status,
          'approvalStatus',
            case
              when status_values.in_status in ('Rejected','Cancelled') or status_values.out_status in ('Rejected','Cancelled') then 'Rejected'
              when nullif(entry->>'timeOut','') is null and status_values.in_status='Approved' then 'Active'
              when nullif(entry->>'timeOut','') is null then 'Pending'
              when status_values.in_status='Approved' and status_values.out_status='Approved' then 'Approved'
              else 'Pending'
            end,
          'punchAudit',case when jsonb_typeof(entry->'punchAudit')='array' then entry->'punchAudit' else '[]'::jsonb end
        )
      end order by ordinal_position
    )
    from jsonb_array_elements(case when jsonb_typeof(duty_hours->'entries')='array' then duty_hours->'entries' else '[]'::jsonb end)
      with ordinality as records(entry,ordinal_position)
    cross join lateral (
      select
        case
          when nullif(entry->>'timeInApprovalStatus','') in ('Pending','Approved','Rejected','Cancelled','Not Submitted') then entry->>'timeInApprovalStatus'
          when nullif(entry->>'timeIn','') is null then 'Not Submitted'
          when nullif(entry->>'timeOut','') is null then case when coalesce(entry->>'approvalStatus','Pending')='Rejected' then 'Rejected' else 'Pending' end
          when coalesce(entry->>'approvalStatus','Approved')='Approved' then 'Approved'
          when coalesce(entry->>'approvalStatus','Pending')='Rejected' then 'Rejected'
          else 'Pending'
        end as in_status,
        case
          when nullif(entry->>'timeOutApprovalStatus','') in ('Pending','Approved','Rejected','Cancelled','Not Submitted') then entry->>'timeOutApprovalStatus'
          when nullif(entry->>'timeOut','') is null then 'Not Submitted'
          when coalesce(entry->>'approvalStatus','Pending')='Approved' then 'Approved'
          when coalesce(entry->>'approvalStatus','Pending')='Rejected' then 'Rejected'
          else 'Pending'
        end as out_status
    ) as status_values
  ),'[]'::jsonb),true
),updated_at=now()
where id=1;

notify pgrst,'reload schema';
commit;

-- Optional verification after running:
-- select entry->>'id' id, entry->>'memberId' member_id, entry->>'date' duty_date,
--        entry->>'timeIn' time_in, entry->>'timeOut' time_out,
--        entry->>'timeInApprovalStatus' time_in_status, entry->>'timeOutApprovalStatus' time_out_status
-- from public.system_state, jsonb_array_elements(duty_hours->'entries') entry
-- where coalesce(entry->>'entryType','Duty')='Duty'
-- order by entry->>'createdAt' desc;
