(() => {
  'use strict';

  const KEYS = {
    members: 'lso_member_database_v1',
    events: 'lso_events_v2',
    attendance: 'lso_attendance_v2',
    duty: 'lso_duty_hours_v1',
    activity: 'lso_activity_log_v2',
    settings: 'lso_system_settings_v2'
  };
  const GROUPS = ['Official Members', 'Trainee Members', 'Probationary Members'];
  const MODES = ['Current', 'Archive'];
  const hostId = 'dashboardCommandCenterV4';
  let selectedMonth = localMonth();
  let detailState = null;
  let wired = false;

  const el = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function safe(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function load(key, fallback) {
    try {
      const parsed = JSON.parse(window.LSOStorage?.getItem(key) || JSON.stringify(fallback));
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || {};
  }

  function role() {
    return currentAccount()?.role || 'Staff Account';
  }

  function isAdmin() {
    return role() === 'Administrator';
  }


  function canAction(action) {
    return window.LSORoleAccess?.can?.(action, currentAccount()) ?? isAdmin();
  }

  function canView(viewId) {
    return window.LSORoleAccess?.canAccessView?.(viewId, currentAccount()) ?? role() !== 'Trainee/Probationary';
  }

  function getMembers() {
    return window.LSOApp?.getMembers?.() || load(KEYS.members, []);
  }

  function getEvents() {
    return window.LSOOperations?.getEvents?.() || load(KEYS.events, []);
  }

  function getAttendance() {
    return window.LSOOperations?.getAttendance?.() || load(KEYS.attendance, []);
  }

  function getAccounts() {
    return window.LSOAuth?.loadAccounts?.() || [];
  }

  function getDutyData() {
    return window.LSODutyHours?.getData?.() || load(KEYS.duty, { version: 7, commitments: {}, entries: [] });
  }

  function getActivity() {
    return load(KEYS.activity, []);
  }

  function getSettings() {
    return { attendanceThreshold: 75, ...load(KEYS.settings, {}) };
  }

  function localDate(date = new Date()) {
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function localMonth(date = new Date()) {
    return localDate(date).slice(0, 7);
  }

  function monthLabel(month) {
    const date = new Date(`${month}-01T00:00:00`);
    return Number.isNaN(date.getTime()) ? month : new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(date);
  }

  function dateLabel(value, includeYear = true) {
    if (!value) return 'Date not set';
    const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: includeYear ? 'numeric' : undefined }).format(date);
  }

  function dateTimeLabel(value) {
    if (!value) return 'Recently';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function timeLabel(value) {
    if (!value) return '';
    const [hours, minutes] = String(value).split(':').map(Number);
    if (!Number.isFinite(hours)) return String(value);
    const date = new Date(2000, 0, 1, hours, Number.isFinite(minutes) ? minutes : 0);
    return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function addMonths(month, amount) {
    const date = new Date(`${month}-01T00:00:00`);
    date.setMonth(date.getMonth() + amount);
    return localMonth(date);
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function download(filename, content, type = 'text/csv;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function memberStage(member) {
    const value = String(member?.periodGroup || member?.membershipStage || 'Membership Period');
    if (/trainee/i.test(value)) return 'Trainee Period';
    if (/probation/i.test(value)) return 'Probationary Period';
    return 'Membership Period';
  }

  function memberStatus(member) {
    return String(member?.memberStatus || member?.status || 'Active');
  }

  function isInactive(member) {
    return ['inactive', 'nonactive', 'archived'].includes(normalize(memberStatus(member)));
  }

  function isLoa(member) {
    return normalize(memberStatus(member)).includes('loa') || normalize(memberStatus(member)).includes('leave');
  }

  function memberIdLabel(member) {
    return member?.membershipId || member?.studentNumber || 'No ID';
  }

  function eventCancelled(event) {
    return normalize(event?.status) === 'cancelled' || normalize(event?.type) === 'cancelled';
  }

  function eventWorkflowEntries(event) {
    const workflows = event?.attendanceWorkflows && typeof event.attendanceWorkflows === 'object'
      ? Object.entries(event.attendanceWorkflows)
      : [];
    return workflows.map(([key, value]) => ({
      key,
      group: String(key).split('::')[0] || 'Official Members',
      mode: String(key).split('::')[1] || 'Current',
      state: value?.state === 'Finalized' ? 'Finalized' : 'Draft',
      unlockedAt: value?.unlockedAt || '',
      history: Array.isArray(value?.history) ? value.history : []
    }));
  }

  function recordWorkflowState(record, event) {
    const key = `${record?.attendanceGroup || 'Official Members'}::${record?.rosterModeAtEdit || 'Current'}`;
    return event?.attendanceWorkflows?.[key]?.state === 'Finalized' ? 'Finalized' : 'Draft';
  }

  function eventAttendanceState(event, attendance) {
    const records = attendance.filter((record) => record.eventId === event.id && record.status);
    const workflows = eventWorkflowEntries(event);
    const unlocked = workflows.some((item) => item.unlockedAt && item.state !== 'Finalized');
    const finalized = workflows.some((item) => item.state === 'Finalized');
    const draft = workflows.some((item) => item.state !== 'Finalized') || (records.length > 0 && !finalized);
    if (unlocked) return 'Unlocked';
    if (draft) return 'Draft';
    if (finalized) return 'Finalized';
    return 'Not Started';
  }

  function punchStatus(entry, type) {
    const key = type === 'TimeOut' ? 'timeOutApprovalStatus' : 'timeInApprovalStatus';
    const value = entry?.[key];
    if (['Pending', 'Approved', 'Rejected', 'Cancelled', 'Not Submitted'].includes(value)) return value;
    if (type === 'TimeOut') return entry?.timeOut ? (entry?.approvalStatus === 'Approved' ? 'Approved' : 'Pending') : 'Not Submitted';
    return entry?.timeIn ? (entry?.approvalStatus === 'Rejected' ? 'Rejected' : entry?.approvalStatus === 'Pending' ? 'Pending' : 'Approved') : 'Not Submitted';
  }

  function durationLabel(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    const hours = Math.floor(value / 60);
    const remainder = value % 60;
    if (hours && remainder) return `${hours}h ${remainder}m`;
    if (hours) return `${hours}h`;
    return `${remainder}m`;
  }

  function attendanceAnalytics(members, events, attendance) {
    const eventMap = new Map(events.map((event) => [event.id, event]));
    return members.map((member) => {
      const records = attendance
        .filter((record) => record.memberId === member.id && record.status && eventMap.has(record.eventId))
        .map((record) => ({ record, event: eventMap.get(record.eventId) }))
        .sort((a, b) => String(a.event.date || '').localeCompare(String(b.event.date || '')));
      const included = records.filter(({ record }) => ['Present', 'Late', 'Absent'].includes(record.status));
      const attended = included.filter(({ record }) => ['Present', 'Late'].includes(record.status)).length;
      const verified = included.filter(({ record, event }) => recordWorkflowState(record, event) === 'Finalized');
      const verifiedAttended = verified.filter(({ record }) => ['Present', 'Late'].includes(record.status)).length;
      const late = records.filter(({ record }) => record.status === 'Late').length;
      let consecutiveAbsences = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index].record.status === 'Absent') consecutiveAbsences += 1;
        else if (['Present', 'Late'].includes(records[index].record.status)) break;
      }
      return {
        member,
        records: records.length,
        present: records.filter(({ record }) => record.status === 'Present').length,
        late,
        absent: records.filter(({ record }) => record.status === 'Absent').length,
        excused: records.filter(({ record }) => record.status === 'Excused').length,
        rate: included.length ? Math.round(attended / included.length * 100) : null,
        verifiedRate: verified.length ? Math.round(verifiedAttended / verified.length * 100) : null,
        consecutiveAbsences,
        riskScore: (consecutiveAbsences >= 2 ? 3 : consecutiveAbsences) + (late >= 3 ? 2 : late ? 1 : 0)
      };
    });
  }

  function dataQuality(members, accounts, events, attendance, dutyData) {
    const studentNumbers = new Map();
    const emails = new Map();
    members.forEach((member) => {
      const number = normalize(member.studentNumber);
      const email = normalize(member.dlsudEmail || member.outlookEmail || member.email);
      if (number) studentNumbers.set(number, (studentNumbers.get(number) || 0) + 1);
      if (email) emails.set(email, (emails.get(email) || 0) + 1);
    });
    const duplicateStudent = members.filter((member) => studentNumbers.get(normalize(member.studentNumber)) > 1);
    const duplicateEmail = members.filter((member) => emails.get(normalize(member.dlsudEmail || member.outlookEmail || member.email)) > 1);
    const incomplete = members.filter((member) => Number(member.recordQuality || 0) < 90);
    const missingId = members.filter((member) => !String(member.studentNumber || '').trim());
    const missingSection = members.filter((member) => !String(member.orchestraSection || member.section || '').trim());
    const invalidTimeline = members.filter((member) => {
      const dates = [member.traineeStartDate, member.probationaryStartDate, member.regularMemberDate].filter(Boolean);
      return dates.some((date, index) => index && date < dates[index - 1]);
    });
    const accountWithoutMember = accounts.filter((account) => account.role === 'Trainee/Probationary' && account.approvalStatus === 'Approved' && !account.memberId);
    const inactiveLinked = accounts.filter((account) => {
      if (account.role !== 'Trainee/Probationary' || account.approvalStatus !== 'Approved' || !account.memberId) return false;
      const member = members.find((item) => item.id === account.memberId);
      return !member || isInactive(member) || isLoa(member);
    });
    const missingTimeOut = (dutyData.entries || []).filter((entry) => entry.entryType === 'Duty' && entry.timeIn && !entry.timeOut && ['Approved', 'Pending'].includes(punchStatus(entry, 'TimeIn')));
    const eventWithoutRoster = events.filter((event) => event.date <= localDate() && !attendance.some((record) => record.eventId === event.id && record.status));
    return { incomplete, missingId, missingSection, duplicateStudent, duplicateEmail, invalidTimeline, accountWithoutMember, inactiveLinked, missingTimeOut, eventWithoutRoster };
  }

  function dashboardData() {
    const members = getMembers();
    const events = getEvents();
    const attendance = getAttendance();
    const accounts = getAccounts();
    const duty = getDutyData();
    const settings = getSettings();
    const analytics = attendanceAnalytics(members, events, attendance);
    const quality = dataQuality(members, accounts, events, attendance, duty);
    const threshold = Math.max(1, Math.min(100, Number(settings.attendanceThreshold) || 75));
    const pendingTimeIn = (duty.entries || []).filter((entry) => entry.entryType === 'Duty' && punchStatus(entry, 'TimeIn') === 'Pending');
    const pendingTimeOut = (duty.entries || []).filter((entry) => entry.entryType === 'Duty' && punchStatus(entry, 'TimeOut') === 'Pending');
    const draftEvents = events.filter((event) => event.date <= localDate() && eventAttendanceState(event, attendance) === 'Draft');
    const unlockedEvents = events.filter((event) => eventAttendanceState(event, attendance) === 'Unlocked');
    const noAttendanceEvents = events.filter((event) => event.date <= localDate() && eventAttendanceState(event, attendance) === 'Not Started' && !eventCancelled(event));
    const belowThreshold = analytics.filter((item) => item.rate !== null && item.rate < threshold);
    const consecutive = analytics.filter((item) => item.consecutiveAbsences >= 2);
    const frequentLate = analytics.filter((item) => item.late >= 3);
    return { members, events, attendance, accounts, duty, settings, threshold, analytics, quality, pendingTimeIn, pendingTimeOut, draftEvents, unlockedEvents, noAttendanceEvents, belowThreshold, consecutive, frequentLate };
  }

  function actionCards(data) {
    const cards = [
      { key: 'pending-accounts', icon: 'AC', label: 'Pending Accounts', value: data.accounts.filter((item) => item.approvalStatus === 'Pending').length, note: 'Choose a role and approve', tone: 'blue', visible: canView('accountsView') },
      { key: 'pending-time-in', icon: 'IN', label: 'Pending Time In', value: data.pendingTimeIn.length, note: 'Separate punch approvals', tone: 'gold', visible: canAction('reviewDutyPunches') },
      { key: 'pending-time-out', icon: 'OUT', label: 'Pending Time Out', value: data.pendingTimeOut.length, note: 'Review completed sessions', tone: 'gold', visible: canAction('reviewDutyPunches') },
      { key: 'draft-attendance', icon: 'DR', label: 'Draft Attendance', value: data.draftEvents.length, note: canAction('finalizeAttendance') ? 'Save or finalize rosters' : 'Review and save draft rosters', tone: 'purple', visible: canView('attendanceView') },
      { key: 'unlocked-attendance', icon: 'UL', label: 'Unlocked Attendance', value: data.unlockedEvents.length, note: 'Corrections need re-finalizing', tone: 'red', visible: canView('attendanceView') },
      { key: 'incomplete-profiles', icon: 'ID', label: 'Incomplete Profiles', value: data.quality.incomplete.length, note: 'Below 90% completeness', tone: 'green', visible: canView('membersView') }
    ];
    return cards.filter((card) => card.visible);
  }

  function renderHeader(data) {
    const account = currentAccount();
    const firstName = String(account.displayName || account.username || 'LSO team').trim().split(/\s+/)[0];
    const urgent = actionCards(data).filter((item) => item.value > 0).length;
    return `<section class="dcc-hero">
      <div class="dcc-hero-copy"><p class="dcc-kicker">Orchestra Command Center</p><h2>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${safe(firstName)}</h2><p>${safe(role())} workspace • ${urgent ? `${urgent} action group${urgent === 1 ? '' : 's'} require attention` : 'operations are currently clear'}.</p><div class="dcc-role-row"><span class="dcc-role-pill">${safe(role())}</span><span>${safe(dateLabel(localDate()))}</span><span>Attendance threshold: ${data.threshold}%</span></div></div>
      <div class="dcc-hero-actions">${canAction('manageMembers') ? '<button class="button button-light" data-dcc-action="add-member" type="button">+ Add Member</button>' : '<button class="button button-light" data-dcc-action="attendance" type="button">Open Attendance</button>'}${canAction('manageEvents') ? '<button class="button dcc-ghost" data-dcc-action="create-activity" type="button">Create Activity</button>' : canView('monthlyReportView') ? '<button class="button dcc-ghost" data-dcc-action="monthly-report" type="button">View Reports</button>' : ''}</div>
    </section>`;
  }

  function renderActionCenter(data) {
    const cards = actionCards(data);
    return `<section class="dcc-section"><div class="dcc-section-heading"><div><p class="dcc-kicker">Action Center</p><h3>What needs attention</h3><p>Each card opens the exact records behind the count.</p></div>${canView('alertsView') ? '<button class="dcc-text-button" data-dcc-action="alerts" type="button">Open full alerts →</button>' : ''}</div><div class="dcc-action-grid">${cards.map((card) => `<button class="dcc-action-card tone-${card.tone}${card.value ? ' has-items' : ''}" data-dcc-detail="${card.key}" type="button"><span class="dcc-action-icon">${safe(card.icon)}</span><span class="dcc-action-copy"><small>${safe(card.label)}</small><strong>${card.value}</strong><em>${safe(card.note)}</em></span><span class="dcc-card-arrow">→</span></button>`).join('')}</div></section>`;
  }

  function monthEvents(data) {
    return data.events.filter((event) => String(event.date || '').slice(0, 7) === selectedMonth);
  }

  function renderMonthlyOverview(data) {
    const events = monthEvents(data);
    const attendanceIds = new Set(events.map((event) => event.id));
    const marks = data.attendance.filter((record) => attendanceIds.has(record.eventId) && record.status).length;
    const today = localDate();
    const metrics = {
      activities: events.length,
      completed: events.filter((event) => event.date < today && !eventCancelled(event)).length,
      upcoming: events.filter((event) => event.date >= today && !eventCancelled(event)).length,
      finalized: events.filter((event) => eventAttendanceState(event, data.attendance) === 'Finalized').length,
      draft: events.filter((event) => ['Draft', 'Unlocked'].includes(eventAttendanceState(event, data.attendance))).length,
      cancelled: events.filter(eventCancelled).length,
      marks
    };
    const eventRows = [...events].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.startTime || '').localeCompare(String(b.startTime || ''))).slice(0, 6);
    return `<section class="dcc-panel dcc-month-panel"><div class="dcc-panel-heading"><div><p class="dcc-kicker">Monthly Operations</p><h3>${safe(monthLabel(selectedMonth))}</h3><p>Activities and attendance remain separated by calendar month.</p></div><div class="dcc-month-controls"><button data-dcc-month="-1" type="button" aria-label="Previous month">‹</button><input id="dccMonthPicker" type="month" value="${safe(selectedMonth)}"/><button data-dcc-month="1" type="button" aria-label="Next month">›</button><button data-dcc-month="today" type="button">Current</button></div></div>
      <div class="dcc-month-metrics">${[
        ['Activities', metrics.activities], ['Completed', metrics.completed], ['Upcoming', metrics.upcoming], ['Finalized', metrics.finalized], ['Draft', metrics.draft], ['Cancelled', metrics.cancelled], ['Attendance Marks', metrics.marks]
      ].map(([label, value]) => `<div><span>${safe(label)}</span><strong>${value}</strong></div>`).join('')}</div>
      <div class="dcc-month-list">${eventRows.length ? eventRows.map((event) => {
        const state = eventCancelled(event) ? 'Cancelled' : eventAttendanceState(event, data.attendance);
        return `<button class="dcc-event-row" data-dcc-event="${safe(event.id)}" type="button"><time><strong>${safe(String(event.date || '').slice(8, 10))}</strong><small>${safe(new Intl.DateTimeFormat('en-PH', { month: 'short' }).format(new Date(`${event.date}T00:00:00`)))}</small></time><span><strong>${safe(event.title || 'Untitled activity')}</strong><small>${safe([event.type, timeLabel(event.startTime), event.venue].filter(Boolean).join(' • '))}</small></span><em class="dcc-state state-${normalize(state).replace(/\s+/g, '-')}">${safe(state)}</em></button>`;
      }).join('') : `<div class="dcc-empty"><span>＋</span><strong>No activities in ${safe(monthLabel(selectedMonth))}</strong><p>This month is ready for a new rehearsal, meeting, performance, or activity.</p>${canAction('manageEvents') ? '<button class="button button-primary" data-dcc-action="create-activity" type="button">Create Activity</button>' : ''}</div>`}</div>
    </section>`;
  }

  function riskLabel(item, threshold) {
    if (item.consecutiveAbsences >= 2 || (item.rate !== null && item.rate < threshold - 10)) return ['At Risk', 'red'];
    if (item.late >= 3 || (item.rate !== null && item.rate < threshold)) return ['Needs Monitoring', 'gold'];
    return ['Good Standing', 'green'];
  }

  function renderAttendanceHealth(data) {
    const eligible = data.analytics.filter((item) => item.records > 0);
    const totalIncluded = eligible.reduce((sum, item) => sum + item.present + item.late + item.absent, 0);
    const totalAttended = eligible.reduce((sum, item) => sum + item.present + item.late, 0);
    const overall = totalIncluded ? Math.round(totalAttended / totalIncluded * 100) : null;
    const atRisk = eligible.filter((item) => riskLabel(item, data.threshold)[0] !== 'Good Standing')
      .sort((a, b) => b.riskScore - a.riskScore || (a.rate ?? 101) - (b.rate ?? 101)).slice(0, 6);
    return `<section class="dcc-panel"><div class="dcc-panel-heading"><div><p class="dcc-kicker">Attendance Health</p><h3>Participation and risk signals</h3><p>Excused and Not Required records do not lower the attendance rate.</p></div><button class="dcc-text-button" data-dcc-export="attendance" type="button">Export analytics CSV</button></div>
      <div class="dcc-health-summary"><div class="dcc-rate-ring" style="--rate:${overall ?? 0}"><div><strong>${overall === null ? '—' : `${overall}%`}</strong><small>Overall rate</small></div></div><div class="dcc-health-kpis"><div><span>Below threshold</span><strong>${data.belowThreshold.length}</strong></div><div><span>Consecutive absences</span><strong>${data.consecutive.length}</strong></div><div><span>Frequent lateness</span><strong>${data.frequentLate.length}</strong></div><div><span>No attendance data</span><strong>${data.analytics.filter((item) => item.records === 0).length}</strong></div></div></div>
      <div class="dcc-risk-list">${atRisk.length ? atRisk.map((item) => { const [label, tone] = riskLabel(item, data.threshold); return `<button class="dcc-risk-row" data-dcc-member="${safe(item.member.id)}" type="button"><span class="dcc-avatar">${safe(String(item.member.fullName || '?').split(/\s+/).slice(0,2).map((part) => part[0]).join('').toUpperCase())}</span><span><strong>${safe(item.member.fullName || 'Unnamed member')}</strong><small>${safe(memberIdLabel(item.member))} • ${item.absent} absent • ${item.late} late${item.verifiedRate === null ? '' : ` • ${item.verifiedRate}% verified`}</small></span><span class="dcc-risk-rate"><strong>${item.rate === null ? '—' : `${item.rate}%`}</strong><em class="tone-${tone}">${label}</em></span></button>`; }).join('') : '<div class="dcc-empty compact"><span>✓</span><strong>No attendance risk detected</strong><p>Members with recorded attendance are within the configured threshold.</p></div>'}</div>
    </section>`;
  }

  function dutyRows(data) {
    return data.members.filter((member) => ['Trainee Period', 'Probationary Period'].includes(memberStage(member))).map((member) => {
      const calculated = window.LSODutyHours?.calculateMember?.(member.id);
      const academic = calculated?.academicYear || { committed: 0, credited: 0, balance: 0 };
      const pendingIn = data.pendingTimeIn.filter((entry) => entry.memberId === member.id).length;
      const pendingOut = data.pendingTimeOut.filter((entry) => entry.memberId === member.id).length;
      const progress = academic.committed > 0 ? Math.max(0, Math.min(100, Math.round(academic.credited / academic.committed * 100))) : 0;
      return { member, stage: memberStage(member), committed: academic.committed || 0, credited: academic.credited || 0, balance: academic.balance || 0, progress, pendingIn, pendingOut };
    }).sort((a, b) => a.progress - b.progress || String(a.member.fullName).localeCompare(String(b.member.fullName)));
  }

  function renderDutyProgress(data) {
    const rows = dutyRows(data);
    const completed = rows.filter((row) => row.committed > 0 && row.balance <= 0).length;
    const outstanding = rows.reduce((sum, row) => sum + Math.max(0, row.balance), 0);
    return `<section class="dcc-panel"><div class="dcc-panel-heading"><div><p class="dcc-kicker">Duty Hours Progress</p><h3>Trainee and Probationary compliance</h3><p>Only separately approved Time In and Time Out punches affect credited totals.</p></div><button class="dcc-text-button" data-dcc-export="duty" type="button">Export progress CSV</button></div>
      <div class="dcc-inline-kpis"><div><span>Active records</span><strong>${rows.length}</strong></div><div><span>Completed</span><strong>${completed}</strong></div><div><span>Pending punches</span><strong>${data.pendingTimeIn.length + data.pendingTimeOut.length}</strong></div><div><span>Outstanding</span><strong>${durationLabel(outstanding)}</strong></div></div>
      <div class="dcc-duty-list">${rows.length ? rows.slice(0, 7).map((row) => `<button class="dcc-duty-row" data-dcc-duty-member="${safe(row.member.id)}" type="button"><span><strong>${safe(row.member.fullName)}</strong><small>${safe(row.stage)} • ${row.pendingIn + row.pendingOut} pending punch${row.pendingIn + row.pendingOut === 1 ? '' : 'es'}</small></span><span class="dcc-progress-copy"><strong>${durationLabel(row.credited)} / ${durationLabel(row.committed)}</strong><small>${row.balance > 0 ? `${durationLabel(row.balance)} remaining` : row.committed ? 'Requirement complete' : 'Commitment not set'}</small></span><span class="dcc-progress"><i style="width:${row.progress}%"></i></span><b>${row.progress}%</b></button>`).join('') : '<div class="dcc-empty compact"><span>◷</span><strong>No active duty-hour records</strong><p>Current Trainee and Probationary members will appear here.</p></div>'}</div>
    </section>`;
  }

  function upcomingStatus(event, data) {
    const state = eventAttendanceState(event, data.attendance);
    if (eventCancelled(event)) return 'Cancelled';
    if (state === 'Finalized') return 'Finalized';
    if (state === 'Draft' || state === 'Unlocked') return `${state} Attendance`;
    return event.date >= localDate() ? 'Upcoming' : 'Attendance Not Started';
  }

  function renderUpcoming(data) {
    const rows = data.events.filter((event) => event.date >= localDate() && !eventCancelled(event))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.startTime || '').localeCompare(String(b.startTime || ''))).slice(0, 5);
    return `<section class="dcc-panel"><div class="dcc-panel-heading"><div><p class="dcc-kicker">Upcoming Activities</p><h3>Next five scheduled activities</h3><p>Open an activity directly in the monthly Attendance workspace.</p></div><button class="dcc-text-button" data-dcc-action="attendance" type="button">Open calendar →</button></div><div class="dcc-upcoming-list">${rows.length ? rows.map((event) => `<button class="dcc-upcoming-row" data-dcc-event="${safe(event.id)}" type="button"><time><strong>${safe(String(event.date).slice(8,10))}</strong><small>${safe(new Intl.DateTimeFormat('en-PH', { month: 'short' }).format(new Date(`${event.date}T00:00:00`)))}</small></time><span><strong>${safe(event.title || 'Untitled activity')}</strong><small>${safe([timeLabel(event.startTime), event.venue || 'Venue not set', event.semester].filter(Boolean).join(' • '))}</small></span><em>${safe(upcomingStatus(event, data))}</em></button>`).join('') : '<div class="dcc-empty compact"><span>▣</span><strong>No upcoming activities</strong><p>Create an activity to begin the schedule.</p></div>'}</div></section>`;
  }

  function renderMemberStats(data) {
    const stats = [
      ['Membership Period', data.members.filter((member) => memberStage(member) === 'Membership Period' && !isInactive(member) && !isLoa(member)).length, 'members'],
      ['Trainee Period', data.members.filter((member) => memberStage(member) === 'Trainee Period' && !isInactive(member) && !isLoa(member)).length, 'trainees'],
      ['Probationary Period', data.members.filter((member) => memberStage(member) === 'Probationary Period' && !isInactive(member) && !isLoa(member)).length, 'probationary'],
      ['LOA', data.members.filter(isLoa).length, 'loa'],
      ['Inactive / Archived', data.members.filter(isInactive).length, 'inactive'],
      ['Incomplete Profiles', data.quality.incomplete.length, 'incomplete']
    ];
    return `<section class="dcc-panel"><div class="dcc-panel-heading"><div><p class="dcc-kicker">Member Overview</p><h3>Current organization records</h3><p>Select a statistic to open the corresponding roster or exact record list.</p></div><button class="dcc-text-button" data-dcc-action="members" type="button">Open directory →</button></div><div class="dcc-member-stat-grid">${stats.map(([label, value, key]) => `<button data-dcc-member-stat="${key}" type="button"><span>${safe(label)}</span><strong>${value}</strong><small>View records →</small></button>`).join('')}</div></section>`;
  }

  function activityIcon(category) {
    const map = { Members: 'M', Attendance: 'A', 'Attendance Audit': 'A', Accounts: 'AC', 'Duty Hours': 'DH', Data: 'D', Settings: 'S' };
    return map[category] || '•';
  }

  function renderRecentActivity(data) {
    const log = getActivity().slice(0, 8);
    return `<section class="dcc-panel"><div class="dcc-panel-heading"><div><p class="dcc-kicker">Recent System Activity</p><h3>Latest recorded changes</h3><p>Administrative actions are shown from the shared audit log.</p></div>${canView('dataView') ? '<button class="dcc-text-button" data-dcc-action="data" type="button">Open audit log →</button>' : ''}</div><div class="dcc-activity-list">${log.length ? log.map((item) => `<div class="dcc-activity-row"><span>${safe(activityIcon(item.category))}</span><div><strong>${safe(item.action || 'System activity')}</strong><small>${safe([item.details, item.account].filter(Boolean).join(' • '))}</small></div><time>${safe(dateTimeLabel(item.timestamp))}</time></div>`).join('') : '<div class="dcc-empty compact"><span>↻</span><strong>No recent activity</strong><p>New member, attendance, account, and duty-hour actions will appear here.</p></div>'}</div></section>`;
  }

  function qualityRows(data) {
    return [
      ['Incomplete member profiles', data.quality.incomplete.length, 'incomplete-profiles'],
      ['Missing Student Number', data.quality.missingId.length, 'missing-id'],
      ['Missing orchestra section', data.quality.missingSection.length, 'missing-section'],
      ['Duplicate Student Number', data.quality.duplicateStudent.length, 'duplicate-student'],
      ['Duplicate Outlook/email', data.quality.duplicateEmail.length, 'duplicate-email'],
      ['Invalid membership timeline', data.quality.invalidTimeline.length, 'invalid-timeline'],
      ['Approved duty account without member', data.quality.accountWithoutMember.length, 'account-no-member'],
      ['Duty account linked to inactive record', data.quality.inactiveLinked.length, 'inactive-link'],
      ['Open duty session without Time Out', data.quality.missingTimeOut.length, 'missing-timeout'],
      ['Past activity without attendance', data.quality.eventWithoutRoster.length, 'event-no-attendance']
    ];
  }

  function renderDataQuality(data) {
    const rows = qualityRows(data);
    const total = rows.reduce((sum, row) => sum + row[1], 0);
    return `<section class="dcc-panel"><div class="dcc-panel-heading"><div><p class="dcc-kicker">Data Quality Alerts</p><h3>Records that may cause future problems</h3><p>Checks use the fields already stored by the current system.</p></div><span class="dcc-total-alerts">${total} issue${total === 1 ? '' : 's'}</span></div><div class="dcc-quality-list">${rows.map(([label, count, key]) => `<button data-dcc-detail="${key}" type="button"><span>${safe(label)}</span><strong class="${count ? 'has-value' : ''}">${count}</strong><em>Review →</em></button>`).join('')}</div></section>`;
  }

  function renderQuickActions() {
    const sets = {
      Administrator: [
        ['add-member', '+', 'Add Member', 'Create a validated member record'],
        ['create-activity', '▣', 'Create Activity', 'Add to the selected calendar month'],
        ['attendance', '✓', 'Open Attendance', 'Record or finalize a roster'],
        ['duty-hours', '◷', 'Review Duty Hours', 'Approve separate punch requests'],
        ['accounts', 'AC', 'Approve Accounts', 'Choose roles and linked members'],
        ['monthly-report', 'PDF', 'Monthly Report', 'Generate and download reports'],
        ['backup', '↓', 'Export Backup', 'Protect the complete system data']
      ],
      Membership: [
        ['add-member', '+', 'Add Member', 'Manage membership records'],
        ['create-activity', '▣', 'Create Activity', 'Prepare Trainee/Probationary attendance'],
        ['attendance', '✓', 'Attendance Drafts', 'Trainee and Probationary rosters'],
        ['duty-hours', '◷', 'Duty Hours', 'Approve punches and add manual time'],
        ['monthly-report', 'PDF', 'Monthly Report', 'Prepare official reports'],
        ['members', 'M', 'Member Directory', 'Open member operations']
      ],
      'General Secretary': [
        ['create-activity', '▣', 'Create Activity', 'Add a monthly attendance activity'],
        ['attendance', '✓', 'Attendance Drafts', 'Record and save draft rosters']
      ],
      'Staff Account': [
        ['members', 'M', 'Member Directory', 'Search and inspect profiles'],
        ['attendance', '✓', 'Attendance', 'View monthly rosters and analytics'],
        ['duty-hours', '◷', 'Duty Hours', 'View progress and records'],
        ['monthly-report', 'PDF', 'Monthly Report', 'Preview organization reports'],
        ['alerts', '!', 'Action Center', 'Review current operational alerts'],
        ['data', '↓', 'Data & Audit', 'View exports and activity history']
      ]
    };
    const actions = sets[role()] || sets['Staff Account'];
    const heading = isAdmin() ? 'Administrative tools' : role() === 'Staff Account' ? 'Read-only workspace tools' : `${role()} tools`;
    return `<section class="dcc-section"><div class="dcc-section-heading"><div><p class="dcc-kicker">Quick Actions</p><h3>${safe(heading)}</h3><p>Open the most frequently used modules in one click.</p></div></div><div class="dcc-quick-grid">${actions.map(([key, icon, title, note]) => `<button data-dcc-action="${key}" type="button"><span>${safe(icon)}</span><strong>${safe(title)}</strong><small>${safe(note)}</small></button>`).join('')}</div></section>`;
  }

  function render() {
    const host = el(hostId);
    if (!host) return;
    if (role() === 'Trainee/Probationary') {
      host.innerHTML = '';
      document.body.classList.remove('dashboard-command-center-ready');
      return;
    }
    const data = dashboardData();
    host.innerHTML = `${renderHeader(data)}${renderActionCenter(data)}<div class="dcc-main-grid">${renderMonthlyOverview(data)}${renderUpcoming(data)}${renderAttendanceHealth(data)}${renderDutyProgress(data)}${renderMemberStats(data)}${renderDataQuality(data)}${renderRecentActivity(data)}</div>${renderQuickActions()}${renderDetailModal()}`;
    document.body.classList.add('dashboard-command-center-ready');
    if (detailState) updateDetailModal(data);
  }

  function detailItems(key, data) {
    const memberItem = (member, meta) => ({ id: member.id, title: member.fullName || 'Unnamed member', meta: `${memberIdLabel(member)}${meta ? ` • ${meta}` : ''}`, action: 'member' });
    const eventItem = (event, meta) => ({ id: event.id, title: event.title || 'Untitled activity', meta: `${dateLabel(event.date)}${meta ? ` • ${meta}` : ''}`, action: 'event' });
    const accountItem = (account) => ({ id: account.id, title: account.displayName || account.username, meta: `${account.username} • ${account.role || 'Role not assigned'}`, action: 'accounts' });
    const dutyItem = (entry, type) => {
      const member = data.members.find((item) => item.id === entry.memberId);
      return { id: entry.id, title: member?.fullName || 'Unknown member', meta: `${type === 'TimeIn' ? 'Time In' : 'Time Out'} • ${dateLabel(entry.date)} • ${timeLabel(type === 'TimeIn' ? entry.timeIn : entry.timeOut)}`, action: 'duty' };
    };
    const maps = {
      'pending-accounts': { title: 'Pending account approvals', module: 'accounts', items: data.accounts.filter((item) => item.approvalStatus === 'Pending').map(accountItem) },
      'pending-time-in': { title: 'Pending Time In requests', module: 'duty-hours', items: data.pendingTimeIn.map((entry) => dutyItem(entry, 'TimeIn')) },
      'pending-time-out': { title: 'Pending Time Out requests', module: 'duty-hours', items: data.pendingTimeOut.map((entry) => dutyItem(entry, 'TimeOut')) },
      'draft-attendance': { title: 'Draft attendance activities', module: 'attendance', items: data.draftEvents.map((event) => eventItem(event, 'Draft')) },
      'unlocked-attendance': { title: 'Attendance unlocked for correction', module: 'attendance', items: data.unlockedEvents.map((event) => eventItem(event, 'Needs re-finalization')) },
      'incomplete-profiles': { title: 'Incomplete member profiles', module: 'members', items: data.quality.incomplete.map((member) => memberItem(member, `${Number(member.recordQuality || 0)}% complete`)) },
      'missing-id': { title: 'Members missing Student Number', module: 'members', items: data.quality.missingId.map((member) => memberItem(member, memberStage(member))) },
      'missing-section': { title: 'Members missing orchestra section', module: 'members', items: data.quality.missingSection.map((member) => memberItem(member, memberStage(member))) },
      'duplicate-student': { title: 'Duplicate Student Numbers', module: 'members', items: data.quality.duplicateStudent.map((member) => memberItem(member, member.studentNumber || 'Missing')) },
      'duplicate-email': { title: 'Duplicate Outlook or email addresses', module: 'members', items: data.quality.duplicateEmail.map((member) => memberItem(member, member.dlsudEmail || member.outlookEmail || member.email)) },
      'invalid-timeline': { title: 'Invalid membership timelines', module: 'members', items: data.quality.invalidTimeline.map((member) => memberItem(member, 'Stage dates are out of order')) },
      'account-no-member': { title: 'Approved duty accounts without a linked member', module: 'accounts', items: data.quality.accountWithoutMember.map(accountItem) },
      'inactive-link': { title: 'Duty accounts linked to inactive records', module: 'accounts', items: data.quality.inactiveLinked.map(accountItem) },
      'missing-timeout': { title: 'Open duty sessions without Time Out', module: 'duty-hours', items: data.quality.missingTimeOut.map((entry) => dutyItem(entry, 'TimeIn')) },
      'event-no-attendance': { title: 'Past activities without attendance', module: 'attendance', items: data.quality.eventWithoutRoster.map((event) => eventItem(event, 'No marked roster')) },
      'members-loa': { title: 'Members on leave of absence', module: 'members', items: data.members.filter(isLoa).map((member) => memberItem(member, memberStage(member))) },
      'members-inactive': { title: 'Inactive or archived members', module: 'members', items: data.members.filter(isInactive).map((member) => memberItem(member, memberStage(member))) }
    };
    return maps[key] || { title: 'Dashboard details', module: '', items: [] };
  }

  function renderDetailModal() {
    return `<div class="dcc-modal hidden" id="dccDetailModal" role="dialog" aria-modal="true" aria-labelledby="dccDetailTitle"><div class="dcc-modal-card"><header><div><p class="dcc-kicker">Exact Records</p><h3 id="dccDetailTitle">Dashboard details</h3><p id="dccDetailSummary"></p></div><button data-dcc-close-modal type="button" aria-label="Close">×</button></header><div id="dccDetailList" class="dcc-detail-list"></div><footer><button class="button button-secondary" data-dcc-close-modal type="button">Close</button><button class="button button-primary" id="dccOpenModuleButton" type="button">Open module</button></footer></div></div>`;
  }

  function updateDetailModal(data) {
    const modal = el('dccDetailModal');
    if (!modal || !detailState) return;
    const detail = detailItems(detailState, data);
    el('dccDetailTitle').textContent = detail.title;
    el('dccDetailSummary').textContent = `${detail.items.length} matching record${detail.items.length === 1 ? '' : 's'}`;
    el('dccDetailList').innerHTML = detail.items.length ? detail.items.map((item) => `<button data-dcc-detail-item="${safe(item.action)}" data-id="${safe(item.id)}" type="button"><span><strong>${safe(item.title)}</strong><small>${safe(item.meta)}</small></span><b>Open →</b></button>`).join('') : '<div class="dcc-empty compact"><span>✓</span><strong>No matching records</strong><p>This action group is currently clear.</p></div>';
    const moduleButton = el('dccOpenModuleButton');
    moduleButton.dataset.module = detail.module;
    const viewMap = { attendance: 'attendanceView', 'duty-hours': 'dutyHoursView', accounts: 'accountsView', alerts: 'alertsView', data: 'dataView', members: 'membersView', 'monthly-report': 'monthlyReportView' };
    moduleButton.classList.toggle('hidden', !detail.module || !canView(viewMap[detail.module]));
    modal.classList.remove('hidden');
  }

  function openDetail(key) {
    detailState = key;
    updateDetailModal(dashboardData());
  }

  function closeDetail() {
    detailState = null;
    el('dccDetailModal')?.classList.add('hidden');
  }

  function openView(viewId) {
    window.LSOApp?.setView?.(viewId);
    requestAnimationFrame(() => el(viewId)?.scrollIntoView({ block: 'start' }));
  }

  function openAttendanceEvent(eventId) {
    const event = getEvents().find((item) => item.id === eventId);
    if (!event) return;
    window.LSOOperations?.setAttendanceMonth?.(String(event.date).slice(0, 7));
    window.LSOOperations?.setAttendanceSemester?.(event.semester || 'First Semester');
    window.LSOOperations?.setSelectedEventId?.(event.id);
    openView('attendanceView');
    setTimeout(() => document.querySelector(`[data-event-id="${window.CSS?.escape ? CSS.escape(event.id) : event.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
  }

  function openMember(memberId) {
    if (!canView('membersView')) { window.LSOApp?.showToast?.(window.LSORoleAccess?.deniedMessage?.() || 'Member records are not assigned to this role.', true); return; }
    closeDetail();
    window.LSOApp?.openRecord?.(memberId);
  }

  function openDutyMember(memberId) {
    if (!canView('dutyHoursView')) { window.LSOApp?.showToast?.(window.LSORoleAccess?.deniedMessage?.() || 'Duty Hours are not assigned to this role.', true); return; }
    openView('dutyHoursView');
    setTimeout(() => {
      const selector = `[data-duty-member="${window.CSS?.escape ? CSS.escape(memberId) : memberId}"]`;
      document.querySelector(selector)?.click();
      document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 90);
  }

  function performAction(action) {
    closeDetail();
    const views = { attendance: 'attendanceView', 'duty-hours': 'dutyHoursView', accounts: 'accountsView', alerts: 'alertsView', data: 'dataView', members: 'membersView', 'monthly-report': 'monthlyReportView' };
    if (views[action]) {
      if (!canView(views[action])) { window.LSOApp?.showToast?.(window.LSORoleAccess?.deniedMessage?.() || 'This module is not assigned to your role.', true); return; }
      if (action === 'attendance') window.LSOOperations?.setAttendanceMonth?.(selectedMonth);
      openView(views[action]);
      if (action === 'monthly-report') setTimeout(() => { if (el('monthlyReportMonth')) { el('monthlyReportMonth').value = selectedMonth; el('monthlyReportMonth').dispatchEvent(new Event('change', { bubbles: true })); } }, 60);
      return;
    }
    if (action === 'add-member') {
      if (!canAction('manageMembers')) { window.LSOApp?.showToast?.(window.LSORoleAccess?.deniedMessage?.() || 'Member management is not assigned to this role.', true); return; }
      el('addMemberTop')?.click();
      return;
    }
    if (action === 'create-activity') {
      if (!canAction('manageEvents')) { window.LSOApp?.showToast?.(window.LSORoleAccess?.deniedMessage?.() || 'Activity creation is not assigned to this role.', true); return; }
      window.LSOOperations?.setAttendanceMonth?.(selectedMonth);
      openView('attendanceView');
      setTimeout(() => el('addEventButton')?.click(), 70);
      return;
    }
    if (action === 'backup') {
      openView('dataView');
      setTimeout(() => el('backupCompleteSystem')?.click(), 80);
    }
  }

  function performMemberStat(key) {
    if (!canView('membersView')) { window.LSOApp?.showToast?.(window.LSORoleAccess?.deniedMessage?.() || 'Member records are not assigned to this role.', true); return; }
    if (key === 'members') window.LSOApp?.setMembershipDirectory?.('Membership Period');
    if (key === 'trainees') window.LSOApp?.setMembershipDirectory?.('Trainee Period');
    if (key === 'probationary') window.LSOApp?.setMembershipDirectory?.('Probationary Period');
    if (['members', 'trainees', 'probationary'].includes(key)) { openView('membersView'); return; }
    if (key === 'loa') { openDetail('members-loa'); return; }
    if (key === 'inactive') { openDetail('members-inactive'); return; }
    if (key === 'incomplete') openDetail('incomplete-profiles');
  }

  function exportAttendance(data) {
    const rows = [['Member', 'Member ID', 'Stage', 'Working Rate', 'Verified Rate', 'Present', 'Late', 'Absent', 'Excused', 'Consecutive Absences', 'Risk']];
    data.analytics.forEach((item) => rows.push([item.member.fullName, memberIdLabel(item.member), memberStage(item.member), item.rate ?? '', item.verifiedRate ?? '', item.present, item.late, item.absent, item.excused, item.consecutiveAbsences, riskLabel(item, data.threshold)[0]]));
    download(`LSO_Attendance_Analytics_${localDate()}.csv`, `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}`);
  }

  function exportDuty(data) {
    const rows = [['Member', 'Member ID', 'Stage', 'Committed Minutes', 'Credited Minutes', 'Remaining Minutes', 'Progress', 'Pending Time In', 'Pending Time Out']];
    dutyRows(data).forEach((item) => rows.push([item.member.fullName, memberIdLabel(item.member), item.stage, item.committed, item.credited, Math.max(0, item.balance), `${item.progress}%`, item.pendingIn, item.pendingOut]));
    download(`LSO_Duty_Hours_Progress_${localDate()}.csv`, `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}`);
  }

  function handleClick(event) {
    const action = event.target.closest('[data-dcc-action]');
    if (action) { performAction(action.dataset.dccAction); return; }
    const detail = event.target.closest('[data-dcc-detail]');
    if (detail) { openDetail(detail.dataset.dccDetail); return; }
    const member = event.target.closest('[data-dcc-member]');
    if (member) { openMember(member.dataset.dccMember); return; }
    const dutyMember = event.target.closest('[data-dcc-duty-member]');
    if (dutyMember) { openDutyMember(dutyMember.dataset.dccDutyMember); return; }
    const eventButton = event.target.closest('[data-dcc-event]');
    if (eventButton) { openAttendanceEvent(eventButton.dataset.dccEvent); return; }
    const stat = event.target.closest('[data-dcc-member-stat]');
    if (stat) { performMemberStat(stat.dataset.dccMemberStat); return; }
    const monthButton = event.target.closest('[data-dcc-month]');
    if (monthButton) {
      selectedMonth = monthButton.dataset.dccMonth === 'today' ? localMonth() : addMonths(selectedMonth, Number(monthButton.dataset.dccMonth));
      render();
      return;
    }
    const close = event.target.closest('[data-dcc-close-modal]');
    if (close) { closeDetail(); return; }
    const item = event.target.closest('[data-dcc-detail-item]');
    if (item) {
      if (item.dataset.dccDetailItem === 'member') openMember(item.dataset.id);
      if (item.dataset.dccDetailItem === 'event') { closeDetail(); openAttendanceEvent(item.dataset.id); }
      if (item.dataset.dccDetailItem === 'accounts') performAction('accounts');
      if (item.dataset.dccDetailItem === 'duty') performAction('duty-hours');
      return;
    }
    if (event.target.closest('#dccOpenModuleButton')) performAction(el('dccOpenModuleButton').dataset.module);
    const exportButton = event.target.closest('[data-dcc-export]');
    if (exportButton) {
      const data = dashboardData();
      if (exportButton.dataset.dccExport === 'attendance') exportAttendance(data);
      if (exportButton.dataset.dccExport === 'duty') exportDuty(data);
    }
  }

  function handleChange(event) {
    if (event.target.id === 'dccMonthPicker' && /^\d{4}-\d{2}$/.test(event.target.value)) {
      selectedMonth = event.target.value;
      render();
    }
  }

  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleChange);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDetail(); });
    ['lso:members-changed', 'lso:operations-changed', 'lso:accounts-changed', 'lso:auth-changed', 'lso:cloud-state-changed', 'lso:duty-hours-changed', 'lso:attendance-governance-changed'].forEach((name) => window.addEventListener(name, () => setTimeout(render, 40)));
    qsa('[data-view="dashboardView"]').forEach((button) => button.addEventListener('click', () => setTimeout(render, 35)));
  }

  function initialize() {
    if (!el(hostId)) return;
    wire();
    render();
    window.setInterval(() => {
      if (!el('appShell')?.classList.contains('hidden') && el('dashboardView')?.classList.contains('active')) render();
    }, 60000);
    window.LSODashboardCommandCenter = { render, getData: dashboardData, setMonth(month) { if (/^\d{4}-\d{2}$/.test(month)) { selectedMonth = month; render(); } } };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
