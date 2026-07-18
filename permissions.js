(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const MUTATION_BUTTON_IDS = new Set([
    'addMemberTop', 'addMemberHero', 'addMemberMembers', 'editRecordButton',
    'addEventButton', 'createEventOnSelectedDate', 'editEventButton', 'deleteEventButton',
    'markAllPresent', 'saveAttendanceButton',
    'addInstrumentButton', 'saveSystemSettings', 'clearActivityLog', 'clearDatabase',
    'applyTimelineDefaults', 'previewContractButton', 'downloadContractButton', 'resetContractButton'
  ]);
  const MUTATION_FILE_IDS = new Set(['restoreCompleteSystem', 'csvImport', 'jsonRestore']);
  const MUTATION_FORM_IDS = new Set([
    'memberForm', 'eventForm', 'instrumentForm',
    'dutyCommitmentForm', 'dutyRenderedForm', 'dutyIncentiveForm', 'contractMakerForm'
  ]);
  const MUTATION_CLICK_SELECTOR = [
    '[data-action="edit"]',
    '[data-action="delete"]',
    '[data-duty-delete]',
    '[data-instrument-action="edit"]',
    '[data-instrument-action="delete"]',
    '[data-account-action]',
    '[data-dashboard-action="add-member"]',
    '[data-dashboard-action="new-event"]',
    '[data-dashboard-action="add-instrument"]',
    '[data-alert-instrument]',
    '[data-monthly-write]'
  ].join(',');

  let observer = null;
  let noticeShown = false;

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function isAdmin() {
    return currentAccount()?.role === 'Administrator';
  }

  function isStaff() {
    return currentAccount()?.role === 'Staff Account';
  }

  function notify(message = 'Read-only access: only an Administrator can add, edit, delete, approve, import, restore, or save records.') {
    window.LSOApp?.showToast?.(message, true);
  }

  function ensureBanner() {
    let banner = el('staffReadOnlyBanner');
    if (!banner) {
      banner = document.createElement('section');
      banner.id = 'staffReadOnlyBanner';
      banner.className = 'staff-readonly-banner hidden';
      banner.setAttribute('role', 'status');
      banner.innerHTML = '<span class="staff-readonly-icon" aria-hidden="true">◉</span><div><strong>Staff Read-Only Access</strong><p>You can view, search, filter, and print records. Only an Administrator can add or change information.</p></div>';
      const topbar = document.querySelector('.topbar');
      topbar?.insertAdjacentElement('afterend', banner);
    }
    banner.classList.toggle('hidden', !isStaff());
  }

  function hideControl(node) {
    if (!node) return;
    node.classList.add('staff-write-control');
    node.setAttribute('aria-hidden', 'true');
    node.tabIndex = -1;
  }

  function restoreControl(node) {
    if (!node) return;
    node.classList.remove('staff-write-control');
    node.removeAttribute('aria-hidden');
    if (node.tabIndex === -1) node.removeAttribute('tabindex');
  }

  function setReadonlyControl(node, readOnly) {
    if (!node) return;
    if (readOnly) {
      node.disabled = true;
      node.setAttribute('aria-disabled', 'true');
      node.classList.add('staff-readonly-field');
      node.title = 'Read-only for Staff Accounts';
    } else if (node.classList.contains('staff-readonly-field')) {
      node.disabled = false;
      node.removeAttribute('aria-disabled');
      node.classList.remove('staff-readonly-field');
      if (node.title === 'Read-only for Staff Accounts') node.removeAttribute('title');
    }
  }

  function mutationButtons(root = document) {
    return [...root.querySelectorAll('button,input[type="button"],input[type="submit"],input[type="file"]')].filter((node) => {
      if (MUTATION_BUTTON_IDS.has(node.id) || MUTATION_FILE_IDS.has(node.id)) return true;
      if (node.matches(MUTATION_CLICK_SELECTOR)) return true;
      if (node.closest('#accountsView') && (node.matches('[data-account-action]') || node.classList.contains('account-role-select'))) return true;
      return false;
    });
  }

  function applyReadOnly(root = document) {
    const staff = isStaff();
    document.body.classList.toggle('staff-readonly-mode', staff);
    ensureBanner();

    mutationButtons(root).forEach((node) => staff ? hideControl(node) : restoreControl(node));

    // Keep attendance values visible while preventing edits.
    root.querySelectorAll?.('.attendance-status, .attendance-remarks').forEach((node) => setReadonlyControl(node, staff));

    // Monthly Report setup and filing fields stay visible but are read-only for Staff.
    root.querySelectorAll?.('[data-monthly-edit]').forEach((node) => setReadonlyControl(node, staff));

    // Settings remain visible so Staff can inspect the configuration.
    ['settingTraineeDays', 'settingProbationaryDays', 'settingRegular1Days', 'settingAlertDays', 'settingAttendanceThreshold']
      .forEach((id) => setReadonlyControl(el(id), staff));

    // Account role selectors are an Administrator-only write control.
    root.querySelectorAll?.('.account-role-select').forEach((node) => setReadonlyControl(node, staff));

    // Editing forms are not useful in Staff mode; hide the write panels but keep reports and summaries.
    ['dutyCommitmentForm', 'dutyRenderedForm', 'dutyIncentiveForm'].forEach((id) => {
      const form = el(id);
      if (!form) return;
      const panel = form.closest('.duty-form-card, .duty-entry-card, article') || form;
      staff ? hideControl(panel) : restoreControl(panel);
    });

    // Restore/import inputs should not leave empty upload labels behind.
    MUTATION_FILE_IDS.forEach((id) => {
      const input = el(id);
      if (!input) return;
      const wrapper = input.closest('label, .field, .data-action-card') || input;
      staff ? hideControl(wrapper) : restoreControl(wrapper);
    });

    if (staff && !noticeShown) {
      noticeShown = true;
      setTimeout(() => window.LSOApp?.showToast?.('Staff Account opened in read-only mode. Viewing and printing remain available.'), 120);
    }
    if (!staff) noticeShown = false;
  }

  function blockedMutationTarget(target) {
    if (!target || !isStaff()) return null;
    const button = target.closest?.('button,input[type="button"],input[type="submit"],input[type="file"]');
    if (button && (MUTATION_BUTTON_IDS.has(button.id) || MUTATION_FILE_IDS.has(button.id) || button.matches(MUTATION_CLICK_SELECTOR))) return button;
    return null;
  }

  document.addEventListener('click', (event) => {
    const blocked = blockedMutationTarget(event.target);
    if (!blocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    notify();
  }, true);

  document.addEventListener('submit', (event) => {
    if (!isStaff() || !MUTATION_FORM_IDS.has(event.target?.id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    notify();
  }, true);

  document.addEventListener('change', (event) => {
    if (!isStaff()) return;
    const target = event.target;
    if (target?.matches?.('.attendance-status, .attendance-remarks, .account-role-select') || MUTATION_FILE_IDS.has(target?.id)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      notify();
      window.LSOOperations?.refreshAll?.();
    }
  }, true);

  window.addEventListener('lso:permission-denied', (event) => notify(event.detail?.message));
  window.addEventListener('lso:auth-changed', () => setTimeout(() => applyReadOnly(document), 0));
  window.addEventListener('lso:cloud-state-changed', () => setTimeout(() => applyReadOnly(document), 30));
  window.addEventListener('lso:members-changed', () => setTimeout(() => applyReadOnly(document), 30));
  window.addEventListener('lso:operations-changed', () => setTimeout(() => applyReadOnly(document), 30));

  function initialize() {
    applyReadOnly(document);
    if (window.MutationObserver) {
      observer = new MutationObserver((mutations) => {
        if (!isStaff()) return;
        mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) applyReadOnly(node);
        }));
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  window.LSOPermissions = {
    isAdmin,
    isStaff,
    canModify: isAdmin,
    apply: () => applyReadOnly(document),
    requireAdmin(message) {
      if (isAdmin()) return true;
      notify(message);
      return false;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
