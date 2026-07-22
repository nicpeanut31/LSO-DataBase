(() => {
  'use strict';

  const EVENTS_KEY = 'lso_events_v2';
  const ATTENDANCE_KEY = 'lso_attendance_v2';
  const SETTINGS_KEY = 'lso_system_settings_v2';
  const GROUPS = ['Official Members', 'Trainee Members', 'Probationary Members'];
  const MODES = ['Current', 'Archive'];
  const SEMESTERS = ['First Semester', 'Second Semester'];
  const el = (id) => document.getElementById(id);

  let beforeSaveSnapshot = null;
  let saveAuditTimer = null;

  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function uid(prefix = 'attendance-audit') {
    return window.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function localISO(date = new Date()) {
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function today() {
    return window.LSOApp?.getToday?.() || localISO();
  }

  function dateLabel(value, includeTime = false) {
    if (!value) return '—';
    const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-PH', includeTime
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function isAdmin() {
    return currentAccount()?.role === 'Administrator';
  }

  function can(action) {
    return window.LSORoleAccess?.can?.(action) ?? isAdmin();
  }

  function canSaveDraftAttendance() { return can('saveDraftAttendance'); }
  function canFinalizeAttendance() { return can('finalizeAttendance'); }
  function canUnlockAttendance() { return can('unlockAttendance'); }

  function activeGroup() {
    const value = window.LSOOperations?.getAttendanceGroup?.() || window.LSOAttendanceGroup;
    const fallback = window.LSORoleAccess?.defaultAttendanceGroup?.(currentAccount()) || 'Official Members';
    const candidate = GROUPS.includes(value) ? value : fallback;
    return window.LSORoleAccess?.canUseAttendanceGroup?.(candidate, currentAccount()) === false ? fallback : candidate;
  }

  function activeMode() {
    const value = window.LSOOperations?.getAttendanceRosterMode?.() || window.LSOAttendanceRosterMode;
    return MODES.includes(value) ? value : 'Current';
  }

  function activeSemester() {
    const value = window.LSOOperations?.getAttendanceSemester?.() || window.LSOAttendanceSemester;
    return SEMESTERS.includes(value) ? value : 'First Semester';
  }

  function workflowKey(group = activeGroup(), mode = activeMode()) {
    return `${group}::${mode}`;
  }

  function normalizeWorkflow(raw) {
    const history = Array.isArray(raw?.history) ? raw.history : [];
    return {
      state: raw?.state === 'Finalized' ? 'Finalized' : 'Draft',
      finalizedAt: raw?.finalizedAt || '',
      finalizedBy: raw?.finalizedBy || '',
      unlockedAt: raw?.unlockedAt || '',
      unlockedBy: raw?.unlockedBy || '',
      revision: Math.max(0, Number(raw?.revision) || 0),
      history
    };
  }

  function getWorkflow(event, group = activeGroup(), mode = activeMode()) {
    if (!event) return normalizeWorkflow(null);
    return normalizeWorkflow(event.attendanceWorkflows?.[workflowKey(group, mode)]);
  }

  function workflowState(event, group = activeGroup(), mode = activeMode()) {
    return getWorkflow(event, group, mode).state;
  }

  function getEvents() {
    return window.LSOOperations?.getEvents?.() || [];
  }

  function getAttendance() {
    return window.LSOOperations?.getAttendance?.() || [];
  }

  function getMembers() {
    return window.LSOApp?.getMembers?.() || [];
  }

  function selectedEventId() {
    return window.LSOOperations?.getSelectedEventId?.() || document.querySelector('.event-card.active')?.dataset.eventId || '';
  }

  function selectedEvent() {
    const id = selectedEventId();
    return getEvents().find((event) => event.id === id) || null;
  }

  function memberName(memberId) {
    return getMembers().find((member) => member.id === memberId)?.fullName || memberId || 'Unknown member';
  }

  function auditActor() {
    const account = currentAccount();
    return {
      account: account?.displayName || account?.username || 'Administrator',
      username: account?.username || ''
    };
  }

  function auditEntry(action, details = '', reason = '') {
    const actor = auditActor();
    return {
      id: uid(),
      timestamp: new Date().toISOString(),
      action,
      details,
      reason,
      account: actor.account,
      username: actor.username,
      attendanceGroup: activeGroup(),
      rosterMode: activeMode(),
      semester: activeSemester()
    };
  }

  function updateWorkflow(event, updater) {
    const next = clone(event);
    const key = workflowKey();
    const workflows = next.attendanceWorkflows && typeof next.attendanceWorkflows === 'object'
      ? clone(next.attendanceWorkflows)
      : {};
    const current = normalizeWorkflow(workflows[key]);
    const updated = normalizeWorkflow(updater(current));
    updated.history = Array.isArray(updater.__history)
      ? updater.__history
      : (Array.isArray(updated.history) ? updated.history.slice(0, 100) : []);
    workflows[key] = updated;
    next.attendanceWorkflows = workflows;
    return next;
  }

  function persistWorkflow(event, nextWorkflow) {
    const nextEvent = clone(event);
    const workflows = nextEvent.attendanceWorkflows && typeof nextEvent.attendanceWorkflows === 'object'
      ? clone(nextEvent.attendanceWorkflows)
      : {};
    workflows[workflowKey()] = normalizeWorkflow(nextWorkflow);
    nextEvent.attendanceWorkflows = workflows;
    return window.LSOOperations?.updateEventRecord?.(nextEvent) !== false;
  }

  function scopedAttendanceRecords(eventId = selectedEventId()) {
    return getAttendance().filter((entry) =>
      entry.eventId === eventId &&
      (entry.attendanceGroup || activeGroup()) === activeGroup() &&
      (entry.rosterModeAtEdit || 'Current') === activeMode()
    );
  }

  function rosterMembers() {
    return window.LSOOperations?.getAttendanceRosterMembers?.(selectedEventId()) || [];
  }

  function statusCounts(records) {
    const counts = { Present: 0, Late: 0, Absent: 0, Excused: 0, 'Not Required': 0 };
    records.forEach((record) => {
      if (Object.prototype.hasOwnProperty.call(counts, record.status)) counts[record.status] += 1;
    });
    return counts;
  }

  function rateFromCounts(counts) {
    const denominator = counts.Present + counts.Late + counts.Absent;
    return denominator ? Math.round(((counts.Present + counts.Late) / denominator) * 100) : null;
  }

  function attendanceRecordSignature(records) {
    return JSON.stringify(records
      .map((record) => ({ memberId: record.memberId, status: record.status || '', remarks: record.remarks || '' }))
      .sort((a, b) => String(a.memberId).localeCompare(String(b.memberId))));
  }

  function appendDraftSaveAudit(beforeRecords) {
    const event = selectedEvent();
    if (!event || workflowState(event) === 'Finalized') return;
    const afterRecords = scopedAttendanceRecords();
    if (attendanceRecordSignature(beforeRecords || []) === attendanceRecordSignature(afterRecords)) return;

    const beforeMap = new Map((beforeRecords || []).map((record) => [record.memberId, record]));
    const afterMap = new Map(afterRecords.map((record) => [record.memberId, record]));
    const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    let changed = 0;
    ids.forEach((id) => {
      const before = beforeMap.get(id) || {};
      const after = afterMap.get(id) || {};
      if ((before.status || '') !== (after.status || '') || (before.remarks || '') !== (after.remarks || '')) changed += 1;
    });

    const workflow = getWorkflow(event);
    workflow.state = 'Draft';
    workflow.history.unshift(auditEntry('Draft saved', `${changed} member attendance record${changed === 1 ? '' : 's'} changed.`));
    workflow.history = workflow.history.slice(0, 100);
    persistWorkflow(event, workflow);
  }

  function finalizeAttendance() {
    if (!canFinalizeAttendance()) {
      window.LSOApp?.showToast?.('Only the Administrator can finalize attendance.', true);
      return;
    }
    const event = selectedEvent();
    if (!event) return;
    if (event.date && event.date > today()) {
      window.LSOApp?.showToast?.('A future event cannot be finalized.', true);
      return;
    }
    if (workflowState(event) === 'Finalized') {
      window.LSOApp?.showToast?.('This attendance roster is already finalized.', true);
      return;
    }

    const members = rosterMembers();
    if (!members.length) {
      window.LSOApp?.showToast?.('There are no members in this roster to finalize.', true);
      return;
    }
    const currentRecords = getAttendance();
    const recordMap = new Map(scopedAttendanceRecords(event.id).map((record) => [record.memberId, record]));
    const missing = members.filter((member) => !recordMap.get(member.id)?.status);
    const message = missing.length
      ? `Finalize this attendance roster? ${missing.length} unmarked member${missing.length === 1 ? '' : 's'} will automatically be recorded as Absent. The roster will then be locked.`
      : 'Finalize and lock this attendance roster? The Administrator can unlock it later when a correction is required.';
    if (!window.confirm(message)) return;

    const now = new Date().toISOString();
    const actor = auditActor();
    const nextAttendance = currentRecords.map((record) => ({ ...record }));
    missing.forEach((member) => {
      const index = nextAttendance.findIndex((record) =>
        record.eventId === event.id &&
        record.memberId === member.id &&
        (record.attendanceGroup || activeGroup()) === activeGroup() &&
        (record.rosterModeAtEdit || 'Current') === activeMode()
      );
      const existing = index >= 0 ? nextAttendance[index] : {};
      const nextRecord = {
        ...existing,
        eventId: event.id,
        memberId: member.id,
        status: 'Absent',
        remarks: existing.remarks || 'Automatically marked Absent during attendance finalization.',
        attendanceGroup: activeGroup(),
        rosterModeAtEdit: activeMode(),
        createdAt: existing.createdAt || now,
        updatedAt: now,
        updatedBy: actor.account
      };
      if (index >= 0) nextAttendance[index] = nextRecord;
      else nextAttendance.push(nextRecord);
    });

    const finalRecords = nextAttendance.filter((record) =>
      record.eventId === event.id &&
      (record.attendanceGroup || activeGroup()) === activeGroup() &&
      (record.rosterModeAtEdit || 'Current') === activeMode()
    );
    const counts = statusCounts(finalRecords);
    const workflow = getWorkflow(event);
    workflow.state = 'Finalized';
    workflow.finalizedAt = now;
    workflow.finalizedBy = actor.account;
    workflow.revision += 1;
    workflow.history.unshift(auditEntry(
      'Attendance finalized',
      `${members.length} roster members • ${counts.Present} Present • ${counts.Late} Late • ${counts.Absent} Absent • ${counts.Excused} Excused.`,
      missing.length ? `${missing.length} unmarked member${missing.length === 1 ? '' : 's'} automatically marked Absent.` : ''
    ));
    workflow.history = workflow.history.slice(0, 100);

    window.LSOOperations?.replaceAttendance?.(nextAttendance);
    persistWorkflow(event, workflow);
    window.LSOOperations?.logActivity?.('Finalized attendance', 'Attendance Audit', `${event.title} • ${activeGroup()} • ${activeMode()} • revision ${workflow.revision}`);
    window.LSOApp?.showToast?.('Attendance finalized and locked.');
    setTimeout(render, 60);
  }

  function unlockAttendance() {
    if (!canUnlockAttendance()) {
      window.LSOApp?.showToast?.('Only the Administrator can unlock attendance.', true);
      return;
    }
    const event = selectedEvent();
    if (!event || workflowState(event) !== 'Finalized') return;
    const reason = window.prompt('Enter the reason for unlocking this finalized attendance roster:');
    if (reason === null) return;
    if (reason.trim().length < 3) {
      window.LSOApp?.showToast?.('Please enter a clear reason before unlocking attendance.', true);
      return;
    }
    const now = new Date().toISOString();
    const actor = auditActor();
    const workflow = getWorkflow(event);
    workflow.state = 'Draft';
    workflow.unlockedAt = now;
    workflow.unlockedBy = actor.account;
    workflow.history.unshift(auditEntry('Unlocked for editing', 'Finalized attendance was reopened for an administrator correction.', reason.trim()));
    workflow.history = workflow.history.slice(0, 100);
    persistWorkflow(event, workflow);
    window.LSOOperations?.logActivity?.('Unlocked finalized attendance', 'Attendance Audit', `${event.title} • ${activeGroup()} • ${activeMode()} • ${reason.trim()}`);
    window.LSOApp?.showToast?.('Attendance unlocked. Save corrections, then finalize it again.');
    setTimeout(render, 60);
  }

  function renderGovernance() {
    const event = selectedEvent();
    const container = el('attendanceGovernancePanel');
    if (!container) return;
    container.classList.toggle('hidden', !event);
    if (!event) return;

    const workflow = getWorkflow(event);
    const finalized = workflow.state === 'Finalized';
    const badge = el('attendanceWorkflowStatusBadge');
    if (badge) {
      badge.textContent = workflow.state;
      badge.className = `badge ${finalized ? 'badge-green' : 'badge-gold'}`;
    }
    if (el('attendanceWorkflowStatusTitle')) {
      el('attendanceWorkflowStatusTitle').textContent = finalized ? 'Attendance is finalized and locked' : 'Attendance is open as a draft';
    }
    if (el('attendanceWorkflowStatusMeta')) {
      el('attendanceWorkflowStatusMeta').textContent = finalized
        ? `Finalized by ${workflow.finalizedBy || 'Administrator'} on ${dateLabel(workflow.finalizedAt, true)} • Revision ${workflow.revision}`
        : workflow.unlockedAt
          ? `Unlocked by ${workflow.unlockedBy || 'Administrator'} on ${dateLabel(workflow.unlockedAt, true)} • Save corrections and finalize again.`
          : 'Changes remain editable until an Administrator finalizes this roster.';
    }

    const finalizeButton = el('finalizeAttendanceButton');
    const unlockButton = el('unlockAttendanceButton');
    if (finalizeButton) finalizeButton.classList.toggle('hidden', finalized || !canFinalizeAttendance());
    if (unlockButton) unlockButton.classList.toggle('hidden', !finalized || !canUnlockAttendance());

    ['markAllPresent', 'saveAttendanceButton'].forEach((id) => {
      const button = el(id);
      if (!button) return;
      button.disabled = finalized;
      button.setAttribute('aria-disabled', finalized ? 'true' : 'false');
      button.title = finalized ? 'Unlock this attendance roster before editing.' : '';
    });
    document.querySelectorAll('.attendance-status, .attendance-remarks').forEach((control) => {
      control.disabled = finalized || !canSaveDraftAttendance();
      control.classList.toggle('attendance-locked-control', finalized);
      control.title = finalized ? 'Finalized attendance is locked. An Administrator may unlock it for corrections.' : '';
    });

    const history = el('attendanceAuditHistory');
    const empty = el('attendanceAuditEmpty');
    if (history) {
      history.innerHTML = workflow.history.slice(0, 12).map((entry) => `
        <div class="attendance-audit-row">
          <span class="attendance-audit-dot" aria-hidden="true"></span>
          <div><strong>${safeText(entry.action || 'Attendance activity')}</strong><small>${safeText(entry.details || '')}</small>${entry.reason ? `<em>Reason: ${safeText(entry.reason)}</em>` : ''}</div>
          <div class="attendance-audit-meta"><span>${safeText(entry.account || 'Administrator')}</span><time>${safeText(dateLabel(entry.timestamp, true))}</time></div>
        </div>`).join('');
    }
    if (empty) empty.classList.toggle('hidden', Boolean(workflow.history.length));
  }

  function relevantEventsForMember(memberId) {
    const eventMap = new Map(getEvents().map((event) => [event.id, event]));
    const records = getAttendance()
      .filter((record) => record.memberId === memberId)
      .filter((record) => (record.attendanceGroup || activeGroup()) === activeGroup())
      .filter((record) => (record.rosterModeAtEdit || 'Current') === activeMode())
      .map((record) => ({ record, event: eventMap.get(record.eventId) }))
      .filter((item) => item.event && (item.event.semester || 'First Semester') === activeSemester())
      .sort((a, b) => String(a.event.date).localeCompare(String(b.event.date)));
    return records;
  }

  function memberSignals(memberId, threshold = 75) {
    const items = relevantEventsForMember(memberId);
    const counted = items.filter(({ record }) => ['Present', 'Late', 'Absent'].includes(record.status));
    const counts = statusCounts(items.map(({ record }) => record));
    const workingRate = rateFromCounts(counts);
    const finalizedItems = items.filter(({ record, event }) => workflowState(event, record.attendanceGroup || activeGroup(), record.rosterModeAtEdit || 'Current') === 'Finalized');
    const finalizedCounts = statusCounts(finalizedItems.map(({ record }) => record));
    const verifiedRate = rateFromCounts(finalizedCounts);
    let absenceStreak = 0;
    for (let index = counted.length - 1; index >= 0; index -= 1) {
      if (counted[index].record.status !== 'Absent') break;
      absenceStreak += 1;
    }
    const onTimeDenominator = counts.Present + counts.Late;
    const onTimeRate = onTimeDenominator ? Math.round((counts.Present / onTimeDenominator) * 100) : null;
    const risks = [];
    const rateForRisk = verifiedRate ?? workingRate;
    if (rateForRisk !== null && counted.length >= 3 && rateForRisk < Number(threshold || 75)) risks.push(`Attendance rate is below ${threshold}%`);
    if (absenceStreak >= 2) risks.push(`${absenceStreak} consecutive absences`);
    if (counts.Late >= 3) risks.push(`${counts.Late} Late records`);
    const draftCount = new Set(items
      .filter(({ record, event }) => workflowState(event, record.attendanceGroup || activeGroup(), record.rosterModeAtEdit || 'Current') !== 'Finalized')
      .map(({ event }) => event.id)).size;
    return {
      totalRecords: items.length,
      counted: counted.length,
      counts,
      workingRate,
      verifiedRate,
      finalizedRecordCount: finalizedItems.length,
      draftEventCount: draftCount,
      absenceStreak,
      lateCount: counts.Late,
      onTimeRate,
      risks,
      items
    };
  }

  function renderVerificationMetrics() {
    const container = el('attendanceVerificationMetrics');
    if (!container) return;
    const events = getEvents().filter((event) => (event.semester || 'First Semester') === activeSemester() && event.date <= today());
    const relevant = events.filter((event) => {
      const records = getAttendance().filter((record) => record.eventId === event.id);
      return records.some((record) => (record.attendanceGroup || activeGroup()) === activeGroup() && (record.rosterModeAtEdit || 'Current') === activeMode());
    });
    const finalized = relevant.filter((event) => workflowState(event) === 'Finalized').length;
    const drafts = relevant.length - finalized;
    const records = relevant.flatMap((event) => getAttendance().filter((record) =>
      record.eventId === event.id &&
      (record.attendanceGroup || activeGroup()) === activeGroup() &&
      (record.rosterModeAtEdit || 'Current') === activeMode()
    ));
    const unresolved = records.filter((record) => !record.status).length;
    const coverage = relevant.length ? Math.round((finalized / relevant.length) * 100) : null;
    container.innerHTML = [
      ['Finalized Events', finalized, `${relevant.length} recorded events`],
      ['Draft Events', drafts, drafts ? 'Requires administrator review' : 'No pending finalization'],
      ['Verification Coverage', coverage === null ? '—' : `${coverage}%`, 'Finalized ÷ recorded events'],
      ['Unmarked Records', unresolved, unresolved ? 'Resolve before finalization' : 'All saved records have status']
    ].map(([label, value, helper]) => `<div class="attendance-kpi"><span>${safeText(label)}</span><strong>${safeText(value)}</strong><small>${safeText(helper)}</small></div>`).join('');
  }

  function renderIndividualRiskSignals() {
    const container = el('individualAttendanceRiskSignals');
    if (!container) return;
    const memberId = el('attendanceIndividualSelect')?.value || '';
    if (!memberId) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }
    const settings = (() => {
      try { return JSON.parse(window.LSOStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
    })();
    const signals = memberSignals(memberId, Number(settings.attendanceThreshold) || 75);
    const member = getMembers().find((item) => item.id === memberId);
    container.classList.remove('hidden');
    const riskMarkup = signals.risks.length
      ? signals.risks.map((risk) => `<span class="attendance-risk-chip risk-active">${safeText(risk)}</span>`).join('')
      : '<span class="attendance-risk-chip risk-clear">No current attendance risk signal</span>';
    container.innerHTML = `
      <div class="individual-analytics-heading"><div><span>Advanced Analytics</span><strong>${safeText(member?.fullName || 'Selected member')}</strong></div><div class="attendance-risk-list">${riskMarkup}</div></div>
      <div class="individual-stat-grid advanced-attendance-grid">
        <div class="attendance-kpi"><span>Working Rate</span><strong>${signals.workingRate === null ? '—' : `${signals.workingRate}%`}</strong><small>Draft + finalized records</small></div>
        <div class="attendance-kpi"><span>Verified Rate</span><strong>${signals.verifiedRate === null ? '—' : `${signals.verifiedRate}%`}</strong><small>Finalized records only</small></div>
        <div class="attendance-kpi"><span>On-Time Rate</span><strong>${signals.onTimeRate === null ? '—' : `${signals.onTimeRate}%`}</strong><small>Present ÷ Present + Late</small></div>
        <div class="attendance-kpi"><span>Consecutive Absences</span><strong>${signals.absenceStreak}</strong><small>Latest counted sequence</small></div>
        <div class="attendance-kpi"><span>Late Records</span><strong>${signals.lateCount}</strong><small>${activeSemester()}</small></div>
        <div class="attendance-kpi"><span>Draft Events</span><strong>${signals.draftEventCount}</strong><small>Not yet verified</small></div>
      </div>`;
  }

  function buildAlerts() {
    const settings = (() => {
      try { return JSON.parse(window.LSOStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
    })();
    const alertDays = Math.max(1, Number(settings.alertDays) || 30);
    const now = new Date(`${today()}T00:00:00`).getTime();
    const alerts = [];
    getEvents().forEach((event) => {
      if (!event.date || event.date > today()) return;
      const eventTime = new Date(`${event.date}T00:00:00`).getTime();
      const ageDays = Math.floor((now - eventTime) / 86_400_000);
      if (ageDays > alertDays) return;
      const records = getAttendance().filter((record) => record.eventId === event.id && record.status);
      if (!records.length) {
        alerts.push({
          type: 'attendance', severity: ageDays >= 1 ? 'high' : 'medium',
          title: `${event.title} has no recorded attendance`,
          detail: `${dateLabel(event.date)} • Attendance has not been entered or finalized.`,
          eventId: event.id
        });
        return;
      }
      const pairs = [...new Map(records.map((record) => {
        const group = record.attendanceGroup || 'Official Members';
        const mode = record.rosterModeAtEdit || 'Current';
        return [`${group}::${mode}`, { group, mode }];
      })).values()];
      const drafts = pairs.filter(({ group, mode }) => workflowState(event, group, mode) !== 'Finalized');
      if (drafts.length) {
        const workflows = drafts.map(({ group, mode }) => getWorkflow(event, group, mode));
        const reopened = workflows.some((workflow) => workflow.unlockedAt && workflow.history[0]?.action === 'Unlocked for editing');
        const draftLabels = drafts.map(({ group, mode }) => `${group}${mode === 'Archive' ? ' Archive' : ''}`);
        alerts.push({
          type: 'attendance', severity: reopened || ageDays >= 7 ? 'high' : 'medium',
          title: reopened ? `${event.title} was unlocked and needs re-finalization` : `${event.title} attendance remains Draft`,
          detail: `${dateLabel(event.date)} • ${draftLabels.join(', ')}${reopened ? ' • Corrections are still open.' : ' • Finalize to verify and lock the records.'}`,
          eventId: event.id
        });
      }
    });
    return alerts;
  }

  function downloadCsv(filename, rows) {
    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function exportOverallAnalytics() {
    const settings = (() => {
      try { return JSON.parse(window.LSOStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
    })();
    const threshold = Number(settings.attendanceThreshold) || 75;
    const members = getMembers().filter((member) => {
      const group = String(member.periodGroup || '').toLowerCase();
      if (activeGroup() === 'Official Members') return group === 'membership period' || String(member.membershipStage || '').toLowerCase() === 'regular member';
      if (activeGroup() === 'Probationary Members') return group === 'probationary period';
      return group === 'trainee period';
    }).sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
    const rows = [[
      'Member', 'Membership ID', 'Attendance Group', 'Semester', 'Present', 'Late', 'Absent', 'Excused',
      'Working Rate', 'Verified Rate', 'On-Time Rate', 'Consecutive Absences', 'Draft Events', 'Risk Signals'
    ]];
    members.forEach((member) => {
      const signals = memberSignals(member.id, threshold);
      rows.push([
        member.fullName, member.membershipId, activeGroup(), activeSemester(), signals.counts.Present, signals.counts.Late,
        signals.counts.Absent, signals.counts.Excused, signals.workingRate ?? '', signals.verifiedRate ?? '', signals.onTimeRate ?? '',
        signals.absenceStreak, signals.draftEventCount, signals.risks.join('; ')
      ]);
    });
    downloadCsv(`LSO_Attendance_Analytics_${activeSemester().replace(/\s+/g, '_')}_${activeGroup().replace(/\s+/g, '_')}_${today()}.csv`, rows);
    window.LSOOperations?.logActivity?.('Exported attendance analytics', 'Attendance Reports', `${activeSemester()} • ${activeGroup()} • ${members.length} members`);
  }

  function exportIndividualAnalytics() {
    const memberId = el('attendanceIndividualSelect')?.value || '';
    const member = getMembers().find((item) => item.id === memberId);
    if (!member) {
      window.LSOApp?.showToast?.('Select a member before exporting the individual report.', true);
      return;
    }
    const signals = memberSignals(memberId);
    const rows = [[
      'Date', 'Event', 'Venue', 'Attendance Group', 'Roster Mode', 'Attendance State', 'Status', 'Remarks'
    ]];
    signals.items.forEach(({ event, record }) => rows.push([
      event.date, event.title, event.venue || '', record.attendanceGroup || activeGroup(), record.rosterModeAtEdit || 'Current',
      workflowState(event, record.attendanceGroup || activeGroup(), record.rosterModeAtEdit || 'Current'), record.status || 'Not marked', record.remarks || ''
    ]));
    downloadCsv(`LSO_${String(member.fullName).replace(/[^a-z0-9]+/gi, '_')}_Attendance_${activeSemester().replace(/\s+/g, '_')}_${today()}.csv`, rows);
    window.LSOOperations?.logActivity?.('Exported individual attendance report', 'Attendance Reports', `${member.fullName} • ${activeSemester()}`);
  }

  function exportAuditHistory() {
    const event = selectedEvent();
    if (!event) return;
    const workflow = getWorkflow(event);
    const rows = [['Timestamp', 'Action', 'Administrator', 'Attendance Group', 'Roster Mode', 'Semester', 'Details', 'Reason']];
    workflow.history.forEach((entry) => rows.push([
      entry.timestamp, entry.action, entry.account, entry.attendanceGroup, entry.rosterMode, entry.semester, entry.details, entry.reason
    ]));
    downloadCsv(`LSO_Attendance_Audit_${String(event.title).replace(/[^a-z0-9]+/gi, '_')}_${today()}.csv`, rows);
  }

  function render() {
    renderGovernance();
    renderVerificationMetrics();
    renderIndividualRiskSignals();
  }

  function interceptLockedEdits(event) {
    const target = event.target;
    const eventRecord = selectedEvent();
    if (!eventRecord || workflowState(eventRecord) !== 'Finalized') return;
    const blocked = target.closest?.('#saveAttendanceButton, #markAllPresent, .attendance-status, .attendance-remarks');
    if (!blocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.LSOApp?.showToast?.('This attendance roster is finalized. Use “Unlock for Editing” before making corrections.', true);
  }

  function wireEvents() {
    el('finalizeAttendanceButton')?.addEventListener('click', finalizeAttendance);
    el('unlockAttendanceButton')?.addEventListener('click', unlockAttendance);
    el('exportAttendanceAuditCsv')?.addEventListener('click', exportAuditHistory);
    el('exportAttendanceAnalyticsCsv')?.addEventListener('click', exportOverallAnalytics);
    el('exportIndividualAttendanceCsv')?.addEventListener('click', exportIndividualAnalytics);

    document.addEventListener('click', interceptLockedEdits, true);
    document.addEventListener('change', interceptLockedEdits, true);

    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('#saveAttendanceButton');
      if (!button) return;
      const eventRecord = selectedEvent();
      if (!eventRecord || workflowState(eventRecord) === 'Finalized') return;
      beforeSaveSnapshot = clone(scopedAttendanceRecords());
      clearTimeout(saveAuditTimer);
      saveAuditTimer = setTimeout(() => {
        appendDraftSaveAudit(beforeSaveSnapshot);
        beforeSaveSnapshot = null;
        render();
      }, 140);
    }, true);

    el('attendanceIndividualSelect')?.addEventListener('change', () => setTimeout(renderIndividualRiskSignals, 20));
    el('eventList')?.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-event-id]')) setTimeout(render, 25);
    });
    el('attendanceMemberSearch')?.addEventListener('input', () => setTimeout(renderGovernance, 20));

    ['lso:operations-changed', 'lso:members-changed', 'lso:attendance-semester-changed', 'lso:attendance-group-changed',
      'lso:attendance-roster-mode-changed', 'lso:cloud-state-changed', 'lso:auth-changed']
      .forEach((name) => window.addEventListener(name, () => setTimeout(render, 40)));
  }

  function initialize() {
    wireEvents();
    render();
    window.LSOOperations?.refreshAll?.();
  }

  window.LSOAttendanceGovernance = {
    getWorkflow,
    workflowState,
    isFinalized: (event, group, mode) => workflowState(event, group, mode) === 'Finalized',
    memberSignals,
    buildAlerts,
    render,
    finalizeAttendance,
    unlockAttendance
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
