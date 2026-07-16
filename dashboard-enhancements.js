(() => {
  'use strict';

  const READ_KEY = 'lso_notification_read_v1';
  const EVENTS_KEY = 'lso_events_v2';
  const ATTENDANCE_KEY = 'lso_attendance_v2';
  const INSTRUMENTS_KEY = 'lso_instruments_v2';
  const ACTIVITY_KEY = 'lso_activity_log_v2';
  const SETTINGS_KEY = 'lso_system_settings_v2';
    const MEMBER_KEY = 'lso_member_database_v1';

  const el = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function loadArray(key) {
    try {
      const value = JSON.parse(window.LSOStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function loadObject(key) {
    try {
      const value = JSON.parse(window.LSOStorage.getItem(key) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function today() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function dateLabel(value, options = {}) {
    if (!value) return 'Date not set';
    const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-PH', {
      month: options.short ? 'short' : 'long',
      day: 'numeric',
      year: options.year === false ? undefined : 'numeric'
    }).format(date);
  }

  function timeLabel(value) {
    if (!value) return '';
    const [hour, minute] = String(value).split(':').map(Number);
    if (!Number.isFinite(hour)) return String(value);
    const date = new Date();
    date.setHours(hour, Number.isFinite(minute) ? minute : 0, 0, 0);
    return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function daysBetween(from, to) {
    const a = new Date(`${from}T00:00:00`);
    const b = new Date(`${to}T00:00:00`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    return Math.round((b.getTime() - a.getTime()) / 86_400_000);
  }

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function isAdmin() {
    return currentAccount()?.role === 'Administrator';
  }

  function getEvents() {
    return window.LSOOperations?.getEvents?.() || loadArray(EVENTS_KEY);
  }

  function getAttendance() {
    return window.LSOOperations?.getAttendance?.() || loadArray(ATTENDANCE_KEY);
  }

  function getInstruments() {
    return window.LSOOperations?.getInstruments?.() || loadArray(INSTRUMENTS_KEY);
  }

  function getMembers() {
    return window.LSOApp?.getMembers?.() || loadArray(MEMBER_KEY);
  }

  function getAlerts() {
    return window.LSOOperations?.buildAlerts?.() || [];
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function relativeDateLabel(dateValue) {
    const value = String(dateValue || '').slice(0, 10);
    const days = daysBetween(today(), value);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    if (days !== null && days > 1 && days <= 7) return `In ${days} days`;
    if (days !== null && days < -1 && days >= -7) return `${Math.abs(days)} days ago`;
    return dateLabel(value, { short: true });
  }

  function relativeTimeLabel(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return 'Recently';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
  }

  function readNotificationIds() {
    try {
      const parsed = JSON.parse(window.LSOStorage.getItem(READ_KEY) || '[]');
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  }

  function saveNotificationIds(readIds) {
    try {
      window.LSOStorage.setItem(READ_KEY, JSON.stringify([...readIds].slice(-800)));
    } catch {
      // The dashboard remains functional even when storage is unavailable.
    }
  }

  function alertNotification(alert) {
    const targetId = alert.memberId || alert.instrumentId || '';
    const stableTitle = String(alert.title || 'Action required').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    return {
      id: `alert:${alert.type}:${targetId || stableTitle}`,
      category: 'Action Center',
      severity: alert.severity || 'medium',
      title: alert.title || 'Action required',
      detail: alert.detail || 'Open the Action Center for details.',
      timestamp: '',
      actionType: alert.memberId ? 'member' : alert.instrumentId ? 'instrument' : 'alerts',
      targetId,
      icon: ({ transition: '→', profile: 'ID', safety: '+', attendance: '%', instrument: '♬' })[alert.type] || '!'
    };
  }

  function buildNotifications() {
    const notifications = getAlerts().map(alertNotification);

    if (isAdmin()) {
      const accounts = window.LSOAuth?.loadAccounts?.() || [];
      accounts
        .filter((account) => !account.isDefault && account.approvalStatus === 'Pending')
        .forEach((account) => notifications.push({
          id: `account:${account.id}`,
          category: 'Account Approval',
          severity: 'high',
          title: 'New account requires approval',
          detail: `${account.displayName || account.username} (@${account.username}) submitted a registration request.`,
          timestamp: account.requestedAt || account.createdAt || '',
          actionType: 'accounts',
          targetId: account.id,
          icon: 'A'
        }));
    }

    getEvents()
      .filter((event) => event.date && event.date >= today())
      .filter((event) => {
        const days = daysBetween(today(), event.date);
        return days !== null && days <= 7;
      })
      .forEach((event) => {
        const days = daysBetween(today(), event.date);
        const schedule = [relativeDateLabel(event.date), timeLabel(event.startTime), event.venue].filter(Boolean).join(' • ');
        notifications.push({
          id: `event:${event.id}:${event.date}`,
          category: 'Upcoming Event',
          severity: days === 0 ? 'high' : days <= 2 ? 'medium' : 'low',
          title: event.title || 'Scheduled orchestra event',
          detail: schedule,
          timestamp: `${event.date}T${event.startTime || '00:00'}:00`,
          actionType: 'event',
          targetId: event.id,
          icon: '▣'
        });
      });

    const severityOrder = { high: 0, medium: 1, low: 2 };
    const readIds = readNotificationIds();
    return notifications
      .filter((notification, index, all) => all.findIndex((item) => item.id === notification.id) === index)
      .map((notification) => ({ ...notification, read: readIds.has(notification.id) }))
      .sort((a, b) => Number(a.read) - Number(b.read)
        || (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9)
        || String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  }

  function notificationMeta(notification) {
    if (notification.timestamp) {
      const datePart = String(notification.timestamp).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return `${notification.category} • ${relativeDateLabel(datePart)}`;
    }
    return notification.category;
  }

  function renderNotifications() {
    const list = el('notificationList');
    const badge = el('notificationBadge');
    const summary = el('notificationSummary');
    const button = el('notificationButton');
    if (!list || !badge || !summary || !button) return;

    const notifications = buildNotifications();
    const unread = notifications.filter((notification) => !notification.read).length;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
    button.classList.toggle('has-unread', unread > 0);
    button.setAttribute('aria-label', unread ? `Open notifications, ${unread} unread` : 'Open notifications, none unread');
    summary.textContent = unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'No unread notifications';
    el('markAllNotificationsRead')?.toggleAttribute('disabled', unread === 0);

    list.innerHTML = notifications.length ? notifications.slice(0, 18).map((notification) => `
      <button class="notification-item severity-${safeText(notification.severity)} ${notification.read ? '' : 'unread'}" data-notification-id="${safeText(notification.id)}" data-notification-action="${safeText(notification.actionType)}" data-notification-target="${safeText(notification.targetId)}" type="button">
        <span class="notification-item-icon">${safeText(notification.icon)}</span>
        <span class="notification-item-copy"><strong>${safeText(notification.title)}</strong><small>${safeText(notification.detail)}</small><em>${safeText(notificationMeta(notification))}</em></span>
        <span class="notification-unread-dot" aria-hidden="true"></span>
      </button>`).join('') : `
      <div class="notification-empty"><span>✓</span><strong>You are all caught up</strong><small>No current alerts, approvals, or events within the next seven days.</small></div>`;

    renderHeroStatus(notifications);
  }

  function markNotificationRead(id) {
    const readIds = readNotificationIds();
    readIds.add(id);
    saveNotificationIds(readIds);
    renderNotifications();
  }

  function markAllNotificationsRead() {
    const readIds = readNotificationIds();
    buildNotifications().forEach((notification) => readIds.add(notification.id));
    saveNotificationIds(readIds);
    renderNotifications();
  }

  function toggleNotificationPopover(forceOpen) {
    const popover = el('notificationPopover');
    const button = el('notificationButton');
    if (!popover || !button) return;
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : popover.classList.contains('hidden');
    popover.classList.toggle('hidden', !shouldOpen);
    button.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      renderNotifications();
      setTimeout(() => el('notificationCloseButton')?.focus(), 20);
    }
  }

  function showView(viewId) {
    window.LSOOperations?.refreshAll?.();
    window.LSOApp?.setView?.(viewId);
    requestAnimationFrame(() => document.getElementById(viewId)?.scrollIntoView({ block: 'start' }));
  }

  function openEvent(eventId) {
    showView('attendanceView');
    setTimeout(() => {
      const card = document.querySelector(`[data-event-id="${cssEscape(eventId)}"]`);
      card?.click();
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 40);
  }

  function openInstrument(instrumentId) {
    showView('instrumentsView');
    setTimeout(() => {
      const button = document.querySelector(`[data-instrument-action="edit"][data-id="${cssEscape(instrumentId)}"]`);
      button?.click();
    }, 40);
  }

  function performNotificationAction(action, targetId) {
    toggleNotificationPopover(false);
    if (action === 'member' && targetId) {
      window.LSOApp?.openRecord?.(targetId);
      return;
    }
    if (action === 'instrument' && targetId) {
      openInstrument(targetId);
      return;
    }
    if (action === 'accounts') {
      showView('accountsView');
      return;
    }
    if (action === 'event' && targetId) {
      openEvent(targetId);
      return;
    }
    showView('alertsView');
  }

  function renderGreeting() {
    const greeting = el('dashboardGreeting');
    const meta = el('dashboardGreetingMeta');
    if (!greeting || !meta) return;
    const account = currentAccount();
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const name = String(account?.displayName || account?.username || 'LSO team').trim().split(/\s+/)[0];
    greeting.textContent = `${timeGreeting}, ${name}`;

    const alerts = getAlerts();
    const urgent = alerts.filter((alert) => alert.severity === 'high').length;
    const upcoming = getEvents().filter((event) => event.date && event.date >= today()).length;
    const attentionText = urgent ? `${urgent} urgent item${urgent === 1 ? '' : 's'} need attention` : 'no urgent issues are currently detected';
    meta.textContent = `${new Intl.DateTimeFormat('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())} • ${attentionText} • ${upcoming} upcoming event${upcoming === 1 ? '' : 's'}.`;
  }

  function renderHeroStatus(notifications = buildNotifications()) {
    const container = el('dashboardHeroStatus');
    if (!container) return;
    const alerts = getAlerts();
    const urgent = alerts.filter((alert) => alert.severity === 'high').length;
    const nextEvent = getEvents().filter((event) => event.date && event.date >= today()).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.startTime || '').localeCompare(String(b.startTime || '')))[0];
    const maintenance = getInstruments().filter((item) => instrumentStatus(item) === 'Maintenance').length;
    const unread = notifications.filter((notification) => !notification.read).length;

    const items = [
      { label: 'Urgent alerts', value: urgent, action: 'alerts' },
      { label: 'Unread updates', value: unread, action: 'notifications' },
      { label: 'Next event', value: nextEvent ? relativeDateLabel(nextEvent.date) : 'None', action: 'attendance' },
      { label: 'Maintenance', value: maintenance, action: 'inventory' }
    ];
    container.innerHTML = items.map((item) => `<button class="hero-status-chip" data-dashboard-action="${safeText(item.action)}" type="button"><small>${safeText(item.label)}</small><strong>${safeText(item.value)}</strong></button>`).join('');
  }

  function upcomingEvents() {
    return getEvents()
      .filter((event) => event.date && event.date >= today())
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
  }

  function renderUpcomingEvents() {
    const container = el('dashboardUpcomingEvents');
    const summary = el('dashboardUpcomingSummary');
    if (!container || !summary) return;
    const events = upcomingEvents();
    const withinSevenDays = events.filter((event) => {
      const days = daysBetween(today(), event.date);
      return days !== null && days <= 7;
    }).length;
    summary.textContent = events.length ? `${events.length} scheduled • ${withinSevenDays} within the next 7 days` : 'No future events are currently scheduled.';

    container.innerHTML = events.length ? events.slice(0, 5).map((event) => {
      const date = new Date(`${event.date}T00:00:00`);
      const schedule = [timeLabel(event.startTime), event.venue || 'Venue not set'].filter(Boolean).join(' • ');
      return `<button class="dashboard-event-item" data-dashboard-event="${safeText(event.id)}" type="button">
        <span class="dashboard-event-date"><strong>${safeText(String(date.getDate()).padStart(2, '0'))}</strong><small>${safeText(new Intl.DateTimeFormat('en-PH', { month: 'short' }).format(date))}</small></span>
        <span class="dashboard-event-copy"><strong>${safeText(event.title || 'Untitled event')}</strong><small>${safeText([event.type, schedule].filter(Boolean).join(' • '))}</small></span>
        <span class="badge ${daysBetween(today(), event.date) === 0 ? 'badge-red' : 'badge-blue'}">${safeText(relativeDateLabel(event.date))}</span>
      </button>`;
    }).join('') : `<div class="dashboard-empty-state"><span>▣</span><strong>No upcoming events</strong><small>Create a rehearsal, performance, meeting, or audition.</small><button class="small-button" data-dashboard-action="new-event" type="button">Create Event</button></div>`;
  }

  function getAttendanceSnapshot() {
    const events = getEvents();
    const attendance = getAttendance();
    const candidates = [...events]
      .filter((event) => event.date && event.date <= today())
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.startTime || '').localeCompare(String(a.startTime || '')));
    const event = candidates.find((item) => attendance.some((entry) => entry.eventId === item.id && entry.status)) || candidates[0] || null;
    if (!event) return null;
    const records = attendance.filter((entry) => entry.eventId === event.id && entry.status);
    const count = (status) => records.filter((entry) => entry.status === status).length;
    const present = count('Present');
    const late = count('Late');
    const absent = count('Absent');
    const counted = present + late + absent;
    return {
      event,
      records: records.length,
      present,
      late,
      absent,
      excused: count('Excused'),
      rate: counted ? Math.round(((present + late) / counted) * 100) : null
    };
  }

  function renderAttendancePulse() {
    const container = el('dashboardAttendancePulse');
    const summary = el('dashboardAttendanceSummary');
    if (!container || !summary) return;
    const snapshot = getAttendanceSnapshot();
    if (!snapshot) {
      summary.textContent = 'No completed events are available yet.';
      container.innerHTML = `<div class="dashboard-empty-state"><span>✓</span><strong>No attendance history</strong><small>Create an event and save its attendance roster to begin tracking participation.</small><button class="small-button" data-dashboard-action="new-event" type="button">Create Event</button></div>`;
      return;
    }

    summary.textContent = `${snapshot.event.title || 'Latest event'} • ${dateLabel(snapshot.event.date, { short: true })}`;
    const settings = loadObject(SETTINGS_KEY);
    const threshold = Number(settings.attendanceThreshold) || 75;
    const rate = snapshot.rate;
    const status = rate === null ? 'Not enough counted records' : rate >= threshold ? 'Meeting the attendance target' : 'Below the attendance target';
    container.innerHTML = `<div class="attendance-pulse-layout">
      <div class="attendance-ring" style="--attendance-progress:${rate ?? 0}"><div><strong>${rate === null ? '—' : `${rate}%`}</strong><small>Attendance</small></div></div>
      <div class="attendance-pulse-copy"><strong>${safeText(status)}</strong><small>${safeText(snapshot.records)} roster entr${snapshot.records === 1 ? 'y' : 'ies'} saved for this event.</small>
        <div class="attendance-mini-grid"><span><strong>${snapshot.present}</strong><small>Present</small></span><span><strong>${snapshot.late}</strong><small>Late</small></span><span><strong>${snapshot.absent}</strong><small>Absent</small></span><span><strong>${snapshot.excused}</strong><small>Excused</small></span></div>
      </div>
    </div>`;
  }

  function instrumentStatus(item) {
    if (item.manualStatus) return item.manualStatus;
    if (['Needs Repair', 'Unserviceable'].includes(item.condition)) return 'Maintenance';
    return item.assignedMemberId ? 'Issued' : 'Available';
  }

  function renderInventorySnapshot() {
    const container = el('dashboardInventorySnapshot');
    const summary = el('dashboardInventorySummary');
    if (!container || !summary) return;
    const instruments = getInstruments();
    const statusCount = (status) => instruments.filter((item) => instrumentStatus(item) === status).length;
    const available = statusCount('Available');
    const issued = statusCount('Issued');
    const maintenance = statusCount('Maintenance');
    const overdue = instruments.filter((item) => instrumentStatus(item) === 'Issued' && item.expectedReturn && item.expectedReturn < today()).length;
    const utilization = instruments.length ? Math.round((issued / instruments.length) * 100) : 0;
    summary.textContent = instruments.length ? `${instruments.length} registered asset${instruments.length === 1 ? '' : 's'} • ${utilization}% currently issued` : 'No instruments are registered yet.';

    container.innerHTML = instruments.length ? `<div class="inventory-dashboard-grid">
      <button data-dashboard-action="inventory" type="button"><span>Available</span><strong>${available}</strong><small>Ready for assignment</small></button>
      <button data-dashboard-action="inventory" type="button"><span>Issued</span><strong>${issued}</strong><small>Assigned to members</small></button>
      <button data-dashboard-action="inventory" type="button"><span>Maintenance</span><strong>${maintenance}</strong><small>Needs attention</small></button>
      <button data-dashboard-action="inventory" type="button"><span>Overdue</span><strong>${overdue}</strong><small>Returns past due</small></button>
    </div><div class="inventory-utilization"><div><span>Inventory utilization</span><strong>${utilization}%</strong></div><div class="bar-track"><div class="bar-fill" style="width:${utilization}%"></div></div></div>` : `<div class="dashboard-empty-state"><span>♬</span><strong>No inventory records</strong><small>Add instruments to track assignment, condition, and return dates.</small><button class="small-button" data-dashboard-action="add-instrument" type="button">Add Instrument</button></div>`;
  }

  function renderRecentActivity() {
    const container = el('dashboardRecentActivity');
    if (!container) return;
    const activity = loadArray(ACTIVITY_KEY).slice(0, 6);
    container.innerHTML = activity.length ? activity.map((item) => `<div class="dashboard-activity-item"><span class="activity-dot"></span><div><strong>${safeText(item.action || 'System activity')}</strong><small>${safeText(item.details || item.category || '')}</small><em>${safeText(item.account || 'Local user')} • ${safeText(relativeTimeLabel(item.timestamp))}</em></div></div>`).join('') : `<div class="dashboard-empty-state compact-dashboard-empty"><span>↻</span><strong>No recorded activity</strong><small>Member, attendance, inventory, account, and backup actions will appear here.</small></div>`;
  }

  function renderDashboardModules() {
    renderGreeting();
    renderUpcomingEvents();
    renderAttendancePulse();
    renderInventorySnapshot();
    renderRecentActivity();
    renderNotifications();
  }

  function performDashboardAction(action) {
    if (action === 'add-member') {
      el('addMemberTop')?.click();
      return;
    }
    if (action === 'new-event') {
      el('addEventButton')?.click();
      return;
    }
    if (action === 'add-instrument') {
      el('addInstrumentButton')?.click();
      return;
    }
    if (action === 'attendance') {
      showView('attendanceView');
      return;
    }
    if (action === 'inventory') {
      showView('instrumentsView');
      return;
    }
    if (action === 'alerts') {
      showView('alertsView');
      return;
    }
    if (action === 'data') {
      showView('dataView');
      return;
    }
    if (action === 'notifications') toggleNotificationPopover(true);
  }

  function wireEvents() {
    el('notificationButton')?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleNotificationPopover();
    });
    el('notificationCloseButton')?.addEventListener('click', () => toggleNotificationPopover(false));
    el('markAllNotificationsRead')?.addEventListener('click', markAllNotificationsRead);
    el('openActionCenterFromNotifications')?.addEventListener('click', () => {
      toggleNotificationPopover(false);
      showView('alertsView');
    });
    el('notificationPopover')?.addEventListener('click', (event) => event.stopPropagation());
    el('notificationList')?.addEventListener('click', (event) => {
      const item = event.target.closest('[data-notification-id]');
      if (!item) return;
      markNotificationRead(item.dataset.notificationId);
      performNotificationAction(item.dataset.notificationAction, item.dataset.notificationTarget);
    });

    document.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-dashboard-action]');
      if (actionButton) performDashboardAction(actionButton.dataset.dashboardAction);
      const eventButton = event.target.closest('[data-dashboard-event]');
      if (eventButton) openEvent(eventButton.dataset.dashboardEvent);
      if (!event.target.closest('#notificationCenter')) toggleNotificationPopover(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') toggleNotificationPopover(false);
    });

    qsa('.nav-item').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.view === 'dashboardView') setTimeout(renderDashboardModules, 20);
    }));

    ['lso:members-changed', 'lso:operations-changed', 'lso:accounts-changed', 'lso:auth-changed', 'lso:cloud-state-changed'].forEach((eventName) => {
      window.addEventListener(eventName, () => setTimeout(renderDashboardModules, 0));
    });

    window.addEventListener('storage', (event) => {
      if ([EVENTS_KEY, ATTENDANCE_KEY, INSTRUMENTS_KEY, ACTIVITY_KEY, SETTINGS_KEY, MEMBER_KEY, READ_KEY].includes(event.key)) {
        window.LSOOperations?.refreshAll?.();
        renderDashboardModules();
      }
    });

    window.setInterval(() => {
      if (!el('appShell')?.classList.contains('hidden')) renderDashboardModules();
    }, 60_000);
  }

  function initialize() {
    wireEvents();
    renderDashboardModules();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
