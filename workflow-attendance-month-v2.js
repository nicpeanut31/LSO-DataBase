(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const normalize = (value) => String(value ?? '').trim().toLowerCase();
  const safeText = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  let calendarCursor = new Date();
  calendarCursor.setDate(1);
  let selectedCalendarDate = localISO(new Date());
  window.LSOAttendanceMonth = /^\d{4}-\d{2}$/.test(String(window.LSOAttendanceMonth || ''))
    ? String(window.LSOAttendanceMonth)
    : `${calendarCursor.getFullYear()}-${String(calendarCursor.getMonth() + 1).padStart(2, '0')}`;
  window.LSOAttendanceSelectedDate = selectedCalendarDate;
  let selectedAttendanceMemberId = '';
  const SEMESTERS = ['First Semester', 'Second Semester'];
  const ATTENDANCE_GROUPS = ['Official Members', 'Trainee Members', 'Probationary Members'];
  const ATTENDANCE_ROSTER_MODES = ['Current', 'Archive'];
  window.LSOAttendanceSemester = SEMESTERS.includes(window.LSOAttendanceSemester) ? window.LSOAttendanceSemester : 'First Semester';
  window.LSOAttendanceGroup = ATTENDANCE_GROUPS.includes(window.LSOAttendanceGroup) ? window.LSOAttendanceGroup : 'Official Members';
  window.LSOAttendanceRosterMode = ATTENDANCE_ROSTER_MODES.includes(window.LSOAttendanceRosterMode) ? window.LSOAttendanceRosterMode : 'Current';

  function localISO(date) {
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function today() {
    return localISO(new Date());
  }

  function addDays(value, amount) {
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    date.setDate(date.getDate() + amount);
    return localISO(date);
  }

  function dateLabel(value, options = {}) {
    if (!value) return '—';
    const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-PH', {
      year: options.year === false ? undefined : 'numeric',
      month: options.short ? 'short' : 'long',
      day: 'numeric',
      weekday: options.weekday ? 'long' : undefined
    }).format(date);
  }

  function getMembers() {
    return window.LSOApp?.getMembers?.() || [];
  }

  function getEvents() {
    return window.LSOOperations?.getEvents?.() || [];
  }

  function getAttendance() {
    return window.LSOOperations?.getAttendance?.() || [];
  }

  function normalizeSemester(value) {
    return SEMESTERS.includes(value) ? value : 'First Semester';
  }

  function activeSemester() {
    return normalizeSemester(window.LSOAttendanceSemester);
  }

  function normalizeAttendanceGroup(value) {
    return ATTENDANCE_GROUPS.includes(value) ? value : 'Official Members';
  }

  function activeAttendanceGroup() {
    const selected = normalizeAttendanceGroup(window.LSOAttendanceGroup);
    if (window.LSORoleAccess?.canUseAttendanceGroup && !window.LSORoleAccess.canUseAttendanceGroup(selected)) {
      const fallback = window.LSORoleAccess.defaultAttendanceGroup?.() || 'Trainee Members';
      window.LSOAttendanceGroup = fallback;
      return normalizeAttendanceGroup(fallback);
    }
    return selected;
  }

  function normalizeAttendanceRosterMode(value) {
    return ATTENDANCE_ROSTER_MODES.includes(value) ? value : 'Current';
  }

  function activeAttendanceRosterMode() {
    return normalizeAttendanceRosterMode(window.LSOAttendanceRosterMode);
  }

  function attendanceGroupShortLabel(group = activeAttendanceGroup()) {
    return ({
      'Official Members': 'Official Members',
      'Trainee Members': 'Trainees',
      'Probationary Members': 'Probationary Members'
    })[normalizeAttendanceGroup(group)];
  }

  function attendanceRosterModeLabel(mode = activeAttendanceRosterMode()) {
    return normalizeAttendanceRosterMode(mode) === 'Archive' ? 'Attendance Archive' : 'Current Roster';
  }

  function currentMemberAttendanceGroup(member) {
    if (!member) return 'Official Members';
    const period = normalize(member.periodGroup);
    const stage = normalize(member.membershipStage);

    // The calculated periodGroup is authoritative. membershipStage is only a
    // fallback for older records that do not yet have a periodGroup value.
    if (period === 'trainee period') return 'Trainee Members';
    if (period === 'probationary period') return 'Probationary Members';
    if (period === 'membership period') return 'Official Members';
    if (stage === 'trainee') return 'Trainee Members';
    if (stage === 'probationary') return 'Probationary Members';
    if (stage === 'regular member') return 'Official Members';

    // Fallback for older/imported profiles whose calculated period label is missing.
    const referenceDate = today();
    const membershipStart = String(member.regularMemberDate || '').slice(0, 10);
    const probationaryStart = String(member.probationaryStartDate || '').slice(0, 10);
    if (membershipStart && referenceDate >= membershipStart) return 'Official Members';
    if (!member.probationarySkipped && probationaryStart && referenceDate >= probationaryStart) return 'Probationary Members';
    return 'Trainee Members';
  }

  function memberIsCurrentlyActive(member) {
    const status = normalize(member?.memberStatus);
    // Older/imported records sometimes have no status. Treat them as active unless
    // they are explicitly marked Nonactive or LOA.
    return !['nonactive', 'loa'].includes(status);
  }

  function memberAttendanceGroupOnDate(member, dateValue) {
    if (!member) return '';
    const date = String(dateValue || today()).slice(0, 10);
    const traineeStart = String(member.traineeStartDate || member.dateRegistered || '').slice(0, 10);
    const probationaryStart = String(member.probationaryStartDate || '').slice(0, 10);
    const membershipStart = String(member.regularMemberDate || '').slice(0, 10);
    const skipped = Boolean(member.probationarySkipped);
    const currentGroup = currentMemberAttendanceGroup(member);

    if (membershipStart && date >= membershipStart) return 'Official Members';
    if (!membershipStart && currentGroup === 'Official Members') return 'Official Members';
    if (!skipped && probationaryStart && date >= probationaryStart) return 'Probationary Members';
    if (!probationaryStart && currentGroup === 'Probationary Members') return 'Probationary Members';
    if (!traineeStart || date >= traineeStart) return 'Trainee Members';
    return currentMemberAttendanceGroup(member);
  }

  function memberHasAttendanceGroupHistory(member, group = activeAttendanceGroup()) {
    const normalizedGroup = normalizeAttendanceGroup(group);
    const currentGroup = currentMemberAttendanceGroup(member);
    if (normalizedGroup === 'Trainee Members') {
      return currentGroup !== 'Trainee Members' && Boolean(member?.traineeStartDate || member?.dateRegistered);
    }
    if (normalizedGroup === 'Probationary Members') {
      return currentGroup === 'Official Members' && Boolean(member?.probationaryStartDate || member?.probationarySkipped);
    }
    return currentGroup === 'Official Members' && !memberIsCurrentlyActive(member);
  }

  function memberMatchesAttendanceRosterMode(member, group = activeAttendanceGroup(), mode = activeAttendanceRosterMode()) {
    if (!member) return false;
    const normalizedGroup = normalizeAttendanceGroup(group);
    if (normalizeAttendanceRosterMode(mode) === 'Current') {
      return memberIsCurrentlyActive(member) && currentMemberAttendanceGroup(member) === normalizedGroup;
    }
    return memberHasAttendanceGroupHistory(member, normalizedGroup);
  }

  function attendanceRecordGroup(record, event, member) {
    if (ATTENDANCE_GROUPS.includes(record?.attendanceGroup)) return record.attendanceGroup;
    return memberAttendanceGroupOnDate(member, event?.date);
  }

  function memberEligibleForAttendanceEvent(member, event) {
    if (!memberMatchesAttendanceRosterMode(member) || !event) return false;

    // Current rosters must always show every person who is currently assigned to
    // the selected membership group. The event date must not hide their name.
    // The saved attendanceGroup field keeps Official, Trainee, and Probationary
    // attendance completely separate even when they use the same event.
    if (activeAttendanceRosterMode() === 'Current') return true;

    // Archive mode remains historical: show a former-stage member when the event
    // occurred during that stage or when a stored record already exists.
    const hasStoredRecord = getAttendance().some((record) =>
      record.eventId === event.id &&
      record.memberId === member.id &&
      attendanceRecordGroup(record, event, member) === activeAttendanceGroup()
    );
    return hasStoredRecord || memberAttendanceGroupOnDate(member, event.date) === activeAttendanceGroup();
  }

  function memberEventsForActiveGroup(member, events) {
    return events.filter((event) => {
      if (memberAttendanceGroupOnDate(member, event.date) === activeAttendanceGroup()) return true;
      return getAttendance().some((record) =>
        record.eventId === event.id &&
        record.memberId === member.id &&
        attendanceRecordGroup(record, event, member) === activeAttendanceGroup()
      );
    });
  }

  function membersForAttendanceGroup() {
    return getMembers()
      .filter((member) => memberMatchesAttendanceRosterMode(member))
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  }

  function groupRecordsForEvents(events) {
    const eventMap = new Map(events.map((event) => [event.id, event]));
    const memberMap = new Map(getMembers().map((member) => [member.id, member]));
    return getAttendance().filter((record) => {
      const event = eventMap.get(record.eventId);
      const member = memberMap.get(record.memberId);
      return Boolean(
        record.status &&
        event &&
        member &&
        memberMatchesAttendanceRosterMode(member) &&
        attendanceRecordGroup(record, event, member) === activeAttendanceGroup()
      );
    });
  }

  function eventSemester(event) {
    return normalizeSemester(event?.semester);
  }

  function semesterEvents(semester = activeSemester()) {
    return getEvents().filter((event) => eventSemester(event) === normalizeSemester(semester));
  }

  function eventIsPastOrToday(event) {
    return !event.date || event.date <= today();
  }

  function rehearsalEvents(semester = activeSemester()) {
    return semesterEvents(semester)
      .filter((event) => normalize(event.type) === 'rehearsal' && eventIsPastOrToday(event))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function activityEvents(semester = activeSemester()) {
    return semesterEvents(semester)
      .filter(eventIsPastOrToday)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function calendarMonthKey() {
    return `${calendarCursor.getFullYear()}-${String(calendarCursor.getMonth() + 1).padStart(2, '0')}`;
  }

  function calendarMonthLabel() {
    return new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(calendarCursor);
  }

  function eventsInCalendarMonth(events) {
    const month = calendarMonthKey();
    return events.filter((event) => String(event.date || '').slice(0, 7) === month);
  }

  function setMonthWorkspace(monthDate, { resetDate = true } = {}) {
    calendarCursor = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    if (resetDate) selectedCalendarDate = localISO(calendarCursor);
    window.LSOAttendanceSelectedDate = selectedCalendarDate;
    const month = calendarMonthKey();
    const changed = window.LSOAttendanceMonth !== month;
    window.LSOAttendanceMonth = month;
    if (changed) {
      if (!window.LSOOperations?.setAttendanceMonth?.(month)) {
        window.dispatchEvent(new CustomEvent('lso:attendance-month-changed', { detail: { month, label: calendarMonthLabel() } }));
      }
    }
  }

  function moveCalendarMonth(amount) {
    const next = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + amount, 1);
    setMonthWorkspace(next, { resetDate: true });
    renderEverything();
  }

  function renderMonthWorkspaceSummary(monthlyEvents) {
    const container = el('attendanceMonthWorkspaceSummary');
    if (!container) return;
    const eventIds = new Set(monthlyEvents.map((event) => event.id));
    const records = groupRecordsForEvents(monthlyEvents);
    const finalized = monthlyEvents.filter((event) => eventWorkflowState(event) === 'Finalized').length;
    const draft = Math.max(0, monthlyEvents.length - finalized);
    container.innerHTML = `<div class="month-workspace-copy"><span>Selected month workspace</span><strong>${safeText(calendarMonthLabel())}</strong><small>Only this month’s activities appear in the activity list and attendance workspace. Other months remain stored separately.</small></div>
      <div class="month-workspace-metric"><span>Activities</span><strong>${monthlyEvents.length}</strong><small>Selected semester</small></div>
      <div class="month-workspace-metric"><span>Finalized</span><strong>${finalized}</strong><small>Locked rosters</small></div>
      <div class="month-workspace-metric"><span>Draft</span><strong>${draft}</strong><small>Still editable</small></div>
      <div class="month-workspace-metric"><span>Attendance Marks</span><strong>${records.filter((record) => eventIds.has(record.eventId) && record.status).length}</strong><small>${safeText(attendanceGroupShortLabel())}</small></div>`;
  }

  function statusCounts(records) {
    const statuses = ['Present', 'Late', 'Absent', 'Excused', 'Not Required'];
    return Object.fromEntries(statuses.map((status) => [status, records.filter((record) => record.status === status).length]));
  }

  function rateFromCounts(counts) {
    const denominator = counts.Present + counts.Late + counts.Absent;
    return denominator ? Math.round(((counts.Present + counts.Late) / denominator) * 100) : null;
  }

  function eventWorkflowState(event, group = activeAttendanceGroup(), mode = activeAttendanceRosterMode()) {
    if (window.LSOAttendanceGovernance?.workflowState) return window.LSOAttendanceGovernance.workflowState(event, group, mode);
    const key = `${group}::${mode}`;
    return event?.attendanceWorkflows?.[key]?.state === 'Finalized' ? 'Finalized' : 'Draft';
  }

  function memberSummaryForEvents(memberId, events) {
    const attendance = getAttendance();
    const member = getMembers().find((item) => item.id === memberId);
    const scopedEvents = member ? memberEventsForActiveGroup(member, events) : [];
    const eventMap = new Map(scopedEvents.map((event) => [event.id, event]));
    const records = attendance.filter((record) => {
      const event = eventMap.get(record.eventId);
      return record.memberId === memberId && event && attendanceRecordGroup(record, event, member) === activeAttendanceGroup();
    });
    const counts = statusCounts(records);
    return {
      events: scopedEvents,
      records,
      counts,
      totalEvents: scopedEvents.length,
      totalRehearsals: scopedEvents.length,
      recorded: records.filter((record) => record.status).length,
      rate: rateFromCounts(counts)
    };
  }

  function memberRehearsalSummary(memberId) {
    return memberSummaryForEvents(memberId, rehearsalEvents());
  }

  function metricMarkup(label, value, helper = '') {
    return `<div class="attendance-kpi"><span>${safeText(label)}</span><strong>${safeText(value)}</strong><small>${safeText(helper)}</small></div>`;
  }

  function renderOverallAttendance() {
    const metrics = el('overallAttendanceMetrics');
    const tableBody = el('attendanceOverallTableBody');
    if (!metrics || !tableBody) return;

    const allEvents = activityEvents();
    const members = membersForAttendanceGroup(rehearsalEvents());
    const memberIds = new Set(members.map((member) => member.id));
    const events = allEvents.filter((event) => members.some((member) => memberEligibleForAttendanceEvent(member, event)));
    const records = groupRecordsForEvents(events).filter((record) => memberIds.has(record.memberId));
    const counts = statusCounts(records);
    const marked = records.length;
    const overallRate = rateFromCounts(counts);
    const percent = (count) => marked ? `${Math.round((count / marked) * 100)}%` : '0%';

    metrics.innerHTML = [
      metricMarkup('Group Members', members.length, attendanceGroupShortLabel()),
      metricMarkup('Recorded Activities', events.length, `${marked} attendance marks`),
      metricMarkup('Present', counts.Present, percent(counts.Present)),
      metricMarkup('Late', counts.Late, percent(counts.Late)),
      metricMarkup('Absent', counts.Absent, percent(counts.Absent)),
      metricMarkup('Overall Rate', overallRate === null ? '—' : `${overallRate}%`, 'Present + Late ÷ counted')
    ].join('');

    if (el('overallAttendanceCaption')) {
      el('overallAttendanceCaption').textContent = events.length
        ? `${attendanceRosterModeLabel()} • ${attendanceGroupShortLabel()} • ${activeSemester()} • ${events.length} completed activit${events.length === 1 ? 'y' : 'ies'} • ${marked} recorded statuses`
        : `No completed ${attendanceRosterModeLabel().toLowerCase()} ${attendanceGroupShortLabel().toLowerCase()} attendance activities in ${activeSemester()}.`;
    }
    if (el('attendanceGroupHeading')) el('attendanceGroupHeading').textContent = `${attendanceRosterModeLabel()} — ${attendanceGroupShortLabel()}`;

    tableBody.innerHTML = members.length ? members.map((member) => {
      const summary = memberRehearsalSummary(member.id);
      return `<tr>
        <td><strong>${safeText(member.fullName)}</strong><small class="table-subtext">${safeText(member.membershipId)} • ${safeText(member.periodGroup)}</small></td>
        <td>${summary.totalRehearsals}</td>
        <td>${summary.counts.Present}</td>
        <td>${summary.counts.Late}</td>
        <td>${summary.counts.Absent}</td>
        <td>${summary.counts.Excused}</td>
        <td><span class="badge ${summary.rate === null ? 'badge-gray' : summary.rate >= 80 ? 'badge-green' : summary.rate >= 60 ? 'badge-gold' : 'badge-red'}">${summary.rate === null ? 'No data' : `${summary.rate}%`}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="7"><div class="empty-state compact-empty"><h4>No ${safeText(attendanceGroupShortLabel())} records</h4><p>Members assigned to this attendance group will appear here.</p></div></td></tr>`;
  }

  function populateIndividualSelect() {
    const select = el('attendanceIndividualSelect');
    if (!select) return;
    const current = selectedAttendanceMemberId || select.value;
    const members = membersForAttendanceGroup(rehearsalEvents());
    select.innerHTML = '<option value="">Choose a member…</option>' + members.map((member) =>
      `<option value="${safeText(member.id)}">${safeText(member.fullName)} — ${safeText(member.periodGroup)}</option>`
    ).join('');
    if (members.some((member) => member.id === current)) select.value = current;
  }

  function renderIndividualAttendance() {
    const container = el('individualAttendanceSummary');
    const history = el('individualAttendanceHistory');
    const actions = el('individualReportActions');
    if (!container || !history || !actions) return;

    const member = membersForAttendanceGroup(rehearsalEvents()).find((item) => item.id === selectedAttendanceMemberId);
    if (!member) {
      container.innerHTML = '<div class="dashboard-empty-state"><span>⌕</span><strong>Select a member</strong><small>Their rehearsal totals and printable history will appear here.</small></div>';
      history.innerHTML = '';
      actions.classList.add('hidden');
      return;
    }

    const summary = memberRehearsalSummary(member.id);
    container.innerHTML = `<div class="individual-member-heading"><div class="member-avatar">${safeText(String(member.fullName || 'M').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase())}</div><div><strong>${safeText(member.fullName)}</strong><small>${safeText(member.membershipId)} • ${safeText(member.periodGroup)}</small></div></div>
      <div class="individual-stat-grid">
        ${metricMarkup('Total Rehearsals', summary.totalRehearsals, activeSemester())}
        ${metricMarkup('Present', summary.counts.Present)}
        ${metricMarkup('Late', summary.counts.Late)}
        ${metricMarkup('Absent', summary.counts.Absent)}
        ${metricMarkup('Excused', summary.counts.Excused)}
        ${metricMarkup('Attendance Rate', summary.rate === null ? '—' : `${summary.rate}%`, 'Excused excluded')}
      </div>`;

    const attendanceByEvent = new Map(summary.records.map((record) => [record.eventId, record]));
    history.innerHTML = summary.events.length ? `<div class="individual-history-header"><strong>${safeText(activeSemester())} Rehearsal History</strong><span>${summary.recorded} of ${summary.totalRehearsals} marked</span></div>${summary.events.map((event) => {
      const record = attendanceByEvent.get(event.id) || {};
      const status = record.status || 'Not marked';
      const badge = status === 'Present' ? 'badge-green' : status === 'Late' || status === 'Excused' ? 'badge-gold' : status === 'Absent' ? 'badge-red' : 'badge-gray';
      const workflow = eventWorkflowState(event, record.attendanceGroup || activeAttendanceGroup(), record.rosterModeAtEdit || activeAttendanceRosterMode());
      return `<div class="attendance-history-row"><div><strong>${safeText(event.title)}</strong><small>${safeText(dateLabel(event.date, { short: true }))}${event.venue ? ` • ${safeText(event.venue)}` : ''}</small></div><span class="badge ${badge}">${safeText(status)}</span><span class="badge ${workflow === 'Finalized' ? 'badge-green' : 'badge-gold'}">${safeText(workflow)}</span><small>${safeText(record.remarks || '')}</small></div>`;
    }).join('')}` : '<div class="dashboard-empty-state"><span>□</span><strong>No completed rehearsals</strong><small>Create rehearsal events in the attendance calendar.</small></div>';
    actions.classList.remove('hidden');
  }

  function renderCalendar() {
    const grid = el('attendanceCalendarGrid');
    if (!grid) return;
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const monthStart = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - monthStart.getDay());
    const monthlyEvents = eventsInCalendarMonth(semesterEvents());
    const eventsByDate = new Map();
    monthlyEvents.forEach((event) => {
      if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
      eventsByDate.get(event.date).push(event);
    });
    renderMonthWorkspaceSummary(monthlyEvents);

    el('attendanceCalendarMonth').textContent = `${new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(monthStart)} — ${activeSemester()} — ${attendanceRosterModeLabel()} — ${attendanceGroupShortLabel()}`;
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      const iso = localISO(date);
      const outside = date.getMonth() !== month;
      const dayEvents = outside ? [] : (eventsByDate.get(iso) || []);
      const selected = !outside && iso === selectedCalendarDate;
      const isToday = !outside && iso === today();
      cells.push(`<button class="attendance-calendar-day${outside ? ' outside-month' : ''}${selected ? ' selected' : ''}${isToday ? ' today' : ''}" ${outside ? 'disabled aria-hidden="true" tabindex="-1"' : `data-calendar-date="${iso}"`} type="button">
        <span class="calendar-day-number">${date.getDate()}</span>
        <span class="calendar-day-events">${dayEvents.slice(0, 3).map((event) => `<em class="calendar-event-pill ${normalize(event.type) === 'rehearsal' ? 'rehearsal' : ''}">${safeText(event.title)}</em>`).join('')}${dayEvents.length > 3 ? `<em class="calendar-more">+${dayEvents.length - 3} more</em>` : ''}</span>
      </button>`);
    }
    grid.innerHTML = cells.join('');
    renderSelectedCalendarDate();
  }

  function renderSelectedCalendarDate() {
    const events = semesterEvents().filter((event) => event.date === selectedCalendarDate);
    if (el('calendarSelectedDateLabel')) el('calendarSelectedDateLabel').textContent = dateLabel(selectedCalendarDate, { weekday: true });
    if (el('calendarSelectedDateMeta')) el('calendarSelectedDateMeta').textContent = events.length
      ? `${events.length} scheduled event${events.length === 1 ? '' : 's'} • click the date again to open the first one`
      : 'No event scheduled. Create a rehearsal for this date.';
  }

  function selectCalendarDate(value, openEvent = true) {
    selectedCalendarDate = value;
    window.LSOAttendanceSelectedDate = value;
    const selectedDate = new Date(`${value}T00:00:00`);
    if (!Number.isNaN(selectedDate.getTime())) {
      setMonthWorkspace(selectedDate, { resetDate: false });
    }
    renderCalendar();
    const event = semesterEvents().find((item) => item.date === value);
    if (event && openEvent) {
      if (el('eventSearch')) el('eventSearch').value = '';
      window.LSOOperations?.refreshAll?.();
      setTimeout(() => document.querySelector(`[data-event-id="${cssEscape(event.id)}"]`)?.click(), 20);
    }
  }

  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');
  }

  function createEventOnSelectedDate() {
    el('addEventButton')?.click();
    setTimeout(() => {
      if (el('eventDate')) el('eventDate').value = selectedCalendarDate || today();
      if (el('eventType')) el('eventType').value = 'Rehearsal';
      if (el('eventSemester')) el('eventSemester').value = activeSemester();
      if (el('eventTitle') && !el('eventTitle').value) el('eventTitle').value = 'Full Orchestra Rehearsal';
      el('eventTitle')?.focus();
    }, 20);
  }

  function printableDocument({ title, subtitle, summaryHtml, tableHtml, footer = '' }) {
    return `<!doctype html><html><head><title>${safeText(title)}</title><style>
      @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17362d;margin:0}.header{display:flex;justify-content:space-between;border-bottom:4px solid #167055;padding-bottom:12px;margin-bottom:16px}.org{font-size:11px;text-transform:uppercase;letter-spacing:.13em;color:#167055;font-weight:700}h1{font-size:25px;margin:5px 0}.sub{font-size:12px;color:#60766e}.summary{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:15px 0}.summary>div{border:1px solid #d8e6df;padding:10px;border-radius:8px}.summary span{display:block;font-size:9px;text-transform:uppercase;color:#6b8078}.summary strong{font-size:20px}.report-section{margin:18px 0 8px;font-size:14px;color:#0b3b2e}.report-note{font-size:10px;color:#60766e;margin:0 0 8px}table{width:100%;border-collapse:collapse;font-size:10px}th,td{border:1px solid #d8e6df;padding:7px;text-align:left}th{background:#eff8f3;text-transform:uppercase;font-size:9px}.sign{display:grid;grid-template-columns:1fr 1fr;gap:90px;margin-top:45px;text-align:center}.sign div{border-top:1px solid #333;padding-top:6px}.footer{font-size:9px;color:#6c8079;margin-top:15px;text-align:center}${window.LSOBrand?.printCss || ''}</style></head><body>
      ${window.LSOBrand.printHeader({ title, subtitle, meta: `Generated ${dateLabel(today())}` })}
      ${summaryHtml}${tableHtml}<div class="sign"><div>Prepared by</div><div>Authorized Officer</div></div><div class="footer">${safeText(footer || 'Generated from the LSO Orchestra Management System.')}</div>${window.LSOBrand.printRuntimeScript}</body></html>`;
  }

  function openPrintDocument(html) {
    const popup = window.open('', '_blank', 'width=1100,height=800');
    if (!popup) {
      window.LSOApp?.showToast?.('Allow pop-ups to generate the printable report.', true);
      return;
    }
    popup.document.write(html);
    popup.document.close();
  }

  function printIndividualAttendance() {
    const member = membersForAttendanceGroup(rehearsalEvents()).find((item) => item.id === selectedAttendanceMemberId);
    if (!member) return;
    const summary = memberRehearsalSummary(member.id);
    const signals = window.LSOAttendanceGovernance?.memberSignals?.(member.id) || {};
    const recordMap = new Map(summary.records.map((record) => [record.eventId, record]));
    const summaryHtml = `<div class="summary">${[
      ['Total Rehearsals', summary.totalRehearsals], ['Present', summary.counts.Present], ['Late', summary.counts.Late],
      ['Absent', summary.counts.Absent], ['Working Rate', signals.workingRate == null ? (summary.rate === null ? '—' : `${summary.rate}%`) : `${signals.workingRate}%`],
      ['Verified Rate', signals.verifiedRate == null ? '—' : `${signals.verifiedRate}%`]
    ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>`;
    const rows = summary.events.map((event) => {
      const record = recordMap.get(event.id) || {};
      const workflow = eventWorkflowState(event, record.attendanceGroup || activeAttendanceGroup(), record.rosterModeAtEdit || activeAttendanceRosterMode());
      return `<tr><td>${safeText(dateLabel(event.date, { short: true }))}</td><td>${safeText(event.venue || '—')}</td><td>${safeText(workflow)}</td><td>${safeText(record.status || 'Not marked')}</td><td>${safeText(record.remarks || '')}</td></tr>`;
    }).join('');
    openPrintDocument(printableDocument({
      title: `${member.fullName} — ${attendanceRosterModeLabel()} — ${attendanceGroupShortLabel()} Attendance`,
      subtitle: `${activeSemester()} • ${attendanceGroupShortLabel()} • ${member.membershipId} • ${member.periodGroup} • ${member.primaryInstrument || 'No instrument recorded'}`, 
      summaryHtml,
      tableHtml: `<table><thead><tr><th>Date</th><th>Venue</th><th>Verification</th><th>Status</th><th>Remarks</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No completed rehearsal records.</td></tr>'}</tbody></table>`
    }));
  }

  function eventDetailReportTable(events) {
    const attendance = getAttendance();
    const rows = events.map((event) => {
      const memberMap = new Map(getMembers().map((member) => [member.id, member]));
      const records = attendance.filter((record) => {
        const member = memberMap.get(record.memberId);
        return record.eventId === event.id && record.status && member && memberMatchesAttendanceRosterMode(member) && attendanceRecordGroup(record, event, member) === activeAttendanceGroup();
      });
      const workflow = eventWorkflowState(event);
      return `<tr><td>${safeText(dateLabel(event.date, { short: true }))}</td><td>${safeText(event.title)}</td><td>${safeText(event.type || 'Activity')}</td><td>${safeText(event.venue || '—')}</td><td>${safeText(workflow)}</td><td>${records.length}</td></tr>`;
    }).join('');
    return `<h2 class="report-section">Activity Breakdown</h2><p class="report-note">Each row lists one completed activity, its verification state, and the number of recorded attendance entries.</p><table><thead><tr><th>Date</th><th>Activity</th><th>Type</th><th>Venue</th><th>Verification</th><th>Recorded</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No completed activities in this report period.</td></tr>'}</tbody></table>`;
  }

  function printCurrentAttendanceGroupRoster() {
    const members = membersForAttendanceGroup();
    const rehearsals = rehearsalEvents();
    const records = groupRecordsForEvents(rehearsals);
    const modeLabel = attendanceRosterModeLabel();
    const summaryHtml = `<div class="summary">${[
      [modeLabel, members.length],
      ['Semester', activeSemester()],
      ['Recorded Entries', records.length]
    ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>`;
    const rows = members.map((member) => {
      const summary = memberRehearsalSummary(member.id);
      const recordStatus = activeAttendanceRosterMode() === 'Archive' ? 'Archived Attendance Record' : 'Current';
      return `<tr><td>${safeText(member.fullName)}</td><td>${safeText(member.membershipId || '—')}</td><td>${safeText(member.orchestraSection || '—')}</td><td>${safeText(member.primaryInstrument || '—')}</td><td>${safeText(recordStatus)}</td><td>${summary.rate === null ? '—' : `${summary.rate}%`}</td></tr>`;
    }).join('');
    openPrintDocument(printableDocument({
      title: `${modeLabel} — ${attendanceGroupShortLabel()} Attendance`,
      subtitle: `${activeSemester()} • ${activeAttendanceRosterMode() === 'Archive' ? 'Completed-stage records only' : 'Current active roster only'}`,
      summaryHtml,
      tableHtml: `<table><thead><tr><th>Member</th><th>Membership ID</th><th>Section</th><th>Instrument</th><th>Record Status</th><th>Attendance Rate</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No members in this attendance roster.</td></tr>'}</tbody></table>`
    }));
  }

  function printOverallAttendance() {
    const members = membersForAttendanceGroup(rehearsalEvents());
    const memberIds = new Set(members.map((member) => member.id));
    const events = activityEvents().filter((event) => members.some((member) => memberEligibleForAttendanceEvent(member, event)));
    const records = groupRecordsForEvents(events).filter((record) => memberIds.has(record.memberId));
    const counts = statusCounts(records);
    const rate = rateFromCounts(counts);
    const finalizedEvents = events.filter((event) => eventWorkflowState(event) === 'Finalized').length;
    const summaryHtml = `<div class="summary">${[
      ['Members', members.length], ['Activities', events.length], ['Finalized', finalizedEvents], ['Draft', Math.max(0, events.length - finalizedEvents)], ['Absent', counts.Absent], ['Working Rate', rate === null ? '—' : `${rate}%`]
    ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>`;
    const rows = members.map((member) => {
      const summary = memberRehearsalSummary(member.id);
      const signals = window.LSOAttendanceGovernance?.memberSignals?.(member.id) || {};
      return `<tr><td>${safeText(member.fullName)}</td><td>${summary.rate === null ? '—' : `${summary.rate}%`}</td><td>${signals.verifiedRate == null ? '—' : `${signals.verifiedRate}%`}</td><td>${safeText((signals.risks || []).join('; ') || 'No current signal')}</td></tr>`;
    }).join('');
    openPrintDocument(printableDocument({
      title: `${attendanceRosterModeLabel()} — ${attendanceGroupShortLabel()} — ${activeSemester()} Attendance Report`,
      subtitle: `${members.length} members • ${events.length} completed activities • ${records.length} recorded attendance statuses`,
      summaryHtml,
      tableHtml: `${eventDetailReportTable(events)}<h2 class="report-section">${safeText(attendanceGroupShortLabel())} Semester Summary</h2><p class="report-note">Working Rate includes Draft and Finalized records. Verified Rate includes Finalized records only.</p><table><thead><tr><th>Member</th><th>Working Rate</th><th>Verified Rate</th><th>Risk Signals</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No member records.</td></tr>'}</tbody></table>`
    }));
  }

  function printMonthlyAttendance() {
    const monthLabel = calendarMonthLabel();
    const monthEvents = eventsInCalendarMonth(activityEvents());
    const members = membersForAttendanceGroup(monthEvents.filter((event) => normalize(event.type) === 'rehearsal'));
    const memberIds = new Set(members.map((member) => member.id));
    const events = monthEvents.filter((event) => members.some((member) => memberEligibleForAttendanceEvent(member, event)));
    const records = groupRecordsForEvents(events).filter((record) => memberIds.has(record.memberId));
    const counts = statusCounts(records);
    const rate = rateFromCounts(counts);
    const summaryHtml = `<div class="summary">${[
      ['Members', members.length], ['Activities', events.length], ['Present', counts.Present], ['Late', counts.Late], ['Absent', counts.Absent], ['Overall Rate', rate === null ? '—' : `${rate}%`]
    ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>`;
    const rows = members.map((member) => {
      const summary = memberSummaryForEvents(member.id, events);
      return `<tr><td>${safeText(member.fullName)}</td><td>${summary.rate === null ? '—' : `${summary.rate}%`}</td></tr>`;
    }).join('');
    openPrintDocument(printableDocument({
      title: `${attendanceRosterModeLabel()} — ${attendanceGroupShortLabel()} — ${monthLabel} Attendance Report`,
      subtitle: `${activeSemester()} • ${members.length} members • ${events.length} completed activities • ${records.length} recorded statuses`,
      summaryHtml,
      tableHtml: `${eventDetailReportTable(events)}<h2 class="report-section">${safeText(attendanceGroupShortLabel())} Monthly Summary</h2><p class="report-note">This monthly report is isolated from the other attendance groups.</p><table><thead><tr><th>Member</th><th>Attendance Rate</th></tr></thead><tbody>${rows || '<tr><td colspan="2">No member records.</td></tr>'}</tbody></table>`,
      footer: `${attendanceGroupShortLabel()} monthly attendance report for ${monthLabel}, ${activeSemester()}.`
    }));
  }

  function printIndividualMonthlyAttendance() {
    const member = membersForAttendanceGroup(rehearsalEvents()).find((item) => item.id === selectedAttendanceMemberId);
    if (!member) return;
    const monthLabel = calendarMonthLabel();
    const events = eventsInCalendarMonth(rehearsalEvents());
    const summary = memberSummaryForEvents(member.id, events);
    const recordMap = new Map(summary.records.map((record) => [record.eventId, record]));
    const summaryHtml = `<div class="summary">${[
      ['Rehearsals', summary.totalEvents], ['Present', summary.counts.Present], ['Late', summary.counts.Late],
      ['Absent', summary.counts.Absent], ['Excused', summary.counts.Excused], ['Attendance Rate', summary.rate === null ? '—' : `${summary.rate}%`]
    ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>`;
    const rows = summary.events.map((event) => {
      const record = recordMap.get(event.id) || {};
      const workflow = eventWorkflowState(event, record.attendanceGroup || activeAttendanceGroup(), record.rosterModeAtEdit || activeAttendanceRosterMode());
      return `<tr><td>${safeText(dateLabel(event.date, { short: true }))}</td><td>${safeText(event.venue || '—')}</td><td>${safeText(workflow)}</td><td>${safeText(record.status || 'Not marked')}</td><td>${safeText(record.remarks || '')}</td></tr>`;
    }).join('');
    openPrintDocument(printableDocument({
      title: `${member.fullName} — ${attendanceRosterModeLabel()} — ${attendanceGroupShortLabel()} — ${monthLabel}`, 
      subtitle: `${activeSemester()} • ${attendanceGroupShortLabel()} • ${member.membershipId} • ${member.periodGroup} • ${member.primaryInstrument || 'No instrument recorded'}`,
      summaryHtml,
      tableHtml: `<table><thead><tr><th>Date</th><th>Venue</th><th>Verification</th><th>Status</th><th>Remarks</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No completed rehearsal records for this month.</td></tr>'}</tbody></table>`,
      footer: `Individual monthly attendance report for ${monthLabel}, ${activeSemester()}.`
    }));
  }

  function printSelectedEventAttendance() {
    const active = document.querySelector('.event-card.active');
    const event = getEvents().find((item) => item.id === active?.dataset.eventId);
    if (!event) return;
    const members = getMembers()
      .filter((member) => memberEligibleForAttendanceEvent(member, event))
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
    const memberIds = new Set(members.map((member) => member.id));
    const memberMap = new Map(members.map((member) => [member.id, member]));
    const records = getAttendance().filter((record) => {
      const member = memberMap.get(record.memberId);
      return record.eventId === event.id && memberIds.has(record.memberId) && attendanceRecordGroup(record, event, member) === activeAttendanceGroup();
    });
    const map = new Map(records.map((record) => [record.memberId, record]));
    const counts = statusCounts(records);
    const workflow = eventWorkflowState(event);
    const summaryHtml = `<div class="summary">${[
      ['Roster', members.length], ['Verification', workflow], ['Present', counts.Present], ['Late', counts.Late], ['Absent', counts.Absent], ['Recorded', records.filter((r) => r.status).length]
    ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>`;
    const rows = members.map((member) => {
      const record = map.get(member.id) || {};
      return `<tr><td>${safeText(member.fullName)}</td><td>${safeText(member.orchestraSection || '—')}</td><td>${safeText(record.status || 'Not marked')}</td><td>${safeText(record.remarks || '')}</td></tr>`;
    }).join('');
    openPrintDocument(printableDocument({
      title: `${event.title} — ${attendanceRosterModeLabel()} — ${attendanceGroupShortLabel()}`, 
      subtitle: `${eventSemester(event)} • ${dateLabel(event.date)} • ${event.venue || 'Venue not recorded'} • ${event.type || 'Activity'} • ${workflow}`,
      summaryHtml,
      tableHtml: `<table><thead><tr><th>Member</th><th>Section</th><th>Status</th><th>Remarks</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No members in this attendance group.</td></tr>'}</tbody></table>`
    }));
  }

  function renderMembershipFlow() {
    const container = el('dashboardMembershipFlow');
    if (!container) return;
    const members = getMembers();
    const groups = [
      ['Trainee Period', 'Training', 'Foundation and onboarding'],
      ['Probationary Period', 'Evaluation', 'Performance monitoring'],
      ['Membership Period', 'Official', 'Full member directory']
    ];
    const total = members.length || 1;
    container.innerHTML = `<div class="membership-flow-track">${groups.map(([stage, label, helper], index) => {
      const count = members.filter((member) => member.periodGroup === stage).length;
      const percent = Math.round((count / total) * 100);
      return `<button class="membership-flow-node" data-dashboard-stage="${safeText(stage)}" type="button"><span class="flow-index">0${index + 1}</span><div><small>${safeText(label)}</small><strong>${count}</strong><em>${safeText(helper)}</em></div><span class="flow-percent">${members.length ? percent : 0}%</span></button>`;
    }).join('<span class="flow-connector">→</span>')}</div>`;
    if (el('dashboardMembershipFlowSummary')) el('dashboardMembershipFlowSummary').textContent = members.length
      ? `${members.length} total profiles moving through three automatic periods`
      : 'No membership profiles have been registered yet.';
  }

  function semesterAttendanceSignal(semester) {
    const events = activityEvents(semester);
    const eventMap = new Map(events.map((event) => [event.id, event]));
    const memberMap = new Map(getMembers().map((member) => [member.id, member]));
    const records = getAttendance().filter((record) => {
      const event = eventMap.get(record.eventId);
      const member = memberMap.get(record.memberId);
      return Boolean(record.status && event && member && attendanceRecordGroup(record, event, member) === 'Official Members');
    });
    const counts = statusCounts(records);
    return { semester, events, records, counts, rate: rateFromCounts(counts) };
  }

  function renderDutyDashboard() {
    const container = el('dashboardDutyOverview');
    const caption = el('dashboardDutySummary');
    if (!container || !caption) return;
    const api = window.LSODutyHours;
    if (!api?.getDashboardSummary) {
      container.innerHTML = '<div class="dashboard-empty-state"><span>◷</span><strong>Duty Hours is ready</strong><small>Open the module to set commitments and rendered time.</small></div>';
      caption.textContent = 'Waiting for duty-hour records';
      return;
    }
    const first = api.getDashboardSummary('First Semester');
    const second = api.getDashboardSummary('Second Semester');
    caption.textContent = `${first.tracked + second.tracked} semester roster records • exact hour-and-minute accounting`;
    container.innerHTML = `<div class="dashboard-semester-signal-grid">${[first, second].map((item) => `<button class="dashboard-semester-signal" data-dashboard-duty-semester="${safeText(item.semester)}" type="button"><span>${safeText(item.semester.replace(' Semester', ''))}</span><strong>${safeText(item.remainingLabel)}</strong><small>${item.tracked} tracked • ${item.completed} complete</small><div class="mini-progress"><i style="width:${item.progress}%"></i></div></button>`).join('')}</div>`;
  }

  function renderFuturisticDashboardSignals() {
    const members = getMembers();
    const events = getEvents();
    const first = semesterAttendanceSignal('First Semester');
    const second = semesterAttendanceSignal('Second Semester');
    const upcoming = events.filter((event) => event.date >= today()).length;
    const membership = members.filter((member) => member.periodGroup === 'Membership Period').length;
    if (el('dashboardHeroStatus')) {
      el('dashboardHeroStatus').innerHTML = [
        ['1st Sem Official Attendance', first.rate === null ? 'No data' : `${first.rate}%`],
        ['2nd Sem Official Attendance', second.rate === null ? 'No data' : `${second.rate}%`],
        ['Upcoming Schedule', `${upcoming} event${upcoming === 1 ? '' : 's'}`],
        ['Official Members', membership]
      ].map(([label, value]) => `<div class="hero-status-chip"><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('');
    }
    if (el('dashboardAttendanceSummary')) {
      el('dashboardAttendanceSummary').textContent = `Official-member semester signals • 1st: ${first.rate === null ? 'No data' : `${first.rate}%`} • 2nd: ${second.rate === null ? 'No data' : `${second.rate}%`}`;
    }
    if (el('dashboardGreetingMeta')) {
      el('dashboardGreetingMeta').textContent = 'Semester-separated attendance, exact duty-hour compliance, membership progression, and printable operational records in one live workspace.';
    }
    renderMembershipFlow();
    renderDutyDashboard();
  }

  function setEntryStage(stage) {
    const dateRegistered = el('dateRegistered')?.value || today();
    const skipControl = el('probationarySkipped');
    if (stage === 'Trainee Period') {
      if (skipControl) skipControl.checked = false;
      el('traineeStartDate').value = el('traineeStartDate').value || dateRegistered;
      el('probationaryStartDate').disabled = false;
      el('probationaryStartDate').value = '';
      el('regularMemberDate').value = '';
    } else if (stage === 'Probationary Period') {
      if (skipControl) skipControl.checked = false;
      const probationary = today();
      el('traineeStartDate').value = el('traineeStartDate').value && el('traineeStartDate').value < probationary ? el('traineeStartDate').value : addDays(probationary, -1);
      el('probationaryStartDate').disabled = false;
      el('probationaryStartDate').value = probationary;
      el('regularMemberDate').value = '';
    } else {
      const membership = today();
      const skipped = Boolean(skipControl?.checked);
      el('traineeStartDate').value = el('traineeStartDate').value && el('traineeStartDate').value < membership ? el('traineeStartDate').value : addDays(membership, skipped ? -1 : -2);
      el('probationaryStartDate').disabled = skipped;
      el('probationaryStartDate').value = skipped ? '' : (el('probationaryStartDate').value && el('probationaryStartDate').value < membership ? el('probationaryStartDate').value : addDays(membership, -1));
      el('regularMemberDate').value = membership;
    }
    if (skipControl) skipControl.dispatchEvent(new Event('change', { bubbles: true }));
    ['traineeStartDate', 'probationaryStartDate', 'regularMemberDate'].forEach((id) => el(id)?.dispatchEvent(new Event('change', { bubbles: true })));
  }

  function syncAttendanceSemesterControls() {
    if (el('attendanceSemesterLabel')) el('attendanceSemesterLabel').textContent = activeSemester();
    qsa('[data-attendance-semester]', el('attendanceSemesterToggle')).forEach((button) => {
      button.classList.toggle('active', button.dataset.attendanceSemester === activeSemester());
    });
  }

  function syncAttendanceGroupControls() {
    qsa('[data-attendance-group]', el('attendanceGroupToggle')).forEach((button) => {
      const allowed = window.LSORoleAccess?.canUseAttendanceGroup?.(button.dataset.attendanceGroup) ?? true;
      button.classList.toggle('active', allowed && button.dataset.attendanceGroup === activeAttendanceGroup());
      button.classList.toggle('role-hidden', !allowed);
      button.disabled = !allowed;
      button.setAttribute('aria-hidden', String(!allowed));
    });
    qsa('[data-attendance-roster-mode]', el('attendanceRosterModeToggle')).forEach((button) => {
      button.classList.toggle('active', button.dataset.attendanceRosterMode === activeAttendanceRosterMode());
    });
    const modeLabel = attendanceRosterModeLabel();
    if (el('attendanceRosterModeLabel')) el('attendanceRosterModeLabel').textContent = activeAttendanceRosterMode() === 'Archive' ? 'Archived stage records' : 'Current roster';
    if (el('attendanceGroupLabel')) el('attendanceGroupLabel').textContent = attendanceGroupShortLabel();
    if (el('attendanceGroupPrintButton')) el('attendanceGroupPrintButton').textContent = activeAttendanceRosterMode() === 'Archive' ? 'Print Archived Roster' : 'Print Current Roster';
    if (el('printOverallAttendance')) el('printOverallAttendance').textContent = 'Print Semester Report';
    if (el('printMonthlyAttendance')) el('printMonthlyAttendance').textContent = 'Print Monthly Report';
    if (el('attendanceRosterGroupLabel')) el('attendanceRosterGroupLabel').textContent = `${modeLabel}: ${attendanceGroupShortLabel()}`;
    if (el('attendanceArchiveNotice')) el('attendanceArchiveNotice').classList.toggle('hidden', activeAttendanceRosterMode() !== 'Archive');
  }

  function renderEverything() {
    syncAttendanceSemesterControls();
    syncAttendanceGroupControls();
    populateIndividualSelect();
    renderOverallAttendance();
    renderIndividualAttendance();
    renderCalendar();
    renderFuturisticDashboardSignals();
  }

  function removeRetiredInventoryFromUI() {
    document.querySelector('[data-view="instrumentsView"]')?.remove();
    el('instrumentsView')?.classList.add('hidden');
    el('instrumentModal')?.classList.add('hidden');
    qsa('[data-dashboard-action="inventory"], [data-dashboard-action="add-instrument"]').forEach((node) => node.remove());
  }

  function wireEvents() {
    el('attendanceIndividualSelect')?.addEventListener('change', (event) => {
      selectedAttendanceMemberId = event.target.value;
      renderIndividualAttendance();
    });
    el('printIndividualAttendance')?.addEventListener('click', printIndividualAttendance);
    el('printIndividualMonthlyAttendance')?.addEventListener('click', printIndividualMonthlyAttendance);
    el('printOverallAttendance')?.addEventListener('click', printOverallAttendance);
    el('printMonthlyAttendance')?.addEventListener('click', printMonthlyAttendance);
    el('printCalendarMonthlyAttendance')?.addEventListener('click', printMonthlyAttendance);
    el('printEventAttendance')?.addEventListener('click', printSelectedEventAttendance);
    el('attendanceSemesterToggle')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-attendance-semester]');
      if (!button) return;
      window.LSOAttendanceSemester = normalizeSemester(button.dataset.attendanceSemester);
      qsa('[data-attendance-semester]', el('attendanceSemesterToggle')).forEach((item) => item.classList.toggle('active', item === button));
      if (el('attendanceSemesterLabel')) el('attendanceSemesterLabel').textContent = window.LSOAttendanceSemester;
      window.LSOOperations?.setAttendanceSemester?.(window.LSOAttendanceSemester);
      renderEverything();
    });
    el('attendanceGroupToggle')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-attendance-group]');
      if (!button) return;
      const requestedGroup = normalizeAttendanceGroup(button.dataset.attendanceGroup);
      if (window.LSORoleAccess?.canUseAttendanceGroup && !window.LSORoleAccess.canUseAttendanceGroup(requestedGroup)) {
        window.LSOApp?.showToast?.(window.LSORoleAccess.deniedMessage('attendanceGroup'), true);
        return;
      }
      window.LSOAttendanceGroup = requestedGroup;
      selectedAttendanceMemberId = '';
      if (el('attendanceIndividualSelect')) el('attendanceIndividualSelect').value = '';
      window.LSOOperations?.setAttendanceGroup?.(window.LSOAttendanceGroup);
      renderEverything();
    });
    el('attendanceRosterModeToggle')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-attendance-roster-mode]');
      if (!button) return;
      window.LSOAttendanceRosterMode = normalizeAttendanceRosterMode(button.dataset.attendanceRosterMode);
      selectedAttendanceMemberId = '';
      if (el('attendanceIndividualSelect')) el('attendanceIndividualSelect').value = '';
      window.LSOOperations?.setAttendanceRosterMode?.(window.LSOAttendanceRosterMode);
      renderEverything();
    });
    el('attendanceGroupPrintButton')?.addEventListener('click', printCurrentAttendanceGroupRoster);
    el('calendarPreviousMonth')?.addEventListener('click', () => moveCalendarMonth(-1));
    el('calendarNextMonth')?.addEventListener('click', () => moveCalendarMonth(1));
    el('calendarToday')?.addEventListener('click', () => selectCalendarDate(today(), false));
    el('createEventOnSelectedDate')?.addEventListener('click', createEventOnSelectedDate);
    el('attendanceCalendarGrid')?.addEventListener('click', (event) => {
      const day = event.target.closest('[data-calendar-date]');
      if (day) selectCalendarDate(day.dataset.calendarDate, true);
    });
    el('stageEntryToggle')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-entry-stage]');
      if (button) setEntryStage(button.dataset.entryStage);
    });

    document.addEventListener('click', (event) => {
      const stage = event.target.closest('[data-dashboard-stage]');
      if (stage) {
        window.LSOApp?.setView?.('membersView');
        window.LSOApp?.setMembershipDirectory?.(stage.dataset.dashboardStage);
      }
      const action = event.target.closest('[data-dashboard-action="member-lookup"]');
      if (action) window.LSOApp?.setView?.('lookupView');
      const membersAction = event.target.closest('[data-dashboard-action="members"]');
      if (membersAction) window.LSOApp?.setView?.('membersView');
      const dutyAction = event.target.closest('[data-dashboard-action="duty-hours"]');
      if (dutyAction) window.LSOApp?.setView?.('dutyHoursView');
      const dutySemester = event.target.closest('[data-dashboard-duty-semester]');
      if (dutySemester) {
        window.LSOApp?.setView?.('dutyHoursView');
        window.LSODutyHours?.setSemester?.(dutySemester.dataset.dashboardDutySemester);
      }
    }, true);

    ['lso:members-changed', 'lso:operations-changed', 'lso:duty-hours-changed', 'lso:attendance-semester-changed', 'lso:attendance-month-changed', 'lso:attendance-group-changed', 'lso:attendance-roster-mode-changed', 'lso:cloud-state-changed', 'lso:auth-changed'].forEach((name) => {
      window.addEventListener(name, () => setTimeout(renderEverything, 30));
    });

    // The existing attendance manager saves first, then this refresh updates analytics and calendar.
    el('saveAttendanceButton')?.addEventListener('click', () => setTimeout(renderEverything, 80));
    el('eventForm')?.addEventListener('submit', () => setTimeout(() => {
      selectedCalendarDate = el('eventDate')?.value || selectedCalendarDate;
      window.LSOAttendanceSelectedDate = selectedCalendarDate;
      const savedDate = new Date(`${selectedCalendarDate}T00:00:00`);
      if (!Number.isNaN(savedDate.getTime())) setMonthWorkspace(savedDate, { resetDate: false });
      renderEverything();
    }, 100));
  }

  window.addEventListener('lso:auth-changed', () => setTimeout(() => { activeAttendanceGroup(); renderAll(); }, 0));

  function initialize() {
    if (el('attendanceSemesterLabel')) el('attendanceSemesterLabel').textContent = activeSemester();
    qsa('[data-attendance-semester]', el('attendanceSemesterToggle')).forEach((button) => button.classList.toggle('active', button.dataset.attendanceSemester === activeSemester()));
    syncAttendanceGroupControls();
    setMonthWorkspace(calendarCursor, { resetDate: false });
    removeRetiredInventoryFromUI();
    wireEvents();
    renderEverything();
    window.setInterval(() => {
      if (!el('appShell')?.classList.contains('hidden')) renderEverything();
    }, 60_000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
