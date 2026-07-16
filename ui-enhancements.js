(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function updateCloudStatus(event) {
    const text = el('systemStatusText');
    const statusBox = text?.closest('.topbar-status');
    if (!text || !event?.detail) return;
    text.textContent = event.detail.message || 'Shared database';
    if (statusBox) statusBox.dataset.status = event.detail.kind || 'offline';
  }

  function updateCurrentDate() {
    const target = el('currentDateLabel');
    if (!target) return;
    target.textContent = new Intl.DateTimeFormat('en-PH', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date());
  }

  function closeSidebar() {
    el('sidebar')?.classList.remove('open');
    document.body.classList.remove('sidebar-open');
  }

  function syncSidebarState() {
    const isOpen = Boolean(el('sidebar')?.classList.contains('open'));
    document.body.classList.toggle('sidebar-open', isOpen && window.innerWidth <= 920);
  }

  function wireResponsiveNavigation() {
    el('mobileMenuButton')?.addEventListener('click', () => requestAnimationFrame(syncSidebarState));
    el('sidebarCloseButton')?.addEventListener('click', closeSidebar);
    el('sidebarOverlay')?.addEventListener('click', closeSidebar);
    qsa('.nav-item').forEach((button) => button.addEventListener('click', closeSidebar));

    const sidebar = el('sidebar');
    if (sidebar && window.MutationObserver) {
      new MutationObserver(syncSidebarState).observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    }

    window.addEventListener('resize', () => {
      if (window.innerWidth > 920) closeSidebar();
      refreshTableHints();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && sidebar?.classList.contains('open')) closeSidebar();
    });
  }

  function getHeaderLabels(table) {
    return qsa('thead th', table).map((header) => header.textContent.trim().replace(/\s+/g, ' '));
  }

  function applyCellLabels(table) {
    const labels = getHeaderLabels(table);
    if (!labels.length) return;

    qsa('tbody tr', table).forEach((row) => {
      qsa(':scope > td', row).forEach((cell, index) => {
        if (cell.hasAttribute('colspan')) return;
        cell.dataset.label = labels[index] || 'Details';
      });
    });
  }

  function addTableAccessibility(wrapper, index) {
    if (!wrapper.hasAttribute('tabindex')) wrapper.tabIndex = 0;
    if (!wrapper.hasAttribute('role')) wrapper.setAttribute('role', 'region');
    if (!wrapper.hasAttribute('aria-label')) wrapper.setAttribute('aria-label', `Scrollable data table ${index + 1}`);

    if (!wrapper.nextElementSibling?.classList.contains('table-scroll-hint')) {
      const hint = document.createElement('p');
      hint.className = 'table-scroll-hint';
      hint.textContent = 'Scroll sideways to view additional columns.';
      wrapper.insertAdjacentElement('afterend', hint);
    }
  }

  function refreshTableHints() {
    qsa('.table-wrap, .period-table-wrap').forEach((wrapper) => {
      const hint = wrapper.nextElementSibling?.classList.contains('table-scroll-hint') ? wrapper.nextElementSibling : null;
      if (!hint) return;
      const needsHorizontalScroll = window.innerWidth > 760 && wrapper.scrollWidth > wrapper.clientWidth + 2;
      hint.style.display = needsHorizontalScroll ? 'block' : 'none';
    });
  }

  let tableRefreshQueued = false;
  function enhanceTables() {
    if (tableRefreshQueued) return;
    tableRefreshQueued = true;
    requestAnimationFrame(() => {
      tableRefreshQueued = false;
      qsa('table').forEach(applyCellLabels);
      qsa('.table-wrap, .period-table-wrap').forEach(addTableAccessibility);
      refreshTableHints();
    });
  }

  function wireTableEnhancement() {
    enhanceTables();
    if (!window.MutationObserver) return;
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === 'childList' && (mutation.addedNodes.length || mutation.removedNodes.length))) {
        enhanceTables();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function updatePendingAccountBadge() {
    const badge = el('pendingAccountCount');
    if (!badge) return;
    const accounts = window.LSOAuth?.loadAccounts?.() || [];
    const count = accounts.filter((account) => account.approvalStatus === 'Pending' && !account.isDefault).length;
    badge.textContent = String(count);
    badge.classList.toggle('hidden', count === 0);
    badge.setAttribute('aria-label', `${count} pending account registration${count === 1 ? '' : 's'}`);
  }

  function wireAccountBadge() {
    updatePendingAccountBadge();
    window.addEventListener('lso:accounts-changed', updatePendingAccountBadge);
    window.addEventListener('lso:auth-changed', updatePendingAccountBadge);
  }

  function enhanceButtons() {
    qsa('.table-action').forEach((button) => {
      if (!button.getAttribute('aria-label')) {
        const label = button.title || button.textContent.trim() || 'Record action';
        button.setAttribute('aria-label', label);
      }
    });
  }

  function wireDynamicButtonEnhancement() {
    enhanceButtons();
    if (!window.MutationObserver) return;
    new MutationObserver(enhanceButtons).observe(document.body, { childList: true, subtree: true });
  }

  function initialize() {
    updateCurrentDate();
    wireResponsiveNavigation();
    wireTableEnhancement();
    wireAccountBadge();
    wireDynamicButtonEnhancement();
    window.addEventListener('lso:cloud-status', updateCloudStatus);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
