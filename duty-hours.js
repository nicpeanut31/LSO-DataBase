(() => {
  'use strict';

  const DUTY_KEY = 'lso_duty_hours_v1';
  const SEMESTERS = ['First Semester', 'Second Semester'];
  const PERIODS = ['Trainee Period', 'Probationary Period'];
  const el = (id) => document.getElementById(id);
  const safeText = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));

  let activeSemester = 'First Semester';
  let selectedMemberId = '';
  let selectedPeriod = 'Trainee Period';
  let overallPeriod = 'Trainee Period';
  let searchTerm = '';

  function today() {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function uid(prefix = 'duty') {
    return window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function isAdmin() {
    return currentAccount()?.role === 'Administrator';
  }

  function getMembers() {
    return window.LSOApp?.getMembers?.() || [];
  }

  function normalizeSemester(value) {
    return SEMESTERS.includes(value) ? value : 'First Semester';
  }

  function normalizePeriod(value) {
    return PERIODS.includes(value) ? value : 'Trainee Period';
  }

  function periodKey(period) {
    return normalizePeriod(period) === 'Probationary Period' ? 'probationary' : 'trainee';
  }

  function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function minuteValue(value) {
    return Math.round(numberValue(value));
  }

  function legacyHoursToMinutes(value) {
    return Math.round(numberValue(value) * 60);
  }

  function emptySemesterCommitment() {
    return { trainee: 0, probationary: 0 };
  }

  function defaultData() {
    return { version: 3, commitments: {}, entries: [] };
  }

  function normalizeCommitments(rawCommitments) {
    const result = {};
    if (!rawCommitments || typeof rawCommitments !== 'object' || Array.isArray(rawCommitments)) return result;

    Object.entries(rawCommitments).forEach(([memberId, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const hasSemesterShape = SEMESTERS.some((semester) => raw[semester] && typeof raw[semester] === 'object');
      if (hasSemesterShape) {
        result[memberId] = {};
        SEMESTERS.forEach((semester) => {
          const source = raw[semester] && typeof raw[semester] === 'object' ? raw[semester] : {};
          result[memberId][semester] = {
            trainee: Math.max(0, minuteValue(source.trainee)),
            probationary: Math.max(0, minuteValue(source.probationary))
          };
        });
      } else {
        // Previous versions stored decimal hours without a semester. Preserve them in First Semester.
        result[memberId] = {
          'First Semester': {
            trainee: Math.max(0, legacyHoursToMinutes(raw.trainee)),
            probationary: Math.max(0, legacyHoursToMinutes(raw.probationary))
          },
          'Second Semester': emptySemesterCommitment()
        };
      }
      result[memberId].updatedAt = raw.updatedAt || '';
      result[memberId].updatedBy = raw.updatedBy || '';
    });
    return result;
  }

  function normalizeEntries(rawEntries) {
    if (!Array.isArray(rawEntries)) return [];
    return rawEntries.map((entry) => {
      const entryType = entry?.entryType === 'Incentive' ? 'Incentive' : 'Duty';
      let minutes;
      if (Number.isFinite(Number(entry?.minutes))) minutes = minuteValue(entry.minutes);
      else minutes = legacyHoursToMinutes(entry?.hours);
      if (entryType === 'Duty') minutes = Math.max(0, minutes);
      return {
        id: entry?.id || uid('duty-entry'),
        memberId: String(entry?.memberId || ''),
        semester: normalizeSemester(entry?.semester),
        period: normalizePeriod(entry?.period),
        entryType,
        date: entry?.date || today(),
        minutes,
        timeIn: entryType === 'Duty' ? String(entry?.timeIn || '') : '',
        timeOut: entryType === 'Duty' ? String(entry?.timeOut || '') : '',
        description: String(entry?.description || ''),
        createdAt: entry?.createdAt || new Date().toISOString(),
        createdBy: String(entry?.createdBy || ''),
        createdByUsername: String(entry?.createdByUsername || '')
      };
    }).filter((entry) => entry.memberId && entry.minutes !== 0);
  }

  function normalizeData(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      version: 3,
      commitments: normalizeCommitments(data.commitments),
      entries: normalizeEntries(data.entries)
    };
  }

  function loadRawData() {
    try {
      return JSON.parse(window.LSOStorage?.getItem(DUTY_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function loadData() {
    return normalizeData(loadRawData());
  }

  function persistData(data, activity = null) {
    const normalized = normalizeData(data);
    window.LSOStorage?.setItem(DUTY_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent('lso:duty-hours-changed'));
    if (activity) window.LSOOperations?.logActivity?.(activity.action, 'Duty Hours', activity.details || '');
  }

  function ensureDataMigration() {
    const raw = loadRawData();
    if (raw?.version === 3) return;
    const normalized = normalizeData(raw);
    window.LSOStorage?.setItem(DUTY_KEY, JSON.stringify(normalized));
  }

  function getSemesterCommitment(data, memberId, semester) {
    const member = data.commitments?.[memberId] || {};
    const record = member[normalizeSemester(semester)] || {};
    return {
      trainee: Math.max(0, minuteValue(record.trainee)),
      probationary: Math.max(0, minuteValue(record.probationary))
    };
  }

  function getCommitment(data, memberId, semester, period) {
    return getSemesterCommitment(data, memberId, semester)[periodKey(period)];
  }

  function entriesFor(data, memberId, semester = '', period = '') {
    return data.entries.filter((entry) => entry.memberId === memberId &&
      (!semester || entry.semester === normalizeSemester(semester)) &&
      (!period || entry.period === normalizePeriod(period)));
  }

  function calculatePeriod(data, memberId, semester, period) {
    const entries = entriesFor(data, memberId, semester, period);
    const rendered = entries.filter((entry) => entry.entryType === 'Duty')
      .reduce((sum, entry) => sum + Math.max(0, minuteValue(entry.minutes)), 0);
    const incentives = entries.filter((entry) => entry.entryType === 'Incentive')
      .reduce((sum, entry) => sum + minuteValue(entry.minutes), 0);
    const committed = getCommitment(data, memberId, semester, period);
    const credited = rendered + incentives;
    const balance = committed - credited;
    const progress = committed > 0 ? Math.max(0, Math.min(100, Math.round((credited / committed) * 100))) : 0;
    return { semester: normalizeSemester(semester), period: normalizePeriod(period), committed, rendered, incentives, credited, balance, progress, entries };
  }

  function combineSummaries(items) {
    return items.reduce((result, item) => {
      result.committed += item.committed;
      result.rendered += item.rendered;
      result.incentives += item.incentives;
      result.credited += item.credited;
      result.balance += item.balance;
      result.entries.push(...item.entries);
      return result;
    }, { committed: 0, rendered: 0, incentives: 0, credited: 0, balance: 0, entries: [] });
  }

  function calculateSemester(data, memberId, semester) {
    const trainee = calculatePeriod(data, memberId, semester, 'Trainee Period');
    const probationary = calculatePeriod(data, memberId, semester, 'Probationary Period');
    return { semester: normalizeSemester(semester), trainee, probationary, combined: combineSummaries([trainee, probationary]) };
  }

  function calculateMember(data, memberId) {
    const first = calculateSemester(data, memberId, 'First Semester');
    const second = calculateSemester(data, memberId, 'Second Semester');
    return { first, second, academicYear: combineSummaries([first.combined, second.combined]) };
  }

  function splitMinutes(totalMinutes) {
    const value = Math.abs(minuteValue(totalMinutes));
    return { hours: Math.floor(value / 60), minutes: value % 60 };
  }

  function durationLabel(totalMinutes, signed = false) {
    const value = minuteValue(totalMinutes);
    const absolute = Math.abs(value);
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;
    const parts = [];
    if (hours) parts.push(`${hours} hr${hours === 1 ? '' : 's'}`);
    if (minutes || !parts.length) parts.push(`${minutes} min`);
    const prefix = signed ? (value > 0 ? '+' : value < 0 ? '−' : '') : value < 0 ? '−' : '';
    return `${prefix}${parts.join(' ')}`;
  }

  function dateLabel(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function balanceText(balance, committed = 0, credited = 0) {
    const value = minuteValue(balance);
    if (minuteValue(committed) === 0 && minuteValue(credited) === 0) return 'Not set';
    if (value === 0) return 'Completed';
    return value > 0 ? `${durationLabel(value)} remaining` : `${durationLabel(Math.abs(value))} excess`;
  }

  function balanceBadge(summary) {
    const unset = summary.committed === 0 && summary.credited === 0;
    const className = unset ? 'badge-gray' : summary.balance > 0 ? 'badge-gold' : 'badge-green';
    return `<span class="badge ${className}">${safeText(balanceText(summary.balance, summary.committed, summary.credited))}</span>`;
  }

  function memberHasPeriodData(data, memberId, period) {
    return SEMESTERS.some((semester) => getCommitment(data, memberId, semester, period) > 0) ||
      data.entries.some((entry) => entry.memberId === memberId && entry.period === period);
  }

  function rosterMembers(data, period, applySearch = true) {
    const query = applySearch ? searchTerm.trim().toLowerCase() : '';
    return getMembers()
      .filter((member) => member.periodGroup === period || memberHasPeriodData(data, member.id, period))
      .filter((member) => !query || [member.fullName, member.membershipId, member.studentNumber]
        .some((value) => String(value || '').toLowerCase().includes(query)))
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  }

  function rosterButton(member, period, data) {
    const summary = calculatePeriod(data, member.id, activeSemester, period);
    const active = member.id === selectedMemberId && period === selectedPeriod;
    const initials = String(member.fullName || 'M').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    const historical = member.periodGroup !== period;
    return `<button class="duty-roster-person${active ? ' active' : ''}" data-duty-member="${safeText(member.id)}" data-duty-roster-period="${safeText(period)}" type="button">
      <span class="member-avatar">${safeText(initials)}</span>
      <span class="duty-roster-person-copy"><strong>${safeText(member.fullName)}</strong><small>${safeText(member.membershipId || member.studentNumber || 'No ID')}${historical ? ' • Historical record' : ''}</small></span>
      <span class="duty-roster-balance ${summary.balance <= 0 && summary.committed > 0 ? 'complete' : ''}">${safeText(balanceText(summary.balance, summary.committed, summary.credited))}</span>
    </button>`;
  }

  function renderRosters() {
    const data = loadData();
    const trainee = rosterMembers(data, 'Trainee Period');
    const probationary = rosterMembers(data, 'Probationary Period');
    if (el('dutyTraineeCount')) el('dutyTraineeCount').textContent = trainee.length;
    if (el('dutyProbationaryCount')) el('dutyProbationaryCount').textContent = probationary.length;
    if (el('dutyTraineeRoster')) el('dutyTraineeRoster').innerHTML = trainee.length
      ? trainee.map((member) => rosterButton(member, 'Trainee Period', data)).join('')
      : '<div class="roster-empty"><strong>No trainees found</strong><small>Add a Trainee member or clear the search.</small></div>';
    if (el('dutyProbationaryRoster')) el('dutyProbationaryRoster').innerHTML = probationary.length
      ? probationary.map((member) => rosterButton(member, 'Probationary Period', data)).join('')
      : '<div class="roster-empty"><strong>No probationary members found</strong><small>Add a Probationary member or clear the search.</small></div>';
  }

  function summaryStat(label, value, helper = '') {
    return `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong>${helper ? `<small>${safeText(helper)}</small>` : ''}</div>`;
  }

  function progressCard(summary) {
    return `<article class="duty-focus-card">
      <div class="duty-focus-heading"><div><p class="eyebrow">${safeText(summary.semester)}</p><h4>${safeText(summary.period)}</h4></div>${balanceBadge(summary)}</div>
      <div class="duty-progress-track"><span style="width:${summary.progress}%"></span></div>
      <div class="duty-focus-stats">
        ${summaryStat('Committed', durationLabel(summary.committed))}
        ${summaryStat('Rendered', durationLabel(summary.rendered))}
        ${summaryStat('Incentives', durationLabel(summary.incentives, true), 'Net adjustment')}
        ${summaryStat('Credited', durationLabel(summary.credited))}
      </div>
    </article>`;
  }

  function renderSelectedMember() {
    const data = loadData();
    const member = getMembers().find((item) => item.id === selectedMemberId);
    const summaryContainer = el('dutyHoursSummary');
    const adminControls = el('dutyHoursAdminControls');
    const ledgerSection = el('dutyLedgerSection');
    const printButton = el('printDutyHoursIndividual');
    if (!summaryContainer || !adminControls || !ledgerSection || !printButton) return;

    if (!member) {
      if (el('dutySelectedTitle')) el('dutySelectedTitle').textContent = 'Choose a Trainee or Probationary member';
      if (el('dutySelectedContext')) el('dutySelectedContext').textContent = 'The selected semester and period control every calculation below.';
      if (el('dutySelectedBadge')) { el('dutySelectedBadge').textContent = 'No selection'; el('dutySelectedBadge').className = 'badge badge-gray'; }
      summaryContainer.innerHTML = '<div class="dashboard-empty-state"><span>◷</span><strong>Select a name from either roster</strong><small>Committed time, rendered time, incentives, and remaining balance will appear here.</small></div>';
      adminControls.classList.add('hidden');
      ledgerSection.classList.add('hidden');
      printButton.disabled = true;
      renderAcademicYearSummary(null, data);
      return;
    }

    const focus = calculatePeriod(data, member.id, activeSemester, selectedPeriod);
    const semester = calculateSemester(data, member.id, activeSemester);
    const semesterCombined = semester.combined;
    if (el('dutySelectedTitle')) el('dutySelectedTitle').textContent = member.fullName;
    if (el('dutySelectedContext')) el('dutySelectedContext').textContent = `${member.membershipId || member.studentNumber || 'No ID'} • ${activeSemester} • ${selectedPeriod}`;
    if (el('dutySelectedBadge')) {
      el('dutySelectedBadge').textContent = selectedPeriod;
      el('dutySelectedBadge').className = `badge ${selectedPeriod === 'Trainee Period' ? 'badge-blue' : 'badge-gold'}`;
    }

    summaryContainer.innerHTML = `<div class="duty-profile-snapshot">
      ${progressCard(focus)}
      <article class="duty-semester-total-card"><p class="eyebrow">Semester Total</p><h4>${safeText(activeSemester)}</h4><div class="duty-focus-stats">
        ${summaryStat('Both Periods Committed', durationLabel(semesterCombined.committed))}
        ${summaryStat('Both Periods Rendered', durationLabel(semesterCombined.rendered))}
        ${summaryStat('Net Incentives', durationLabel(semesterCombined.incentives, true))}
        ${summaryStat('Semester Balance', balanceText(semesterCombined.balance, semesterCombined.committed, semesterCombined.credited))}
      </div></article>
    </div>`;

    writeTimeInputs('dutyCommittedHours', 'dutyCommittedMinutes', focus.committed);
    adminControls.classList.toggle('hidden', !isAdmin());
    ledgerSection.classList.remove('hidden');
    printButton.disabled = false;
    renderLedger(data, member);
    renderAcademicYearSummary(member, data);
  }

  function renderAcademicYearSummary(member, data) {
    const container = el('dutyAcademicYearSummary');
    if (!container) return;
    if (!member) {
      container.innerHTML = '<div class="dashboard-empty-state compact-dashboard-empty"><span>↔</span><strong>No profile selected</strong><small>Select a roster name to compare semesters.</small></div>';
      return;
    }
    const summary = calculateMember(data, member.id);
    const cards = [
      ['First Semester', summary.first.combined],
      ['Second Semester', summary.second.combined],
      ['Whole Academic Year', summary.academicYear]
    ];
    container.innerHTML = `<div class="duty-year-card-grid">${cards.map(([label, item]) => `<article class="duty-year-card${label === 'Whole Academic Year' ? ' total' : ''}"><span>${safeText(label)}</span><strong>${safeText(balanceText(item.balance, item.committed, item.credited))}</strong><small>${safeText(durationLabel(item.credited))} credited of ${safeText(durationLabel(item.committed))}</small><div class="mini-progress"><i style="width:${item.committed > 0 ? Math.max(0, Math.min(100, Math.round(item.credited / item.committed * 100))) : 0}%"></i></div></article>`).join('')}</div>`;
  }

  function renderLedger(data, member) {
    const body = el('dutyLedgerTableBody');
    const caption = el('dutyLedgerCaption');
    if (!body || !caption) return;
    const entries = entriesFor(data, member.id, activeSemester, selectedPeriod)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    caption.textContent = `${activeSemester} • ${selectedPeriod} • ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
    body.innerHTML = entries.length ? entries.map((entry) => {
      const isIncentive = entry.entryType === 'Incentive';
      const minutes = minuteValue(entry.minutes);
      const effect = isIncentive
        ? minutes > 0 ? `Reduces remaining by ${durationLabel(minutes)}` : `Adds ${durationLabel(Math.abs(minutes))} to remaining`
        : `Adds ${durationLabel(minutes)} rendered`;
      return `<tr>
        <td>${safeText(dateLabel(entry.date))}</td>
        <td><strong>${safeText(isIncentive ? '—' : clockRangeLabel(entry))}</strong></td>
        <td>${safeText(entry.semester)}</td>
        <td><span class="badge ${entry.period === 'Trainee Period' ? 'badge-blue' : 'badge-gold'}">${safeText(entry.period)}</span></td>
        <td>${safeText(isIncentive ? 'Incentive Adjustment' : 'Rendered Duty')}</td>
        <td><strong class="${minutes < 0 ? 'negative-value' : ''}">${safeText(durationLabel(minutes, isIncentive))}</strong></td>
        <td>${safeText(effect)}</td>
        <td>${safeText(entry.description || '—')}<small class="table-subtext">${safeText(entry.createdBy || '')}</small></td>
        <td class="admin-only"><button class="table-action danger" data-duty-delete="${safeText(entry.id)}" type="button" aria-label="Delete duty entry">×</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="9"><div class="empty-state compact-empty"><h4>No entries in this ledger</h4><p>Add clock-based rendered time or an incentive for the selected semester and period.</p></div></td></tr>';
    body.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', !isAdmin()));
  }

  function renderOverall() {
    const data = loadData();
    const members = rosterMembers(data, overallPeriod, false);
    const metrics = el('dutyOverallMetrics');
    const body = el('dutyOverallTableBody');
    const caption = el('dutyOverallCaption');
    if (!metrics || !body || !caption) return;
    const summaries = members.map((member) => ({ member, summary: calculatePeriod(data, member.id, activeSemester, overallPeriod) }));
    const totals = combineSummaries(summaries.map((item) => item.summary));
    const completed = summaries.filter((item) => item.summary.committed > 0 && item.summary.balance <= 0).length;
    const outstanding = summaries.reduce((sum, item) => sum + Math.max(0, item.summary.balance), 0);

    metrics.innerHTML = [
      ['Roster Members', members.length, overallPeriod],
      ['Committed', durationLabel(totals.committed), activeSemester],
      ['Rendered', durationLabel(totals.rendered), 'Actual service'],
      ['Net Incentives', durationLabel(totals.incentives, true), 'Credits minus deductions'],
      ['Completed', completed, 'Met required time'],
      ['Outstanding', durationLabel(outstanding), 'Still to render']
    ].map(([label, value, helper]) => `<div class="attendance-kpi"><span>${safeText(label)}</span><strong>${safeText(value)}</strong><small>${safeText(helper)}</small></div>`).join('');
    caption.textContent = `${activeSemester} • ${overallPeriod} • ${members.length} tracked member${members.length === 1 ? '' : 's'}`;
    body.innerHTML = summaries.length ? summaries.map(({ member, summary }) => `<tr>
      <td><strong>${safeText(member.fullName)}</strong><small class="table-subtext">${safeText(member.membershipId || member.studentNumber || 'No ID')}</small></td>
      <td>${safeText(durationLabel(summary.committed))}</td>
      <td>${safeText(durationLabel(summary.rendered))}</td>
      <td><span class="${summary.incentives < 0 ? 'negative-value' : ''}">${safeText(durationLabel(summary.incentives, true))}</span></td>
      <td>${safeText(durationLabel(summary.credited))}</td>
      <td>${balanceBadge(summary)}</td>
      <td><div class="table-progress"><span style="width:${summary.progress}%"></span></div><small>${summary.progress}%</small></td>
    </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state compact-empty"><h4>No roster records</h4><p>No members or historical duty records match this semester and period.</p></div></td></tr>';
  }

  function parseTimeInputs(hoursId, minutesId) {
    const hours = Math.floor(numberValue(el(hoursId)?.value));
    const minutes = Math.floor(numberValue(el(minutesId)?.value));
    if (hours < 0 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function writeTimeInputs(hoursId, minutesId, totalMinutes) {
    const parts = splitMinutes(totalMinutes);
    if (el(hoursId)) el(hoursId).value = parts.hours || '';
    if (el(minutesId)) el(minutesId).value = parts.minutes || '';
  }

  function parseClockValue(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function calculateClockDuration(timeIn, timeOut) {
    const start = parseClockValue(timeIn);
    const end = parseClockValue(timeOut);
    if (start === null || end === null) return { valid: false, reason: 'missing', minutes: 0 };
    if (end <= start) return { valid: false, reason: 'order', minutes: 0 };
    return { valid: true, reason: '', minutes: end - start };
  }

  function formatClockTime(value) {
    const total = parseClockValue(value);
    if (total === null) return '';
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    const date = new Date(2000, 0, 1, hours, minutes, 0, 0);
    return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  }

  function clockRangeLabel(entry) {
    if (entry?.entryType !== 'Duty' || !entry.timeIn || !entry.timeOut) return 'Manual duration';
    return `${formatClockTime(entry.timeIn)} – ${formatClockTime(entry.timeOut)}`;
  }

  function updateRenderedDurationPreview() {
    const preview = el('dutyRenderedDurationPreview');
    if (!preview) return;
    const timeIn = el('dutyRenderedTimeIn')?.value || '';
    const timeOut = el('dutyRenderedTimeOut')?.value || '';
    const result = calculateClockDuration(timeIn, timeOut);
    const title = preview.querySelector('strong');
    const helper = preview.querySelector('small');
    preview.classList.toggle('valid', result.valid);
    preview.classList.toggle('invalid', !result.valid && Boolean(timeIn && timeOut));
    if (!timeIn || !timeOut) {
      if (title) title.textContent = 'Select Time In and Time Out';
      if (helper) helper.textContent = 'Example: 12:00 PM to 5:00 PM = 5 hrs';
      return;
    }
    if (!result.valid) {
      if (title) title.textContent = 'Time Out must be later than Time In';
      if (helper) helper.textContent = 'This entry is treated as same-day duty service.';
      return;
    }
    if (title) title.textContent = durationLabel(result.minutes);
    if (helper) helper.textContent = `${formatClockTime(timeIn)} to ${formatClockTime(timeOut)} • computed automatically`;
  }

  function selectedMember() {
    return getMembers().find((member) => member.id === selectedMemberId) || null;
  }

  function saveCommitment(event) {
    event.preventDefault();
    const member = selectedMember();
    if (!member || !isAdmin()) return;
    const minutes = parseTimeInputs('dutyCommittedHours', 'dutyCommittedMinutes');
    if (minutes === null) {
      window.LSOApp?.showToast?.('Minutes must be from 0 to 59, and time cannot be negative.', true);
      return;
    }
    const data = loadData();
    data.commitments[member.id] = data.commitments[member.id] || {};
    data.commitments[member.id][activeSemester] = data.commitments[member.id][activeSemester] || emptySemesterCommitment();
    data.commitments[member.id][activeSemester][periodKey(selectedPeriod)] = minutes;
    data.commitments[member.id].updatedAt = new Date().toISOString();
    data.commitments[member.id].updatedBy = currentAccount()?.displayName || currentAccount()?.username || 'Administrator';
    persistData(data, { action: 'Updated committed duty time', details: `${member.fullName} • ${activeSemester} • ${selectedPeriod} • ${durationLabel(minutes)}` });
    window.LSOApp?.showToast?.('Committed duty time saved.');
    renderAll();
  }

  function saveRendered(event) {
    event.preventDefault();
    const member = selectedMember();
    if (!member || !isAdmin()) return;
    const date = el('dutyRenderedDate')?.value;
    const timeIn = el('dutyRenderedTimeIn')?.value || '';
    const timeOut = el('dutyRenderedTimeOut')?.value || '';
    const duration = calculateClockDuration(timeIn, timeOut);
    if (!date || !duration.valid) {
      const message = !date
        ? 'Select the duty date.'
        : duration.reason === 'order'
          ? 'Time Out must be later than Time In for a same-day duty entry.'
          : 'Enter both Time In and Time Out.';
      window.LSOApp?.showToast?.(message, true);
      updateRenderedDurationPreview();
      return;
    }
    const minutes = duration.minutes;
    const data = loadData();
    const account = currentAccount();
    data.entries.push({
      id: uid('duty-entry'), memberId: member.id, semester: activeSemester, period: selectedPeriod,
      entryType: 'Duty', date, minutes, timeIn, timeOut,
      description: el('dutyRenderedDescription')?.value.trim() || '',
      createdAt: new Date().toISOString(), createdBy: account?.displayName || account?.username || 'Administrator', createdByUsername: account?.username || ''
    });
    persistData(data, { action: 'Recorded clock-based duty time', details: `${member.fullName} • ${activeSemester} • ${selectedPeriod} • ${formatClockTime(timeIn)}–${formatClockTime(timeOut)} • ${durationLabel(minutes)}` });
    if (el('dutyRenderedTimeIn')) el('dutyRenderedTimeIn').value = '';
    if (el('dutyRenderedTimeOut')) el('dutyRenderedTimeOut').value = '';
    if (el('dutyRenderedDescription')) el('dutyRenderedDescription').value = '';
    updateRenderedDurationPreview();
    window.LSOApp?.showToast?.(`Rendered duty added: ${durationLabel(minutes)}.`);
    renderAll();
  }

  function saveIncentive(event) {
    event.preventDefault();
    const member = selectedMember();
    if (!member || !isAdmin()) return;
    const amount = parseTimeInputs('dutyIncentiveHours', 'dutyIncentiveMinutes');
    const date = el('dutyIncentiveDate')?.value;
    const direction = el('dutyIncentiveDirection')?.value === 'Deduction' ? 'Deduction' : 'Credit';
    if (!date || amount === null || amount <= 0) {
      window.LSOApp?.showToast?.('Enter a date and incentive time greater than zero. Minutes must be 0 to 59.', true);
      return;
    }
    const minutes = direction === 'Credit' ? amount : -amount;
    const data = loadData();
    const account = currentAccount();
    data.entries.push({
      id: uid('duty-entry'), memberId: member.id, semester: activeSemester, period: selectedPeriod,
      entryType: 'Incentive', date, minutes,
      description: el('dutyIncentiveDescription')?.value.trim() || '',
      createdAt: new Date().toISOString(), createdBy: account?.displayName || account?.username || 'Administrator', createdByUsername: account?.username || ''
    });
    persistData(data, { action: 'Recorded duty-hour incentive', details: `${member.fullName} • ${activeSemester} • ${selectedPeriod} • ${durationLabel(minutes, true)}` });
    writeTimeInputs('dutyIncentiveHours', 'dutyIncentiveMinutes', 0);
    if (el('dutyIncentiveDescription')) el('dutyIncentiveDescription').value = '';
    window.LSOApp?.showToast?.('Incentive adjustment added.');
    renderAll();
  }

  function deleteEntry(entryId) {
    if (!isAdmin()) return;
    const data = loadData();
    const entry = data.entries.find((item) => item.id === entryId);
    const member = getMembers().find((item) => item.id === entry?.memberId);
    if (!entry || !window.confirm('Delete this duty-hour ledger entry?')) return;
    data.entries = data.entries.filter((item) => item.id !== entryId);
    persistData(data, { action: 'Deleted duty-hour entry', details: `${member?.fullName || 'Member'} • ${entry.semester} • ${entry.period} • ${durationLabel(entry.minutes, entry.entryType === 'Incentive')}` });
    window.LSOApp?.showToast?.('Duty-hour entry deleted.');
    renderAll();
  }

  function setSelected(memberId, period) {
    selectedMemberId = memberId || '';
    selectedPeriod = normalizePeriod(period);
    renderAll();
  }

  function setSemester(semester) {
    activeSemester = normalizeSemester(semester);
    if (el('dutySemesterLabel')) el('dutySemesterLabel').textContent = activeSemester;
    document.querySelectorAll('[data-duty-semester]').forEach((button) => button.classList.toggle('active', button.dataset.dutySemester === activeSemester));
    renderAll();
  }

  function setOverallPeriod(period) {
    overallPeriod = normalizePeriod(period);
    document.querySelectorAll('[data-duty-period]').forEach((button) => button.classList.toggle('active', button.dataset.dutyPeriod === overallPeriod));
    renderOverall();
  }

  function printStyles(orientation = 'landscape') {
    return `@page{size:A4 ${orientation};margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17362d;margin:0}.header{display:flex;justify-content:space-between;gap:25px;border-bottom:4px solid #167055;padding-bottom:12px;margin-bottom:16px}.org{font-size:10px;text-transform:uppercase;letter-spacing:.13em;color:#167055;font-weight:700}h1{font-size:23px;margin:5px 0}.sub{font-size:11px;color:#60766e}.summary{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin:14px 0}.summary>div{border:1px solid #d8e6df;padding:9px;border-radius:7px}.summary span{display:block;font-size:8px;text-transform:uppercase;color:#6b8078}.summary strong{font-size:17px}.period-table{margin:14px 0}table{width:100%;border-collapse:collapse;font-size:9px}th,td{border:1px solid #d8e6df;padding:6px;text-align:left;vertical-align:top}th{background:#eff8f3;text-transform:uppercase;font-size:8px}.positive{color:#126443}.negative{color:#a2333d}.sign{display:grid;grid-template-columns:1fr 1fr;gap:90px;margin-top:40px;text-align:center}.sign div{border-top:1px solid #333;padding-top:6px}.footer{font-size:8px;color:#6c8079;margin-top:14px;text-align:center}`;
  }

  function openPrint(html) {
    const popup = window.open('', '_blank', 'width=1100,height=800');
    if (!popup) {
      window.LSOApp?.showToast?.('Allow pop-ups to generate the printable report.', true);
      return;
    }
    popup.document.write(html);
    popup.document.close();
  }

  function printIndividual() {
    const data = loadData();
    const member = selectedMember();
    if (!member) return;
    const focus = calculatePeriod(data, member.id, activeSemester, selectedPeriod);
    const year = calculateMember(data, member.id);
    const yearRows = [
      ['First Semester', year.first.combined], ['Second Semester', year.second.combined], ['Whole Academic Year', year.academicYear]
    ].map(([label, item]) => `<tr><td><strong>${safeText(label)}</strong></td><td>${safeText(durationLabel(item.committed))}</td><td>${safeText(durationLabel(item.rendered))}</td><td>${safeText(durationLabel(item.incentives, true))}</td><td>${safeText(durationLabel(item.credited))}</td><td>${safeText(balanceText(item.balance, item.committed, item.credited))}</td></tr>`).join('');
    const entries = entriesFor(data, member.id, activeSemester, selectedPeriod).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const ledgerRows = entries.map((entry, index) => `<tr><td>${index + 1}</td><td>${safeText(dateLabel(entry.date))}</td><td>${safeText(entry.entryType === 'Duty' ? clockRangeLabel(entry) : '—')}</td><td>${safeText(entry.entryType === 'Duty' ? 'Rendered Duty' : 'Incentive Adjustment')}</td><td class="${entry.minutes < 0 ? 'negative' : 'positive'}">${safeText(durationLabel(entry.minutes, entry.entryType === 'Incentive'))}</td><td>${safeText(entry.description || '—')}</td><td>${safeText(entry.createdBy || '—')}</td></tr>`).join('');
    const html = `<!doctype html><html><head><title>${safeText(member.fullName)} — Duty Hours</title><style>${printStyles('landscape')}</style></head><body>
      <div class="header"><div><div class="org">Lasallian Symphony Orchestra</div><h1>Individual Duty Hours Report</h1><div class="sub">${safeText(member.fullName)} • ${safeText(activeSemester)} • ${safeText(selectedPeriod)}</div></div><div class="sub">Generated ${safeText(dateLabel(today()))}</div></div>
      <div class="summary">${[
        ['Committed', durationLabel(focus.committed)], ['Rendered', durationLabel(focus.rendered)], ['Net Incentives', durationLabel(focus.incentives, true)], ['Credited', durationLabel(focus.credited)], ['Remaining / Excess', balanceText(focus.balance, focus.committed, focus.credited)], ['Ledger Entries', entries.length]
      ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>
      <table class="period-table"><thead><tr><th>Academic Period</th><th>Committed</th><th>Rendered</th><th>Incentives</th><th>Credited</th><th>Balance</th></tr></thead><tbody>${yearRows}</tbody></table>
      <table><thead><tr><th>#</th><th>Date</th><th>Clock In–Out</th><th>Entry</th><th>Computed Time</th><th>Description / Basis</th><th>Recorded By</th></tr></thead><tbody>${ledgerRows || '<tr><td colspan="7">No entries in the selected semester and period.</td></tr>'}</tbody></table>
      <div class="sign"><div>Member Signature</div><div>Authorized Officer</div></div><div class="footer">Rendered duty is calculated automatically from Time In and Time Out and stored in exact minutes.</div><script>window.onload=()=>window.print()<\/script></body></html>`;
    openPrint(html);
  }

  function printOverall() {
    const data = loadData();
    const members = rosterMembers(data, overallPeriod, false);
    const summaries = members.map((member) => ({ member, summary: calculatePeriod(data, member.id, activeSemester, overallPeriod) }));
    const totals = combineSummaries(summaries.map((item) => item.summary));
    const outstanding = summaries.reduce((sum, item) => sum + Math.max(0, item.summary.balance), 0);
    const rows = summaries.map(({ member, summary }, index) => `<tr><td>${index + 1}</td><td>${safeText(member.fullName)}</td><td>${safeText(member.membershipId || member.studentNumber || '—')}</td><td>${safeText(durationLabel(summary.committed))}</td><td>${safeText(durationLabel(summary.rendered))}</td><td>${safeText(durationLabel(summary.incentives, true))}</td><td>${safeText(durationLabel(summary.credited))}</td><td>${safeText(balanceText(summary.balance, summary.committed, summary.credited))}</td><td>${summary.progress}%</td></tr>`).join('');
    const html = `<!doctype html><html><head><title>${safeText(activeSemester)} Duty Hours</title><style>${printStyles('landscape')}</style></head><body>
      <div class="header"><div><div class="org">Lasallian Symphony Orchestra</div><h1>${safeText(activeSemester)} Duty Hours Report</h1><div class="sub">${safeText(overallPeriod)} roster</div></div><div class="sub">Generated ${safeText(dateLabel(today()))}</div></div>
      <div class="summary">${[
        ['Roster', members.length], ['Committed', durationLabel(totals.committed)], ['Rendered', durationLabel(totals.rendered)], ['Net Incentives', durationLabel(totals.incentives, true)], ['Credited', durationLabel(totals.credited)], ['Outstanding', durationLabel(outstanding)]
      ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>
      <table><thead><tr><th>#</th><th>Member</th><th>ID</th><th>Committed</th><th>Rendered</th><th>Incentives</th><th>Credited</th><th>Remaining / Excess</th><th>Progress</th></tr></thead><tbody>${rows || '<tr><td colspan="9">No duty-hour records.</td></tr>'}</tbody></table>
      <div class="sign"><div>Prepared by</div><div>Authorized Officer</div></div><div class="footer">Rendered duty is calculated automatically from clock-based Time In and Time Out and stored in exact minutes.</div><script>window.onload=()=>window.print()<\/script></body></html>`;
    openPrint(html);
  }

  function getDashboardSummary(semester) {
    const data = loadData();
    const trackedMap = new Map();
    PERIODS.forEach((period) => rosterMembers(data, period, false).forEach((member) => trackedMap.set(`${member.id}:${period}`, { member, period })));
    const rows = [...trackedMap.values()].map(({ member, period }) => calculatePeriod(data, member.id, normalizeSemester(semester), period));
    const totals = combineSummaries(rows);
    const remaining = rows.reduce((sum, item) => sum + Math.max(0, item.balance), 0);
    const completed = rows.filter((item) => item.committed > 0 && item.balance <= 0).length;
    const progress = totals.committed > 0 ? Math.max(0, Math.min(100, Math.round(totals.credited / totals.committed * 100))) : 0;
    return { semester: normalizeSemester(semester), tracked: rows.length, completed, remaining, remainingLabel: remaining ? `${durationLabel(remaining)} left` : rows.length ? 'All complete' : 'No records', progress };
  }

  function renderAll() {
    if (el('dutySemesterLabel')) el('dutySemesterLabel').textContent = activeSemester;
    document.querySelectorAll('[data-duty-semester]').forEach((button) => button.classList.toggle('active', button.dataset.dutySemester === activeSemester));
    document.querySelectorAll('[data-duty-period]').forEach((button) => button.classList.toggle('active', button.dataset.dutyPeriod === overallPeriod));
    renderRosters();
    renderSelectedMember();
    renderOverall();
  }

  function wireEvents() {
    el('dutySemesterToggle')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-duty-semester]');
      if (button) setSemester(button.dataset.dutySemester);
    });
    el('dutyOverallPeriodToggle')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-duty-period]');
      if (button) setOverallPeriod(button.dataset.dutyPeriod);
    });
    el('dutyMemberSearch')?.addEventListener('input', (event) => { searchTerm = event.target.value; renderRosters(); });
    ['dutyTraineeRoster', 'dutyProbationaryRoster'].forEach((id) => el(id)?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-duty-member]');
      if (button) setSelected(button.dataset.dutyMember, button.dataset.dutyRosterPeriod);
    }));
    el('dutyCommitmentForm')?.addEventListener('submit', saveCommitment);
    el('dutyRenderedForm')?.addEventListener('submit', saveRendered);
    ['dutyRenderedTimeIn', 'dutyRenderedTimeOut'].forEach((id) => {
      el(id)?.addEventListener('input', updateRenderedDurationPreview);
      el(id)?.addEventListener('change', updateRenderedDurationPreview);
      el(id)?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        el('dutyRenderedForm')?.requestSubmit();
      });
    });
    el('dutyIncentiveForm')?.addEventListener('submit', saveIncentive);
    el('dutyLedgerTableBody')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-duty-delete]');
      if (button) deleteEntry(button.dataset.dutyDelete);
    });
    el('printDutyHoursIndividual')?.addEventListener('click', printIndividual);
    el('printDutyHoursOverall')?.addEventListener('click', printOverall);
    ['lso:members-changed', 'lso:duty-hours-changed', 'lso:cloud-state-changed', 'lso:auth-changed'].forEach((name) => {
      window.addEventListener(name, () => setTimeout(renderAll, 25));
    });
  }

  function initialize() {
    if (!el('dutyHoursView')) return;
    ensureDataMigration();
    if (el('dutyRenderedDate')) el('dutyRenderedDate').value = today();
    if (el('dutyIncentiveDate')) el('dutyIncentiveDate').value = today();
    wireEvents();
    updateRenderedDurationPreview();
    renderAll();
  }

  window.LSODutyHours = {
    getData: loadData,
    calculateMember: (memberId) => calculateMember(loadData(), memberId),
    calculateClockDuration,
    formatClockTime,
    getDashboardSummary,
    setSemester,
    refresh: renderAll
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
