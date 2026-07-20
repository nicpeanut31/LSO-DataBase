(() => {
  'use strict';

  const SESSION_KEY = 'lso_shared_session_v1';
  const DEFAULT_USERNAME = 'SNA1161';
  const el = (id) => document.getElementById(id);
  const normalizeUsername = (value) => String(value || '').trim().toLowerCase();

  let accountsCache = [];
  let accountRefreshTimer = null;

  function emit(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
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
      role: ['Administrator', 'Staff Account', 'Trainee/Probationary'].includes(account.role) ? account.role : 'Staff Account',
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
    document.body.dataset.accessMode = normalized.role === 'Administrator' ? 'full' : traineeAccess ? 'duty-entry' : 'read-only';
    document.body.dataset.storageMode = 'cloud';
    el('authScreen')?.classList.add('hidden');
    el('appShell')?.classList.remove('hidden');
    if (el('currentAccountName')) el('currentAccountName').textContent = normalized.displayName || normalized.username;
    if (el('currentAccountUsername')) el('currentAccountUsername').textContent = `@${normalized.username}`;
    if (el('accountAvatar')) el('accountAvatar').textContent = accountInitial(normalized);
    if (el('currentAccountRole')) {
      el('currentAccountRole').textContent = normalized.role === 'Administrator'
        ? 'Administrator • Full Access'
        : traineeAccess
          ? 'Trainee/Probationary • Duty Hours Only'
          : 'Staff Account • Read Only';
    }
    document.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', normalized.role !== 'Administrator'));
    document.querySelectorAll('.trainee-only').forEach((node) => node.classList.toggle('hidden', !traineeAccess));
    document.querySelectorAll('.nav-item').forEach((node) => {
      const allowed = !traineeAccess || node.dataset.view === 'dutyHoursView';
      node.classList.toggle('role-hidden', !allowed);
      node.setAttribute('aria-hidden', String(!allowed));
      if (!allowed) node.tabIndex = -1;
      else node.removeAttribute('tabindex');
    });
    if (traineeAccess) window.LSOApp?.setView?.('dutyHoursView');
    emit('lso:auth-changed', normalized);
    window.LSOPermissions?.apply?.();
    document.title = traineeAccess ? 'Duty Hours | LSO Orchestra Management System' : 'LSO Orchestra Management System';
    startAccountRefresh();
  }

  function showLoginScreen({ preserveMessage = false } = {}) {
    window.LSOCurrentAccount = null;
    delete document.body.dataset.accountRole;
    delete document.body.dataset.accessMode;
    document.body.dataset.storageMode = 'cloud';
    el('appShell')?.classList.add('hidden');
    el('authScreen')?.classList.remove('hidden');
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

    setFormBusy('loginForm', true);
    try {
      const result = await window.LSOCloud.login(username, password);
      if (!result?.ok) {
        setMessage('loginMessage', loginMessageForCode(result?.code));
        return;
      }
      await authorize(result.account, result.token);
    } catch (error) {
      setMessage('loginMessage', error.message || 'The shared database could not be reached.');
    } finally {
      setFormBusy('loginForm', false);
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
      setMessage('loginMessage', 'Registration submitted. The Administrator will choose your role before approval. Trainee/Probationary accounts will receive Duty Hours–only access.', true);
    } catch (error) {
      setMessage('registerMessage', error.message || 'The registration could not reach the shared database.');
    } finally {
      setFormBusy('registerForm', false);
    }
  }

  async function handleLogout() {
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
    refreshActiveAccount
  };

  async function initializeAuth() {
    wireAuthEvents();
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
