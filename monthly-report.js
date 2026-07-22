(() => {
  'use strict';

  const STORAGE_KEY = 'lso_monthly_reports_v1';
  const ACTIVITY_KEY = 'lso_activity_log_v2';
  const TRAINER_COUNT = 1;
  const CIVIL_OPTIONS = ['', 'Single', 'Married', 'Widowed', 'Separated', 'Other'];
  const el = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  let state = loadState();
  let activeReportKey = currentMonthKey();
  let activeTab = 'setup';
  let previewUrl = '';
  let saveTimer = null;
  let lastLocalSaveAt = 0;
  let pendingRemoteRefresh = false;
  let deferredRefreshTimer = null;

  function uid(prefix = 'row') {
    return window.crypto?.randomUUID ? window.crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function currentMonthKey() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 7);
  }

  function today() {
    if (window.LSOApp?.getToday) return window.LSOApp.getToday();
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function dateLabel(value, options = {}) {
    if (!value) return '—';
    const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-PH', options.short
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  }

  function monthLabel(value) {
    if (!/^\d{4}-\d{2}$/.test(String(value || ''))) return 'Selected Month';
    const [year, month] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
  }

  function normalizeState(raw) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      version: 1,
      reports: value.reports && typeof value.reports === 'object' && !Array.isArray(value.reports) ? value.reports : {},
      civilStatusByMember: value.civilStatusByMember && typeof value.civilStatusByMember === 'object' && !Array.isArray(value.civilStatusByMember) ? value.civilStatusByMember : {},
      traineeFiles: value.traineeFiles && typeof value.traineeFiles === 'object' && !Array.isArray(value.traineeFiles) ? value.traineeFiles : {}
    };
  }

  function loadState() {
    try {
      return normalizeState(JSON.parse(window.LSOStorage?.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return normalizeState({});
    }
  }

  function blankReport(key) {
    const now = new Date();
    const currentYear = now.getFullYear();
    return {
      key,
      month: key,
      asOfDate: today(),
      semester: now.getMonth() >= 6 ? 'First Semester' : 'Second Semester',
      academicYear: now.getMonth() >= 6 ? `${currentYear}-${currentYear + 1}` : `${currentYear - 1}-${currentYear}`,
      preparedBy: '',
      preparedTitle: 'EVP for Membership',
      notedBy: '',
      notedTitle: 'President',
      loaRows: [],
      ojtRows: [],
      quittedRows: [],
      remainingMode: 'automatic',
      manualRemainingRows: [],
      updatedAt: new Date().toISOString()
    };
  }

  function currentReport() {
    if (!state.reports[activeReportKey]) state.reports[activeReportKey] = blankReport(activeReportKey);
    const report = state.reports[activeReportKey];
    report.loaRows = Array.isArray(report.loaRows) ? report.loaRows : [];
    report.ojtRows = Array.isArray(report.ojtRows) ? report.ojtRows : [];
    report.quittedRows = Array.isArray(report.quittedRows) ? report.quittedRows : [];
    report.manualRemainingRows = Array.isArray(report.manualRemainingRows) ? report.manualRemainingRows : [];
    return report;
  }

  function canModify() {
    if (window.LSOPermissions?.canModify) return window.LSOPermissions.canModify();
    return window.LSORoleAccess?.can?.('editMonthlyReport') ?? (window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount)?.role === 'Administrator';
  }

  function status(message, stateName = '') {
    const target = el('monthlyReportStatus');
    if (!target) return;
    target.textContent = message;
    target.dataset.state = stateName;
  }

  function toast(message, error = false) {
    if (window.LSOApp?.showToast) window.LSOApp.showToast(message, error);
    else if (error) window.alert(message);
  }

  function saveState({ quiet = false } = {}) {
    if (!canModify()) {
      if (!quiet) toast('Only an Administrator can modify the Overall Monthly Report.', true);
      return false;
    }
    currentReport().updatedAt = new Date().toISOString();
    lastLocalSaveAt = Date.now();
    const saved = window.LSOStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (saved === false) {
      if (!quiet) status('The draft could not be saved. Check your access and connection.', 'error');
      return false;
    }
    window.dispatchEvent(new CustomEvent('lso:monthly-report-changed', { detail: { key: activeReportKey, source: 'local-editor' } }));
    if (!quiet) status('Draft saved. You can continue typing.', 'saved');
    return true;
  }

  function queueSave() {
    if (!canModify()) return;
    clearTimeout(saveTimer);
    status('Autosaving draft…', 'working');
    saveTimer = setTimeout(() => saveState({ quiet: false }), 500);
  }

  function monthlyEditorFocused() {
    const active = document.activeElement;
    return Boolean(active && active.closest?.('#monthlyReportView') && active.matches?.('input, textarea, select'));
  }

  function applyDeferredSharedRefresh() {
    clearTimeout(deferredRefreshTimer);
    deferredRefreshTimer = setTimeout(() => {
      if (monthlyEditorFocused()) return;
      if (!pendingRemoteRefresh) return;
      pendingRemoteRefresh = false;
      state = loadState();
      renderAll();
      status('Shared draft refreshed.', 'saved');
    }, 120);
  }

  function logActivity(action, details = '') {
    try {
      const current = JSON.parse(window.LSOStorage.getItem(ACTIVITY_KEY) || '[]');
      const list = Array.isArray(current) ? current : [];
      const account = window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || {};
      list.unshift({
        id: uid('activity'),
        timestamp: new Date().toISOString(),
        action,
        category: 'Monthly Report',
        details,
        account: account.displayName || account.username || 'Administrator',
        username: account.username || ''
      });
      window.LSOStorage.setItem(ACTIVITY_KEY, JSON.stringify(list.slice(0, 500)));
    } catch {
      // Report generation remains available if the audit log cannot be updated.
    }
  }

  function members() {
    if (window.LSOApp?.getMembers) return window.LSOApp.getMembers();
    try {
      const parsed = JSON.parse(window.LSOStorage.getItem('lso_member_database_v1') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function activeForReport(member) {
    return normalize(member.memberStatus) !== 'nonactive';
  }

  function memberGroup(member) {
    const period = normalize(member.periodGroup);
    const stage = normalize(member.membershipStage);
    if (period.includes('probationary') || stage === 'probationary') return 'Probationary';
    if (period.includes('trainee') || stage === 'trainee') return 'Trainee';
    if (period.includes('membership') || stage.includes('regular')) return 'Official';
    if (member.regularMemberDate) return 'Official';
    if (member.probationaryStartDate) return 'Probationary';
    return 'Trainee';
  }

  function isOfficer(member) {
    const value = normalize(`${member.organizationPosition || ''} ${member.organizationRole || ''}`);
    return value.includes('executive board') || value.includes('officer') || value.includes('president') || value.includes('secretary') || value.includes('treasurer');
  }

  function rankFor(member) {
    const group = memberGroup(member);
    if (group === 'Trainee') return 'TRAINEE';
    if (group === 'Probationary') return 'PROBATIONARY MEMBER';
    return isOfficer(member) ? 'OFFICER' : 'MEMBER';
  }

  function reportRoster() {
    const priority = { Official: 0, Trainee: 1, Probationary: 2 };
    return members()
      .filter(activeForReport)
      .filter((member) => ['Official', 'Trainee', 'Probationary'].includes(memberGroup(member)))
      .sort((a, b) => {
        const group = priority[memberGroup(a)] - priority[memberGroup(b)];
        if (group) return group;
        if (memberGroup(a) === 'Official') {
          const rank = Number(isOfficer(b)) - Number(isOfficer(a));
          if (rank) return rank;
        }
        return String(a.fullName || '').localeCompare(String(b.fullName || ''));
      });
  }

  function comparativeCounts() {
    const roster = reportRoster();
    const official = roster.filter((member) => memberGroup(member) === 'Official');
    const currentTrainees = roster.filter((member) => memberGroup(member) === 'Trainee').length;
    const currentProbationary = roster.filter((member) => memberGroup(member) === 'Probationary').length;
    const result = {
      officer: official.filter(isOfficer).length,
      member: official.filter((member) => !isOfficer(member)).length,
      trainer: TRAINER_COUNT,
      trainee: currentTrainees + currentProbationary,
      currentTrainees,
      currentProbationary
    };
    result.total = result.officer + result.member + result.trainer + result.trainee;
    return result;
  }

  function semesterKey(report = currentReport()) {
    return `${report.semester || 'Semester'}|${report.academicYear || 'Academic Year'}`;
  }

  function traineeFile(report = currentReport()) {
    const key = semesterKey(report);
    if (!state.traineeFiles[key]) state.traineeFiles[key] = { key, createdAt: '', updatedAt: '', rows: [] };
    const file = state.traineeFiles[key];
    file.rows = Array.isArray(file.rows) ? file.rows : [];
    return file;
  }

  function snapshotRowFromMember(member) {
    return {
      id: uid('trainee-file'),
      memberId: member.id || '',
      name: member.fullName || '',
      course: member.course || member.college || '',
      year: member.yearLevel || '',
      date: member.traineeStartDate || member.dateRegistered || today(),
      capturedAt: new Date().toISOString()
    };
  }

  function captureCurrentTrainees() {
    if (!canModify()) return toast('Administrator or Membership access is required to update the permanent Trainee file.', true);
    const file = traineeFile();
    const current = reportRoster().filter((member) => memberGroup(member) === 'Trainee');
    const existingKeys = new Set(file.rows.map((row) => row.memberId || normalize(row.name)));
    let added = 0;
    current.forEach((member) => {
      const key = member.id || normalize(member.fullName);
      if (existingKeys.has(key)) return;
      file.rows.push(snapshotRowFromMember(member));
      existingKeys.add(key);
      added += 1;
    });
    if (!file.createdAt) file.createdAt = new Date().toISOString();
    file.updatedAt = new Date().toISOString();
    saveState({ quiet: true });
    renderAll();
    logActivity('Updated permanent Trainee file', `${semesterKey()} • ${added} new record${added === 1 ? '' : 's'}`);
    toast(added ? `${added} current Trainee record${added === 1 ? '' : 's'} added to the permanent semester file.` : 'The permanent Trainee file is already current.');
  }

  function genderKey(member) {
    const sex = normalize(member.sex || member.gender);
    if (sex.startsWith('m')) return 'Male';
    if (sex.startsWith('f')) return 'Female';
    return 'Unspecified';
  }

  function yearKey(member) {
    const value = normalize(member.yearLevel).replace(/[^0-9]/g, '');
    if (value.startsWith('1')) return 'First Year';
    if (value.startsWith('2')) return 'Second Year';
    if (value.startsWith('3')) return 'Third Year';
    if (value.startsWith('4')) return 'Fourth Year';
    if (value.startsWith('5')) return 'Fifth Year';
    return 'Unspecified';
  }

  function civilStatus(member) {
    return state.civilStatusByMember[member.id] || member.civilStatus || '';
  }

  function memberById(id) {
    return members().find((member) => String(member.id) === String(id)) || null;
  }

  function selectedMemberOptions(selected = '') {
    return ['<option value="">Select member</option>', ...reportRoster().map((member) => `<option value="${safeText(member.id)}" ${String(member.id) === String(selected) ? 'selected' : ''}>${safeText(member.fullName)} — ${safeText(memberGroup(member))}</option>`)].join('');
  }

  function reportField(id, key) {
    const input = el(id);
    if (!input) return;
    input.value = currentReport()[key] || '';
  }

  function renderReportFields() {
    reportField('monthlyReportMonth', 'month');
    reportField('monthlyReportDate', 'asOfDate');
    reportField('monthlyReportSemester', 'semester');
    reportField('monthlyReportAcademicYear', 'academicYear');
    reportField('monthlyReportPreparedBy', 'preparedBy');
    reportField('monthlyReportPreparedTitle', 'preparedTitle');
    reportField('monthlyReportNotedBy', 'notedBy');
    reportField('monthlyReportNotedTitle', 'notedTitle');
  }

  function percent(count, total) {
    return total ? `${((Number(count) / total) * 100).toFixed(2)}%` : '0.00%';
  }

  function renderSummary() {
    const counts = comparativeCounts();
    const target = el('monthlyReportSummaryGrid');
    if (target) {
      const cards = [
        ['Officers', counts.officer, 'Official Executive Board'],
        ['Members', counts.member, 'Official non-officers'],
        ['Trainer', counts.trainer, 'Fixed count: 1'],
        ['Trainee Classification', counts.trainee, `${counts.currentTrainees} Trainee + ${counts.currentProbationary} Probationary`],
        ['Total Complement', counts.total, 'Includes one Trainer', true]
      ];
      target.innerHTML = cards.map(([label, value, note, highlight]) => `<article class="monthly-summary-card${highlight ? ' highlight' : ''}"><span>${safeText(label)}</span><strong>${safeText(value)}</strong><small>${safeText(note)}</small></article>`).join('');
    }

    const body = el('monthlyComparativeBody');
    if (body) {
      const rows = [
        ['OFFICER', counts.officer],
        ['MEMBER/S', counts.member],
        ['TRAINER', counts.trainer],
        ['TRAINEE', counts.trainee]
      ];
      body.innerHTML = `${rows.map(([label, value]) => `<tr class="${label === 'TRAINER' ? 'monthly-fixed-trainer-row' : ''}"><td><strong>${label}</strong>${label === 'TRAINER' ? '<small class="monthly-fixed-note">Fixed at 1</small>' : ''}</td><td>${value}</td><td>${percent(value, counts.total)}</td></tr>`).join('')}<tr><td><strong>TOTAL</strong></td><td><strong>${counts.total}</strong></td><td><strong>100.00%</strong></td></tr>`;
    }

    const roster = reportRoster();
    const gender = { Male: 0, Female: 0, Unspecified: 0 };
    const years = { 'First Year': 0, 'Second Year': 0, 'Third Year': 0, 'Fourth Year': 0, 'Fifth Year': 0, Unspecified: 0 };
    roster.forEach((member) => { gender[genderKey(member)] += 1; years[yearKey(member)] += 1; });
    const genderBody = el('monthlyGenderSummaryBody');
    if (genderBody) genderBody.innerHTML = Object.entries(gender).map(([label, value]) => `<tr><td>${safeText(label.toUpperCase())}</td><td>${value}</td></tr>`).join('') + `<tr><td><strong>TOTAL</strong></td><td><strong>${roster.length}</strong></td></tr>`;
    const yearBody = el('monthlyYearSummaryBody');
    if (yearBody) yearBody.innerHTML = Object.entries(years).map(([label, value]) => `<tr><td>${safeText(label.toUpperCase())}</td><td>${value}</td></tr>`).join('') + `<tr><td><strong>TOTAL</strong></td><td><strong>${roster.length}</strong></td></tr>`;
  }

  function rankClass(rank) {
    if (rank === 'OFFICER') return 'monthly-rank-officer';
    if (rank === 'TRAINEE') return 'monthly-rank-trainee';
    if (rank === 'PROBATIONARY MEMBER') return 'monthly-rank-probationary';
    return 'monthly-rank-member';
  }

  function renderManpowerRoster() {
    const body = el('monthlyManpowerBody');
    const count = el('monthlyManpowerCount');
    if (!body) return;
    const query = normalize(el('monthlyManpowerSearch')?.value);
    const all = reportRoster();
    if (count) count.textContent = all.length;
    const filtered = all.filter((member) => !query || normalize([member.fullName, member.membershipId, member.studentNumber, member.course, member.yearLevel, memberGroup(member)].join(' ')).includes(query));
    let lastGroup = '';
    let visibleNumber = 0;
    const rows = [];
    all.forEach((member, index) => { member.__monthlyNumber = index + 1; });
    filtered.forEach((member) => {
      const group = memberGroup(member);
      if (group !== lastGroup) {
        rows.push(`<tr class="monthly-record-group-row"><td colspan="7">${safeText(group === 'Official' ? 'Official Members' : `${group} Members`)}</td></tr>`);
        lastGroup = group;
      }
      visibleNumber += 1;
      const rank = rankFor(member);
      const civil = civilStatus(member);
      rows.push(`<tr>
        <td>${member.__monthlyNumber}</td>
        <td><strong>${safeText(member.fullName || 'Unnamed')}</strong><small>${safeText(member.membershipId || member.studentNumber || '')}</small></td>
        <td><span class="monthly-rank-badge ${rankClass(rank)}">${safeText(rank)}</span></td>
        <td>${safeText(member.yearLevel || '—')}</td>
        <td>${safeText(member.course || member.college || '—')}</td>
        <td><select data-monthly-edit data-monthly-civil-member="${safeText(member.id)}" aria-label="Civil status for ${safeText(member.fullName)}">${CIVIL_OPTIONS.map((option) => `<option value="${safeText(option)}" ${option === civil ? 'selected' : ''}>${safeText(option || 'Select')}</option>`).join('')}</select></td>
        <td>${safeText((member.sex || member.gender || '—').toString().slice(0, 1).toUpperCase())}</td>
      </tr>`);
    });
    body.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="7" class="monthly-empty-row">No matching member records.</td></tr>';
  }

  function loaRows() {
    return currentReport().loaRows;
  }

  function ojtRows() {
    return currentReport().ojtRows;
  }

  function syncLoaRows() {
    if (!canModify()) return toast('Administrator or Membership access is required to sync Leave records.', true);
    const existing = new Set(loaRows().map((row) => row.memberId).filter(Boolean));
    let added = 0;
    members().filter((member) => normalize(member.memberStatus) === 'loa').forEach((member) => {
      if (existing.has(member.id)) return;
      loaRows().push({ id: uid('loa'), memberId: member.id, name: member.fullName || '', course: member.course || '', year: member.yearLevel || '', purpose: '', until: '' });
      existing.add(member.id);
      added += 1;
    });
    saveState({ quiet: true });
    renderLoa();
    toast(added ? `${added} Leave record${added === 1 ? '' : 's'} added from member profiles.` : 'Leave table is already synchronized with member records.');
  }

  function renderLoa() {
    const body = el('monthlyLoaBody');
    const count = el('monthlyLoaCount');
    if (!body) return;
    if (count) count.textContent = loaRows().length;
    body.innerHTML = loaRows().length ? loaRows().map((row) => {
      const member = memberById(row.memberId);
      return `<tr data-monthly-loa-row="${safeText(row.id)}">
        <td><select data-monthly-edit data-monthly-loa-field="memberId">${selectedMemberOptions(row.memberId)}</select></td>
        <td>${safeText(member?.course || row.course || '—')}</td>
        <td>${safeText(member?.yearLevel || row.year || '—')}</td>
        <td><textarea data-monthly-edit data-monthly-loa-field="purpose" placeholder="Purpose of filing LOA">${safeText(row.purpose || '')}</textarea></td>
        <td><input data-monthly-edit data-monthly-loa-field="until" value="${safeText(row.until || '')}" placeholder="e.g., Second Semester"/></td>
        <td><button class="monthly-row-delete" data-monthly-write data-monthly-delete-loa="${safeText(row.id)}" type="button" aria-label="Delete Leave row">×</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="monthly-empty-row">No Members on Leave recorded for this report.</td></tr>';
  }

  function renderOjt() {
    const body = el('monthlyOjtBody');
    const count = el('monthlyOjtCount');
    if (!body) return;
    if (count) count.textContent = ojtRows().length;
    body.innerHTML = ojtRows().length ? ojtRows().map((row) => {
      const member = memberById(row.memberId);
      return `<tr data-monthly-ojt-row="${safeText(row.id)}">
        <td><select data-monthly-edit data-monthly-ojt-field="memberId">${selectedMemberOptions(row.memberId)}</select></td>
        <td>${safeText(member?.course || row.course || '—')}</td>
        <td>${safeText(member?.yearLevel || row.year || '—')}</td>
        <td><input data-monthly-edit data-monthly-ojt-field="until" value="${safeText(row.until || '')}" placeholder="OJT until"/></td>
        <td><button class="monthly-row-delete" data-monthly-write data-monthly-delete-ojt="${safeText(row.id)}" type="button" aria-label="Delete OJT row">×</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="monthly-empty-row">No OJT records entered.</td></tr>';
  }

  function renderTraineeFile() {
    const file = traineeFile();
    const body = el('monthlyTraineeFileBody');
    const count = el('monthlyTraineeFileCount');
    const statusNode = el('monthlyTraineeFileStatus');
    if (count) count.textContent = file.rows.length;
    if (statusNode) {
      statusNode.innerHTML = file.rows.length
        ? `<strong>Permanent file: ${safeText(semesterKey())}</strong><small>${safeText(file.rows.length)} original Trainee record${file.rows.length === 1 ? '' : 's'} retained. Updating adds new names without removing previous entries.</small>`
        : `<strong>No permanent Trainee file captured</strong><small>Use “Update Permanent Trainee File” to capture the current Trainee roster for ${safeText(semesterKey())}.</small>`;
    }
    if (!body) return;
    body.innerHTML = file.rows.length ? file.rows.map((row) => `<tr><td>${safeText(row.name)}</td><td>${safeText(row.course || '—')}</td><td>${safeText(row.year || '—')}</td><td>${safeText(dateLabel(row.date, { short: true }))}</td></tr>`).join('') : '<tr><td colspan="4" class="monthly-empty-row">No permanent Trainee records captured for this semester.</td></tr>';
  }

  function quittedRows() {
    return currentReport().quittedRows;
  }

  function renderQuitted() {
    const body = el('monthlyQuittedBody');
    const count = el('monthlyQuittedCount');
    if (!body) return;
    if (count) count.textContent = quittedRows().length;
    const snapshotNames = traineeFile().rows.map((row) => row.name).filter(Boolean);
    body.innerHTML = quittedRows().length ? quittedRows().map((row) => `<tr data-monthly-quitted-row="${safeText(row.id)}">
      <td><input data-monthly-edit data-monthly-quitted-field="name" list="monthlyTraineeNames" value="${safeText(row.name || '')}" placeholder="Trainee name"/></td>
      <td><textarea data-monthly-edit data-monthly-quitted-field="reason" placeholder="Reason/s">${safeText(row.reason || '')}</textarea></td>
      <td><textarea data-monthly-edit data-monthly-quitted-field="remarks" placeholder="Remarks">${safeText(row.remarks || '')}</textarea></td>
      <td><button class="monthly-row-delete" data-monthly-write data-monthly-delete-quitted="${safeText(row.id)}" type="button" aria-label="Delete Quitted/Removed row">×</button></td>
    </tr>`).join('') : '<tr><td colspan="4" class="monthly-empty-row">No Quitted or Removed Trainees entered.</td></tr>';
    const datalist = el('monthlyTraineeNames');
    if (datalist) datalist.innerHTML = snapshotNames.map((name) => `<option value="${safeText(name)}"></option>`).join('');
  }

  function automaticRemainingRows() {
    const removed = new Set(quittedRows().map((row) => normalize(row.name)).filter(Boolean));
    return traineeFile().rows.filter((row) => !removed.has(normalize(row.name))).map((row) => ({ id: row.id, name: row.name, course: row.course }));
  }

  function effectiveRemainingRows() {
    return currentReport().remainingMode === 'manual' ? currentReport().manualRemainingRows : automaticRemainingRows();
  }

  function renderRemaining() {
    const report = currentReport();
    const mode = el('monthlyRemainingMode');
    if (mode) mode.value = report.remainingMode || 'automatic';
    const rows = effectiveRemainingRows();
    const count = el('monthlyRemainingCount');
    if (count) count.textContent = rows.length;
    const add = el('monthlyAddRemaining');
    add?.classList.toggle('hidden', report.remainingMode !== 'manual');
    const body = el('monthlyRemainingBody');
    if (!body) return;
    body.innerHTML = rows.length ? rows.map((row) => report.remainingMode === 'manual'
      ? `<tr data-monthly-remaining-row="${safeText(row.id)}"><td><input data-monthly-edit data-monthly-remaining-field="name" value="${safeText(row.name || '')}" placeholder="Name"/></td><td><input data-monthly-edit data-monthly-remaining-field="course" value="${safeText(row.course || '')}" placeholder="Course"/></td><td><button class="monthly-row-delete" data-monthly-write data-monthly-delete-remaining="${safeText(row.id)}" type="button" aria-label="Delete Remaining Trainee row">×</button></td></tr>`
      : `<tr><td>${safeText(row.name)}</td><td>${safeText(row.course || '—')}</td><td><span class="badge badge-green">Automatic</span></td></tr>`).join('')
      : '<tr><td colspan="3" class="monthly-empty-row">No Remaining Trainee records.</td></tr>';
  }

  function renderTabs() {
    qsa('[data-monthly-tab]').forEach((button) => button.classList.toggle('active', button.dataset.monthlyTab === activeTab));
    qsa('[data-monthly-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.monthlyPanel === activeTab));
  }

  function renderAll() {
    renderReportFields();
    renderSummary();
    renderManpowerRoster();
    renderLoa();
    renderOjt();
    renderTraineeFile();
    renderQuitted();
    renderRemaining();
    renderTabs();
    window.LSOPermissions?.apply?.();
  }

  function updateReportFromFields() {
    const report = currentReport();
    const mapping = {
      monthlyReportDate: 'asOfDate',
      monthlyReportSemester: 'semester',
      monthlyReportAcademicYear: 'academicYear',
      monthlyReportPreparedBy: 'preparedBy',
      monthlyReportPreparedTitle: 'preparedTitle',
      monthlyReportNotedBy: 'notedBy',
      monthlyReportNotedTitle: 'notedTitle'
    };
    Object.entries(mapping).forEach(([id, key]) => { if (el(id)) report[key] = el(id).value.trim(); });
  }

  function handleMonthChange(value) {
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    activeReportKey = value;
    const report = currentReport();
    report.month = value;
    clearPreview();
    renderAll();
    status(`Viewing ${monthLabel(value)} report draft.`, '');
  }

  function addRow(type) {
    if (!canModify()) return toast('Administrator or Membership access is required to add report rows.', true);
    const report = currentReport();
    if (type === 'loa') report.loaRows.push({ id: uid('loa'), memberId: '', purpose: '', until: '' });
    if (type === 'ojt') report.ojtRows.push({ id: uid('ojt'), memberId: '', until: '' });
    if (type === 'quitted') report.quittedRows.push({ id: uid('quitted'), name: '', reason: '', remarks: '' });
    if (type === 'remaining') report.manualRemainingRows.push({ id: uid('remaining'), name: '', course: '' });
    saveState({ quiet: true });
    renderAll();
  }

  function removeRow(type, id) {
    if (!canModify()) return toast('Administrator or Membership access is required to delete report rows.', true);
    const report = currentReport();
    const key = ({ loa: 'loaRows', ojt: 'ojtRows', quitted: 'quittedRows', remaining: 'manualRemainingRows' })[type];
    report[key] = report[key].filter((row) => row.id !== id);
    saveState({ quiet: true });
    renderAll();
  }

  function updateDynamicRow(target) {
    const report = currentReport();
    const containers = [
      ['monthlyLoaRow', 'loaRows', 'monthlyLoaField'],
      ['monthlyOjtRow', 'ojtRows', 'monthlyOjtField'],
      ['monthlyQuittedRow', 'quittedRows', 'monthlyQuittedField'],
      ['monthlyRemainingRow', 'manualRemainingRows', 'monthlyRemainingField']
    ];
    for (const [rowDataset, collection, fieldDataset] of containers) {
      const rowElement = target.closest(`[data-${rowDataset.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}]`);
      const field = target.dataset[fieldDataset];
      if (!rowElement || !field) continue;
      const rowId = rowElement.dataset[rowDataset];
      const row = report[collection].find((item) => item.id === rowId);
      if (!row) return false;
      row[field] = target.value;
      if (field === 'memberId') {
        const member = memberById(target.value);
        row.name = member?.fullName || '';
        row.course = member?.course || '';
        row.year = member?.yearLevel || '';
      }
      queueSave();
      if (field === 'memberId') renderAll();
      return true;
    }
    return false;
  }

  function fillBlankCivilAsSingle() {
    if (!canModify()) return toast('Administrator or Membership access is required to update Civil Status.', true);
    let updated = 0;
    reportRoster().forEach((member) => {
      if (civilStatus(member)) return;
      state.civilStatusByMember[member.id] = 'Single';
      updated += 1;
    });
    saveState({ quiet: true });
    renderManpowerRoster();
    toast(`${updated} blank Civil Status field${updated === 1 ? '' : 's'} set to Single.`);
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    el('monthlyReportPreviewFrame')?.classList.add('hidden');
    el('monthlyReportPreviewPlaceholder')?.classList.remove('hidden');
  }

  function base64Bytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function validateReport() {
    updateReportFromFields();
    const report = currentReport();
    const missing = [];
    if (!report.month) missing.push('Report Month');
    if (!report.asOfDate) missing.push('As-of Date');
    if (!report.semester) missing.push('Semester');
    if (!report.academicYear) missing.push('Academic Year');
    if (!report.preparedBy) missing.push('Prepared By');
    if (!report.notedBy) missing.push('Noted By');
    if (missing.length) throw new Error(`Complete these required fields first: ${missing.join(', ')}.`);
  }

  async function buildPdfBytes() {
    validateReport();
    if (!window.PDFLib?.PDFDocument) throw new Error('The PDF library did not load. Refresh the website and try again.');
    if (!window.LSO_MONTHLY_REPORT_TEMPLATE_BASE64) throw new Error('The official LSO report template is missing. Upload monthly-report-template-data.js to GitHub.');

    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const output = await PDFDocument.create();
    const template = await PDFDocument.load(base64Bytes(window.LSO_MONTHLY_REPORT_TEMPLATE_BASE64));
    const times = await output.embedFont(StandardFonts.TimesRoman);
    const timesBold = await output.embedFont(StandardFonts.TimesRomanBold);
    const timesItalic = await output.embedFont(StandardFonts.TimesRomanItalic);
    const helvetica = await output.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await output.embedFont(StandardFonts.HelveticaBold);

    const colors = {
      ink: rgb(0, 0, 0),
      green: rgb(0.02, 0.38, 0.20),
      officer: rgb(0.57, 0.78, 0.28),
      highlightGreen: rgb(0.57, 0.78, 0.28),
      yellow: rgb(1, 1, 0),
      gray: rgb(0.84, 0.84, 0.84),
      white: rgb(1, 1, 1),
      line: rgb(0, 0, 0)
    };
    const PAGE_WIDTH = 612;
    const bounds = { left: 60, right: 552, top: 632, bottom: 82 };
    const report = currentReport();
    const roster = reportRoster();
    const counts = comparativeCounts();

    async function templatePage() {
      const [page] = await output.copyPages(template, [0]);
      output.addPage(page);
      return page;
    }

    function textWidth(font, value, size) {
      return font.widthOfTextAtSize(String(value ?? ''), size);
    }

    function splitLongWord(font, word, size, maxWidth) {
      const pieces = [];
      let current = '';
      [...String(word)].forEach((character) => {
        const candidate = current + character;
        if (current && textWidth(font, candidate, size) > maxWidth) {
          pieces.push(current);
          current = character;
        } else current = candidate;
      });
      if (current) pieces.push(current);
      return pieces;
    }

    function wrap(font, value, size, maxWidth) {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return [''];
      const tokens = text.split(' ').flatMap((word) => textWidth(font, word, size) > maxWidth
        ? splitLongWord(font, word, size, maxWidth)
        : [word]);
      const lines = [];
      let line = '';
      tokens.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word;
        if (line && textWidth(font, candidate, size) > maxWidth) {
          lines.push(line);
          line = word;
        } else line = candidate;
      });
      if (line) lines.push(line);
      return lines;
    }

    function drawCentered(page, text, y, size, font = timesBold, color = colors.ink) {
      const value = String(text ?? '');
      page.drawText(value, {
        x: Math.max(bounds.left, (PAGE_WIDTH - textWidth(font, value, size)) / 2),
        y, size, font, color
      });
    }

    function drawRight(page, text, xRight, y, size, font = times, color = colors.ink) {
      const value = String(text ?? '');
      page.drawText(value, { x: xRight - textWidth(font, value, size), y, size, font, color });
    }

    function organizationTitle(value, fallback) {
      const title = String(value || fallback || '').trim();
      if (!title) return 'Lasallian Symphony Orchestra';
      return /lasallian symphony orchestra/i.test(title) ? title : `${title}, Lasallian Symphony Orchestra`;
    }

    function drawSignatoryBlock(page, x, y, width, label, name, title) {
      page.drawText(label, { x, y, size: 9.5, font: timesBold, color: colors.ink });
      page.drawLine({ start: { x, y: y - 36 }, end: { x: x + width, y: y - 36 }, thickness: 0.7, color: colors.ink });
      const displayName = String(name || ' ').trim() || ' ';
      page.drawText(displayName, { x, y: y - 51, size: 9, font: times, color: colors.ink });
      const displayTitle = organizationTitle(title, label === 'Prepared By:' ? 'EVP for Membership' : 'President');
      const titleLines = wrap(timesItalic, displayTitle, 8.5, width + 30);
      titleLines.slice(0, 2).forEach((line, index) => page.drawText(line, {
        x, y: y - 72 - index * 11, size: 8.5, font: timesItalic, color: colors.ink
      }));
    }

    function drawCenteredPrepared(page, y) {
      drawCentered(page, 'Prepared By:', y, 9, times);
      page.drawLine({ start: { x: 206, y: y - 40 }, end: { x: 406, y: y - 40 }, thickness: 0.7, color: colors.ink });
      drawCentered(page, report.preparedBy || ' ', y - 55, 9, times);
      drawCentered(page, report.preparedTitle || 'EVP for Membership', y - 72, 8.5, timesBold);
      drawCentered(page, 'Lasallian Symphony Orchestra', y - 87, 8.5, timesBold);
    }

    function rowHeight(columns, row, size = 7.5, padding = 4, minHeight = 20) {
      let maxLines = 1;
      row.forEach((value, index) => {
        const column = columns[index];
        const font = column.font || helvetica;
        const lines = wrap(font, value, size, Math.max(8, column.width - padding * 2));
        maxLines = Math.max(maxLines, lines.length);
      });
      return Math.max(minHeight, maxLines * (size + 2.2) + padding * 2);
    }

    function drawTableHeader(page, columns, x, y, options = {}) {
      const height = options.height || 23;
      const size = options.size || 7.5;
      const fills = options.fills || [];
      let cursor = x;
      columns.forEach((column, index) => {
        page.drawRectangle({
          x: cursor, y: y - height, width: column.width, height,
          color: fills[index] || colors.yellow,
          borderColor: colors.line, borderWidth: 0.65
        });
        const labelLines = wrap(helveticaBold, column.label, size, column.width - 7).slice(0, 2);
        const lineHeight = size + 1.5;
        const totalHeight = labelLines.length * lineHeight;
        const firstBaseline = y - (height - totalHeight) / 2 - size;
        labelLines.forEach((line, lineIndex) => {
          const tx = cursor + Math.max(3.5, (column.width - textWidth(helveticaBold, line, size)) / 2);
          page.drawText(line, { x: tx, y: firstBaseline - lineIndex * lineHeight, size, font: helveticaBold, color: colors.ink });
        });
        cursor += column.width;
      });
      return y - height;
    }

    function drawTableRow(page, columns, row, x, y, options = {}) {
      const size = options.size || 7.5;
      const padding = options.padding ?? 4;
      const height = options.height || rowHeight(columns, row, size, padding, options.minHeight || 20);
      const fills = options.fills || [];
      const fonts = options.fonts || [];
      let cursor = x;
      columns.forEach((column, index) => {
        const font = fonts[index] || (options.bold ? helveticaBold : (column.font || helvetica));
        const fill = options.total ? colors.yellow : (fills[index] || options.background || colors.white);
        page.drawRectangle({
          x: cursor, y: y - height, width: column.width, height,
          color: fill, borderColor: colors.line, borderWidth: 0.55
        });
        const lines = wrap(font, row[index], size, Math.max(8, column.width - padding * 2));
        const lineHeight = size + 2.1;
        const totalHeight = lines.length * lineHeight;
        const firstBaseline = y - (height - totalHeight) / 2 - size;
        lines.forEach((line, lineIndex) => {
          const align = column.align || 'left';
          let tx = cursor + padding;
          if (align === 'center') tx = cursor + Math.max(padding, (column.width - textWidth(font, line, size)) / 2);
          if (align === 'right') tx = cursor + column.width - padding - textWidth(font, line, size);
          page.drawText(line, { x: tx, y: firstBaseline - lineIndex * lineHeight, size, font, color: colors.ink });
        });
        cursor += column.width;
      });
      return y - height;
    }

    async function drawPaginatedTable({
      columns, rows, totalRow = null, fontSize = 7.5, emptyRow = null,
      drawHeading, rowStyle, totalLabel = '', headerFills = null,
      continuationHeading = true, bottomReserve = 0
    }) {
      let page = await templatePage();
      let pageIndex = 0;
      let y = drawHeading(page, false);
      y = drawTableHeader(page, columns, bounds.left, y, { fills: headerFills || columns.map(() => colors.yellow) });
      const tableRows = rows.length ? rows : [emptyRow || columns.map((_, index) => index === 0 ? '-' : '-')];

      for (let index = 0; index < tableRows.length; index += 1) {
        const row = tableRows[index];
        const style = rowStyle ? (rowStyle(row, index) || {}) : {};
        const height = rowHeight(columns, row, fontSize, style.padding ?? 4, style.minHeight || 20);
        if (y - height < bounds.bottom + bottomReserve) {
          page = await templatePage();
          pageIndex += 1;
          y = continuationHeading ? drawHeading(page, true) : bounds.top;
          y = drawTableHeader(page, columns, bounds.left, y, { fills: headerFills || columns.map(() => colors.yellow) });
        }
        y = drawTableRow(page, columns, row, bounds.left, y, { size: fontSize, ...style, height });
      }

      if (totalRow) {
        const totalHeight = rowHeight(columns, totalRow, fontSize, 4, 22);
        if (y - totalHeight < bounds.bottom + bottomReserve) {
          page = await templatePage();
          pageIndex += 1;
          y = continuationHeading ? drawHeading(page, true) : bounds.top;
          y = drawTableHeader(page, columns, bounds.left, y, { fills: headerFills || columns.map(() => colors.yellow) });
        }
        y = drawTableRow(page, columns, totalRow, bounds.left, y, { size: fontSize, total: true, bold: true, height: totalHeight });
      }
      return { page, y, pageCount: pageIndex + 1 };
    }

    function civilAbbreviation(value) {
      const normalized = normalize(value);
      if (normalized === 'single') return 'S';
      if (normalized === 'married') return 'M';
      if (normalized === 'widowed') return 'W';
      if (normalized === 'separated') return 'SEP';
      if (normalized === 'other') return 'O';
      return value ? String(value).slice(0, 3).toUpperCase() : '-';
    }

    function genderAbbreviation(member) {
      const value = genderKey(member);
      if (value === 'Male') return 'M';
      if (value === 'Female') return 'F';
      return '-';
    }

    function yearDisplay(value) {
      const text = String(value || '').trim();
      const digit = text.match(/[1-5]/)?.[0];
      if (!digit) return text ? text.toUpperCase() : '-';
      const suffix = ({ 1: 'ST', 2: 'ND', 3: 'RD', 4: 'TH', 5: 'TH' })[digit];
      return `${digit}${suffix}`;
    }

    function courseDisplay(member, fallback = '') {
      return String(member?.course || fallback || member?.college || '-').toUpperCase();
    }

    // Page 1: Cover page, following the official filing layout.
    {
      const page = await templatePage();
      drawCentered(page, 'De La Salle University - Dasmarinas', 618, 9.5, timesBold);
      drawCentered(page, 'Cultural Arts Office', 601, 9.5, timesBold);
      drawCentered(page, 'Lasallian Symphony Orchestra', 532, 19, timesBold);
      drawCentered(page, 'Report for the Month of', 505, 10, times);
      drawCentered(page, monthLabel(report.month), 486, 10.5, times);
      drawCentered(page, 'Manpower Complement', 390, 11, timesBold);
      drawCentered(page, 'Summary of Manpower Count', 372, 11, timesBold);
      drawCentered(page, `${report.semester} - Academic Year ${report.academicYear}`, 342, 8.5, times);
      drawCenteredPrepared(page, 218);
    }

    // Page 2: Comparative Manpower Complement.
    {
      const page = await templatePage();
      page.drawText('COMPARATIVE MANPOWER COMPLEMENT', { x: bounds.left, y: 622, size: 12.5, font: timesBold, color: colors.ink });
      page.drawText(`As of ${dateLabel(report.asOfDate)}`, { x: bounds.left, y: 592, size: 10, font: times, color: colors.ink });
      const columns = [
        { label: '', width: 166 },
        { label: 'NUMBER', width: 163, align: 'center' },
        { label: 'PERCENT', width: 163, align: 'center' }
      ];
      let y = drawTableHeader(page, columns, bounds.left, 535, { height: 25, size: 8.5, fills: [colors.white, colors.yellow, colors.yellow] });
      const rows = [
        ['OFFICER', counts.officer, percent(counts.officer, counts.total)],
        ['MEMBER/S', counts.member, percent(counts.member, counts.total)],
        ['TRAINER', counts.trainer, percent(counts.trainer, counts.total)],
        ['TRAINEE', counts.trainee, percent(counts.trainee, counts.total)]
      ];
      rows.forEach((row) => {
        y = drawTableRow(page, columns, row, bounds.left, y, {
          size: 8.7, minHeight: 24, fonts: [helveticaBold, helvetica, helvetica],
          fills: [colors.gray, colors.white, colors.white]
        });
      });
      y = drawTableRow(page, columns, ['TOTAL:', counts.total, '100%'], bounds.left, y, { size: 9, minHeight: 25, total: true, bold: true });
      drawSignatoryBlock(page, bounds.left, y - 38, 210, 'Prepared By:', report.preparedBy, report.preparedTitle);
      drawSignatoryBlock(page, bounds.left, y - 168, 210, 'Noted By:', report.notedBy, report.notedTitle);
    }

    // Manpower Complement: continuous numbering across Official, Trainee and Probationary records.
    const manpowerColumns = [
      { label: 'NAME', width: 132 },
      { label: 'RANK', width: 92, align: 'center' },
      { label: 'YEAR', width: 56, align: 'center' },
      { label: 'COURSE', width: 74, align: 'center' },
      { label: 'CIVIL STATUS', width: 80, align: 'center' },
      { label: 'GENDER', width: 58, align: 'center' }
    ];
    const manpowerRows = roster.map((member, index) => [
      `${index + 1}. ${String(member.fullName || '').toUpperCase()}`,
      rankFor(member),
      yearDisplay(member.yearLevel),
      courseDisplay(member),
      civilAbbreviation(civilStatus(member)),
      genderAbbreviation(member)
    ]);
    await drawPaginatedTable({
      columns: manpowerColumns,
      rows: manpowerRows,
      totalRow: [`TOTAL NUMBER OF MEMBERS AND TRAINEES: ${roster.length}`, '', '', '', '', ''],
      fontSize: 7.2,
      continuationHeading: false,
      drawHeading(page, continued) {
        if (continued) return 632;
        drawCentered(page, 'Manpower Complement', 624, 10, timesBold);
        drawCentered(page, `As of ${dateLabel(report.asOfDate)}`, 608, 8.3, times);
        drawCentered(page, 'Lasallian Symphony Orchestra', 592, 8.3, timesItalic);
        return 574;
      },
      rowStyle(row) {
        const rank = String(row[1] || '');
        return {
          minHeight: 26,
          fills: [colors.white, rank === 'OFFICER' ? colors.officer : colors.white, colors.white, colors.white, colors.white, colors.white],
          fonts: [helvetica, helveticaBold, helvetica, helvetica, helvetica, helvetica]
        };
      }
    });

    // Separate signatory filing page, matching the reference report.
    {
      const page = await templatePage();
      drawSignatoryBlock(page, bounds.left, 610, 240, 'Prepared By:', report.preparedBy, report.preparedTitle);
      drawSignatoryBlock(page, bounds.left, 455, 240, 'Noted By:', report.notedBy, report.notedTitle);
    }

    // Summary of Manpower Count: Gender and Year Level.
    {
      const page = await templatePage();
      page.drawText('SUMMARY OF MANPOWER COUNT', { x: bounds.left, y: 622, size: 12.5, font: timesBold, color: colors.ink });
      page.drawText(`As of ${dateLabel(report.asOfDate)}`, { x: bounds.left, y: 596, size: 8.7, font: times, color: colors.ink });
      page.drawText('Lasallian Symphony Orchestra', { x: bounds.left, y: 581, size: 8.7, font: timesItalic, color: colors.ink });

      const genderCounts = { MALE: 0, FEMALE: 0, UNSPECIFIED: 0 };
      roster.forEach((member) => { genderCounts[genderKey(member).toUpperCase()] += 1; });
      page.drawText('Table 1. According to Gender', { x: bounds.left, y: 542, size: 9.5, font: timesBold, color: colors.ink });
      const summaryColumns = [{ label: 'GENDER', width: 246 }, { label: monthLabel(report.month).toUpperCase(), width: 246, align: 'center' }];
      let y = drawTableHeader(page, summaryColumns, bounds.left, 526, { height: 23, size: 8.2 });
      const genderRows = [['MALE', genderCounts.MALE], ['FEMALE', genderCounts.FEMALE]];
      if (genderCounts.UNSPECIFIED) genderRows.push(['UNSPECIFIED', genderCounts.UNSPECIFIED]);
      genderRows.forEach((row) => { y = drawTableRow(page, summaryColumns, row, bounds.left, y, { size: 8.3, minHeight: 23, background: colors.gray }); });
      y = drawTableRow(page, summaryColumns, ['TOTAL:', roster.length], bounds.left, y, { size: 8.5, minHeight: 23, total: true, bold: true });

      page.drawText('Table 2. According to the Year Level', { x: bounds.left, y: y - 38, size: 9.5, font: timesBold, color: colors.ink });
      const yearCounts = { 'FIRST YEAR': 0, 'SECOND YEAR': 0, 'THIRD YEAR': 0, 'FOURTH YEAR': 0, 'FIFTH YEAR': 0, UNSPECIFIED: 0 };
      roster.forEach((member) => { yearCounts[yearKey(member).toUpperCase()] += 1; });
      y = drawTableHeader(page, [{ label: 'YEAR LEVEL', width: 246 }, { label: monthLabel(report.month).toUpperCase(), width: 246, align: 'center' }], bounds.left, y - 54, { height: 23, size: 8.2 });
      const yearRows = ['FIRST YEAR', 'SECOND YEAR', 'THIRD YEAR', 'FOURTH YEAR', 'FIFTH YEAR'].map((label) => [label, yearCounts[label]]);
      if (yearCounts.UNSPECIFIED) yearRows.push(['UNSPECIFIED', yearCounts.UNSPECIFIED]);
      yearRows.forEach((row) => { y = drawTableRow(page, summaryColumns, row, bounds.left, y, { size: 8.3, minHeight: 23, background: colors.gray }); });
      drawTableRow(page, summaryColumns, ['TOTAL:', roster.length], bounds.left, y, { size: 8.5, minHeight: 23, total: true, bold: true });
    }

    // Table 3: Members on Leave.
    const leaveRows = loaRows().map((row, index) => {
      const member = memberById(row.memberId);
      return [
        `${index + 1}. ${String(member?.fullName || row.name || '-').toUpperCase()}`,
        courseDisplay(member, row.course),
        yearDisplay(member?.yearLevel || row.year),
        String(row.purpose || '-').toUpperCase(),
        String(row.until || '-').toUpperCase()
      ];
    });
    await drawPaginatedTable({
      columns: [
        { label: 'NAME', width: 140 }, { label: 'COURSE', width: 72, align: 'center' },
        { label: 'YEAR', width: 58, align: 'center' }, { label: 'PURPOSE OF FILING LOA', width: 137, align: 'center' },
        { label: 'LOA UNTIL', width: 85, align: 'center' }
      ],
      rows: leaveRows,
      emptyRow: ['-', '-', '-', '-', '-'],
      fontSize: 7.2,
      continuationHeading: false,
      drawHeading(page, continued) {
        if (continued) return 632;
        page.drawText('Table 3. Summary of Members on Leave', { x: bounds.left, y: 622, size: 10, font: timesBold, color: colors.ink });
        return 600;
      },
      rowStyle() {
        return { minHeight: 25, fills: [colors.white, colors.white, colors.white, colors.white, colors.highlightGreen] };
      }
    });

    // Table 4: Members on OJT.
    const ojtPdfRows = ojtRows().map((row, index) => {
      const member = memberById(row.memberId);
      return [
        `${index + 1}. ${String(member?.fullName || row.name || '-').toUpperCase()}`,
        courseDisplay(member, row.course),
        yearDisplay(member?.yearLevel || row.year),
        String(row.until || '-').toUpperCase()
      ];
    });
    await drawPaginatedTable({
      columns: [
        { label: 'NAME', width: 190 }, { label: 'COURSE', width: 105, align: 'center' },
        { label: 'YEAR', width: 82, align: 'center' }, { label: 'OJT UNTIL', width: 115, align: 'center' }
      ],
      rows: ojtPdfRows,
      emptyRow: ['-', '-', '-', '-'],
      fontSize: 7.6,
      continuationHeading: false,
      drawHeading(page, continued) {
        if (continued) return 632;
        page.drawText('Table 4. Summary of Members on "ON THE JOB TRAINING" (OJT)', { x: bounds.left, y: 622, size: 9.6, font: timesBold, color: colors.ink });
        return 600;
      },
      rowStyle() { return { minHeight: 24 }; }
    });

    // Table 5: Permanent Summary of Trainees.
    const snapshot = traineeFile();
    const filingDate = snapshot.createdAt ? dateLabel(snapshot.createdAt) : dateLabel(report.asOfDate);
    const traineeRows = snapshot.rows.map((row, index) => [
      `${index + 1}. ${String(row.name || '-').toUpperCase()}`,
      String(row.course || '-').toUpperCase(),
      yearDisplay(row.year),
      dateLabel(row.date || snapshot.createdAt || report.asOfDate)
    ]);
    await drawPaginatedTable({
      columns: [
        { label: 'NAME', width: 178 }, { label: 'COURSE', width: 108, align: 'center' },
        { label: 'YEAR', width: 72, align: 'center' }, { label: 'DATE', width: 134, align: 'center' }
      ],
      rows: traineeRows,
      totalRow: [`TOTAL: ${traineeRows.length}`, '', '', ''],
      emptyRow: ['-', '-', '-', '-'],
      fontSize: 7.2,
      continuationHeading: false,
      drawHeading(page, continued) {
        if (continued) return 632;
        page.drawText('Table 5. Summary of Trainees', { x: bounds.left, y: 622, size: 10, font: timesBold, color: colors.ink });
        const subtitle = `As of ${filingDate}, Auditions Result (Results are Submitted on ${filingDate})`;
        page.drawText(subtitle, { x: bounds.left, y: 601, size: 7.2, font: times, color: colors.ink });
        return 584;
      },
      rowStyle() {
        return { minHeight: 25, fills: [colors.white, colors.white, colors.white, colors.highlightGreen] };
      }
    });

    // Table 6: Quitted/Removed Trainees.
    const quittedPdfRows = quittedRows().map((row, index) => [
      `${index + 1}. ${String(row.name || '-').toUpperCase()}`,
      row.reason || '-',
      row.remarks || '-'
    ]);
    await drawPaginatedTable({
      columns: [
        { label: 'NAME', width: 175 }, { label: 'REASON/S', width: 170, align: 'center' },
        { label: 'REMARKS', width: 147, align: 'center' }
      ],
      rows: quittedPdfRows,
      totalRow: [`TOTAL: ${quittedPdfRows.length}`, '', ''],
      emptyRow: ['-', '-', '-'],
      fontSize: 7.2,
      continuationHeading: false,
      drawHeading(page, continued) {
        if (continued) return 632;
        page.drawText('Table 6. Summary of Quitted/Removed Trainees', { x: bounds.left, y: 622, size: 10, font: timesBold, color: colors.ink });
        return 600;
      },
      rowStyle() { return { minHeight: 25 }; }
    });

    // Table 7: Remaining Trainees.
    const remaining = effectiveRemainingRows();
    const remainingRows = remaining.map((row, index) => [
      `${index + 1}. ${String(row.name || '-').toUpperCase()}`,
      String(row.course || '-').toUpperCase()
    ]);
    await drawPaginatedTable({
      columns: [{ label: 'NAME', width: 330 }, { label: 'COURSE', width: 162, align: 'center' }],
      rows: remainingRows,
      totalRow: [`TOTAL: ${remainingRows.length}`, ''],
      emptyRow: ['-', '-'],
      fontSize: 7.8,
      continuationHeading: false,
      drawHeading(page, continued) {
        if (continued) return 632;
        page.drawText('Table 7. Summary of Remaining Trainees', { x: bounds.left, y: 622, size: 10, font: timesBold, color: colors.ink });
        return 600;
      },
      rowStyle() { return { minHeight: 24 }; }
    });

    output.setTitle(`LSO Overall Monthly Report - ${monthLabel(report.month)}`);
    output.setAuthor('Lasallian Symphony Orchestra');
    output.setSubject('Manpower Complement and Summary of Manpower Count');
    output.setCreator('LSO Orchestra Management System');
    return output.save();
  }

  async function previewPdf() {
    try {
      status('Generating PDF preview…', 'working');
      const bytes = await buildPdfBytes();
      clearPreview();
      previewUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const frame = el('monthlyReportPreviewFrame');
      frame.src = `${previewUrl}#view=FitH&toolbar=1`;
      frame.classList.remove('hidden');
      el('monthlyReportPreviewPlaceholder')?.classList.add('hidden');
      status('PDF preview generated.', 'saved');
      activeTab = 'preview';
      renderTabs();
    } catch (error) {
      status(error.message || 'Unable to generate the PDF preview.', 'error');
      toast(error.message || 'Unable to generate the PDF preview.', true);
    }
  }

  async function downloadPdf() {
    try {
      status('Building the official PDF report…', 'working');
      if (canModify()) {
        updateReportFromFields();
        saveState({ quiet: true });
      }
      const bytes = await buildPdfBytes();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `LSO_Overall_Monthly_Report_${activeReportKey}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1200);
      logActivity('Downloaded Overall Monthly Report', `${monthLabel(activeReportKey)} • ${comparativeCounts().total} comparative manpower complement`);
      status('Official Monthly Report PDF downloaded.', 'saved');
      toast('Overall Monthly Report PDF downloaded.');
    } catch (error) {
      status(error.message || 'Unable to download the PDF report.', 'error');
      toast(error.message || 'Unable to download the PDF report.', true);
    }
  }

  function wireEvents() {
    qsa('[data-monthly-tab]').forEach((button) => button.addEventListener('click', () => {
      activeTab = button.dataset.monthlyTab;
      renderTabs();
    }));

    el('monthlyReportMonth')?.addEventListener('change', (event) => handleMonthChange(event.target.value));
    ['monthlyReportDate', 'monthlyReportSemester', 'monthlyReportAcademicYear', 'monthlyReportPreparedBy', 'monthlyReportPreparedTitle', 'monthlyReportNotedBy', 'monthlyReportNotedTitle']
      .forEach((id) => el(id)?.addEventListener('input', () => { updateReportFromFields(); queueSave(); if (['monthlyReportSemester', 'monthlyReportAcademicYear'].includes(id)) renderTraineeFile(); }));

    el('monthlyReportSaveButton')?.addEventListener('click', () => { updateReportFromFields(); saveState(); });
    el('monthlyReportPreviewButton')?.addEventListener('click', previewPdf);
    el('monthlyReportDownloadButton')?.addEventListener('click', downloadPdf);
    el('monthlyManpowerSearch')?.addEventListener('input', renderManpowerRoster);
    el('monthlyFillBlankSingle')?.addEventListener('click', fillBlankCivilAsSingle);
    el('monthlySyncLoa')?.addEventListener('click', syncLoaRows);
    el('monthlyAddLoa')?.addEventListener('click', () => addRow('loa'));
    el('monthlyAddOjt')?.addEventListener('click', () => addRow('ojt'));
    el('monthlyCaptureTrainees')?.addEventListener('click', captureCurrentTrainees);
    el('monthlyAddQuitted')?.addEventListener('click', () => addRow('quitted'));
    el('monthlyAddRemaining')?.addEventListener('click', () => addRow('remaining'));
    el('monthlyRemainingMode')?.addEventListener('change', (event) => {
      if (!canModify()) return renderRemaining();
      currentReport().remainingMode = event.target.value;
      saveState({ quiet: true });
      renderRemaining();
    });

    document.addEventListener('change', (event) => {
      const target = event.target;
      if (target.matches('[data-monthly-civil-member]')) {
        if (!canModify()) return renderManpowerRoster();
        state.civilStatusByMember[target.dataset.monthlyCivilMember] = target.value;
        queueSave();
        return;
      }
      updateDynamicRow(target);
    });
    document.addEventListener('input', (event) => updateDynamicRow(event.target));

    document.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.monthlyDeleteLoa) removeRow('loa', target.dataset.monthlyDeleteLoa);
      if (target.dataset.monthlyDeleteOjt) removeRow('ojt', target.dataset.monthlyDeleteOjt);
      if (target.dataset.monthlyDeleteQuitted) removeRow('quitted', target.dataset.monthlyDeleteQuitted);
      if (target.dataset.monthlyDeleteRemaining) removeRow('remaining', target.dataset.monthlyDeleteRemaining);
    });

    document.querySelector('[data-view="monthlyReportView"]')?.addEventListener('click', () => setTimeout(renderAll, 20));
    window.addEventListener('lso:members-changed', () => setTimeout(renderAll, 40));
    window.addEventListener('lso:cloud-state-changed', (event) => {
      if (event.detail?.key && event.detail.key !== STORAGE_KEY && event.detail.key !== 'lso_member_database_v1') return;
      const source = String(event.detail?.source || '');
      const isOwnMonthlySave = event.detail?.key === STORAGE_KEY && (source === 'cloud-save' || Date.now() - lastLocalSaveAt < 2500);
      if (isOwnMonthlySave) return;
      if (monthlyEditorFocused()) {
        pendingRemoteRefresh = true;
        return;
      }
      state = loadState();
      setTimeout(renderAll, 30);
    });
    document.addEventListener('focusout', (event) => {
      if (!event.target.closest?.('#monthlyReportView')) return;
      applyDeferredSharedRefresh();
    });
    window.addEventListener('lso:auth-changed', () => setTimeout(renderAll, 30));
  }

  function initialize() {
    const monthInput = el('monthlyReportMonth');
    if (!monthInput) return;
    activeReportKey = monthInput.value || currentMonthKey();
    currentReport().month = activeReportKey;
    renderAll();
    wireEvents();
    status(`Viewing ${monthLabel(activeReportKey)} report draft.`, '');
  }

  window.LSOMonthlyReport = {
    refresh() { state = loadState(); renderAll(); },
    preview: previewPdf,
    download: downloadPdf,
    getState: () => JSON.parse(JSON.stringify(state)),
    getCurrentReport: () => JSON.parse(JSON.stringify(currentReport())),
    _buildPdfBytes: buildPdfBytes
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
