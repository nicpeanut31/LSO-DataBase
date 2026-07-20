(() => {
  'use strict';

  const STORAGE_KEY = 'lso_member_database_v1';
  const MEMBERSHIP_STAGES = ['Trainee', 'Probationary', 'Regular Member'];
  const PERIOD_GROUPS = ['Trainee Period', 'Probationary Period', 'Membership Period'];
  const CSV_FIELDS = [
    ['membershipId', 'Membership ID'],
    ['fullName', 'Full Name'],
    ['birthdate', 'Birthdate'],
    ['age', 'Age'],
    ['sex', 'Sex'],
    ['contactNumber', 'Contact Number'],
    ['homeAddress', 'Home Address'],
    ['emergencyContactName', 'Emergency Contact Name'],
    ['emergencyContactRelationship', 'Emergency Contact Relationship'],
    ['emergencyContactNumber', 'Emergency Contact Number'],
    ['alternativeContactNumber', 'Alternative Contact Number'],
    ['studentNumber', 'Student Number'],
    ['college', 'College'],
    ['course', 'Course'],
    ['yearLevel', 'Year Level'],
    ['section', 'Section'],
    ['cys', 'CYS'],
    ['outlook', 'DLSUD Outlook'],
    ['academicStatus', 'Academic Status'],
    ['organizationPosition', 'Position in Organization'],
    ['organizationRole', 'Specific Organization Role'],
    ['memberStatus', 'Member Status'],
    ['membershipStage', 'Membership Stage'],
    ['traineeStartDate', 'Trainee Start Date'],
    ['probationaryStartDate', 'Probationary Start Date'],
    ['probationarySkipped', 'Probationary Period Skipped'],
    ['regularMemberDate', 'Membership Period Start Date'],
    ['periodGroup', 'Current Period Group'],
    ['stageNotes', 'Trainee / Probationary Notes'],
    ['orchestraSection', 'Orchestra Section'],
    ['primaryInstrument', 'Primary Instrument'],
    ['dateRegistered', 'Date Registered'],
    ['lastProfileReview', 'Last Profile Review'],
    ['remarks', 'Remarks / Notes'],
    ['recordQuality', 'Record Quality'],
    ['reviewStatus', 'Profile Review Status']
  ];

  const requiredForCompleteness = [
    'fullName', 'sex', 'contactNumber', 'emergencyContactName', 'emergencyContactRelationship', 'emergencyContactNumber', 'studentNumber', 'college', 'course',
    'yearLevel', 'section', 'cys', 'outlook', 'academicStatus', 'organizationPosition',
    'memberStatus', 'membershipStage', 'orchestraSection', 'primaryInstrument', 'dateRegistered'
  ];

  let members = loadMembers();
  let selectedMemberId = null;
  let directoryMode = 'members';
  let directoryStage = 'Membership Period';

  const el = (id) => document.getElementById(id);
  const qsa = (selector) => [...document.querySelectorAll(selector)];

  function isAdmin() {
    return (window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount)?.role === 'Administrator';
  }

  function requireAdmin(message = 'Administrator access is required to modify member records.') {
    if (isAdmin()) return true;
    showToast(message, true);
    return false;
  }

  function loadMembers() {
    try {
      const parsed = JSON.parse(window.LSOStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.map(enrichMember) : [];
    } catch {
      return [];
    }
  }

  function saveMembers() {
    if (!requireAdmin()) return false;
    window.LSOStorage.setItem(STORAGE_KEY, JSON.stringify(members));
    renderAll();
    window.dispatchEvent(new CustomEvent('lso:members-changed', { detail: { count: members.length } }));
    return true;
  }

  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function normalizeKey(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function initials(name) {
    const parts = String(name || 'LSO').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'LSO';
  }

  function toDateLabel(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  }

  function toShortDateLabel(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function toTimeLabel(value) {
    if (!value) return '—';
    const [hour, minute] = String(value).split(':').map(Number);
    if (!Number.isFinite(hour)) return value;
    const date = new Date();
    date.setHours(hour, Number.isFinite(minute) ? minute : 0, 0, 0);
    return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function getToday() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function ageFromBirthdate(value) {
    if (!value) return '';
    const birth = new Date(`${value}T00:00:00`);
    if (Number.isNaN(birth.getTime())) return '';
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const month = today.getMonth() - birth.getMonth();
    if (month < 0 || (month === 0 && today.getDate() < birth.getDate())) age -= 1;
    return age >= 0 ? String(age) : '';
  }

  function generateMembershipId(dateRegistered = getToday(), sourceMembers = members) {
    const year = String(dateRegistered || getToday()).slice(0, 4);
    const existing = sourceMembers
      .map((member) => member.membershipId)
      .filter((id) => typeof id === 'string' && id.startsWith(`LSO-${year}-`))
      .map((id) => Number(id.split('-').pop()))
      .filter(Number.isFinite);
    const next = (existing.length ? Math.max(...existing) : 0) + 1;
    return `LSO-${year}-${String(next).padStart(4, '0')}`;
  }

  function calculateCompleteness(member) {
    const completed = requiredForCompleteness.filter((key) => String(member[key] ?? '').trim()).length;
    return Math.round((completed / requiredForCompleteness.length) * 100);
  }

  function calculateReviewStatus(member) {
    if (member.reviewStatus && ['Current', 'For Review', 'Overdue'].includes(member.reviewStatus)) return member.reviewStatus;
    if (!member.lastProfileReview) return 'For Review';
    const last = new Date(`${member.lastProfileReview}T00:00:00`);
    if (Number.isNaN(last.getTime())) return 'For Review';
    const ageDays = (Date.now() - last.getTime()) / 86_400_000;
    if (ageDays > 365) return 'Overdue';
    if (ageDays > 300) return 'For Review';
    return 'Current';
  }

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function addDays(value, days) {
    if (!validDate(value)) return '';
    const date = new Date(`${value}T00:00:00`);
    date.setDate(date.getDate() + days);
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function migrateLegacyStageDates(member) {
    const migrated = { ...member };
    const hasNewTimeline = migrated.traineeStartDate || migrated.probationaryStartDate || migrated.regularMemberDate;
    if (hasNewTimeline) return migrated;
    if (migrated.membershipStage === 'Trainee') {
      migrated.traineeStartDate = migrated.stageStartDate || migrated.dateRegistered || '';
      migrated.probationaryStartDate = migrated.stageEndDate ? addDays(migrated.stageEndDate, 1) : '';
    } else if (migrated.membershipStage === 'Probationary') {
      migrated.traineeStartDate = migrated.dateRegistered || '';
      migrated.probationaryStartDate = migrated.stageStartDate || '';
      migrated.regularMemberDate = migrated.stageEndDate ? addDays(migrated.stageEndDate, 1) : '';
    } else if (migrated.membershipStage === 'Regular Member') {
      migrated.regularMemberDate = migrated.stageStartDate || migrated.stageEndDate || '';
    }
    return migrated;
  }

  function calculateMembershipStage(member, referenceDate = getToday()) {
    const hasTimeline = member.traineeStartDate || member.probationaryStartDate || member.regularMemberDate;
    if (!hasTimeline) {
      if (member.periodGroup === 'Membership Period' || member.membershipStage === 'Regular Member') return 'Regular Member';
      if (member.periodGroup === 'Probationary Period' || member.membershipStage === 'Probationary') return 'Probationary';
      return 'Trainee';
    }
    if (validDate(member.regularMemberDate) && referenceDate >= member.regularMemberDate) return 'Regular Member';
    if (validDate(member.probationaryStartDate) && referenceDate >= member.probationaryStartDate) return 'Probationary';
    return 'Trainee';
  }

  function calculatePeriodGroup(member, referenceDate = getToday()) {
    const stage = calculateMembershipStage(member, referenceDate);
    if (stage === 'Trainee') return 'Trainee Period';
    if (stage === 'Probationary') return 'Probationary Period';
    return 'Membership Period';
  }

  function getPeriodBadge(periodGroup) {
    const map = {
      'Trainee Period': 'badge-blue',
      'Probationary Period': 'badge-gold',
      'Membership Period': 'badge-green',
      'Regular — Period 1': 'badge-green',
      'Regular — Period 2': 'badge-green'
    };
    return map[periodGroup] || 'badge-gray';
  }

  function daysBetween(fromDate, toDate) {
    if (!validDate(fromDate) || !validDate(toDate)) return null;
    const from = new Date(`${fromDate}T00:00:00`);
    const to = new Date(`${toDate}T00:00:00`);
    return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  }

  function calculateStagePeriodStatus(member, referenceDate = getToday()) {
    const stage = calculateMembershipStage(member, referenceDate);
    if (validDate(member.traineeStartDate) && referenceDate < member.traineeStartDate) {
      const days = daysBetween(referenceDate, member.traineeStartDate);
      return `Trainee Period starts in ${days} day${days === 1 ? '' : 's'}`;
    }
    if (stage === 'Trainee') {
      if (member.probationarySkipped && validDate(member.regularMemberDate)) {
        const days = daysBetween(referenceDate, member.regularMemberDate);
        if (days === 0) return 'Moves directly to Membership Period today';
        if (days === 1) return 'Direct Membership Period starts tomorrow';
        return `Direct Membership Period starts in ${days} days • Probationary skipped`;
      }
      if (!validDate(member.probationaryStartDate)) return 'Trainee Period • next date not set';
      const days = daysBetween(referenceDate, member.probationaryStartDate);
      if (days === 0) return 'Moves to Probationary Period today';
      if (days === 1) return 'Probationary Period starts tomorrow';
      return `Probationary Period starts in ${days} days`;
    }
    if (stage === 'Probationary') {
      if (!validDate(member.regularMemberDate)) return 'Probationary Period • membership date not set';
      const days = daysBetween(referenceDate, member.regularMemberDate);
      if (days === 0) return 'Moves to Membership Period today';
      if (days === 1) return 'Membership Period starts tomorrow';
      return `Membership Period starts in ${days} days`;
    }
    return validDate(member.regularMemberDate)
      ? `Member since ${toShortDateLabel(member.regularMemberDate)}`
      : 'Membership Period';
  }

  function enrichMember(member) {
    const enriched = migrateLegacyStageDates(member);
    const skipValue = String(enriched.probationarySkipped ?? '').trim().toLowerCase();
    enriched.probationarySkipped = enriched.probationarySkipped === true || ['true', '1', 'yes', 'y', 'skipped'].includes(skipValue) || Boolean(enriched.regularMemberDate && !enriched.probationaryStartDate);
    enriched.membershipStage = calculateMembershipStage(enriched);
    enriched.periodGroup = calculatePeriodGroup(enriched);
    if (!enriched.age && enriched.birthdate) enriched.age = ageFromBirthdate(enriched.birthdate);
    enriched.recordQuality = calculateCompleteness(enriched);
    enriched.reviewStatus = calculateReviewStatus(enriched);
    enriched.stagePeriodStatus = calculateStagePeriodStatus(enriched);
    enriched.updatedAt = enriched.updatedAt || new Date().toISOString();
    return enriched;
  }

  function getStatusBadge(status) {
    const map = { Active: 'badge-green', Nonactive: 'badge-gray', LOA: 'badge-gold' };
    return map[status] || 'badge-gray';
  }

  function getStageBadge(stage) {
    const map = { Trainee: 'badge-blue', Probationary: 'badge-gold', 'Regular Member': 'badge-green' };
    return map[stage] || 'badge-gray';
  }

  function getReviewBadge(status) {
    const map = { Current: 'badge-green', 'For Review': 'badge-gold', Overdue: 'badge-red' };
    return map[status] || 'badge-gray';
  }

  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    el('toastRegion').appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function setView(viewId) {
    const account = window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
    if (account?.role === 'Trainee/Probationary' && viewId !== 'dutyHoursView') viewId = 'dutyHoursView';
    qsa('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
    qsa('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
    const titleMap = {
      dashboardView: 'Dashboard',
      membersView: 'Members',
      lookupView: 'Member Lookup',
      contractView: 'Contract Maker',
      monthlyReportView: 'Overall Monthly Report',
      attendanceView: 'Attendance',
      dutyHoursView: 'Duty Hours',
      alertsView: 'Action Center',
      accountsView: 'Account Management',
      dataView: 'Data & Backup'
    };
    el('pageTitle').textContent = titleMap[viewId] || 'LSO Member Database';
    el('sidebar').classList.remove('open');
    if (viewId === 'lookupView') renderLookupResults();
  }

  function metricCard(label, value, helper) {
    return `<article class="metric-card"><p>${safeText(label)}</p><strong>${safeText(value)}</strong><small>${safeText(helper)}</small></article>`;
  }

  function renderDashboard() {
    members = members.map(enrichMember);
    const total = members.length;
    const active = members.filter((m) => m.memberStatus === 'Active').length;
    const trainee = members.filter((m) => m.periodGroup === 'Trainee Period').length;
    const probationary = members.filter((m) => m.periodGroup === 'Probationary Period').length;
    const membership = members.filter((m) => m.periodGroup === 'Membership Period').length;
    const executive = members.filter((m) => m.organizationPosition === 'Executive Board').length;
    const average = total ? Math.round(members.reduce((sum, m) => sum + Number(m.recordQuality || 0), 0) / total) : 0;

    const metricGrid = el('metricGrid');
    if (metricGrid) {
      metricGrid.innerHTML = [
        metricCard('Membership Period', membership, 'Official member directory'),
        metricCard('Probationary Period', probationary, 'Under evaluation'),
        metricCard('Trainee Period', trainee, 'Recruitment and training'),
        metricCard('Active Records', active, total ? `${Math.round((active / total) * 100)}% of all profiles` : 'No records yet'),
        metricCard('Executive Board', executive, 'Organization officers'),
        metricCard('Profile Quality', `${average}%`, average >= 90 ? 'Records are in good shape' : 'Some profiles need review')
      ].join('');
    }

    renderBars('statusBars', ['Active', 'Nonactive', 'LOA'], 'memberStatus');
    renderBars('sectionBars', ['Piano', 'String', 'Woodwinds', 'Brass', 'Percussion'], 'orchestraSection');
    // Backward-compatible only: the former stageBars panel may no longer exist
    // because stage intelligence is now rendered by dashboard-intelligence.js.
    renderBars('stageBars', PERIOD_GROUPS, 'periodGroup');

    const recent = [...members].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 6);
    const recentMembers = el('recentMembers');
    if (recentMembers) recentMembers.innerHTML = recent.length ? recent.map((member) => `
      <div class="recent-item">
        <div class="member-avatar">${safeText(initials(member.fullName))}</div>
        <div><h4>${safeText(member.fullName)}</h4><p>${safeText(member.membershipId)} • ${safeText(member.primaryInstrument || 'No instrument')}</p></div>
        <span class="badge ${getPeriodBadge(member.periodGroup)}">${safeText(member.periodGroup)}</span>
        <button class="text-button" data-open-record="${safeText(member.id)}">Open →</button>
      </div>
    `).join('') : `<div class="empty-state"><div class="empty-icon">♫</div><h4>No records yet</h4><p>Use “Add Member” to create the first profile.</p></div>`;
  }

  function renderBars(containerId, labels, field) {
    const container = el(containerId);
    if (!container) return;
    const total = members.length || 1;
    container.innerHTML = labels.map((label) => {
      const count = members.filter((member) => member[field] === label).length;
      const percent = Math.round((count / total) * 100);
      return `<div><div class="bar-row-top"><span>${safeText(label)}</span><span>${count} (${members.length ? percent : 0}%)</span></div><div class="bar-track"><div class="bar-fill" style="width:${members.length ? percent : 0}%"></div></div></div>`;
    }).join('');
  }

  function getFilteredMembers() {
    const search = normalize(el('memberSearch').value);
    const status = el('statusFilter').value;
    const section = el('sectionFilter').value;
    const position = el('positionFilter').value;
    return members.filter((member) => {
      const haystack = [
        member.membershipId, member.fullName, member.studentNumber, member.outlook,
        member.primaryInstrument, member.organizationRole, member.course, member.cys,
        member.membershipStage, member.periodGroup
      ].map(normalize).join(' ');
      return member.periodGroup === directoryStage &&
        (!search || haystack.includes(search)) &&
        (!status || member.memberStatus === status) &&
        (!section || member.orchestraSection === section) &&
        (!position || member.organizationPosition === position);
    }).sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  }

  function memberActions(member) {
    const viewIcon = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.75"></circle></svg>`;
    const editIcon = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg>`;
    const deleteIcon = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m7 7 1 13h8l1-13"></path><path d="M10 11v5M14 11v5"></path></svg>`;
    return `<div class="table-actions member-row-actions">
      <button class="table-action" aria-label="View ${safeText(member.fullName)}" title="View record" data-action="view" data-id="${safeText(member.id)}">${viewIcon}</button>
      ${isAdmin() ? `<button class="table-action" aria-label="Edit ${safeText(member.fullName)}" title="Edit member" data-action="edit" data-id="${safeText(member.id)}">${editIcon}</button><button class="table-action danger" aria-label="Delete ${safeText(member.fullName)}" title="Delete member" data-action="delete" data-id="${safeText(member.id)}">${deleteIcon}</button>` : ''}
    </div>`;
  }

  function renderPeriodGroups(filtered) {
    const selectedGroup = el('periodGroupFilter').value;
    const selectedStage = el('stageFilter').value;
    const groups = selectedGroup ? [selectedGroup]
      : selectedStage === 'Trainee' ? ['Trainee Period']
      : selectedStage === 'Probationary' ? ['Probationary Period']
      : selectedStage === 'Regular Member' ? ['Membership Period']
      : PERIOD_GROUPS;
    el('periodGroupsContainer').innerHTML = groups.map((group) => {
      const groupMembers = filtered.filter((member) => member.periodGroup === group);
      return `<section class="period-group-card">
        <div class="period-group-header">
          <div>
            <p class="eyebrow">Membership Timeline</p>
            <h4>${safeText(group)}</h4>
          </div>
          <span class="period-count ${getPeriodBadge(group)}">${groupMembers.length} member${groupMembers.length === 1 ? '' : 's'}</span>
        </div>
        ${groupMembers.length ? `<div class="period-table-wrap"><table class="period-table">
          <thead><tr><th>Member</th><th>Membership ID</th><th>Student No.</th><th>Section / Instrument</th><th>Status</th><th>Timeline</th><th>Actions</th></tr></thead>
          <tbody>${groupMembers.map((member) => `<tr>
            <td><div class="member-cell member-identity"><div class="member-avatar" aria-hidden="true">${safeText(initials(member.fullName))}</div><div class="member-copy"><strong class="member-name">${safeText(member.fullName)}</strong><small class="member-email" title="${safeText(member.outlook || 'No Outlook account')}">${safeText(member.outlook || 'No Outlook account')}</small></div></div></td>
            <td><strong>${safeText(member.membershipId)}</strong></td>
            <td>${safeText(member.studentNumber || '—')}</td>
            <td><strong>${safeText(member.orchestraSection || '—')}</strong><br><small>${safeText(member.primaryInstrument || '—')}</small></td>
            <td><span class="badge ${getStatusBadge(member.memberStatus)}">${safeText(member.memberStatus || 'Unspecified')}</span></td>
            <td><small>${safeText(member.stagePeriodStatus)}</small></td>
            <td>${memberActions(member)}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : `<div class="period-empty"><span>♪</span><p>No members currently belong to this period.</p></div>`}
      </section>`;
    }).join('');
  }

  function renderMembersTable() {
    const filtered = getFilteredMembers();
    const stageTotal = members.filter((member) => member.periodGroup === directoryStage).length;
    const counts = {
      'Membership Period': members.filter((member) => member.periodGroup === 'Membership Period').length,
      'Probationary Period': members.filter((member) => member.periodGroup === 'Probationary Period').length,
      'Trainee Period': members.filter((member) => member.periodGroup === 'Trainee Period').length
    };
    if (el('membershipTabCount')) el('membershipTabCount').textContent = counts['Membership Period'];
    if (el('probationaryTabCount')) el('probationaryTabCount').textContent = counts['Probationary Period'];
    if (el('traineeTabCount')) el('traineeTabCount').textContent = counts['Trainee Period'];
    if (el('memberDirectoryTitle')) el('memberDirectoryTitle').textContent = directoryStage;
    el('memberCountLabel').textContent = `${filtered.length} shown • ${stageTotal} in ${directoryStage}`;
    if (el('membersEmptyText')) el('membersEmptyText').textContent = `No records are currently in ${directoryStage}.`;
    el('membersTableBody').innerHTML = filtered.map((member) => `
      <tr>
        <td><strong>${safeText(member.membershipId)}</strong></td>
        <td><div class="member-cell member-identity"><div class="member-avatar" aria-hidden="true">${safeText(initials(member.fullName))}</div><div class="member-copy"><strong class="member-name">${safeText(member.fullName)}</strong><small class="member-email" title="${safeText(member.outlook || 'No Outlook account')}">${safeText(member.outlook || 'No Outlook account')}</small></div></div></td>
        <td>${safeText(member.studentNumber || '—')}</td>
        <td>${safeText(member.orchestraSection || '—')}</td>
        <td>${safeText(member.primaryInstrument || '—')}</td>
        <td class="organization-cell"><strong>${safeText(member.organizationPosition || '—')}</strong><small>${safeText(member.organizationRole || '')}</small></td>
        <td class="stage-cell"><span class="badge ${getPeriodBadge(member.periodGroup)}">${safeText(member.periodGroup)}</span><small>${safeText(member.stagePeriodStatus)}</small></td>
        <td><span class="badge ${getStatusBadge(member.memberStatus)}">${safeText(member.memberStatus || 'Unspecified')}</span></td>
        <td><span class="badge ${member.recordQuality >= 90 ? 'badge-green' : member.recordQuality >= 70 ? 'badge-gold' : 'badge-red'}">${safeText(member.recordQuality)}%</span></td>
        <td>${memberActions(member)}</td>
      </tr>
    `).join('');

    el('memberListContainer').classList.remove('hidden');
    el('periodGroupsContainer').classList.add('hidden');
    el('membersEmpty').classList.toggle('hidden', filtered.length > 0);
    el('membersTableBody').closest('.table-wrap').classList.toggle('hidden', filtered.length === 0);
  }

  function setMembershipDirectory(stage) {
    directoryStage = PERIOD_GROUPS.includes(stage) ? stage : 'Membership Period';
    if (el('periodGroupFilter')) el('periodGroupFilter').value = directoryStage;
    el('memberListMode')?.classList.toggle('active', directoryStage === 'Membership Period');
    el('probationaryTab')?.classList.toggle('active', directoryStage === 'Probationary Period');
    el('traineeTab')?.classList.toggle('active', directoryStage === 'Trainee Period');
    if (el('directoryModeHelp')) {
      el('directoryModeHelp').textContent = directoryStage === 'Membership Period'
        ? 'Only profiles whose Membership Period has started appear here.'
        : directoryStage === 'Probationary Period'
          ? 'Probationary profiles stay separate until their Membership Period start date arrives.'
          : 'Trainee profiles stay separate until their Probationary Period start date arrives.';
    }
    renderMembersTable();
  }

  function setDirectoryMode(mode) {
    directoryMode = 'members';
    setMembershipDirectory(mode === 'trainee' ? 'Trainee Period' : mode === 'probationary' ? 'Probationary Period' : 'Membership Period');
  }

  function lookupMatches() {
    const search = normalize(el('lookupSearch').value);
    const source = search ? members.filter((member) => [member.fullName, member.membershipId, member.studentNumber, member.membershipStage, member.periodGroup].map(normalize).join(' ').includes(search)) : members;
    return source.sort((a, b) => String(a.fullName).localeCompare(String(b.fullName))).slice(0, 30);
  }

  function renderLookupResults() {
    const results = lookupMatches();
    el('lookupResults').innerHTML = results.length ? results.map((member) => `
      <button class="lookup-result ${selectedMemberId === member.id ? 'active' : ''}" data-lookup-id="${safeText(member.id)}">
        <div class="member-avatar">${safeText(initials(member.fullName))}</div>
        <div><strong>${safeText(member.fullName)}</strong><small>${safeText(member.membershipId)} • ${safeText(member.periodGroup)} • ${safeText(member.studentNumber || 'No student number')}</small></div>
      </button>
    `).join('') : `<div class="empty-state"><div class="empty-icon">?</div><h4>No matching member</h4><p>Try a different name or number.</p></div>`;
    if (selectedMemberId) renderMemberRecord(selectedMemberId);
  }

  function recordField(label, value) {
    return `<div class="record-field"><span>${safeText(label)}</span><strong>${safeText(value || '—')}</strong></div>`;
  }

  function renderMemberRecord(id) {
    const member = members.find((item) => item.id === id);
    if (!member) {
      selectedMemberId = null;
      el('recordPlaceholder').classList.remove('hidden');
      el('memberRecord').classList.add('hidden');
      return;
    }
    selectedMemberId = id;
    el('recordPlaceholder').classList.add('hidden');
    el('memberRecord').classList.remove('hidden');
    el('recordName').textContent = member.fullName;
    el('recordIdentity').textContent = `${member.membershipId} • Student No. ${member.studentNumber || '—'}`;
    el('recordBadges').innerHTML = `
      <span class="badge ${getStatusBadge(member.memberStatus)}">${safeText(member.memberStatus || 'Unspecified')}</span>
      <span class="badge ${getPeriodBadge(member.periodGroup)}">${safeText(member.periodGroup)}</span>
      <span class="badge badge-blue">${safeText(member.orchestraSection || 'No section')}</span>
      <span class="badge ${getReviewBadge(member.reviewStatus)}">${safeText(member.reviewStatus)}</span>
      <span class="badge ${member.recordQuality >= 90 ? 'badge-green' : member.recordQuality >= 70 ? 'badge-gold' : 'badge-red'}">${safeText(member.recordQuality)}% complete</span>`;
    el('recordGrid').innerHTML = [
      recordField('Birthdate', toDateLabel(member.birthdate)), recordField('Age', member.age), recordField('Sex', member.sex),
      recordField('Contact Number', member.contactNumber), recordField('Home Address', member.homeAddress), recordField('DLSUD Outlook', member.outlook),
      recordField('Emergency Contact', member.emergencyContactName), recordField('Emergency Contact Relationship', member.emergencyContactRelationship), recordField('Emergency Contact Number', member.emergencyContactNumber),
      recordField('Alternative Contact', member.alternativeContactNumber),
      recordField('College', member.college), recordField('Course', member.course), recordField('Year Level', member.yearLevel),
      recordField('Section', member.section), recordField('CYS', member.cys), recordField('Academic Status', member.academicStatus),
      recordField('Position in Organization', member.organizationPosition), recordField('Specific Organization Role', member.organizationRole), recordField('Member Status', member.memberStatus),
      recordField('Current Membership Period', member.periodGroup), recordField('Trainee Period Start', toDateLabel(member.traineeStartDate)),
      recordField('Probationary Period Start', member.probationarySkipped ? 'Skipped' : toDateLabel(member.probationaryStartDate)), recordField('Membership Period Start', toDateLabel(member.regularMemberDate)),
      recordField('Stage Timeline Status', member.stagePeriodStatus), recordField('Orchestra Section', member.orchestraSection),
      recordField('Primary Instrument', member.primaryInstrument),
      recordField('Date Registered', toDateLabel(member.dateRegistered)), recordField('Last Profile Review', toDateLabel(member.lastProfileReview)), recordField('Record Quality', `${member.recordQuality}%`)
    ].join('');
    const notes = [member.stageNotes ? `Recruitment / stage notes:\n${member.stageNotes}` : '', member.remarks || ''].filter(Boolean).join('\n\n');
    el('recordRemarks').textContent = notes || 'No remarks recorded.';
    qsa('[data-lookup-id]').forEach((button) => button.classList.toggle('active', button.dataset.lookupId === id));
  }

  function printSelectedMemberRecord() {
    const member = members.find((item) => item.id === selectedMemberId);
    if (!member) { showToast('Select a member record first.', true); return; }
    const fields = [
      ['Membership ID', member.membershipId], ['Student Number', member.studentNumber], ['Current Period', member.periodGroup],
      ['Member Status', member.memberStatus], ['Orchestra Section', member.orchestraSection], ['Primary Instrument', member.primaryInstrument],
      ['Contact Number', member.contactNumber], ['DLSUD Outlook', member.outlook], ['College / Course', [member.college, member.course].filter(Boolean).join(' — ')],
      ['Year / Section', [member.yearLevel, member.section].filter(Boolean).join(' — ')], ['Emergency Contact', member.emergencyContactName],
      ['Emergency Number', member.emergencyContactNumber], ['Trainee Period Start', toDateLabel(member.traineeStartDate)],
      ['Probationary Period Start', member.probationarySkipped ? 'Skipped — duty record archived' : toDateLabel(member.probationaryStartDate)], ['Membership Period Start', toDateLabel(member.regularMemberDate)],
      ['Date Registered', toDateLabel(member.dateRegistered)], ['Profile Review', member.reviewStatus], ['Record Quality', `${member.recordQuality}%`]
    ];
    const popup = window.open('', '_blank', 'width=980,height=760');
    if (!popup) { showToast('Allow pop-ups to print the member document.', true); return; }
    popup.document.write(`<!doctype html><html><head><title>${safeText(member.fullName)} — Official Member Record</title><style>
      @page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17362d;margin:0}.head{border-bottom:4px solid #167055;padding-bottom:14px;margin-bottom:18px;display:flex;justify-content:space-between}.brand{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#167055;font-weight:700}h1{margin:5px 0 3px;font-size:26px}.id{font-size:13px;color:#5d746b}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#e1f5ea;color:#0d6c49;font-size:12px;font-weight:700}.grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid #d8e6df}.field{padding:11px 13px;border-right:1px solid #d8e6df;border-bottom:1px solid #d8e6df;min-height:58px}.field:nth-child(even){border-right:0}.field span{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#6c8079;margin-bottom:5px}.field strong{font-size:13px}.notes{margin-top:16px;padding:14px;border:1px solid #d8e6df;white-space:pre-wrap;min-height:80px}.sign{display:grid;grid-template-columns:1fr 1fr;gap:70px;margin-top:60px;text-align:center}.sign div{border-top:1px solid #333;padding-top:7px;font-size:12px}.foot{margin-top:25px;font-size:10px;color:#6c8079;text-align:center}${window.LSOBrand?.printCss || ''}@media print{button{display:none}}</style></head><body>
      ${window.LSOBrand.printHeader({ title: member.fullName, subtitle: 'Official Member Record', meta: `Generated ${toDateLabel(getToday())}`, badge: member.periodGroup })}
      <div class="grid">${fields.map(([label,value])=>`<div class="field"><span>${safeText(label)}</span><strong>${safeText(value||'—')}</strong></div>`).join('')}</div>
      <div class="notes"><strong>Remarks / Evaluation Notes</strong><br><br>${safeText([member.stageNotes,member.remarks].filter(Boolean).join('\n\n')||'No remarks recorded.')}</div>
      <div class="sign"><div>Member Signature</div><div>Authorized Officer</div></div><div class="foot">This document was generated from the LSO Orchestra Management System.</div>
      ${window.LSOBrand.printRuntimeScript}</body></html>`);
    popup.document.close();
  }

  function renderStorage() {
    const raw = window.LSOStorage.getItem(STORAGE_KEY) || '';
    const bytes = new Blob([raw]).size;
    const maxEstimate = 5 * 1024 * 1024;
    const percent = Math.min(100, Math.round((bytes / maxEstimate) * 100));
    el('storageMeter').style.width = `${Math.max(percent, members.length ? 1 : 0)}%`;
    el('storageLabel').textContent = `${members.length} shared record${members.length === 1 ? '' : 's'} • ${(bytes / 1024).toFixed(1)} KB browser cache`;
  }

  function renderAll() {
    renderDashboard();
    renderMembersTable();
    renderLookupResults();
    renderStorage();
  }

  function openMemberModal(member = null) {
    if (!requireAdmin()) return;
    el('memberForm').reset();
    el('formMessage').classList.add('hidden');
    el('editingId').value = member?.id || '';
    el('modalTitle').textContent = member ? 'Edit Member Record' : 'Register New Member';
    el('dateRegistered').value = member?.dateRegistered || getToday();
    el('membershipStage').value = member?.membershipStage || 'Trainee';
    el('traineeStartDate').value = member?.traineeStartDate || member?.dateRegistered || getToday();
    el('memberStatus').value = member?.memberStatus || 'Active';

    const fieldMap = {
      fullName: 'fullName', birthdate: 'birthdate', age: 'age', sex: 'sex', contactNumber: 'contactNumber', homeAddress: 'homeAddress', emergencyContactName: 'emergencyContactName', emergencyContactRelationship: 'emergencyContactRelationship', emergencyContactNumber: 'emergencyContactNumber', alternativeContactNumber: 'alternativeContactNumber', studentNumber: 'studentNumber',
      college: 'college', course: 'course', yearLevel: 'yearLevel', section: 'academicSection', cys: 'cys', outlook: 'outlook',
      academicStatus: 'academicStatus', organizationPosition: 'organizationPosition', organizationRole: 'organizationRole',
      memberStatus: 'memberStatus', traineeStartDate: 'traineeStartDate', probationaryStartDate: 'probationaryStartDate', regularMemberDate: 'regularMemberDate', regularPeriod2StartDate: 'regularPeriod2StartDate', stageNotes: 'stageNotes',
      orchestraSection: 'orchestraSection', primaryInstrument: 'primaryInstrument', dateRegistered: 'dateRegistered', lastProfileReview: 'lastProfileReview', reviewStatus: 'reviewStatus', remarks: 'remarks'
    };
    if (member) Object.entries(fieldMap).forEach(([key, id]) => { el(id).value = member[key] ?? ''; });
    if (el('probationarySkipped')) el('probationarySkipped').checked = Boolean(member?.probationarySkipped || (member?.regularMemberDate && !member?.probationaryStartDate));
    if (el('probationaryStartDate')) el('probationaryStartDate').disabled = Boolean(el('probationarySkipped')?.checked);
    if (el('stageTimelineNote')) el('stageTimelineNote').innerHTML = el('probationarySkipped')?.checked
      ? '<strong>Direct transition:</strong> Trainee Period → Membership Period. The Probationary duty ledger remains available in the archive and is included in combined totals.'
      : '<strong>Automatic transition:</strong> Trainee Period → Probationary Period → Membership Period. Once the Membership Period start date arrives, the person automatically appears in the Members list.';
    updateAutomaticStagePreview();
    el('memberModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => el('fullName').focus(), 50);
  }

  function closeMemberModal() {
    el('memberModal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function collectFormData() {
    const editingId = el('editingId').value;
    const existing = members.find((member) => member.id === editingId);
    const dateRegistered = el('dateRegistered').value || getToday();
    const member = {
      id: existing?.id || (crypto.randomUUID ? crypto.randomUUID() : `member-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      membershipId: existing?.membershipId || generateMembershipId(dateRegistered),
      fullName: el('fullName').value.trim(),
      birthdate: el('birthdate').value,
      age: el('age').value.trim() || ageFromBirthdate(el('birthdate').value),
      sex: el('sex').value,
      contactNumber: el('contactNumber').value.trim(),
      homeAddress: el('homeAddress').value.trim(),
      emergencyContactName: el('emergencyContactName').value.trim(),
      emergencyContactRelationship: el('emergencyContactRelationship').value.trim(),
      emergencyContactNumber: el('emergencyContactNumber').value.trim(),
      alternativeContactNumber: el('alternativeContactNumber').value.trim(),
      studentNumber: el('studentNumber').value.trim(),
      college: el('college').value.trim(),
      course: el('course').value.trim(),
      yearLevel: el('yearLevel').value,
      section: el('academicSection').value.trim(),
      cys: el('cys').value.trim(),
      outlook: el('outlook').value.trim(),
      academicStatus: el('academicStatus').value,
      organizationPosition: el('organizationPosition').value,
      organizationRole: el('organizationRole').value.trim(),
      memberStatus: el('memberStatus').value,
      membershipStage: el('membershipStage').value,
      traineeStartDate: el('traineeStartDate').value || dateRegistered,
      probationaryStartDate: el('probationarySkipped')?.checked ? '' : el('probationaryStartDate').value,
      probationarySkipped: Boolean(el('probationarySkipped')?.checked),
      regularMemberDate: el('regularMemberDate').value,
      regularPeriod2StartDate: el('regularPeriod2StartDate').value,
      stageNotes: el('stageNotes').value.trim(),
      orchestraSection: el('orchestraSection').value,
      primaryInstrument: el('primaryInstrument').value.trim(),
      dateRegistered,
      lastProfileReview: el('lastProfileReview').value,
      reviewStatus: el('reviewStatus').value,
      remarks: el('remarks').value.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!member.cys) member.cys = buildCys(member.course, member.yearLevel, member.section);
    return enrichMember(member);
  }

  function buildCys(course, yearLevel, section) {
    const coursePart = String(course || '').trim().split(/\s+/).map((word) => word[0]).join('').toUpperCase();
    const yearPart = String(yearLevel || '').match(/\d+/)?.[0] || '';
    const sectionPart = String(section || '').trim().toUpperCase();
    return [coursePart, yearPart, sectionPart].filter(Boolean).join('-');
  }

  function validateMember(member) {
    const required = [
      ['fullName', 'Full Name'], ['studentNumber', 'Student Number'], ['outlook', 'DLSUD Outlook'],
      ['emergencyContactName', 'Emergency Contact Name'], ['emergencyContactRelationship', 'Emergency Contact Relationship'], ['emergencyContactNumber', 'Emergency Contact Number'],
      ['organizationPosition', 'Position in Organization'], ['memberStatus', 'Member Status'], ['traineeStartDate', 'Trainee Start Date'],
      ['orchestraSection', 'Orchestra Section'], ['primaryInstrument', 'Primary Instrument'], ['dateRegistered', 'Date Registered']
    ];
    const missing = required.filter(([key]) => !String(member[key] || '').trim()).map(([, label]) => label);
    if (missing.length) return `Please complete: ${missing.join(', ')}.`;
    if (member.probationarySkipped && !member.regularMemberDate) return 'Set the Membership Period Start when the Probationary Period is skipped.';
    if (member.probationarySkipped && member.probationaryStartDate) return 'Clear the Probationary Period Start or turn off Skip Probationary Period.';
    if (member.probationaryStartDate && member.probationaryStartDate <= member.traineeStartDate) return 'Probationary Start Date must be later than the Trainee Start Date.';
    if (member.regularMemberDate && !member.probationaryStartDate && !member.probationarySkipped) return 'Set the Probationary Period Start or select Skip the Probationary Period.';
    if (member.regularMemberDate && member.probationarySkipped && member.regularMemberDate <= member.traineeStartDate) return 'Membership Period Start must be later than the Trainee Start Date.';
    if (member.regularMemberDate && member.probationaryStartDate && member.regularMemberDate <= member.probationaryStartDate) return 'Membership Period Start must be later than the Probationary Period Start.';

    const duplicateStudent = members.find((item) => item.id !== member.id && normalize(item.studentNumber) === normalize(member.studentNumber));
    if (duplicateStudent) return `Student Number already belongs to ${duplicateStudent.fullName}.`;
    const duplicateOutlook = members.find((item) => item.id !== member.id && normalize(item.outlook) === normalize(member.outlook));
    if (duplicateOutlook) return `DLSUD Outlook account already belongs to ${duplicateOutlook.fullName}.`;
    return '';
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const member = collectFormData();
    const error = validateMember(member);
    if (error) {
      el('formMessage').textContent = error;
      el('formMessage').classList.remove('hidden');
      return;
    }
    const index = members.findIndex((item) => item.id === member.id);
    if (index >= 0) members[index] = member;
    else members.push(member);
    selectedMemberId = member.id;
    saveMembers();
    window.LSOOperations?.logActivity(index >= 0 ? 'Updated member' : 'Registered member', 'Members', `${member.fullName} (${member.membershipId})`);
    closeMemberModal();
    showToast(index >= 0 ? 'Member record updated.' : `Member registered as ${member.membershipId}.`);
  }

  function deleteMember(id) {
    if (!requireAdmin()) return;
    const member = members.find((item) => item.id === id);
    if (!member) return;
    if (!window.confirm(`Delete the record of ${member.fullName}? This cannot be undone unless you have a backup.`)) return;
    members = members.filter((item) => item.id !== id);
    if (selectedMemberId === id) selectedMemberId = null;
    saveMembers();
    window.LSOOperations?.logActivity('Deleted member', 'Members', `${member.fullName} (${member.membershipId})`);
    showToast('Member record deleted.');
  }

  function exportCsv(records = members, filename = 'LSO_Member_Database.csv') {
    const header = CSV_FIELDS.map(([, label]) => csvEscape(label)).join(',');
    const rows = records.map((member) => CSV_FIELDS.map(([key]) => csvEscape(member[key] ?? '')).join(','));
    downloadFile(filename, `\uFEFF${[header, ...rows].join('\r\n')}`, 'text/csv;charset=utf-8');
    showToast(`Exported ${records.length} record${records.length === 1 ? '' : 's'} to CSV.`);
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadFile(filename, content, type) {
    downloadBlob(filename, new Blob([content], { type }));
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

  function backupJson() {
    const payload = {
      application: 'Lasallian Symphony Orchestra Member Database',
      version: 4,
      exportedAt: new Date().toISOString(),
      members
    };
    const date = getToday();
    downloadFile(`LSO_Member_Database_Backup_${date}.json`, JSON.stringify(payload, null, 2), 'application/json');
    showToast('JSON backup downloaded.');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"' && quoted && next === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && next === '\n') i += 1;
        row.push(cell); cell = '';
        if (row.some((value) => value !== '')) rows.push(row);
        row = [];
      } else cell += char;
    }
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
    return rows;
  }

  function importCsv(file) {
    if (!requireAdmin('Administrator access is required to import member records.')) { if (el('csvImport')) el('csvImport').value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result || '').replace(/^\uFEFF/, ''));
        if (rows.length < 2) throw new Error('The CSV has no data rows.');
        const headers = rows[0].map((header) => header.trim());
        const keyByHeader = Object.fromEntries(CSV_FIELDS.map(([key, label]) => [normalize(label), key]));
        const imported = [];
        const skipped = [];
        rows.slice(1).forEach((row, rowIndex) => {
          const member = {};
          headers.forEach((header, index) => {
            const key = keyByHeader[normalize(header)];
            if (key) member[key] = row[index]?.trim() || '';
          });
          if (!member.fullName || !member.studentNumber) { skipped.push(rowIndex + 2); return; }
          const duplicate = [...members, ...imported].some((item) => normalize(item.studentNumber) === normalize(member.studentNumber) || (member.outlook && normalize(item.outlook) === normalize(member.outlook)));
          if (duplicate) { skipped.push(rowIndex + 2); return; }
          const dateRegistered = member.dateRegistered || getToday();
          imported.push(enrichMember({
            ...member,
            id: crypto.randomUUID ? crypto.randomUUID() : `member-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            membershipId: member.membershipId || generateMembershipId(dateRegistered, [...members, ...imported]),
            dateRegistered,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }));
        });
        members.push(...imported);
        saveMembers();
        window.LSOOperations?.logActivity('Imported member records', 'Data', `${imported.length} imported; ${skipped.length} skipped`);
        showToast(`Imported ${imported.length} record${imported.length === 1 ? '' : 's'}${skipped.length ? `; skipped ${skipped.length} incomplete or duplicate row${skipped.length === 1 ? '' : 's'}` : ''}.`);
      } catch (error) {
        showToast(error.message || 'Unable to import CSV.', true);
      } finally {
        el('csvImport').value = '';
      }
    };
    reader.onerror = () => showToast('Unable to read the CSV file.', true);
    reader.readAsText(file);
  }

  function restoreJson(file) {
    if (!requireAdmin('Administrator access is required to restore member records.')) { if (el('jsonRestore')) el('jsonRestore').value = ''; return; }
    if (window.LSOCurrentAccount?.role !== 'Administrator') { showToast('Administrator access is required to restore a database.', true); el('jsonRestore').value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        const records = Array.isArray(parsed) ? parsed : parsed.members;
        if (!Array.isArray(records)) throw new Error('This is not a valid LSO database backup.');
        if (!window.confirm(`Restore ${records.length} records? This will replace the current shared member database.`)) return;
        const restored = [];
        records.forEach((member) => {
          restored.push(enrichMember({
            ...member,
            id: member.id || (crypto.randomUUID ? crypto.randomUUID() : `member-${Date.now()}-${Math.random().toString(16).slice(2)}`),
            membershipId: member.membershipId || generateMembershipId(member.dateRegistered, restored)
          }));
        });
        members = restored;
        selectedMemberId = null;
        saveMembers();
        window.LSOOperations?.logActivity('Restored member database', 'Data', `${restored.length} member records`);
        showToast('Database restored successfully.');
      } catch (error) {
        showToast(error.message || 'Unable to restore the backup.', true);
      } finally {
        el('jsonRestore').value = '';
      }
    };
    reader.onerror = () => showToast('Unable to read the JSON file.', true);
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const header = CSV_FIELDS.map(([, label]) => csvEscape(label)).join(',');
    downloadFile('LSO_Member_Import_Template.csv', `\uFEFF${header}\r\n`, 'text/csv;charset=utf-8');
    showToast('CSV import template downloaded.');
  }

  function clearDatabase() {
    if (window.LSOCurrentAccount?.role !== 'Administrator') { showToast('Administrator access is required to clear the database.', true); return; }
    if (!members.length) { showToast('The database is already empty.'); return; }
    const confirmation = window.prompt('Type CLEAR LSO to permanently remove all shared member records from every device.');
    if (confirmation !== 'CLEAR LSO') { showToast('Clear operation cancelled.'); return; }
    members = [];
    selectedMemberId = null;
    saveMembers();
    window.LSOOperations?.logActivity('Cleared member database', 'Data', 'All member records were removed');
    showToast('All shared member records were cleared.');
  }


  function updateAutomaticStagePreview() {
    const draft = {
      membershipStage: el('membershipStage').value || 'Trainee',
      traineeStartDate: el('traineeStartDate').value,
      probationaryStartDate: el('probationarySkipped')?.checked ? '' : el('probationaryStartDate').value,
      probationarySkipped: Boolean(el('probationarySkipped')?.checked),
      regularMemberDate: el('regularMemberDate').value
    };
    const stage = calculateMembershipStage(draft);
    const periodGroup = calculatePeriodGroup(draft);
    el('membershipStage').value = stage;
    el('automaticStagePreview').textContent = periodGroup;
    el('automaticStagePreview').className = `auto-stage-value ${getPeriodBadge(periodGroup)}`;
    el('automaticStageHelp').textContent = calculateStagePeriodStatus(draft);
    document.querySelectorAll('[data-entry-stage]').forEach((button) => button.classList.toggle('active', button.dataset.entryStage === periodGroup));
  }

  function refreshAutomaticStages(showNotice = false) {
    const before = JSON.stringify(members.map((member) => [member.membershipStage, member.periodGroup, member.traineeStartDate, member.probationaryStartDate, member.regularMemberDate]));
    members = members.map(enrichMember);
    const after = JSON.stringify(members.map((member) => [member.membershipStage, member.periodGroup, member.traineeStartDate, member.probationaryStartDate, member.regularMemberDate]));
    if (before !== after && isAdmin()) {
      window.LSOStorage.setItem(STORAGE_KEY, JSON.stringify(members));
      renderAll();
      if (showNotice) showToast('Membership stages were updated automatically.');
    }
  }

  function scheduleStageRefresh() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 2, 0);
    setTimeout(() => {
      refreshAutomaticStages(true);
      setInterval(() => refreshAutomaticStages(true), 86_400_000);
    }, Math.max(1_000, next.getTime() - now.getTime()));
  }

  function wireEvents() {
    qsa('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    qsa('[data-jump]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.jump)));
    el('mobileMenuButton').addEventListener('click', () => el('sidebar').classList.toggle('open'));
    el('memberListMode').addEventListener('click', () => setMembershipDirectory('Membership Period'));
    el('probationaryTab').addEventListener('click', () => setMembershipDirectory('Probationary Period'));
    el('traineeTab').addEventListener('click', () => setMembershipDirectory('Trainee Period'));

    ['addMemberTop', 'addMemberHero', 'addMemberMembers'].forEach((id) => el(id).addEventListener('click', () => openMemberModal()));
    el('closeMemberModal').addEventListener('click', closeMemberModal);
    el('cancelMemberForm').addEventListener('click', closeMemberModal);
    el('memberModal').addEventListener('click', (event) => { if (event.target === el('memberModal')) closeMemberModal(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !el('memberModal').classList.contains('hidden')) closeMemberModal(); });
    el('memberForm').addEventListener('submit', handleSubmit);

    ['course', 'yearLevel', 'academicSection'].forEach((id) => el(id).addEventListener('input', () => {
      if (!el('editingId').value || !el('cys').value.trim()) el('cys').value = buildCys(el('course').value, el('yearLevel').value, el('academicSection').value);
    }));
    el('birthdate').addEventListener('change', () => { if (!el('age').value) el('age').value = ageFromBirthdate(el('birthdate').value); });
    ['traineeStartDate', 'probationaryStartDate', 'regularMemberDate'].forEach((id) => el(id).addEventListener('change', updateAutomaticStagePreview));
    el('probationarySkipped')?.addEventListener('change', () => {
      const skipped = el('probationarySkipped').checked;
      if (skipped) el('probationaryStartDate').value = '';
      el('probationaryStartDate').disabled = skipped;
      if (el('stageTimelineNote')) el('stageTimelineNote').innerHTML = skipped
        ? '<strong>Direct transition:</strong> Trainee Period → Membership Period. The Probationary duty ledger remains available in the archive and is included in combined totals.'
        : '<strong>Automatic transition:</strong> Trainee Period → Probationary Period → Membership Period. Once the Membership Period start date arrives, the person automatically appears in the Members list.';
      updateAutomaticStagePreview();
    });
    el('dateRegistered').addEventListener('change', () => {
      if (!el('traineeStartDate').value) el('traineeStartDate').value = el('dateRegistered').value;
      updateAutomaticStagePreview();
    });

    ['memberSearch', 'statusFilter', 'sectionFilter', 'positionFilter'].forEach((id) => el(id).addEventListener(id === 'memberSearch' ? 'input' : 'change', renderMembersTable));
    el('clearFilters').addEventListener('click', () => {
      el('memberSearch').value = '';
      el('statusFilter').value = '';
      el('sectionFilter').value = '';
      el('positionFilter').value = '';
      renderMembersTable();
    });

    const handleDirectoryAction = (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const member = members.find((item) => item.id === button.dataset.id);
      if (!member) return;
      if (button.dataset.action === 'edit') openMemberModal(member);
      if (button.dataset.action === 'delete') deleteMember(member.id);
      if (button.dataset.action === 'view') {
        selectedMemberId = member.id;
        setView('lookupView');
        renderMemberRecord(member.id);
      }
    };
    el('membersTableBody').addEventListener('click', handleDirectoryAction);
    el('periodGroupsContainer').addEventListener('click', handleDirectoryAction);

    el('recentMembers').addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-record]');
      if (!button) return;
      selectedMemberId = button.dataset.openRecord;
      setView('lookupView');
      renderMemberRecord(selectedMemberId);
    });

    el('lookupSearch').addEventListener('input', renderLookupResults);
    el('lookupResults').addEventListener('click', (event) => {
      const button = event.target.closest('[data-lookup-id]');
      if (!button) return;
      renderMemberRecord(button.dataset.lookupId);
    });
    el('editRecordButton').addEventListener('click', () => {
      const member = members.find((item) => item.id === selectedMemberId);
      if (member) openMemberModal(member);
    });
    el('printRecordButton').addEventListener('click', printSelectedMemberRecord);

    ['exportCsvTop', 'exportCsvData'].forEach((id) => el(id).addEventListener('click', () => exportCsv()));
    el('backupJson').addEventListener('click', backupJson);
    el('downloadTemplate').addEventListener('click', downloadTemplate);
    el('csvImport').addEventListener('change', (event) => { if (event.target.files[0]) importCsv(event.target.files[0]); });
    el('jsonRestore').addEventListener('change', (event) => { if (event.target.files[0]) restoreJson(event.target.files[0]); });
    el('clearDatabase').addEventListener('click', clearDatabase);

  }

  window.LSOApp = {
    getMembers: () => members.map((member) => ({ ...member })),
    setMembershipDirectory,
    getSelectedMemberId: () => selectedMemberId,
    getMemberById: (id) => {
      const member = members.find((item) => item.id === id);
      return member ? { ...member } : null;
    },
    refresh: () => { members = loadMembers(); renderAll(); },
    openMember: (id) => {
      const member = members.find((item) => item.id === id);
      if (member) openMemberModal(member);
    },
    openRecord: (id) => {
      selectedMemberId = id;
      setView('lookupView');
      renderMemberRecord(id);
    },
    showToast,
    getToday,
    setView
  };

  window.addEventListener('lso:cloud-state-changed', (event) => {
    if (event.detail?.key && event.detail.key !== STORAGE_KEY) return;
    members = loadMembers();
    renderAll();
  });

  if (typeof window !== 'undefined' && window.__LSO_TEST_MODE__) return;
  refreshAutomaticStages(false);
  wireEvents();
  renderAll();
  scheduleStageRefresh();
})();
