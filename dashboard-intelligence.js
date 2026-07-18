(() => {
  'use strict';

  const MEMBER_KEY = 'lso_member_database_v1';
  const EVENTS_KEY = 'lso_events_v2';

  const el = (id) => document.getElementById(id);

  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function loadArray(key) {
    try {
      const storage = window.LSOStorage || window.localStorage;
      const parsed = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function getMembers() {
    return window.LSOApp?.getMembers?.() || loadArray(MEMBER_KEY);
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function currentStage(member) {
    const period = normalize(member?.periodGroup);
    if (period.includes('trainee')) return 'Trainee Period';
    if (period.includes('probationary')) return 'Probationary Period';
    if (period.includes('membership') || period.includes('regular')) return 'Membership Period';

    const stage = normalize(member?.membershipStage);
    if (stage.includes('trainee')) return 'Trainee Period';
    if (stage.includes('probationary')) return 'Probationary Period';
    return 'Membership Period';
  }

  function genderOf(member) {
    const sex = normalize(member?.sex);
    if (sex === 'male' || sex === 'm') return 'Male';
    if (sex === 'female' || sex === 'f') return 'Female';
    return 'Unspecified';
  }

  function percent(value, total) {
    return total ? Math.round((value / total) * 100) : 0;
  }

  function stageSummary(stage, members) {
    const stageMembers = members.filter((member) => currentStage(member) === stage);
    const male = stageMembers.filter((member) => genderOf(member) === 'Male').length;
    const female = stageMembers.filter((member) => genderOf(member) === 'Female').length;
    const unspecified = stageMembers.length - male - female;
    const active = stageMembers.filter((member) => !['nonactive', 'loa'].includes(normalize(member.memberStatus))).length;
    return { stage, members: stageMembers, total: stageMembers.length, male, female, unspecified, active };
  }

  function renderStageCard(summary, index) {
    const labels = {
      'Membership Period': ['Official Members', 'Official roster'],
      'Trainee Period': ['Trainees', 'Training stage'],
      'Probationary Period': ['Probationary', 'Evaluation stage']
    };
    const [title, eyebrow] = labels[summary.stage] || [summary.stage, 'Membership stage'];
    const malePercent = percent(summary.male, summary.total);
    const femalePercent = percent(summary.female, summary.total);
    const otherPercent = Math.max(0, 100 - malePercent - femalePercent);

    return `<button class="gender-stage-card" data-gender-stage="${safeText(summary.stage)}" type="button" aria-label="Open ${safeText(title)} directory">
      <div class="gender-stage-top">
        <div class="gender-stage-copy"><small>0${index + 1} • ${safeText(eyebrow)}</small><strong>${safeText(title)}</strong></div>
        <span class="gender-total-badge">${summary.total}</span>
      </div>
      <div class="gender-split">
        <div class="gender-count"><span>Male</span><strong>${summary.male}</strong><em>${malePercent}% of stage</em></div>
        <div class="gender-count"><span>Female</span><strong>${summary.female}</strong><em>${femalePercent}% of stage</em></div>
      </div>
      <div class="gender-bar" aria-label="${malePercent}% male, ${femalePercent}% female, ${otherPercent}% unspecified">
        <i class="male-bar" style="width:${malePercent}%"></i><i class="female-bar" style="width:${femalePercent}%"></i><i class="other-bar" style="width:${otherPercent}%"></i>
      </div>
      <div class="gender-stage-footer"><span>${summary.active} current active record${summary.active === 1 ? '' : 's'}${summary.unspecified ? ` • ${summary.unspecified} unspecified` : ''}</span><b>Open roster →</b></div>
    </button>`;
  }

  function readinessData(members) {
    const averageQuality = members.length
      ? Math.round(members.reduce((sum, member) => sum + Number(member.recordQuality || 0), 0) / members.length)
      : 0;
    const incomplete = members.filter((member) => Number(member.recordQuality || 0) < 90).length;
    const missingGender = members.filter((member) => genderOf(member) === 'Unspecified').length;
    const missingEmergency = members.filter((member) => !String(member.emergencyContactName || '').trim() || !String(member.emergencyContactNumber || '').trim()).length;
    const reviewDue = members.filter((member) => ['for review', 'overdue'].includes(normalize(member.reviewStatus))).length;
    const pendingAccounts = (window.LSOAuth?.loadAccounts?.() || []).filter((account) => account.approvalStatus === 'Pending').length;
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const todayValue = new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
    const futureDate = new Date(now.getTime() + 7 * 86400000);
    const future = new Date(futureDate.getTime() - futureDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const nextSevenDays = loadArray(EVENTS_KEY).filter((event) => event.date >= todayValue && event.date <= future).length;
    return { averageQuality, incomplete, missingGender, missingEmergency, reviewDue, pendingAccounts, nextSevenDays };
  }

  function renderReadiness(data) {
    const accountRow = window.LSOCurrentAccount?.role === 'Administrator'
      ? `<button class="readiness-item" data-readiness-action="accounts" type="button"><span class="readiness-icon">A</span><span><strong>Pending account requests</strong><small>Administrator validation queue</small></span><b class="readiness-value">${data.pendingAccounts}</b></button>`
      : '';

    return `<article class="panel dashboard-readiness-panel">
      <div class="panel-header"><div><p class="eyebrow">System Readiness</p><h3>Profile &amp; Operations Health</h3><p class="panel-subtitle">Live checks that keep records usable and audit-ready.</p></div></div>
      <div class="readiness-overview">
        <div class="readiness-ring" style="--readiness:${data.averageQuality}"><div><strong>${data.averageQuality}%</strong><small>Data quality</small></div></div>
        <div class="readiness-copy"><h4>${data.averageQuality >= 90 ? 'Records are in strong shape' : data.averageQuality >= 70 ? 'Some profiles need attention' : 'Record completion needs action'}</h4><p>Completeness is calculated from the required member-profile fields already used by the database.</p></div>
      </div>
      <div class="readiness-list">
        <button class="readiness-item" data-readiness-action="alerts" type="button"><span class="readiness-icon">!</span><span><strong>Incomplete profiles</strong><small>Below 90% record completeness</small></span><b class="readiness-value">${data.incomplete}</b></button>
        <button class="readiness-item" data-readiness-action="alerts" type="button"><span class="readiness-icon">ID</span><span><strong>Missing gender entry</strong><small>Not included as Male or Female</small></span><b class="readiness-value">${data.missingGender}</b></button>
        <button class="readiness-item" data-readiness-action="alerts" type="button"><span class="readiness-icon">+</span><span><strong>Safety contact gaps</strong><small>Missing emergency contact details</small></span><b class="readiness-value">${data.missingEmergency}</b></button>
        <button class="readiness-item" data-readiness-action="alerts" type="button"><span class="readiness-icon">↻</span><span><strong>Profiles due for review</strong><small>For Review or Overdue</small></span><b class="readiness-value">${data.reviewDue}</b></button>
        <button class="readiness-item" data-readiness-action="attendance" type="button"><span class="readiness-icon">7D</span><span><strong>Activities in the next 7 days</strong><small>Upcoming rehearsals and events</small></span><b class="readiness-value">${data.nextSevenDays}</b></button>
        ${accountRow}
      </div>
    </article>`;
  }

  function render() {
    const host = el('dashboardIntelligenceHub');
    if (!host) return;
    const members = getMembers();
    const stages = [
      stageSummary('Membership Period', members),
      stageSummary('Trainee Period', members),
      stageSummary('Probationary Period', members)
    ];
    const totalMale = stages.reduce((sum, item) => sum + item.male, 0);
    const totalFemale = stages.reduce((sum, item) => sum + item.female, 0);
    const totalUnspecified = stages.reduce((sum, item) => sum + item.unspecified, 0);

    host.innerHTML = `<div class="dashboard-intelligence-shell">
      <article class="panel dashboard-intelligence-panel">
        <div class="panel-header">
          <div><p class="eyebrow">People Intelligence</p><h3>Gender Summary by Membership Stage</h3><p class="panel-subtitle">Current Official, Trainee, and Probationary rosters are calculated separately.</p></div>
          <div class="intelligence-header-actions"><span class="intelligence-live-pill">Live roster data</span></div>
        </div>
        <div class="gender-stage-grid">${stages.map(renderStageCard).join('')}</div>
        <div class="gender-stage-footer" style="margin-top:14px"><span>Organization total: <strong>${members.length}</strong> profiles • Male <strong>${totalMale}</strong> • Female <strong>${totalFemale}</strong>${totalUnspecified ? ` • Unspecified <strong>${totalUnspecified}</strong>` : ''}</span><b>Click a card to open its directory</b></div>
      </article>
      ${renderReadiness(readinessData(members))}
    </div>`;
  }

  function openStage(stage) {
    window.LSOApp?.setView?.('membersView');
    window.LSOApp?.setMembershipDirectory?.(stage);
  }

  function performReadinessAction(action) {
    if (action === 'accounts') {
      window.LSOApp?.setView?.('accountsView');
      return;
    }
    if (action === 'attendance') {
      window.LSOApp?.setView?.('attendanceView');
      return;
    }
    window.LSOApp?.setView?.('alertsView');
  }

  function wire() {
    document.addEventListener('click', (event) => {
      const stageButton = event.target.closest('[data-gender-stage]');
      if (stageButton) openStage(stageButton.dataset.genderStage);
      const readinessButton = event.target.closest('[data-readiness-action]');
      if (readinessButton) performReadinessAction(readinessButton.dataset.readinessAction);
    });

    ['lso:members-changed', 'lso:operations-changed', 'lso:accounts-changed', 'lso:auth-changed', 'lso:cloud-state-changed'].forEach((name) => {
      window.addEventListener(name, () => setTimeout(render, 30));
    });

    document.querySelectorAll('[data-view="dashboardView"]').forEach((button) => {
      button.addEventListener('click', () => setTimeout(render, 30));
    });
  }

  function initialize() {
    wire();
    render();
    window.setInterval(() => {
      if (!el('appShell')?.classList.contains('hidden')) render();
    }, 60_000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
