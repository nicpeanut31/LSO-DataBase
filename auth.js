(() => {
  'use strict';

  const SESSION_KEY = 'lso_shared_session_v1';
  const DEFAULT_USERNAME = 'SNA1161';
  const LOGIN_SECURITY_KEY = 'lso_login_security_v1';
  const ACTIVITY_KEY = 'lso_last_activity_v1';
  const MAX_FAILED_ATTEMPTS = 5;
  const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_COOLDOWN_MS = 5 * 60 * 1000;
  const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
  const INACTIVITY_WARNING_MS = 60 * 1000;
  const el = (id) => document.getElementById(id);
  const normalizeUsername = (value) => String(value || '').trim().toLowerCase();

  let authenticationGateObserver = null;

  function hasAuthenticatedApplicationState() {
    return Boolean(window.LSOCurrentAccount && document.body?.dataset.authenticated === 'true');
  }

  function lockApplicationShell() {
    document.documentElement.classList.add('lso-auth-locked');
    if (document.body) delete document.body.dataset.authenticated;

    const shell = el('appShell');
    if (shell) {
      shell.classList.add('hidden', 'auth-locked');
      shell.hidden = true;
      shell.setAttribute('hidden', '');
      shell.setAttribute('inert', '');
      shell.setAttribute('aria-hidden', 'true');
      shell.style.setProperty('display', 'none', 'important');
    }

    const auth = el('authScreen');
    if (auth) {
      auth.classList.remove('hidden');
      auth.hidden = false;
      auth.removeAttribute('hidden');
      auth.removeAttribute('inert');
      auth.setAttribute('aria-hidden', 'false');
    }
  }

  function unlockApplicationShell() {
    if (!window.LSOCurrentAccount) {
      lockApplicationShell();
      return false;
    }

    document.body.dataset.authenticated = 'true';
    const auth = el('authScreen');
    if (auth) {
      auth.classList.add('hidden');
      auth.hidden = true;
      auth.setAttribute('hidden', '');
      auth.setAttribute('inert', '');
      auth.setAttribute('aria-hidden', 'true');
    }

    const shell = el('appShell');
    if (shell) {
      shell.style.removeProperty('display');
      shell.classList.remove('hidden', 'auth-locked');
      shell.hidden = false;
      shell.removeAttribute('hidden');
      shell.removeAttribute('inert');
      shell.setAttribute('aria-hidden', 'false');
    }
    document.documentElement.classList.remove('lso-auth-locked');
    return true;
  }

  function enforceAuthenticationGate() {
    if (!hasAuthenticatedApplicationState()) lockApplicationShell();
  }

  function installAuthenticationGateObserver() {
    if (authenticationGateObserver || !document.body) return;
    const shell = el('appShell');
    if (!shell) return;
    authenticationGateObserver = new MutationObserver(() => {
      if (!hasAuthenticatedApplicationState() && (!shell.hidden || !shell.classList.contains('hidden') || shell.style.display !== 'none')) {
        lockApplicationShell();
      }
    });
    authenticationGateObserver.observe(shell, { attributes: true, attributeFilter: ['class', 'hidden', 'style', 'inert', 'aria-hidden'] });
    window.addEventListener('pageshow', enforceAuthenticationGate);
    window.addEventListener('popstate', enforceAuthenticationGate);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') enforceAuthenticationGate();
    });
  }

  let accountsCache = [];
  let accountRefreshTimer = null;
  let loginCooldownTimer = null;
  let inactivityTimer = null;
  let inactivityWarningTimer = null;
  let activityListenersBound = false;
  let lastActivityRecordedAt = 0;
  let automaticLogoutInProgress = false;

  function emit(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function readJsonStorage(storage, key, fallback = null) {
    try {
      const parsed = JSON.parse(storage.getItem(key) || 'null');
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function formatCountdown(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function getLoginSecurityState() {
    const now = Date.now();
    const stored = readJsonStorage(localStorage, LOGIN_SECURITY_KEY, {}) || {};
    let failedAttempts = Number(stored.failedAttempts) || 0;
    let lastFailureAt = Number(stored.lastFailureAt) || 0;
    let lockedUntil = Number(stored.lockedUntil) || 0;

    if (lockedUntil && lockedUntil <= now) {
      failedAttempts = 0;
      lastFailureAt = 0;
      lockedUntil = 0;
    } else if (!lockedUntil && lastFailureAt && now - lastFailureAt > FAILED_ATTEMPT_WINDOW_MS) {
      failedAttempts = 0;
      lastFailureAt = 0;
    }

    const normalized = { failedAttempts, lastFailureAt, lockedUntil };
    writeJsonStorage(localStorage, LOGIN_SECURITY_KEY, normalized);
    return normalized;
  }

  function resetLoginSecurity() {
    try { localStorage.removeItem(LOGIN_SECURITY_KEY); } catch { /* Storage can be blocked. */ }
    stopLoginCooldownTicker();
    renderLoginCooldown();
  }

  function recordInvalidCredentials() {
    const now = Date.now();
    const state = getLoginSecurityState();
    const nextAttempts = state.failedAttempts + 1;
    const locked = nextAttempts >= MAX_FAILED_ATTEMPTS;
    const nextState = {
      failedAttempts: locked ? 0 : nextAttempts,
      lastFailureAt: now,
      lockedUntil: locked ? now + LOGIN_COOLDOWN_MS : 0
    };
    writeJsonStorage(localStorage, LOGIN_SECURITY_KEY, nextState);
    if (locked) startLoginCooldownTicker();
    return { ...nextState, locked, remainingAttempts: locked ? 0 : MAX_FAILED_ATTEMPTS - nextAttempts };
  }

  function loginCooldownRemaining() {
    const state = getLoginSecurityState();
    return Math.max(0, state.lockedUntil - Date.now());
  }

  function renderLoginCooldown() {
    const form = el('loginForm');
    const button = form?.querySelector('button[type="submit"]');
    if (!button) return;
    const remaining = loginCooldownRemaining();
    const formBusy = form.classList.contains('is-busy');
    if (remaining > 0) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.textContent = `Try again in ${formatCountdown(remaining)}`;
      setMessage('loginMessage', `Too many incorrect password attempts. Login is temporarily paused for ${formatCountdown(remaining)}.`);
    } else {
      button.disabled = formBusy;
      button.setAttribute('aria-disabled', String(formBusy));
      button.textContent = 'Login to Database';
    }
  }

  function startLoginCooldownTicker() {
    clearInterval(loginCooldownTimer);
    renderLoginCooldown();
    if (!loginCooldownRemaining()) return;
    loginCooldownTimer = setInterval(() => {
      renderLoginCooldown();
      if (!loginCooldownRemaining()) {
        stopLoginCooldownTicker();
        setMessage('loginMessage', 'You may try logging in again.', true);
        el('loginPassword')?.focus();
      }
    }, 1000);
  }

  function stopLoginCooldownTicker() {
    clearInterval(loginCooldownTimer);
    loginCooldownTimer = null;
  }

  function readLastActivity() {
    try { return Number(sessionStorage.getItem(ACTIVITY_KEY)) || 0; } catch { return 0; }
  }

  function writeLastActivity(timestamp) {
    try { sessionStorage.setItem(ACTIVITY_KEY, String(timestamp)); } catch { /* Storage can be blocked. */ }
  }

  function clearLastActivity() {
    try { sessionStorage.removeItem(ACTIVITY_KEY); } catch { /* Storage can be blocked. */ }
  }

  function clearInactivityTimers() {
    clearTimeout(inactivityTimer);
    clearTimeout(inactivityWarningTimer);
    inactivityTimer = null;
    inactivityWarningTimer = null;
  }

  async function handleInactivityLogout() {
    if (!window.LSOCurrentAccount || automaticLogoutInProgress) return;
    automaticLogoutInProgress = true;
    clearInactivityTimers();
    clearLastActivity();
    clearSession();
    try { await window.LSOCloud.logout(); } catch { /* Local logout still continues. */ }
    showLoginScreen();
    setMessage('loginMessage', 'For your security, you were logged out after 15 minutes of inactivity.');
    automaticLogoutInProgress = false;
  }

  function showInactivityWarning() {
    if (!window.LSOCurrentAccount) return;
    window.LSOApp?.showToast?.('Your session will log out in 1 minute unless activity resumes.');
    emit('lso:inactivity-warning', { remainingMs: INACTIVITY_WARNING_MS });
  }

  function scheduleInactivityTimers() {
    clearInactivityTimers();
    if (!window.LSOCurrentAccount) return;
    const now = Date.now();
    const lastActivity = readLastActivity() || now;
    const elapsed = now - lastActivity;
    const remaining = INACTIVITY_TIMEOUT_MS - elapsed;

    if (remaining <= 0) {
      handleInactivityLogout();
      return;
    }

    const warningDelay = remaining - INACTIVITY_WARNING_MS;
    if (warningDelay <= 0) showInactivityWarning();
    else inactivityWarningTimer = setTimeout(showInactivityWarning, warningDelay);
    inactivityTimer = setTimeout(handleInactivityLogout, remaining);
  }

  function recordUserActivity({ force = false } = {}) {
    if (!window.LSOCurrentAccount) return;
    const now = Date.now();
    if (!force && now - lastActivityRecordedAt < 15000) return;
    lastActivityRecordedAt = now;
    writeLastActivity(now);
    scheduleInactivityTimers();
  }

  function handleVisibilityChange() {
    if (!window.LSOCurrentAccount) return;
    if (document.visibilityState === 'visible') scheduleInactivityTimers();
  }

  function bindActivityListeners() {
    if (activityListenersBound) return;
    activityListenersBound = true;
    ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((eventName) => {
      window.addEventListener(eventName, recordUserActivity, { passive: true, capture: true });
    });
    window.addEventListener('mousemove', recordUserActivity, { passive: true });
    window.addEventListener('focus', () => recordUserActivity({ force: true }));
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  function startInactivityTracking() {
    bindActivityListeners();
    automaticLogoutInProgress = false;
    recordUserActivity({ force: true });
  }

  function stopInactivityTracking() {
    clearInactivityTimers();
    clearLastActivity();
    lastActivityRecordedAt = 0;
  }

  function readSession() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      return parsed && typeof parsed.token === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveSession(token, account) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, account }));
      return true;
    } catch {
      return false;
    }
  }

  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Session may be blocked. */ }
  }

  function normalizeApprovalStatus(account) {
    if (account?.isDefault) return 'Approved';
    return ['Pending', 'Approved', 'Rejected'].includes(account?.approvalStatus)
      ? account.approvalStatus
      : 'Pending';
  }

  function normalizeAccount(account) {
    if (!account) return null;
    return {
      id: account.id,
      email: account.email || '',
      username: account.username || '',
      displayName: account.displayName || account.username || 'LSO Account',
      role: ['Administrator', 'Staff Account', 'Membership', 'General Secretary', 'Trainee/Probationary'].includes(account.role) ? account.role : 'Staff Account',
      memberId: String(account.memberId || account.member_id || ''),
      approvalStatus: normalizeApprovalStatus(account),
      disabled: Boolean(account.disabled),
      isDefault: Boolean(account.isDefault),
      requestedAt: account.requestedAt || account.createdAt || '',
      approvedAt: account.approvedAt || '',
      approvedBy: account.approvedBy || '',
      rejectedAt: account.rejectedAt || '',
      rejectedBy: account.rejectedBy || '',
      createdAt: account.createdAt || ''
    };
  }

  function setMessage(id, message = '', success = false) {
    const node = el(id);
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('hidden', !message);
    node.classList.toggle('success', Boolean(message && success));
  }

  function setFormBusy(formId, busy) {
    const form = el(formId);
    if (!form) return;
    [...form.elements].forEach((control) => { control.disabled = Boolean(busy); });
    form.classList.toggle('is-busy', Boolean(busy));
  }

  function switchAuthMode(mode) {
    const isLogin = mode === 'login';
    el('loginForm')?.classList.toggle('hidden', !isLogin);
    el('registerForm')?.classList.toggle('hidden', isLogin);
    el('loginTab')?.classList.toggle('active', isLogin);
    el('registerTab')?.classList.toggle('active', !isLogin);
    el('loginTab')?.setAttribute('aria-selected', String(isLogin));
    el('registerTab')?.setAttribute('aria-selected', String(!isLogin));
    setMessage('loginMessage');
    setMessage('registerMessage');
    setTimeout(() => (isLogin ? el('loginUsername') : el('registerDisplayName'))?.focus(), 30);
  }

  function accountInitial(account) {
    const source = String(account?.displayName || account?.username || 'A').trim();
    return source.charAt(0).toUpperCase() || 'A';
  }

  function startAccountRefresh() {
    clearInterval(accountRefreshTimer);
    accountRefreshTimer = setInterval(() => {
      if (window.LSOCurrentAccount?.role === 'Administrator' && !document.hidden) {
        refreshAccounts().catch(() => undefined);
      }
    }, 10000);
  }

  function stopAccountRefresh() {
    clearInterval(accountRefreshTimer);
    accountRefreshTimer = null;
  }

  function showApplication(account) {
    const normalized = normalizeAccount(account);
    window.LSOCurrentAccount = normalized;
    document.body.dataset.accountRole = normalized.role;
    const traineeAccess = normalized.role === 'Trainee/Probationary';
    const roleAccess = window.LSORoleAccess;
    document.body.dataset.accessMode = normalized.role === 'Administrator'
      ? 'full'
      : normalized.role === 'Membership'
        ? 'membership-operations'
        : normalized.role === 'General Secretary'
          ? 'attendance-operations'
          : traineeAccess
            ? 'duty-entry'
            : 'read-only';
    document.body.dataset.storageMode = 'cloud';
    // The application stays fail-closed until role setup is complete.
    if (el('currentAccountName')) el('currentAccountName').textContent = normalized.displayName || normalized.username;
    if (el('currentAccountUsername')) el('currentAccountUsername').textContent = `@${normalized.username}`;
    if (el('accountAvatar')) el('accountAvatar').textContent = accountInitial(normalized);
    if (el('currentAccountRole')) {
      el('currentAccountRole').textContent = roleAccess?.roleDescription?.(normalized) || normalized.role;
    }
    document.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', normalized.role !== 'Administrator'));
    document.querySelectorAll('.trainee-only').forEach((node) => node.classList.toggle('hidden', !traineeAccess));
    document.querySelectorAll('.nav-item').forEach((node) => {
      const allowed = roleAccess?.canAccessView?.(node.dataset.view, normalized) ?? (!traineeAccess || node.dataset.view === 'dutyHoursView');
      node.classList.toggle('role-hidden', !allowed);
      node.setAttribute('aria-hidden', String(!allowed));
      if (!allowed) node.tabIndex = -1;
      else node.removeAttribute('tabindex');
    });
    const activeView = document.querySelector('.view.active')?.id;
    const landingView = roleAccess?.defaultView?.(normalized) || (traineeAccess ? 'dutyHoursView' : 'dashboardView');
    if (!activeView || !(roleAccess?.canAccessView?.(activeView, normalized) ?? true)) window.LSOApp?.setView?.(landingView);
    if (!unlockApplicationShell()) return;
    emit('lso:auth-changed', normalized);
    window.LSOPermissions?.apply?.();
    document.title = traineeAccess ? 'Duty Hours | LSO Orchestra Management System' : 'LSO Orchestra Management System';
    startAccountRefresh();
    stopLoginCooldownTicker();
    startInactivityTracking();
  }

  function showLoginScreen({ preserveMessage = false } = {}) {
    window.LSOCurrentAccount = null;
    delete document.body.dataset.accountRole;
    delete document.body.dataset.accessMode;
    document.body.dataset.storageMode = 'cloud';
    lockApplicationShell();
    el('sidebar')?.classList.remove('open');
    el('memberModal')?.classList.add('hidden');
    document.body.style.overflow = '';
    document.title = 'Login | LSO Orchestra Management System';
    el('loginForm')?.reset();
    el('registerForm')?.reset();
    if (el('loginUsername')) el('loginUsername').value = '';
    if (el('loginPassword')) el('loginPassword').value = '';
    if (!preserveMessage) switchAuthMode('login');
    emit('lso:auth-changed', null);
    stopAccountRefresh();
    stopInactivityTracking();
    startLoginCooldownTicker();
  }

  function loginMessageForCode(code) {
    const messages = {
      invalid_credentials: 'The username or password is incorrect.',
      pending: 'Your registration is pending administrator approval.',
      rejected: 'Your registration was rejected. Please contact the administrator.',
      disabled: 'This account has been disabled by an administrator.',
      session_expired: 'Your session expired. Please log in again.'
    };
    return messages[code] || 'Login could not be completed.';
  }

  function registrationMessageForCode(code) {
    const messages = {
      invalid_username: 'Username must be 4–30 characters and may contain letters, numbers, periods, underscores, or hyphens.',
      reserved_username: `${DEFAULT_USERNAME} is reserved for the default administrator.`,
      invalid_display_name: 'Enter a valid display name.',
      weak_password: 'Password must contain at least 6 characters.',
      invalid_email: 'Enter a valid email address or leave it blank.',
      username_taken: 'That username is already registered.'
    };
    return messages[code] || 'The registration could not be submitted.';
  }

  async function refreshAccounts() {
    const active = window.LSOCurrentAccount;
    if (!active) {
      accountsCache = [];
      emit('lso:accounts-changed', { count: 0, source: 'cloud' });
      return accountsCache;
    }

    try {
      if (active.role === 'Administrator') {
        const result = await window.LSOCloud.listProfiles();
        accountsCache = Array.isArray(result) ? result.map(normalizeAccount).filter(Boolean) : [];
      } else {
        accountsCache = [normalizeAccount(active)];
      }
      emit('lso:accounts-changed', { count: accountsCache.length, source: 'cloud' });
      return accountsCache;
    } catch (error) {
      console.error('Unable to refresh accounts:', error);
      return accountsCache;
    }
  }

  async function authorize(account, token, { resumed = false } = {}) {
    const normalized = normalizeAccount(account);
    if (!normalized || normalizeApprovalStatus(normalized) !== 'Approved' || normalized.disabled) {
      clearSession();
      await window.LSOCloud.disconnect();
      showLoginScreen({ preserveMessage: true });
      setMessage('loginMessage', loginMessageForCode(normalized?.disabled ? 'disabled' : normalizeApprovalStatus(normalized)));
      return false;
    }

    try {
      await window.LSOCloud.loadSharedState();
      const migrated = await window.LSOCloud.migrateLegacyIfNeeded(normalized.role === 'Administrator');
      if (!saveSession(token, normalized)) {
        throw new Error('This browser blocked session storage. Allow browser storage and try again.');
      }
      showApplication(normalized);
      await refreshAccounts();
      window.LSOApp?.refresh?.();
      window.LSOOperations?.refreshAll?.();
      if (normalized.role === 'Trainee/Probationary') {
        window.LSOApp?.setView?.('dutyHoursView');
        window.LSODutyHours?.refresh?.();
      }
      if (migrated) {
        setTimeout(() => window.LSOApp?.showToast?.('Existing records from this browser were moved to the shared online database.'), 60);
      } else if (!resumed) {
        setTimeout(() => window.LSOApp?.showToast?.('Connected to the shared online database.'), 60);
      }
      return true;
    } catch (error) {
      console.error('Shared database initialization failed:', error);
      clearSession();
      await window.LSOCloud.disconnect();
      showLoginScreen({ preserveMessage: true });
      setMessage('loginMessage', error.message || 'The shared database could not be opened.');
      return false;
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setMessage('loginMessage');
    const username = el('loginUsername')?.value.trim() || '';
    const password = el('loginPassword')?.value || '';

    if (!window.LSOCloud?.isConfigured?.()) {
      setMessage('loginMessage', 'Supabase is not configured correctly. Check supabase-config.js.');
      return;
    }

    const cooldownRemaining = loginCooldownRemaining();
    if (cooldownRemaining > 0) {
      startLoginCooldownTicker();
      return;
    }

    setFormBusy('loginForm', true);
    try {
      const result = await window.LSOCloud.login(username, password);
      if (!result?.ok) {
        if (result?.code === 'invalid_credentials') {
          const security = recordInvalidCredentials();
          if (security.locked) {
            startLoginCooldownTicker();
          } else {
            const attemptWord = security.remainingAttempts === 1 ? 'attempt' : 'attempts';
            setMessage('loginMessage', `The username or password is incorrect. ${security.remainingAttempts} ${attemptWord} remaining before a 5-minute cooldown.`);
          }
        } else {
          setMessage('loginMessage', loginMessageForCode(result?.code));
        }
        return;
      }
      resetLoginSecurity();
      await authorize(result.account, result.token);
    } catch (error) {
      setMessage('loginMessage', error.message || 'The shared database could not be reached.');
    } finally {
      setFormBusy('loginForm', false);
      renderLoginCooldown();
    }
  }

  async function handleRegistration(event) {
    event.preventDefault();
    setMessage('registerMessage');

    const displayName = el('registerDisplayName')?.value.trim() || '';
    const email = el('registerEmail')?.value.trim().toLowerCase() || '';
    const username = el('registerUsername')?.value.trim() || '';
    const password = el('registerPassword')?.value || '';
    const confirmPassword = el('registerConfirmPassword')?.value || '';

    if (displayName.length < 2) {
      setMessage('registerMessage', 'Enter a valid display name.');
      return;
    }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      setMessage('registerMessage', 'Enter a valid email address or leave it blank.');
      return;
    }
    if (!/^[A-Za-z0-9._-]{4,30}$/.test(username)) {
      setMessage('registerMessage', registrationMessageForCode('invalid_username'));
      return;
    }
    if (normalizeUsername(username) === normalizeUsername(DEFAULT_USERNAME)) {
      setMessage('registerMessage', registrationMessageForCode('reserved_username'));
      return;
    }
    if (password.length < 6) {
      setMessage('registerMessage', registrationMessageForCode('weak_password'));
      return;
    }
    if (password !== confirmPassword) {
      setMessage('registerMessage', 'The passwords do not match.');
      return;
    }

    setFormBusy('registerForm', true);
    try {
      const result = await window.LSOCloud.registerAccount({ username, password, displayName, email });
      if (!result?.ok) {
        setMessage('registerMessage', registrationMessageForCode(result?.code));
        return;
      }

      el('registerForm')?.reset();
      switchAuthMode('login');
      if (el('loginUsername')) el('loginUsername').value = username;
      if (el('loginPassword')) el('loginPassword').value = '';
      setMessage('loginMessage', 'Registration submitted. The Administrator will choose the final role and access before approval.', true);
    } catch (error) {
      setMessage('registerMessage', error.message || 'The registration could not reach the shared database.');
    } finally {
      setFormBusy('registerForm', false);
    }
  }

  async function handleLogout() {
    stopInactivityTracking();
    clearSession();
    try { await window.LSOCloud.logout(); } catch { /* The local session is still cleared. */ }
    showLoginScreen();
  }

  async function saveAccounts(accounts) {
    if (window.LSOCurrentAccount?.role !== 'Administrator') return false;
    try {
      const result = await window.LSOCloud.saveAccounts(accounts);
      accountsCache = Array.isArray(result) ? result.map(normalizeAccount).filter(Boolean) : accountsCache;
      emit('lso:accounts-changed', { count: accountsCache.length, source: 'cloud' });
      return true;
    } catch (error) {
      window.LSOApp?.showToast?.(error.message || 'Account changes could not be saved.', true);
      return false;
    }
  }

  async function deleteAccount(accountId) {
    if (window.LSOCurrentAccount?.role !== 'Administrator') return false;
    try {
      const deleted = await window.LSOCloud.deleteAccount(accountId);
      if (deleted) await refreshAccounts();
      return Boolean(deleted);
    } catch (error) {
      window.LSOApp?.showToast?.(error.message || 'The account could not be deleted.', true);
      return false;
    }
  }

  async function refreshActiveAccount() {
    const stored = readSession();
    if (!stored?.token) {
      showLoginScreen();
      return false;
    }

    try {
      const result = await window.LSOCloud.resumeSession(stored.token);
      if (!result?.ok) {
        clearSession();
        showLoginScreen({ preserveMessage: true });
        setMessage('loginMessage', loginMessageForCode(result?.code));
        return false;
      }
      return authorize(result.account, stored.token, { resumed: true });
    } catch (error) {
      showLoginScreen({ preserveMessage: true });
      setMessage('loginMessage', error.message || 'The shared database could not be reached.');
      return false;
    }
  }

  async function handleInvalidSession(event) {
    clearSession();
    await window.LSOCloud.disconnect();
    showLoginScreen({ preserveMessage: true });
    setMessage('loginMessage', event?.detail?.message || 'Your session expired. Please log in again.');
  }

  function wireAuthEvents() {
    el('loginTab')?.addEventListener('click', () => switchAuthMode('login'));
    el('registerTab')?.addEventListener('click', () => switchAuthMode('register'));
    el('loginForm')?.addEventListener('submit', handleLogin);
    el('registerForm')?.addEventListener('submit', handleRegistration);
    el('logoutButton')?.addEventListener('click', handleLogout);
    window.addEventListener('lso:session-invalid', handleInvalidSession);

    document.querySelectorAll('[data-password-target]').forEach((button) => {
      button.addEventListener('click', () => {
        const input = el(button.dataset.passwordTarget);
        if (!input) return;
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        button.textContent = isHidden ? 'Hide' : 'Show';
        button.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
      });
    });
  }

  window.LSOAuth = {
    loadAccounts: () => accountsCache.map((account) => ({ ...account })),
    saveAccounts,
    deleteAccount,
    refreshAccounts,
    getActiveAccount: () => window.LSOCurrentAccount ? { ...window.LSOCurrentAccount } : null,
    signOut: handleLogout,
    refreshActiveAccount,
    securitySettings: {
      maxFailedAttempts: MAX_FAILED_ATTEMPTS,
      cooldownMinutes: LOGIN_COOLDOWN_MS / 60000,
      inactivityMinutes: INACTIVITY_TIMEOUT_MS / 60000
    }
  };

  async function initializeAuth() {
    lockApplicationShell();
    installAuthenticationGateObserver();
    wireAuthEvents();
    bindActivityListeners();
    showLoginScreen();

    if (!window.LSOCloud?.isConfigured?.()) {
      setMessage('loginMessage', 'Supabase is not configured correctly. Add the exact Project URL and publishable key to supabase-config.js.');
      return;
    }

    try {
      await window.LSOCloud.checkConnection();
      await window.LSOCloud.bootstrapDefaultAdmin();
      const stored = readSession();
      if (stored?.token) {
        await refreshActiveAccount();
      }
    } catch (error) {
      showLoginScreen({ preserveMessage: true });
      setMessage('loginMessage', error.message || 'The Supabase project could not be reached.');
    }
  }

  initializeAuth().catch((error) => {
    showLoginScreen({ preserveMessage: true });
    setMessage('loginMessage', error.message || 'The online account system could not be initialized.');
  });
})();
