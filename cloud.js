(() => {
  'use strict';

  const TABLE_ROW_ID = 1;
  const POLL_INTERVAL_MS = 5000;
  const PENDING_KEY = 'lso_cloud_pending_v1';
  const MONTHLY_COMPAT_COLUMN = 'monthly_reports_compat';
  const MONTHLY_SETTINGS_KEY = '__lso_monthly_reports_v1';
  const KEY_TO_COLUMN = {
    lso_member_database_v1: 'members',
    lso_events_v2: 'events',
    lso_attendance_v2: 'attendance',
    lso_instruments_v2: 'instruments',
    lso_activity_log_v2: 'activity_log',
    lso_system_settings_v2: 'settings',
    lso_duty_hours_v1: 'duty_hours',
    lso_monthly_reports_v1: MONTHLY_COMPAT_COLUMN
  };
  const ARRAY_COLUMNS = new Set(['members', 'events', 'attendance', 'instruments', 'activity_log']);
  const OBJECT_COLUMNS = new Set(['settings', 'duty_hours', MONTHLY_COMPAT_COLUMN]);
  const nativeStorage = window.localStorage;
  const config = window.LSO_SUPABASE_CONFIG || {};
  const configured = Boolean(
    /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(String(config.url || '').trim()) &&
    String(config.anonKey || '').trim().length > 20 &&
    !String(config.url).includes('PASTE_') &&
    !String(config.anonKey).includes('PASTE_')
  );

  let client = null;
  let sessionToken = '';
  let sessionAccount = null;
  let state = null;
  let loaded = false;
  let online = false;
  let lastServerUpdate = '';
  let pollTimer = null;
  let flushTimer = null;
  let flushing = false;
  const dirtyVersions = new Map();
  const legacySnapshot = {};

  try {
    const pending = JSON.parse(nativeStorage.getItem(PENDING_KEY) || '[]');
    if (Array.isArray(pending)) pending.forEach((column) => {
      const normalizedColumn = column === 'monthly_reports' ? MONTHLY_COMPAT_COLUMN : column;
      if ([...ARRAY_COLUMNS, ...OBJECT_COLUMNS].includes(normalizedColumn)) dirtyVersions.set(normalizedColumn, 1);
    });
  } catch {
    // A malformed pending marker is ignored.
  }

  Object.keys(KEY_TO_COLUMN).forEach((key) => {
    try {
      const raw = nativeStorage.getItem(key);
      if (raw !== null) legacySnapshot[key] = raw;
    } catch {
      // A blocked local cache does not prevent the cloud connection itself.
    }
  });

  function emit(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function status(kind, message) {
    emit('lso:cloud-status', { kind, message });
  }

  function canWriteShared() {
    return sessionAccount?.role === 'Administrator';
  }

  function isTraineeAccount() {
    return sessionAccount?.role === 'Trainee/Probationary';
  }

  function emitReadOnlyDenied() {
    const message = isTraineeAccount()
      ? 'Trainee/Probationary accounts may submit only their own Duty Hours entries.'
      : 'Staff Accounts have read-only access. An Administrator is required to save changes.';
    emit('lso:permission-denied', { message });
  }

  function safeParse(raw, fallback) {
    try {
      const parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function defaultForColumn(column) {
    return ARRAY_COLUMNS.has(column) ? [] : {};
  }

  function normalizeColumn(column, value) {
    if (ARRAY_COLUMNS.has(column)) return Array.isArray(value) ? value : [];
    if (OBJECT_COLUMNS.has(column)) return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {};
  }

  function getLocal(key) {
    try {
      return nativeStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function setLocal(key, value) {
    try {
      nativeStorage.setItem(key, String(value));
      return true;
    } catch {
      return false;
    }
  }

  function removeLocal(key) {
    try {
      nativeStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function dispatchDomainChange(key, source = 'cloud') {
    if (key === 'lso_member_database_v1') emit('lso:members-changed', { source });
    if (['lso_events_v2', 'lso_attendance_v2', 'lso_instruments_v2', 'lso_activity_log_v2', 'lso_system_settings_v2', 'lso_duty_hours_v1', 'lso_monthly_reports_v1'].includes(key)) {
      emit('lso:operations-changed', { key, source });
    }
    emit('lso:cloud-state-changed', { key, source });
  }

  function stateColumn(stateObject, column) {
    if (!stateObject) return defaultForColumn(column);
    if (column === MONTHLY_COMPAT_COLUMN) {
      const settingsValue = stateObject.settings && typeof stateObject.settings === 'object' && !Array.isArray(stateObject.settings)
        ? stateObject.settings[MONTHLY_SETTINGS_KEY]
        : null;
      if (settingsValue && typeof settingsValue === 'object' && !Array.isArray(settingsValue)) {
        return normalizeColumn(column, settingsValue);
      }
      return normalizeColumn(column, stateObject.monthly_reports);
    }
    if (column === 'settings') {
      const settingsValue = normalizeColumn(column, stateObject.settings);
      const cleanSettings = { ...settingsValue };
      delete cleanSettings[MONTHLY_SETTINGS_KEY];
      return cleanSettings;
    }
    return normalizeColumn(column, stateObject[column]);
  }

  function applyState(nextState, source = 'cloud') {
    if (!nextState || typeof nextState !== 'object') return;
    state = nextState;
    lastServerUpdate = String(nextState.updated_at || nextState.updatedAt || '');

    Object.entries(KEY_TO_COLUMN).forEach(([key, column]) => {
      if (dirtyVersions.has(column)) return;
      const serialized = JSON.stringify(stateColumn(nextState, column));
      if (getLocal(key) !== serialized) {
        setLocal(key, serialized);
        dispatchDomainChange(key, source);
      }
    });

    loaded = true;
    emit('lso:cloud-loaded', { state: cloneState(), source });
  }

  function cloneState() {
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  function rpcErrorMessage(error) {
    const message = String(error?.message || error?.details || error?.hint || 'Unknown database error');
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return 'The Supabase project could not be reached. Verify the Project URL, project status, and internet connection.';
    }
    if (/column [\"']?member_id[\"']? does not exist/i.test(message)) {
      return 'The account database is missing the member_id upgrade. Run LSO_MASTER_DATABASE_REPAIR.sql in Supabase SQL Editor, then refresh this page.';
    }
    if (/violates check constraint.*role|lso_accounts_role_check/i.test(message)) {
      return 'The account database still uses the old role list. Run LSO_MASTER_DATABASE_REPAIR.sql in Supabase SQL Editor, then refresh this page.';
    }
    if (/function .* does not exist|could not find the function|schema cache/i.test(message)) {
      return 'The required database functions are missing. Run URGENT_MEMBER_ID_APPROVAL_FIX.sql in the Supabase SQL Editor, then refresh this page.';
    }
    if (/unsupported shared-data column/i.test(message)) {
      return 'The shared database is using an older schema. Monthly Report data will use compatibility storage automatically.';
    }
    if (/already linked to another active approved/i.test(message)) {
      return 'This member is already linked to another active approved Trainee/Probationary account.';
    }
    if (/overlaps an existing pending or approved duty entry/i.test(message)) {
      return 'This time overlaps an existing pending or approved duty entry for the same date.';
    }
    if (/already been reviewed/i.test(message)) {
      return 'This duty entry was already reviewed. Refresh the Duty Hours page to see its current status.';
    }
    if (/outside this member.*Trainee or Probationary period/i.test(message)) {
      return 'The selected date is outside the linked member’s Trainee or Probationary period.';
    }
    if (/future duty date/i.test(message)) {
      return 'A future duty date cannot be submitted.';
    }
    return message;
  }

  async function rpc(name, params = {}) {
    if (!configured || !client) throw new Error('Supabase is not configured.');
    const { data, error } = await client.rpc(name, params);
    if (error) {
      const message = rpcErrorMessage(error);
      if (/invalid or expired session/i.test(message)) emit('lso:session-invalid', { message });
      throw new Error(message);
    }
    return data;
  }

  function initClient() {
    if (!configured) {
      status('offline', 'Supabase configuration is missing or invalid');
      return null;
    }
    if (!window.supabase?.createClient) {
      status('offline', 'Supabase client library did not load');
      return null;
    }
    client = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      },
      global: {
        headers: { 'x-application-name': 'lso-orchestra-management' }
      }
    });
    return client;
  }

  async function checkConnection() {
    try {
      const result = await rpc('lso_ping');
      online = Boolean(result?.ok);
      status(online ? 'online' : 'offline', online ? 'Shared database connected' : 'Shared database unavailable');
      return online;
    } catch (error) {
      online = false;
      status('offline', error.message);
      throw error;
    }
  }

  function currentValueForColumn(column) {
    if (column === MONTHLY_COMPAT_COLUMN) {
      return normalizeColumn(column, safeParse(getLocal('lso_monthly_reports_v1'), {}));
    }
    const key = Object.keys(KEY_TO_COLUMN).find((item) => KEY_TO_COLUMN[item] === column);
    return normalizeColumn(column, safeParse(getLocal(key), defaultForColumn(column)));
  }

  function settingsPayloadWithMonthlyCompatibility() {
    return {
      ...currentValueForColumn('settings'),
      [MONTHLY_SETTINGS_KEY]: currentValueForColumn(MONTHLY_COMPAT_COLUMN)
    };
  }

  function persistDirtyMarkers() {
    try {
      if (dirtyVersions.size) nativeStorage.setItem(PENDING_KEY, JSON.stringify([...dirtyVersions.keys()]));
      else nativeStorage.removeItem(PENDING_KEY);
    } catch {
      // Cloud saving can still continue if the pending marker cannot be stored.
    }
  }

  function scheduleFlush(delay = 180) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flushDirty().catch(() => undefined), delay);
  }

  function markDirty(column) {
    if (!canWriteShared()) {
      emitReadOnlyDenied();
      return;
    }
    dirtyVersions.set(column, (dirtyVersions.get(column) || 0) + 1);
    persistDirtyMarkers();
    scheduleFlush();
  }

  async function flushDirty() {
    if (!canWriteShared()) return;
    if (flushing || !sessionToken || !dirtyVersions.size) return;
    flushing = true;
    status('syncing', `Saving ${dirtyVersions.size} change${dirtyVersions.size === 1 ? '' : 's'}…`);

    try {
      for (const [column, version] of [...dirtyVersions.entries()]) {
        const serverColumn = column === MONTHLY_COMPAT_COLUMN ? 'settings' : column;
        const serverValue = column === MONTHLY_COMPAT_COLUMN || column === 'settings'
          ? settingsPayloadWithMonthlyCompatibility()
          : currentValueForColumn(column);
        const nextState = await rpc('lso_update_state', {
          p_token: sessionToken,
          p_column: serverColumn,
          p_value: serverValue
        });
        online = true;
        state = nextState;
        lastServerUpdate = String(nextState?.updated_at || '');
        if (dirtyVersions.get(column) === version) {
          dirtyVersions.delete(column);
          persistDirtyMarkers();
        }
      }
      applyState(state, 'cloud-save');
      status('online', 'All changes saved to the shared database');
      emit('lso:cloud-saved', { pending: dirtyVersions.size });
    } catch (error) {
      online = false;
      status('offline', `${error.message} Changes remain queued on this device.`);
      scheduleFlush(5000);
      throw error;
    } finally {
      flushing = false;
    }
  }

  function storageGetItem(key) {
    return getLocal(key);
  }

  function storageSetItem(key, value) {
    const column = KEY_TO_COLUMN[key];
    if (column && sessionToken && sessionAccount && !canWriteShared()) {
      emitReadOnlyDenied();
      return false;
    }
    const saved = setLocal(key, value);
    if (saved && column && sessionToken && loaded) markDirty(column);
    return saved;
  }

  function storageRemoveItem(key) {
    const column = KEY_TO_COLUMN[key];
    if (column && sessionToken && sessionAccount && !canWriteShared()) {
      emitReadOnlyDenied();
      return false;
    }
    const removed = removeLocal(key);
    if (removed && column && sessionToken && loaded) {
      setLocal(key, JSON.stringify(defaultForColumn(column)));
      markDirty(column);
    }
    return removed;
  }

  async function loadSharedState({ quiet = false } = {}) {
    if (!sessionToken) throw new Error('No active shared-database session.');
    if (!quiet) status('syncing', 'Loading shared records…');
    const nextState = await rpc('lso_get_state', { p_token: sessionToken });
    online = true;
    applyState(nextState, 'cloud');
    if (!quiet) status('online', 'Shared database connected');
    return cloneState();
  }

  function buildLegacyState() {
    const result = {};
    let monthlyReports = {};
    Object.entries(KEY_TO_COLUMN).forEach(([key, column]) => {
      if (column === MONTHLY_COMPAT_COLUMN) {
        monthlyReports = normalizeColumn(column, safeParse(legacySnapshot[key], {}));
        return;
      }
      result[column] = normalizeColumn(column, safeParse(legacySnapshot[key], defaultForColumn(column)));
    });
    result.settings = { ...(result.settings || {}), [MONTHLY_SETTINGS_KEY]: monthlyReports };
    result.monthly_reports = monthlyReports;
    return result;
  }

  function hasMeaningfulData(candidate) {
    if (!candidate) return false;
    const duty = candidate.duty_hours && typeof candidate.duty_hours === 'object' ? candidate.duty_hours : {};
    const monthly = candidate.settings?.[MONTHLY_SETTINGS_KEY] && typeof candidate.settings[MONTHLY_SETTINGS_KEY] === 'object'
      ? candidate.settings[MONTHLY_SETTINGS_KEY]
      : (candidate.monthly_reports && typeof candidate.monthly_reports === 'object' ? candidate.monthly_reports : {});
    return ['members', 'events', 'attendance', 'instruments', 'activity_log']
      .some((column) => Array.isArray(candidate[column]) && candidate[column].length > 0) ||
      (candidate.settings && typeof candidate.settings === 'object' && Object.keys(candidate.settings).length > 0) ||
      (Array.isArray(duty.entries) && duty.entries.length > 0) ||
      (duty.commitments && typeof duty.commitments === 'object' && Object.keys(duty.commitments).length > 0) ||
      (monthly.reports && typeof monthly.reports === 'object' && Object.keys(monthly.reports).length > 0) ||
      (monthly.traineeFiles && typeof monthly.traineeFiles === 'object' && Object.keys(monthly.traineeFiles).length > 0);
  }

  function isCloudEmpty() {
    return !hasMeaningfulData(state);
  }

  async function migrateLegacyIfNeeded(isAdministrator = false) {
    if (!isAdministrator || !sessionToken || !isCloudEmpty()) return false;
    const legacy = buildLegacyState();
    if (!hasMeaningfulData(legacy)) return false;

    status('syncing', 'Moving existing browser records to the shared database…');
    const nextState = await rpc('lso_replace_state', {
      p_token: sessionToken,
      p_state: legacy
    });
    dirtyVersions.clear();
    persistDirtyMarkers();
    applyState(nextState, 'migration');
    status('online', 'Existing records moved to the shared database');
    return true;
  }

  async function pollState() {
    if (!sessionToken || document.hidden) return;
    try {
      const nextState = await rpc('lso_get_state', { p_token: sessionToken });
      online = true;
      const nextUpdated = String(nextState?.updated_at || '');
      if (!lastServerUpdate || nextUpdated !== lastServerUpdate) applyState(nextState, 'cloud-poll');
      if (!dirtyVersions.size) status('online', 'Shared database connected');
    } catch (error) {
      online = false;
      status('offline', `${error.message} Reconnecting automatically…`);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => pollState().catch(() => undefined), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function setSession(token, account = null) {
    sessionToken = String(token || '');
    sessionAccount = account || null;
    if (sessionToken) {
      startPolling();
      if (canWriteShared() && dirtyVersions.size) scheduleFlush(500);
      status('online', canWriteShared()
        ? 'Shared database connected'
        : isTraineeAccount()
          ? 'Shared database connected • Duty Hours submission access'
          : 'Shared database connected • Staff read-only access');
    } else stopPolling();
  }

  async function disconnect({ remoteLogout = false } = {}) {
    stopPolling();
    clearTimeout(flushTimer);
    if (remoteLogout && sessionToken) {
      try { await rpc('lso_logout', { p_token: sessionToken }); } catch { /* Local sign-out still proceeds. */ }
    }
    sessionToken = '';
    sessionAccount = null;
    state = null;
    loaded = false;
    dirtyVersions.clear();
    status('offline', 'Signed out from the shared database');
  }

  async function bootstrapDefaultAdmin() {
    return rpc('lso_bootstrap_default_admin');
  }

  async function registerAccount({ username, password, displayName, email }) {
    return rpc('lso_register_account', {
      p_username: username,
      p_password: password,
      p_display_name: displayName,
      p_contact_email: email || null
    });
  }

  async function login(username, password) {
    const result = await rpc('lso_login', { p_username: username, p_password: password });
    if (result?.ok && result.token) setSession(result.token, result.account || null);
    return result;
  }

  async function resumeSession(token) {
    const result = await rpc('lso_resume_session', { p_token: token });
    if (result?.ok) setSession(token, result.account || null);
    return result;
  }

  async function logout() {
    await disconnect({ remoteLogout: true });
  }

  async function listAccounts() {
    return rpc('lso_list_accounts', { p_token: sessionToken });
  }

  async function saveAccounts(accounts) {
    return rpc('lso_save_accounts', { p_token: sessionToken, p_accounts: accounts });
  }

  async function deleteAccount(accountId) {
    return rpc('lso_delete_account', { p_token: sessionToken, p_account_id: accountId });
  }


  async function submitDutyEntry({ semester, period, date, timeIn, timeOut, description }) {
    if (!isTraineeAccount()) throw new Error('Only a Trainee/Probationary account can use self-service duty submission.');
    const nextState = await rpc('lso_submit_duty_entry', {
      p_token: sessionToken,
      p_semester: semester,
      p_period: period,
      p_date: date,
      p_time_in: timeIn,
      p_time_out: timeOut,
      p_description: description || ''
    });
    online = true;
    applyState(nextState, 'duty-submission');
    status('online', 'Duty entry submitted for administrator approval');
    return cloneState();
  }

  async function reviewDutyEntry(entryId, decision) {
    if (!canWriteShared()) throw new Error('Administrator access is required to review duty entries.');
    const nextState = await rpc('lso_review_duty_entry', {
      p_token: sessionToken,
      p_entry_id: entryId,
      p_decision: decision
    });
    online = true;
    applyState(nextState, 'duty-review');
    status('online', 'Duty entry review saved');
    return cloneState();
  }

  window.LSOStorage = {
    getItem: storageGetItem,
    setItem: storageSetItem,
    removeItem: storageRemoveItem
  };

  window.LSOCloud = {
    client: initClient(),
    isConfigured: () => configured,
    isLoaded: () => loaded,
    isOnline: () => online,
    isTrialMode: () => false,
    getItem: storageGetItem,
    setItem: storageSetItem,
    removeItem: storageRemoveItem,
    checkConnection,
    bootstrapDefaultAdmin,
    registerAccount,
    login,
    resumeSession,
    logout,
    disconnect,
    setSession,
    getSessionToken: () => sessionToken,
    getSessionAccount: () => sessionAccount ? { ...sessionAccount } : null,
    loadSharedState,
    cloneState,
    hasLegacyData: () => hasMeaningfulData(buildLegacyState()),
    isCloudEmpty,
    migrateLegacyIfNeeded,
    listProfiles: listAccounts,
    getOwnProfile: async () => sessionAccount,
    updateProfiles: saveAccounts,
    deleteAccount,
    saveAccounts,
    submitDutyEntry,
    reviewDutyEntry,
    flush: flushDirty,
    pollNow: pollState,
    canWrite: canWriteShared
  };

  window.addEventListener('online', () => {
    if (!sessionToken) return;
    checkConnection()
      .then(() => flushDirty())
      .then(() => pollState())
      .catch(() => undefined);
  });

  window.addEventListener('beforeunload', () => {
    if (dirtyVersions.size) flushDirty().catch(() => undefined);
  });

  if (!configured) status('offline', 'Supabase configuration is missing or invalid');
  else if (!client) status('offline', 'Supabase client library did not load');
  else status('syncing', 'Ready to connect to the shared database');
})();
