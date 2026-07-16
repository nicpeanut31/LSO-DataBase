(() => {
  'use strict';

  const EVENTS_KEY = 'lso_events_v2';
  const ATTENDANCE_KEY = 'lso_attendance_v2';
  const INSTRUMENTS_KEY = 'lso_instruments_v2';
  const ACTIVITY_KEY = 'lso_activity_log_v2';
  const SETTINGS_KEY = 'lso_system_settings_v2';
  const MEMBERS_KEY = 'lso_member_database_v1';
  const DUTY_HOURS_KEY = 'lso_duty_hours_v1';
  const ATTENDANCE_SEMESTERS = ['First Semester', 'Second Semester'];

  const DEFAULT_SETTINGS = {
    traineeDays: '',
    probationaryDays: '',
    regular1Days: '',
    alertDays: 30,
    attendanceThreshold: 75
  };

  let events = loadArray(EVENTS_KEY);
  let attendance = loadArray(ATTENDANCE_KEY);
  let instruments = loadArray(INSTRUMENTS_KEY);
  let selectedEventId = events[0]?.id || null;

  const el = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function loadArray(key) {
    try {
      const parsed = JSON.parse(window.LSOStorage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveArray(key, value) {
    window.LSOStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent('lso:operations-changed', { detail: { key } }));
  }

  function loadSettings() {
    try {
      const parsed = JSON.parse(window.LSOStorage.getItem(SETTINGS_KEY) || '{}');
      return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    window.LSOStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }));
  }


  function loadDutyHours() {
    try {
      const parsed = JSON.parse(window.LSOStorage.getItem(DUTY_HOURS_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { version: 1, commitments: {}, entries: [] };
    } catch {
      return { version: 1, commitments: {}, entries: [] };
    }
  }

  function getMembers() {
    if (window.LSOApp?.getMembers) return window.LSOApp.getMembers();
    try {
      const parsed = JSON.parse(window.LSOStorage.getItem(MEMBERS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function uid(prefix) {
    return window.crypto?.randomUUID ? window.crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function today() {
    if (window.LSOApp?.getToday) return window.LSOApp.getToday();
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function dateLabel(value, short = false) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-PH', short
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  }

  function timeLabel(value) {
    if (!value) return '';
    const [hour, minute] = String(value).split(':').map(Number);
    if (!Number.isFinite(hour)) return value;
    const date = new Date();
    date.setHours(hour, Number.isFinite(minute) ? minute : 0, 0, 0);
    return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function daysBetween(from, to) {
    const a = new Date(`${from}T00:00:00`);
    const b = new Date(`${to}T00:00:00`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    return Math.ceil((b.getTime() - a.getTime()) / 86_400_000);
  }

  function addDays(value, days) {
    if (!value || !Number.isFinite(Number(days))) return '';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '';
    date.setDate(date.getDate() + Number(days));
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function isAdmin() {
    return currentAccount()?.role === 'Administrator';
  }

  function toast(message, error = false) {
    if (window.LSOApp?.showToast) {
      window.LSOApp.showToast(message, error);
      return;
    }
    window.alert(message);
  }

  function logActivity(action, category = 'System', details = '') {
    const account = currentAccount();
    const log = loadArray(ACTIVITY_KEY);
    log.unshift({
      id: uid('activity'),
      timestamp: new Date().toISOString(),
      action: String(action || 'Activity'),
      category: String(category || 'System'),
      details: String(details || ''),
      account: account?.displayName || account?.username || 'Local user',
      username: account?.username || ''
    });
    saveArray(ACTIVITY_KEY, log.slice(0, 500));
    renderActivityLog();
  }

  function showModal(id) {
    el(id)?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function hideModal(id) {
    el(id)?.classList.add('hidden');
    if (!document.querySelector('.modal-backdrop:not(.hidden)')) document.body.style.overflow = '';
  }

  function formMessage(id, message = '') {
    const node = el(id);
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('hidden', !message);
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function setView(viewId) {
    if (window.LSOApp?.setView) window.LSOApp.setView(viewId);
    refreshView(viewId);
  }

  // Attendance and events
  function normalizeSemester(value) {
    return ATTENDANCE_SEMESTERS.includes(value) ? value : 'First Semester';
  }

  function activeAttendanceSemester() {
    return normalizeSemester(window.LSOAttendanceSemester);
  }

  function eventsForActiveSemester() {
    const semester = activeAttendanceSemester();
    return events.filter((event) => normalizeSemester(event.semester) === semester);
  }

  function sortedEvents() {
    const now = today();
    return [...eventsForActiveSemester()].sort((a, b) => {
      const aUpcoming = a.date >= now ? 0 : 1;
      const bUpcoming = b.date >= now ? 0 : 1;
      if (aUpcoming !== bUpcoming) return aUpcoming - bUpcoming;
      return aUpcoming === 0 ? String(a.date).localeCompare(String(b.date)) : String(b.date).localeCompare(String(a.date));
    });
  }

  function eventMeta(event) {
    const times = [timeLabel(event.startTime), timeLabel(event.endTime)].filter(Boolean).join('–');
    return [normalizeSemester(event.semester), dateLabel(event.date, true), times, event.venue].filter(Boolean).join(' • ');
  }

  function renderEventList() {
    const list = el('eventList');
    if (!list) return;
    const search = normalize(el('eventSearch')?.value);
    const semesterEvents = sortedEvents();
    const filtered = semesterEvents.filter((event) => !search || normalize([event.title, event.type, event.date, event.venue, event.semester].join(' ')).includes(search));
    el('eventCountLabel').textContent = `${semesterEvents.length} ${activeAttendanceSemester().toLowerCase()} event${semesterEvents.length === 1 ? '' : 's'}`;
    list.innerHTML = filtered.length ? filtered.map((event) => {
      const records = attendance.filter((item) => item.eventId === event.id && item.status);
      const present = records.filter((item) => item.status === 'Present' || item.status === 'Late').length;
      return `<button class="event-card ${selectedEventId === event.id ? 'active' : ''}" data-event-id="${safeText(event.id)}">
        <span class="event-date-box"><strong>${safeText(String(event.date || '').slice(8, 10) || '—')}</strong><small>${safeText(new Date(`${event.date}T00:00:00`).toLocaleDateString('en-PH', { month: 'short' }))}</small></span>
        <span class="event-copy"><strong>${safeText(event.title)}</strong><small>${safeText(eventMeta(event))}</small><em>${records.length ? `${present}/${records.length} attended` : 'Attendance not recorded'}</em></span>
      </button>`;
    }).join('') : '<div class="empty-state compact-empty"><div class="empty-icon">♫</div><h4>No semester events found</h4><p>Create a rehearsal, performance, or meeting for the selected semester.</p></div>';
  }

  function openEventModal(event = null) {
    el('eventForm').reset();
    formMessage('eventFormMessage');
    el('editingEventId').value = event?.id || '';
    el('eventModalTitle').textContent = event ? 'Edit Event' : 'Create Event';
    el('eventTitle').value = event?.title || '';
    el('eventType').value = event?.type || 'Rehearsal';
    if (el('eventSemester')) el('eventSemester').value = normalizeSemester(event?.semester || activeAttendanceSemester());
    el('eventDate').value = event?.date || today();
    el('eventStartTime').value = event?.startTime || '';
    el('eventEndTime').value = event?.endTime || '';
    el('eventVenue').value = event?.venue || '';
    el('eventNotes').value = event?.notes || '';
    showModal('eventModal');
    setTimeout(() => el('eventTitle').focus(), 30);
  }

  function saveEvent(eventObject) {
    const index = events.findIndex((item) => item.id === eventObject.id);
    if (index >= 0) events[index] = eventObject;
    else events.push(eventObject);
    saveArray(EVENTS_KEY, events);
    selectedEventId = eventObject.id;
    renderAttendance();
  }

  function handleEventSubmit(event) {
    event.preventDefault();
    const id = el('editingEventId').value || uid('event');
    const existing = events.find((item) => item.id === id);
    const record = {
      id,
      title: el('eventTitle').value.trim(),
      type: el('eventType').value,
      semester: normalizeSemester(el('eventSemester')?.value || activeAttendanceSemester()),
      date: el('eventDate').value,
      startTime: el('eventStartTime').value,
      endTime: el('eventEndTime').value,
      venue: el('eventVenue').value.trim(),
      notes: el('eventNotes').value.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!record.title || !record.date || !ATTENDANCE_SEMESTERS.includes(record.semester)) {
      formMessage('eventFormMessage', 'Event Title, Semester, and Date are required.');
      return;
    }
    if (record.startTime && record.endTime && record.endTime <= record.startTime) {
      formMessage('eventFormMessage', 'End Time must be later than Start Time.');
      return;
    }
    saveEvent(record);
    hideModal('eventModal');
    logActivity(existing ? 'Updated event' : 'Created event', 'Attendance', `${record.title} • ${record.date}`);
    toast(existing ? 'Event updated.' : 'Event created.');
  }

  function getAttendanceEntry(eventId, memberId) {
    return attendance.find((entry) => entry.eventId === eventId && entry.memberId === memberId) || null;
  }

  function attendanceStats(eventId) {
    const records = attendance.filter((entry) => entry.eventId === eventId && entry.status);
    const count = (status) => records.filter((entry) => entry.status === status).length;
    return {
      total: records.length,
      present: count('Present'),
      late: count('Late'),
      excused: count('Excused'),
      absent: count('Absent'),
      notRequired: count('Not Required')
    };
  }

  function renderAttendanceRoster() {
    const body = el('attendanceRosterBody');
    if (!body || !selectedEventId) return;
    const search = normalize(el('attendanceMemberSearch')?.value);
    const members = getMembers()
      .filter((member) => member.memberStatus === 'Active')
      .filter((member) => !search || normalize([member.fullName, member.membershipId, member.orchestraSection, member.primaryInstrument, member.periodGroup].join(' ')).includes(search))
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));

    body.innerHTML = members.length ? members.map((member) => {
      const entry = getAttendanceEntry(selectedEventId, member.id) || {};
      return `<tr data-attendance-member="${safeText(member.id)}">
        <td><div class="member-cell"><div class="member-avatar">${safeText(String(member.fullName || 'M').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase())}</div><div><strong>${safeText(member.fullName)}</strong><small>${safeText(member.membershipId)} • ${safeText(member.primaryInstrument || 'No instrument')}</small></div></div></td>
        <td><span class="badge badge-blue">${safeText(member.periodGroup || member.membershipStage || '—')}</span></td>
        <td>${safeText(member.orchestraSection || '—')}</td>
        <td><select class="attendance-status" aria-label="Attendance status for ${safeText(member.fullName)}">
          <option value="" ${!entry.status ? 'selected' : ''}>Not marked</option>
          ${['Present', 'Late', 'Excused', 'Absent', 'Not Required'].map((status) => `<option ${entry.status === status ? 'selected' : ''}>${status}</option>`).join('')}
        </select></td>
        <td><input class="attendance-remarks" value="${safeText(entry.remarks || '')}" placeholder="Optional note"/></td>
      </tr>`;
    }).join('') : '<tr><td colspan="5"><div class="empty-state compact-empty"><h4>No active members found</h4><p>Add or activate member records first.</p></div></td></tr>';
  }

  function renderAttendanceSummary() {
    const container = el('attendanceSummary');
    if (!container || !selectedEventId) return;
    const stats = attendanceStats(selectedEventId);
    const items = [
      ['Present', stats.present], ['Late', stats.late], ['Excused', stats.excused], ['Absent', stats.absent], ['Recorded', stats.total]
    ];
    container.innerHTML = items.map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('');
  }

  function renderAttendanceWorkspace() {
    const event = events.find((item) => item.id === selectedEventId);
    el('attendancePlaceholder').classList.toggle('hidden', Boolean(event));
    el('attendanceWorkspace').classList.toggle('hidden', !event);
    if (!event) return;
    el('attendanceEventType').textContent = event.type || 'Activity';
    el('attendanceEventTitle').textContent = event.title;
    el('attendanceEventMeta').textContent = `${eventMeta(event)}${event.notes ? ` • ${event.notes}` : ''}`;
    renderAttendanceSummary();
    renderAttendanceRoster();
  }

  function renderAttendance() {
    const semesterEvents = sortedEvents();
    if (selectedEventId && !semesterEvents.some((event) => event.id === selectedEventId)) selectedEventId = semesterEvents[0]?.id || null;
    if (!selectedEventId && semesterEvents.length) selectedEventId = semesterEvents[0]?.id || null;
    renderEventList();
    renderAttendanceWorkspace();
  }

  function saveAttendanceRoster() {
    if (!selectedEventId) return;
    const rows = qsa('[data-attendance-member]', el('attendanceRosterBody'));
    const now = new Date().toISOString();
    rows.forEach((row) => {
      const memberId = row.dataset.attendanceMember;
      const status = row.querySelector('.attendance-status').value;
      const remarks = row.querySelector('.attendance-remarks').value.trim();
      const index = attendance.findIndex((entry) => entry.eventId === selectedEventId && entry.memberId === memberId);
      if (!status && !remarks) {
        if (index >= 0) attendance.splice(index, 1);
        return;
      }
      const record = { eventId: selectedEventId, memberId, status, remarks, updatedAt: now };
      if (index >= 0) attendance[index] = record;
      else attendance.push(record);
    });
    saveArray(ATTENDANCE_KEY, attendance);
    const event = events.find((item) => item.id === selectedEventId);
    logActivity('Saved attendance', 'Attendance', `${event?.title || 'Event'} • ${rows.length} roster rows`);
    renderAttendance();
    renderAlerts();
    toast('Attendance saved.');
  }

  function deleteSelectedEvent() {
    const event = events.find((item) => item.id === selectedEventId);
    if (!event) return;
    if (!window.confirm(`Delete “${event.title}” and all of its attendance records?`)) return;
    events = events.filter((item) => item.id !== event.id);
    attendance = attendance.filter((entry) => entry.eventId !== event.id);
    saveArray(EVENTS_KEY, events);
    saveArray(ATTENDANCE_KEY, attendance);
    logActivity('Deleted event', 'Attendance', `${event.title} • ${event.date}`);
    selectedEventId = sortedEvents()[0]?.id || null;
    renderAttendance();
    renderAlerts();
    toast('Event and attendance records deleted.');
  }

  function getMemberAttendance(memberId) {
    const validEventIds = new Set(events.map((event) => event.id));
    const records = attendance.filter((entry) => entry.memberId === memberId && validEventIds.has(entry.eventId));
    const counted = records.filter((entry) => ['Present', 'Late', 'Absent'].includes(entry.status));
    const attended = counted.filter((entry) => ['Present', 'Late'].includes(entry.status)).length;
    return {
      sessions: counted.length,
      attended,
      rate: counted.length ? Math.round((attended / counted.length) * 100) : null
    };
  }

  // Instrument inventory
  function instrumentStatus(item) {
    if (item.manualStatus) return item.manualStatus;
    if (['Needs Repair', 'Unserviceable'].includes(item.condition)) return 'Maintenance';
    return item.assignedMemberId ? 'Issued' : 'Available';
  }

  function instrumentIsOverdue(item) {
    return instrumentStatus(item) === 'Issued' && item.expectedReturn && item.expectedReturn < today();
  }

  function memberName(memberId) {
    return getMembers().find((member) => member.id === memberId)?.fullName || '';
  }

  function renderInstrumentMemberOptions(selected = '') {
    const select = el('instrumentAssignedMember');
    if (!select) return;
    const members = getMembers().sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
    select.innerHTML = '<option value="">Unassigned / Available</option>' + members.map((member) => `<option value="${safeText(member.id)}" ${member.id === selected ? 'selected' : ''}>${safeText(member.fullName)} — ${safeText(member.membershipId)}</option>`).join('');
  }

  function renderInventoryMetrics() {
    const container = el('inventoryMetrics');
    if (!container) return;
    const count = (status) => instruments.filter((item) => instrumentStatus(item) === status).length;
    const overdue = instruments.filter(instrumentIsOverdue).length;
    const data = [
      ['Total Assets', instruments.length], ['Available', count('Available')], ['Issued', count('Issued')], ['Maintenance', count('Maintenance')], ['Overdue Returns', overdue]
    ];
    container.innerHTML = data.map(([label, value]) => `<div class="inventory-metric"><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('');
  }

  function renderInstruments() {
    renderInventoryMetrics();
    const body = el('instrumentTableBody');
    if (!body) return;
    const search = normalize(el('instrumentSearch')?.value);
    const status = el('instrumentStatusFilter')?.value || '';
    const condition = el('instrumentConditionFilter')?.value || '';
    const category = el('instrumentCategoryFilter')?.value || '';
    const filtered = [...instruments].filter((item) => {
      const itemStatus = instrumentStatus(item);
      const haystack = normalize([item.assetCode, item.name, item.brand, item.model, item.serialNumber, memberName(item.assignedMemberId)].join(' '));
      return (!search || haystack.includes(search)) && (!status || itemStatus === status) && (!condition || item.condition === condition) && (!category || item.category === category);
    }).sort((a, b) => String(a.assetCode).localeCompare(String(b.assetCode)));

    el('instrumentCountLabel').textContent = `${instruments.length} instrument${instruments.length === 1 ? '' : 's'} • ${filtered.length} shown`;
    el('instrumentEmpty').classList.toggle('hidden', Boolean(filtered.length));
    body.innerHTML = filtered.map((item) => {
      const statusValue = instrumentStatus(item);
      const overdue = instrumentIsOverdue(item);
      const statusClass = statusValue === 'Available' ? 'badge-green' : statusValue === 'Issued' ? 'badge-blue' : statusValue === 'Maintenance' ? 'badge-red' : 'badge-gray';
      return `<tr>
        <td><strong>${safeText(item.assetCode)}</strong><small class="table-subtext">${safeText(item.serialNumber || 'No serial number')}</small></td>
        <td><strong>${safeText(item.name)}</strong><small class="table-subtext">${safeText([item.brand, item.model].filter(Boolean).join(' ') || 'No brand/model')}</small></td>
        <td>${safeText(item.category || '—')}</td>
        <td><span class="badge ${['Needs Repair', 'Unserviceable'].includes(item.condition) ? 'badge-red' : item.condition === 'Fair' ? 'badge-gold' : 'badge-green'}">${safeText(item.condition || '—')}</span></td>
        <td>${safeText(memberName(item.assignedMemberId) || 'Unassigned')}</td>
        <td class="${overdue ? 'overdue-text' : ''}">${safeText(item.expectedReturn ? dateLabel(item.expectedReturn, true) : '—')}${overdue ? '<small class="table-subtext">Overdue</small>' : ''}</td>
        <td><span class="badge ${statusClass}">${safeText(statusValue)}</span></td>
        <td><div class="table-actions"><button class="small-button" data-instrument-action="edit" data-id="${safeText(item.id)}">Edit</button><button class="small-button danger" data-instrument-action="delete" data-id="${safeText(item.id)}">Delete</button></div></td>
      </tr>`;
    }).join('');
  }

  function openInstrumentModal(item = null) {
    el('instrumentForm').reset();
    formMessage('instrumentFormMessage');
    el('editingInstrumentId').value = item?.id || '';
    el('instrumentModalTitle').textContent = item ? 'Edit Instrument' : 'Add Instrument';
    el('instrumentAssetCode').value = item?.assetCode || '';
    el('instrumentName').value = item?.name || '';
    el('instrumentCategory').value = item?.category || '';
    el('instrumentCondition').value = item?.condition || 'Excellent';
    el('instrumentBrand').value = item?.brand || '';
    el('instrumentModel').value = item?.model || '';
    el('instrumentSerialNumber').value = item?.serialNumber || '';
    renderInstrumentMemberOptions(item?.assignedMemberId || '');
    el('instrumentDateIssued').value = item?.dateIssued || '';
    el('instrumentExpectedReturn').value = item?.expectedReturn || '';
    el('instrumentManualStatus').value = item?.manualStatus || '';
    el('instrumentLocation').value = item?.location || '';
    el('instrumentNotes').value = item?.notes || '';
    showModal('instrumentModal');
    setTimeout(() => el('instrumentAssetCode').focus(), 30);
  }

  function handleInstrumentSubmit(event) {
    event.preventDefault();
    const id = el('editingInstrumentId').value || uid('instrument');
    const existing = instruments.find((item) => item.id === id);
    const record = {
      id,
      assetCode: el('instrumentAssetCode').value.trim(),
      name: el('instrumentName').value.trim(),
      category: el('instrumentCategory').value,
      condition: el('instrumentCondition').value,
      brand: el('instrumentBrand').value.trim(),
      model: el('instrumentModel').value.trim(),
      serialNumber: el('instrumentSerialNumber').value.trim(),
      assignedMemberId: el('instrumentAssignedMember').value,
      dateIssued: el('instrumentDateIssued').value,
      expectedReturn: el('instrumentExpectedReturn').value,
      manualStatus: el('instrumentManualStatus').value,
      location: el('instrumentLocation').value.trim(),
      notes: el('instrumentNotes').value.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!record.assetCode || !record.name || !record.category || !record.condition) {
      formMessage('instrumentFormMessage', 'Asset Code, Instrument Name, Category, and Condition are required.');
      return;
    }
    const duplicateAsset = instruments.find((item) => item.id !== id && normalize(item.assetCode) === normalize(record.assetCode));
    if (duplicateAsset) {
      formMessage('instrumentFormMessage', `Asset Code already belongs to ${duplicateAsset.name}.`);
      return;
    }
    if (record.serialNumber) {
      const duplicateSerial = instruments.find((item) => item.id !== id && normalize(item.serialNumber) === normalize(record.serialNumber));
      if (duplicateSerial) {
        formMessage('instrumentFormMessage', `Serial Number already belongs to ${duplicateSerial.name}.`);
        return;
      }
    }
    if (!record.assignedMemberId) {
      record.dateIssued = '';
      record.expectedReturn = '';
    } else if (!record.dateIssued) {
      record.dateIssued = today();
    }
    const index = instruments.findIndex((item) => item.id === id);
    if (index >= 0) instruments[index] = record;
    else instruments.push(record);
    saveArray(INSTRUMENTS_KEY, instruments);
    hideModal('instrumentModal');
    logActivity(existing ? 'Updated instrument' : 'Added instrument', 'Inventory', `${record.assetCode} • ${record.name}${record.assignedMemberId ? ` • assigned to ${memberName(record.assignedMemberId)}` : ''}`);
    renderInstruments();
    renderAlerts();
    toast(existing ? 'Instrument record updated.' : 'Instrument added to inventory.');
  }

  function deleteInstrument(id) {
    const item = instruments.find((instrument) => instrument.id === id);
    if (!item) return;
    if (!isAdmin()) {
      toast('Administrator access is required to delete an instrument record.', true);
      return;
    }
    if (!window.confirm(`Delete ${item.assetCode} — ${item.name}?`)) return;
    instruments = instruments.filter((instrument) => instrument.id !== id);
    saveArray(INSTRUMENTS_KEY, instruments);
    logActivity('Deleted instrument', 'Inventory', `${item.assetCode} • ${item.name}`);
    renderInstruments();
    renderAlerts();
    toast('Instrument record deleted.');
  }

  function exportInstrumentCsv() {
    const headers = ['Asset Code', 'Instrument', 'Category', 'Condition', 'Brand', 'Model', 'Serial Number', 'Status', 'Assigned Member', 'Date Issued', 'Expected Return', 'Storage Location', 'Notes'];
    const rows = instruments.map((item) => [
      item.assetCode, item.name, item.category, item.condition, item.brand, item.model, item.serialNumber, instrumentStatus(item), memberName(item.assignedMemberId), item.dateIssued, item.expectedReturn, item.location, item.notes
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    downloadBlob(`LSO_Instrument_Inventory_${today()}.csv`, new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    logActivity('Exported instrument inventory', 'Inventory', `${instruments.length} records`);
    toast('Instrument inventory exported.');
  }

  // Alerts and action center
  function nextTransition(member) {
    const current = today();
    const candidates = [
      ['Probationary', member.probationaryStartDate],
      ['Membership Period', member.regularMemberDate]
    ].filter(([, date]) => date && date > current).sort((a, b) => a[1].localeCompare(b[1]));
    return candidates[0] || null;
  }

  function buildAlerts() {
    const settings = loadSettings();
    const alertDays = Number(settings.alertDays) || 30;
    const attendanceThreshold = Number(settings.attendanceThreshold) || 75;
    const members = getMembers();
    const alerts = [];

    members.forEach((member) => {
      const transition = nextTransition(member);
      if (transition) {
        const days = daysBetween(today(), transition[1]);
        if (days !== null && days >= 0 && days <= alertDays) {
          alerts.push({
            type: 'transition', severity: days <= 7 ? 'high' : 'medium', title: `${member.fullName} moves to ${transition[0]}`,
            detail: `${dateLabel(transition[1], true)} • ${days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'} remaining`}`,
            memberId: member.id
          });
        }
      }
      if (member.reviewStatus === 'Overdue') {
        alerts.push({ type: 'profile', severity: 'high', title: `${member.fullName} has an overdue profile review`, detail: `Last reviewed: ${dateLabel(member.lastProfileReview, true)}`, memberId: member.id });
      } else if (member.reviewStatus === 'For Review' || Number(member.recordQuality || 0) < 80) {
        alerts.push({ type: 'profile', severity: 'medium', title: `${member.fullName} needs a record review`, detail: `${member.recordQuality || 0}% complete • ${member.reviewStatus || 'For Review'}`, memberId: member.id });
      }
      if (!member.emergencyContactName || !member.emergencyContactNumber) {
        alerts.push({ type: 'safety', severity: 'high', title: `${member.fullName} has no complete emergency contact`, detail: 'Add an emergency contact name and number.', memberId: member.id });
      }
      const attendanceInfo = getMemberAttendance(member.id);
      if (attendanceInfo.sessions >= 3 && attendanceInfo.rate < attendanceThreshold) {
        alerts.push({ type: 'attendance', severity: 'high', title: `${member.fullName} has low attendance`, detail: `${attendanceInfo.rate}% across ${attendanceInfo.sessions} counted activities`, memberId: member.id });
      }
    });

    const severityOrder = { high: 0, medium: 1, low: 2 };
    return alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.title.localeCompare(b.title));
  }

  function alertIcon(type) {
    return ({ transition: '→', profile: 'ID', safety: '+', attendance: '%' })[type] || '!';
  }

  function alertAction(alert) {
    if (alert.memberId) return `<button class="small-button" data-alert-member="${safeText(alert.memberId)}">Open Member</button>`;
    return '';
  }

  function renderDashboardAlerts() {
    const container = el('dashboardAlertPreview');
    if (!container) return;
    const alerts = buildAlerts();
    container.innerHTML = alerts.length ? alerts.slice(0, 4).map((alert) => `<div class="alert-preview-item severity-${safeText(alert.severity)}"><span>${safeText(alertIcon(alert.type))}</span><div><strong>${safeText(alert.title)}</strong><small>${safeText(alert.detail)}</small></div></div>`).join('') : '<div class="all-clear-card"><strong>All clear</strong><span>No urgent automated alerts were found.</span></div>';
  }

  function renderAlerts() {
    const summary = el('alertSummaryGrid');
    const sections = el('alertSections');
    if (!summary || !sections) {
      renderDashboardAlerts();
      return;
    }
    const alerts = buildAlerts();
    const categories = [
      ['transition', 'Upcoming Transitions'],
      ['safety', 'Emergency Contact & Safety'],
      ['profile', 'Profile Reviews'],
      ['attendance', 'Attendance Risk']
    ];
    summary.innerHTML = categories.map(([key, label]) => `<div class="alert-summary-card"><span>${safeText(label)}</span><strong>${alerts.filter((alert) => alert.type === key).length}</strong></div>`).join('');
    sections.innerHTML = categories.map(([key, label]) => {
      const items = alerts.filter((alert) => alert.type === key);
      return `<article class="panel alert-section-card"><div class="panel-header"><div><p class="eyebrow">${safeText(key)}</p><h3>${safeText(label)}</h3></div><span class="period-count badge ${items.some((item) => item.severity === 'high') ? 'badge-red' : 'badge-green'}">${items.length} item${items.length === 1 ? '' : 's'}</span></div>
        <div class="alert-list">${items.length ? items.map((alert) => `<div class="alert-row severity-${safeText(alert.severity)}"><span class="alert-row-icon">${safeText(alertIcon(alert.type))}</span><div><strong>${safeText(alert.title)}</strong><small>${safeText(alert.detail)}</small></div>${alertAction(alert)}</div>`).join('') : '<div class="all-clear-row">No items in this category.</div>'}</div></article>`;
    }).join('');
    renderDashboardAlerts();
  }

  // Accounts, roles, and administrator approval
  function accountApprovalStatus(account) {
    if (account?.isDefault) return 'Approved';
    return ['Pending', 'Approved', 'Rejected'].includes(account?.approvalStatus) ? account.approvalStatus : 'Approved';
  }

  function renderAccounts() {
    const body = el('accountsTableBody');
    if (!body) return;
    if (!isAdmin()) {
      body.innerHTML = '<tr><td colspan="7"><div class="empty-state"><h4>Administrator access required</h4><p>This page is available only to the administrator account.</p></div></td></tr>';
      return;
    }
    const accounts = window.LSOAuth?.loadAccounts?.() || [];
    const active = currentAccount();
    const order = { Pending: 0, Approved: 1, Rejected: 2 };
    const sorted = [...accounts].sort((a, b) => {
      const statusDifference = (order[accountApprovalStatus(a)] ?? 9) - (order[accountApprovalStatus(b)] ?? 9);
      return statusDifference || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    body.innerHTML = sorted.map((account) => {
      const approval = accountApprovalStatus(account);
      const protectedAccount = Boolean(account.isDefault) || account.username === active?.username;
      const approved = approval === 'Approved';
      const accessLabel = approval === 'Pending' ? 'Pending approval' : approval === 'Rejected' ? 'Rejected' : account.disabled ? 'Disabled' : 'Active';
      const accessBadge = approval === 'Pending' ? 'badge-gold' : (approval === 'Rejected' || account.disabled) ? 'badge-red' : 'badge-green';
      const requestedDate = account.requestedAt || account.createdAt;
      const approvalNote = account.isDefault
        ? '<small class="table-subtext">Default administrator</small>'
        : approval === 'Pending'
          ? '<small class="table-subtext">Awaiting admin validation</small>'
          : approval === 'Rejected'
            ? '<small class="table-subtext">Access not approved</small>'
            : account.approvedBy
              ? `<small class="table-subtext">Approved by @${safeText(account.approvedBy)}</small>`
              : '';
      const approvalActions = approval === 'Pending'
        ? `<button class="small-button approve" data-account-action="approve" data-id="${safeText(account.id)}">Approve</button><button class="small-button danger" data-account-action="reject" data-id="${safeText(account.id)}">Reject</button>`
        : approval === 'Rejected'
          ? `<button class="small-button approve" data-account-action="approve" data-id="${safeText(account.id)}">Approve</button>`
          : `<button class="small-button" data-account-action="toggle" data-id="${safeText(account.id)}" ${protectedAccount ? 'disabled' : ''}>${account.disabled ? 'Enable' : 'Disable'}</button>`;
      return `<tr>
        <td><strong>${safeText(account.displayName || account.username)}</strong>${approvalNote}</td>
        <td><strong>@${safeText(account.username)}</strong><small class="table-subtext">${safeText(account.email || 'No optional email')}</small></td>
        <td><select class="account-role-select" data-account-id="${safeText(account.id)}" ${account.isDefault || !approved ? 'disabled' : ''}><option ${account.role === 'Administrator' ? 'selected' : ''}>Administrator</option><option ${account.role !== 'Administrator' ? 'selected' : ''}>Staff Account</option></select></td>
        <td>${safeText(dateLabel(String(requestedDate || '').slice(0, 10), true))}</td>
        <td><span class="badge ${accessBadge}">${safeText(accessLabel)}</span></td>
        <td>${account.approvedAt ? safeText(dateLabel(String(account.approvedAt).slice(0, 10), true)) : '—'}</td>
        <td><div class="table-actions">${approvalActions}<button class="small-button danger" data-account-action="delete" data-id="${safeText(account.id)}" ${protectedAccount ? 'disabled' : ''}>Delete</button></div></td>
      </tr>`;
    }).join('');
  }

  async function saveAccountRole(accountId, role) {
    if (!isAdmin()) return;
    const accounts = window.LSOAuth?.loadAccounts?.() || [];
    const account = accounts.find((item) => item.id === accountId);
    if (!account || account.isDefault || accountApprovalStatus(account) !== 'Approved') return;
    account.role = role === 'Administrator' ? 'Administrator' : 'Staff Account';
    const saved = await window.LSOAuth.saveAccounts(accounts);
    if (!saved) return;
    logActivity('Changed account role', 'Accounts', `${account.username} → ${account.role}`);
    renderAccounts();
    toast('Account role updated.');
  }

  async function accountAction(action, accountId) {
    if (!isAdmin()) return;
    const accounts = window.LSOAuth?.loadAccounts?.() || [];
    const index = accounts.findIndex((item) => item.id === accountId);
    const account = accounts[index];
    if (!account || account.isDefault || account.username === currentAccount()?.username) return;

    if (action === 'approve') {
      account.approvalStatus = 'Approved';
      account.approvedAt = new Date().toISOString();
      account.approvedBy = currentAccount()?.username || 'Administrator';
      account.disabled = false;
      const saved = await window.LSOAuth.saveAccounts(accounts);
      if (!saved) return;
      logActivity('Approved account registration', 'Accounts', account.username);
      renderAccounts();
      toast(`@${account.username} is approved and may now log in.`);
      return;
    }

    if (action === 'reject') {
      account.approvalStatus = 'Rejected';
      account.rejectedAt = new Date().toISOString();
      account.rejectedBy = currentAccount()?.username || 'Administrator';
      account.approvedAt = '';
      account.approvedBy = '';
      removeAccountSessionIfNeeded(account.username);
      const saved = await window.LSOAuth.saveAccounts(accounts);
      if (!saved) return;
      logActivity('Rejected account registration', 'Accounts', account.username);
      renderAccounts();
      toast(`@${account.username} was rejected.`);
      return;
    }

    if (action === 'toggle' && accountApprovalStatus(account) === 'Approved') {
      account.disabled = !account.disabled;
      const saved = await window.LSOAuth.saveAccounts(accounts);
      if (!saved) return;
      logActivity(account.disabled ? 'Disabled account' : 'Enabled account', 'Accounts', account.username);
      renderAccounts();
      toast(`Account ${account.disabled ? 'disabled' : 'enabled'}.`);
      return;
    }

    if (action === 'delete' && window.confirm(`Permanently delete the shared account @${account.username}? Member records will not be deleted.`)) {
      const deleted = await window.LSOAuth.deleteAccount(account.id);
      if (!deleted) return;
      logActivity('Deleted account', 'Accounts', account.username);
      renderAccounts();
      toast('Account deleted.');
    }
  }

  function removeAccountSessionIfNeeded(username) {
    // Session storage is isolated per browser tab. This hook documents that rejected
    // users will also be blocked on the next auth refresh or page load.
    if (currentAccount()?.username === username) window.LSOAuth?.signOut?.();
  }

  // Settings and timeline automation
  function renderSettings() {
    const settings = loadSettings();
    if (el('settingTraineeDays')) el('settingTraineeDays').value = settings.traineeDays || '';
    if (el('settingProbationaryDays')) el('settingProbationaryDays').value = settings.probationaryDays || '';
    if (el('settingRegular1Days')) el('settingRegular1Days').value = '';
    if (el('settingAlertDays')) el('settingAlertDays').value = settings.alertDays || 30;
    if (el('settingAttendanceThreshold')) el('settingAttendanceThreshold').value = settings.attendanceThreshold || 75;
    updateTimelineHelp();
  }

  function handleSaveSettings() {
    if (!isAdmin()) {
      toast('Administrator access is required to change system settings.', true);
      return;
    }
    const numberOrBlank = (id) => {
      const value = el(id).value;
      return value === '' ? '' : Math.max(1, Number(value) || 1);
    };
    const settings = {
      traineeDays: numberOrBlank('settingTraineeDays'),
      probationaryDays: numberOrBlank('settingProbationaryDays'),
      regular1Days: '',
      alertDays: Math.min(365, Math.max(1, Number(el('settingAlertDays').value) || 30)),
      attendanceThreshold: Math.min(100, Math.max(1, Number(el('settingAttendanceThreshold').value) || 75))
    };
    saveSettings(settings);
    logActivity('Updated system settings', 'Settings', `Alerts: ${settings.alertDays} days • Attendance threshold: ${settings.attendanceThreshold}%`);
    updateTimelineHelp();
    renderAlerts();
    toast('Automation settings saved.');
  }

  function timelineConfigured(settings = loadSettings()) {
    return [settings.traineeDays, settings.probationaryDays].every((value) => Number(value) > 0);
  }

  function updateTimelineHelp() {
    const node = el('timelineDefaultsHelp');
    if (!node) return;
    const settings = loadSettings();
    node.textContent = timelineConfigured(settings)
      ? `Configured: ${settings.traineeDays} trainee days and ${settings.probationaryDays} probationary days.`
      : 'Configure the Trainee and Probationary durations in Data & Backup before using automatic date calculation.';
  }

  function applyTimelineDefaults(showMessage = true) {
    const settings = loadSettings();
    if (!timelineConfigured(settings)) {
      if (showMessage) toast('Configure the Trainee and Probationary durations in Data & Backup first.', true);
      return false;
    }
    const start = el('traineeStartDate')?.value;
    if (!start) {
      if (showMessage) toast('Enter the Trainee Start Date first.', true);
      return false;
    }
    const skipped = Boolean(el('probationarySkipped')?.checked);
    const probationary = addDays(start, Number(settings.traineeDays));
    const regular1 = skipped ? probationary : addDays(probationary, Number(settings.probationaryDays));
    el('probationaryStartDate').disabled = skipped;
    el('probationaryStartDate').value = skipped ? '' : probationary;
    el('regularMemberDate').value = regular1;
    if (el('regularPeriod2StartDate')) el('regularPeriod2StartDate').value = '';
    ['probationaryStartDate', 'regularMemberDate'].forEach((id) => el(id).dispatchEvent(new Event('change', { bubbles: true })));
    if (showMessage) toast(skipped ? 'Direct Trainee-to-Membership dates calculated. Probationary duty remains archived.' : 'Recruitment timeline dates calculated.');
    return true;
  }

  // Complete backup and audit log
  function completeBackup() {
    const backup = {
      schemaVersion: 3,
      application: 'Lasallian Symphony Orchestra Management System',
      exportedAt: new Date().toISOString(),
      members: getMembers(),
      events,
      attendance,
      dutyHours: loadDutyHours(),
      instruments,
      settings: loadSettings(),
      activityLog: loadArray(ACTIVITY_KEY)
    };
    downloadBlob(`LSO_Complete_Backup_${today()}.json`, new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    logActivity('Downloaded complete backup', 'Data', `${backup.members.length} members • ${events.length} events`);
    toast('Complete system backup downloaded.');
  }

  function restoreCompleteBackup(file) {
    if (!isAdmin()) {
      toast('Administrator access is required to restore a complete backup.', true);
      el('restoreCompleteSystem').value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const backup = JSON.parse(String(reader.result || ''));
        if (!backup || !Array.isArray(backup.members) || !Array.isArray(backup.events) || !Array.isArray(backup.attendance) || !Array.isArray(backup.instruments)) {
          throw new Error('The selected file is not a valid complete LSO backup.');
        }
        if (!window.confirm(`Restore ${backup.members.length} members and ${backup.events.length} events? Current system data will be replaced.`)) return;
        window.LSOStorage.setItem(MEMBERS_KEY, JSON.stringify(backup.members));
        events = backup.events;
        attendance = backup.attendance;
        instruments = backup.instruments;
        saveArray(EVENTS_KEY, events);
        saveArray(ATTENDANCE_KEY, attendance);
        window.LSOStorage.setItem(DUTY_HOURS_KEY, JSON.stringify(backup.dutyHours && typeof backup.dutyHours === 'object' ? backup.dutyHours : { version: 1, commitments: {}, entries: [] }));
        window.dispatchEvent(new CustomEvent('lso:duty-hours-changed'));
        saveArray(INSTRUMENTS_KEY, instruments);
        saveSettings(backup.settings || DEFAULT_SETTINGS);
        saveArray(ACTIVITY_KEY, Array.isArray(backup.activityLog) ? backup.activityLog : []);
        selectedEventId = sortedEvents()[0]?.id || null;
        window.LSOApp?.refresh?.();
        logActivity('Restored complete backup', 'Data', `${backup.members.length} members • ${backup.events.length} events`);
        refreshAll();
        toast('Complete system backup restored.');
      } catch (error) {
        toast(error.message || 'Unable to restore the complete backup.', true);
      } finally {
        el('restoreCompleteSystem').value = '';
      }
    };
    reader.onerror = () => toast('Unable to read the backup file.', true);
    reader.readAsText(file);
  }

  function renderActivityLog() {
    const container = el('activityList');
    if (!container) return;
    const log = loadArray(ACTIVITY_KEY).slice(0, 30);
    container.innerHTML = log.length ? log.map((item) => `<div class="activity-item"><span class="activity-dot"></span><div><strong>${safeText(item.action)}</strong><p>${safeText(item.details || item.category)}</p><small>${safeText(item.account)} • ${safeText(new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.timestamp)))}</small></div></div>`).join('') : '<div class="all-clear-row">No recorded activity yet.</div>';
  }

  function clearActivityLog() {
    if (!isAdmin()) return;
    if (!window.confirm('Clear the shared activity log for all devices? This does not delete member or attendance records.')) return;
    saveArray(ACTIVITY_KEY, []);
    renderActivityLog();
    toast('Activity log cleared.');
  }

  function refreshView(viewId) {
    if (viewId === 'attendanceView') renderAttendance();
    if (viewId === 'dutyHoursView') window.LSODutyHours?.refresh?.();
    if (viewId === 'instrumentsView') renderInstruments();
    if (viewId === 'alertsView') renderAlerts();
    if (viewId === 'accountsView') renderAccounts();
    if (viewId === 'dataView') {
      renderSettings();
      renderActivityLog();
    }
  }

  function refreshAll() {
    events = loadArray(EVENTS_KEY);
    attendance = loadArray(ATTENDANCE_KEY);
    instruments = loadArray(INSTRUMENTS_KEY);
    renderAttendance();
    renderInstruments();
    renderAlerts();
    renderAccounts();
    renderSettings();
    renderActivityLog();
    renderInstrumentMemberOptions();
  }

  function wireEvents() {
    qsa('.nav-item').forEach((button) => button.addEventListener('click', () => setTimeout(() => refreshView(button.dataset.view), 0)));
    qsa('[data-management-jump]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.managementJump)));

    el('addEventButton').addEventListener('click', () => openEventModal());
    el('closeEventModal').addEventListener('click', () => hideModal('eventModal'));
    el('cancelEventForm').addEventListener('click', () => hideModal('eventModal'));
    el('eventModal').addEventListener('click', (event) => { if (event.target === el('eventModal')) hideModal('eventModal'); });
    el('eventForm').addEventListener('submit', handleEventSubmit);
    el('eventSearch').addEventListener('input', renderEventList);
    el('eventList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-event-id]');
      if (!button) return;
      selectedEventId = button.dataset.eventId;
      renderAttendance();
    });
    el('editEventButton').addEventListener('click', () => openEventModal(events.find((event) => event.id === selectedEventId)));
    el('deleteEventButton').addEventListener('click', deleteSelectedEvent);
    el('attendanceMemberSearch').addEventListener('input', renderAttendanceRoster);
    el('markAllPresent').addEventListener('click', () => qsa('.attendance-status', el('attendanceRosterBody')).forEach((select) => { select.value = 'Present'; }));
    el('saveAttendanceButton').addEventListener('click', saveAttendanceRoster);

    el('addInstrumentButton').addEventListener('click', () => openInstrumentModal());
    el('closeInstrumentModal').addEventListener('click', () => hideModal('instrumentModal'));
    el('cancelInstrumentForm').addEventListener('click', () => hideModal('instrumentModal'));
    el('instrumentModal').addEventListener('click', (event) => { if (event.target === el('instrumentModal')) hideModal('instrumentModal'); });
    el('instrumentForm').addEventListener('submit', handleInstrumentSubmit);
    ['instrumentSearch', 'instrumentStatusFilter', 'instrumentConditionFilter', 'instrumentCategoryFilter'].forEach((id) => el(id).addEventListener(id === 'instrumentSearch' ? 'input' : 'change', renderInstruments));
    el('instrumentTableBody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-instrument-action]');
      if (!button) return;
      const item = instruments.find((instrument) => instrument.id === button.dataset.id);
      if (button.dataset.instrumentAction === 'edit' && item) openInstrumentModal(item);
      if (button.dataset.instrumentAction === 'delete') deleteInstrument(button.dataset.id);
    });
    el('exportInstrumentCsv').addEventListener('click', exportInstrumentCsv);

    el('refreshAlertsButton').addEventListener('click', () => { renderAlerts(); toast('Action Center refreshed.'); });
    el('alertSections').addEventListener('click', (event) => {
      const memberButton = event.target.closest('[data-alert-member]');
      const instrumentButton = event.target.closest('[data-alert-instrument]');
      if (memberButton) window.LSOApp?.openRecord?.(memberButton.dataset.alertMember);
      if (instrumentButton) {
        setView('instrumentsView');
        const item = instruments.find((instrument) => instrument.id === instrumentButton.dataset.alertInstrument);
        if (item) openInstrumentModal(item);
      }
    });

    el('accountsTableBody').addEventListener('change', (event) => {
      const select = event.target.closest('.account-role-select');
      if (select) saveAccountRole(select.dataset.accountId, select.value);
    });
    el('accountsTableBody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-account-action]');
      if (button) accountAction(button.dataset.accountAction, button.dataset.id);
    });

    el('applyTimelineDefaults').addEventListener('click', () => applyTimelineDefaults(true));
    el('traineeStartDate').addEventListener('change', () => {
      const hasOtherDates = el('probationaryStartDate').value || el('regularMemberDate').value;
      if (!hasOtherDates && timelineConfigured()) applyTimelineDefaults(false);
    });
    el('saveSystemSettings').addEventListener('click', handleSaveSettings);
    el('backupCompleteSystem').addEventListener('click', completeBackup);
    el('restoreCompleteSystem').addEventListener('change', (event) => { if (event.target.files[0]) restoreCompleteBackup(event.target.files[0]); });
    el('clearActivityLog').addEventListener('click', clearActivityLog);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!el('eventModal').classList.contains('hidden')) hideModal('eventModal');
      if (!el('instrumentModal').classList.contains('hidden')) hideModal('instrumentModal');
    });

    window.addEventListener('lso:members-changed', () => {
      renderAttendanceRoster();
      renderInstrumentMemberOptions();
      renderInstruments();
      renderAlerts();
    });
    window.addEventListener('lso:accounts-changed', () => renderAccounts());
    window.addEventListener('lso:cloud-state-changed', () => {
      events = loadArray(EVENTS_KEY);
      attendance = loadArray(ATTENDANCE_KEY);
      instruments = loadArray(INSTRUMENTS_KEY);
      refreshAll();
    });
    window.addEventListener('lso:attendance-semester-changed', () => {
      selectedEventId = sortedEvents()[0]?.id || null;
      renderAttendance();
    });

    window.addEventListener('lso:auth-changed', () => {
      setTimeout(() => {
        document.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', !isAdmin()));
        renderAccounts();
      }, 0);
    });
  }

  window.LSOOperations = {
    logActivity,
    refreshAll,
    getEvents: () => events.map((event) => ({ ...event })),
    getAttendance: () => attendance.map((entry) => ({ ...entry })),
    getAttendanceSemester: activeAttendanceSemester,
    setAttendanceSemester: (semester) => {
      window.LSOAttendanceSemester = normalizeSemester(semester);
      window.dispatchEvent(new CustomEvent('lso:attendance-semester-changed', { detail: { semester: window.LSOAttendanceSemester } }));
    },
    getInstruments: () => instruments.map((item) => ({ ...item })),
    buildAlerts
  };

  wireEvents();
  refreshAll();
})();
