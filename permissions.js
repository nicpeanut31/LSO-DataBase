(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  let observer = null;
  let applying = false;

  function account() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function role() {
    return window.LSORoleAccess?.role?.(account()) || account()?.role || 'Staff Account';
  }

  function can(action) {
    return window.LSORoleAccess?.can?.(action, account()) ?? role() === 'Administrator';
  }

  function isAdmin() { return role() === 'Administrator'; }
  function isStaff() { return role() === 'Staff Account'; }
  function isMembership() { return role() === 'Membership'; }
  function isSecretary() { return role() === 'General Secretary'; }
  function isTrainee() { return role() === 'Trainee/Probationary'; }

  function notify(action = '', fallback = '') {
    const message = fallback || window.LSORoleAccess?.deniedMessage?.(action) || 'You do not have permission to perform this action.';
    window.LSOApp?.showToast?.(message, true);
  }

  function show(node, visible) {
    if (!node) return;
    node.classList.toggle('hidden', !visible);
    node.classList.toggle('role-hidden', !visible);
    node.setAttribute('aria-hidden', String(!visible));
    if (visible) node.removeAttribute('tabindex');
    else node.tabIndex = -1;
  }

  function enable(node, enabled, title = '') {
    if (!node) return;
    node.disabled = !enabled;
    node.setAttribute('aria-disabled', String(!enabled));
    node.classList.toggle('role-readonly-field', !enabled);
    if (!enabled && title) node.title = title;
    else if (node.title === title || enabled) node.removeAttribute('title');
  }

  function ensureBanner() {
    let banner = el('roleAccessBanner');
    if (!banner) {
      banner = document.createElement('section');
      banner.id = 'roleAccessBanner';
      banner.className = 'staff-readonly-banner hidden';
      banner.setAttribute('role', 'status');
      document.querySelector('.topbar')?.insertAdjacentElement('afterend', banner);
    }
    if (isAdmin() || isTrainee()) {
      banner.classList.add('hidden');
      return;
    }
    const content = isMembership()
      ? ['Membership Operations', 'Dashboard, member records, contracts, monthly reports, Trainee/Probationary draft attendance, and Duty Hours management are available.']
      : isSecretary()
        ? ['General Secretary Access', 'Dashboard and Attendance are available. You can create activities and save attendance drafts; finalization remains Administrator-only.']
        : ['Staff Read-Only Access', 'You can view, search, filter, print, and export visible records. Changes are disabled.'];
    banner.innerHTML = `<span class="staff-readonly-icon" aria-hidden="true">◉</span><div><strong>${content[0]}</strong><p>${content[1]}</p></div>`;
    banner.classList.remove('hidden');
  }

  function applyNavigation() {
    qsa('.nav-item').forEach((node) => {
      const allowed = window.LSORoleAccess?.canAccessView?.(node.dataset.view, account()) ?? true;
      node.classList.toggle('role-hidden', !allowed);
      node.setAttribute('aria-hidden', String(!allowed));
      node.tabIndex = allowed ? 0 : -1;
    });
  }

  function applyMemberControls(root) {
    const allowed = can('manageMembers');
    ['addMemberTop', 'addMemberHero', 'addMemberMembers', 'editRecordButton'].forEach((id) => show(el(id), allowed));
    qsa('[data-action="edit"], [data-action="delete"]', root).forEach((node) => show(node, allowed));
    qsa('#memberForm input, #memberForm select, #memberForm textarea, #memberForm button[type="submit"]', root).forEach((node) => enable(node, allowed, 'Administrator or Membership access is required.'));
  }

  function attendanceGroupAllowed() {
    const group = window.LSOOperations?.getAttendanceGroup?.() || window.LSOAttendanceGroup || 'Official Members';
    return window.LSORoleAccess?.canUseAttendanceGroup?.(group, account()) ?? true;
  }

  function applyWorkflowPermission(node, permitted) {
    if (!node) return;
    if (!permitted) {
      if (!node.classList.contains('hidden')) node.dataset.roleForcedHidden = 'true';
      node.classList.add('hidden', 'role-hidden');
      node.setAttribute('aria-hidden', 'true');
      node.tabIndex = -1;
      return;
    }
    node.classList.remove('role-hidden');
    node.setAttribute('aria-hidden', 'false');
    if (node.dataset.roleForcedHidden === 'true') {
      node.classList.remove('hidden');
      delete node.dataset.roleForcedHidden;
    }
    node.removeAttribute('tabindex');
  }

  function applyAttendanceControls(root) {
    const manageEvents = can('manageEvents');
    const saveDraft = can('saveDraftAttendance') && attendanceGroupAllowed();
    show(el('addEventButton'), manageEvents);
    show(el('createEventOnSelectedDate'), manageEvents);
    show(el('editEventButton'), manageEvents);
    show(el('deleteEventButton'), can('deleteEvents'));
    show(el('markAllPresent'), saveDraft);
    show(el('saveAttendanceButton'), saveDraft);
    applyWorkflowPermission(el('finalizeAttendanceButton'), can('finalizeAttendance'));
    applyWorkflowPermission(el('unlockAttendanceButton'), can('unlockAttendance'));
    qsa('.attendance-status, .attendance-remarks', root).forEach((node) => {
      const finalized = node.classList.contains('attendance-locked-control');
      enable(node, saveDraft && !finalized, finalized ? 'Finalized attendance is locked.' : 'This role cannot edit the selected attendance roster.');
    });
    qsa('[data-attendance-group]', root).forEach((node) => {
      const allowed = window.LSORoleAccess?.canUseAttendanceGroup?.(node.dataset.attendanceGroup, account()) ?? true;
      show(node, allowed);
    });
  }

  function applyContractControls(root) {
    const allowed = can('generateContract');
    show(el('contractAdminWorkspace'), allowed);
    show(el('contractReadOnlyNotice'), !allowed);
    if (el('contractReadOnlyNotice')) {
      el('contractReadOnlyNotice').querySelector('h3').textContent = allowed ? '' : 'Contract access not assigned';
      el('contractReadOnlyNotice').querySelector('p').textContent = isStaff()
        ? 'Staff Accounts may view system records, but contract generation is assigned to the Administrator and Membership role.'
        : 'Your role does not include the Contract workspace.';
    }
    qsa('#contractMakerForm input, #contractMakerForm textarea, #contractMakerForm button', root).forEach((node) => enable(node, allowed, 'Administrator or Membership access is required.'));
  }

  function applyMonthlyControls(root) {
    const allowed = can('editMonthlyReport');
    qsa('[data-monthly-edit], [data-monthly-write]', root).forEach((node) => {
      if (node.matches('button')) show(node, allowed);
      else enable(node, allowed, 'Administrator or Membership access is required.');
    });
  }

  function applyDutyControls(root) {
    const manage = can('manageDutyHours');
    const review = can('reviewDutyPunches');
    qsa('.duty-management-only', root).forEach((node) => show(node, manage));
    show(el('dutyApprovalPanel'), review);
    show(el('dutyHoursAdminControls'), manage);
    qsa('[data-duty-delete]', root).forEach((node) => show(node, manage));
    qsa('#dutyCommitmentForm input, #dutyCommitmentForm select, #dutyCommitmentForm button, #dutyRenderedForm input, #dutyRenderedForm select, #dutyRenderedForm button, #dutyIncentiveForm input, #dutyIncentiveForm select, #dutyIncentiveForm button', root)
      .forEach((node) => enable(node, manage, 'Administrator or Membership access is required.'));
    qsa('[data-duty-punch-review]', root).forEach((node) => enable(node, review, 'Administrator or Membership access is required.'));
  }

  function applyAdministratorControls(root) {
    qsa('.admin-only', root).forEach((node) => show(node, isAdmin()));
    qsa('.account-role-select, .account-member-select, [data-account-action]', root).forEach((node) => enable(node, isAdmin(), 'Administrator access is required.'));
    ['addInstrumentButton', 'saveSystemSettings', 'clearActivityLog', 'clearDatabase', 'applyTimelineDefaults'].forEach((id) => show(el(id), isAdmin()));
    ['restoreCompleteSystem', 'csvImport', 'jsonRestore'].forEach((id) => {
      const input = el(id);
      if (!input) return;
      const wrapper = input.closest('label, .field, .data-action-card') || input;
      show(wrapper, isAdmin());
    });
  }

  function apply(root = document) {
    if (applying) return;
    applying = true;
    try {
      document.body.dataset.accountRole = role();
      document.body.classList.toggle('staff-readonly-mode', isStaff());
      document.body.classList.toggle('membership-role-mode', isMembership());
      document.body.classList.toggle('secretary-role-mode', isSecretary());
      ensureBanner();
      applyNavigation();
      applyAdministratorControls(root);
      applyMemberControls(root);
      applyAttendanceControls(root);
      applyContractControls(root);
      applyMonthlyControls(root);
      applyDutyControls(root);
    } finally {
      applying = false;
    }
  }

  const actionForTarget = (target) => {
    if (!target?.closest) return '';
    if (target.closest('[data-account-action], .account-role-select, .account-member-select')) return 'manageAccounts';
    if (target.closest('#addMemberTop, #addMemberHero, #addMemberMembers, #editRecordButton, [data-action="edit"], [data-action="delete"], #memberForm')) return 'manageMembers';
    if (target.closest('#addEventButton, #createEventOnSelectedDate, #editEventButton, #eventForm')) return 'manageEvents';
    if (target.closest('#deleteEventButton')) return 'deleteEvents';
    if (target.closest('#markAllPresent, #saveAttendanceButton, .attendance-status, .attendance-remarks')) return 'saveDraftAttendance';
    if (target.closest('#finalizeAttendanceButton')) return 'finalizeAttendance';
    if (target.closest('#unlockAttendanceButton')) return 'unlockAttendance';
    if (target.closest('#contractMakerForm, #previewContractButton, #downloadContractButton, #resetContractButton')) return 'generateContract';
    if (target.closest('[data-monthly-edit], [data-monthly-write]')) return 'editMonthlyReport';
    if (target.closest('[data-duty-punch-review]')) return 'reviewDutyPunches';
    if (target.closest('#dutyCommitmentForm, #dutyRenderedForm, #dutyIncentiveForm, [data-duty-delete]')) return 'manageDutyHours';
    return '';
  };

  function blockIfDenied(event) {
    const action = actionForTarget(event.target);
    if (!action) return;
    if (can(action) && (action !== 'saveDraftAttendance' || attendanceGroupAllowed())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    notify(action === 'saveDraftAttendance' && !attendanceGroupAllowed() ? 'attendanceGroup' : action);
  }

  document.addEventListener('click', blockIfDenied, true);
  document.addEventListener('submit', blockIfDenied, true);
  document.addEventListener('change', blockIfDenied, true);

  ['lso:auth-changed', 'lso:cloud-state-changed', 'lso:members-changed', 'lso:operations-changed', 'lso:attendance-group-changed', 'lso:attendance-governance-changed']
    .forEach((name) => window.addEventListener(name, () => setTimeout(() => apply(document), 20)));
  window.addEventListener('lso:permission-denied', (event) => notify('', event.detail?.message));

  function initialize() {
    apply(document);
    if (window.MutationObserver) {
      observer = new MutationObserver((mutations) => {
        if (applying) return;
        const hasElements = mutations.some((mutation) => [...mutation.addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE));
        if (hasElements) setTimeout(() => apply(document), 0);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  window.LSOPermissions = {
    isAdmin,
    isStaff,
    isMembership,
    isSecretary,
    isTrainee,
    can,
    canModify: (area = 'manageMembers') => can(area),
    apply: () => apply(document),
    require(action, message = '') {
      if (can(action)) return true;
      notify(action, message);
      return false;
    },
    requireAdmin(message = 'Administrator access is required.') {
      if (isAdmin()) return true;
      notify('', message);
      return false;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
