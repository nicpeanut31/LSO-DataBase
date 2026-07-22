(() => {
  'use strict';

  const ROLES = Object.freeze({
    ADMIN: 'Administrator',
    STAFF: 'Staff Account',
    MEMBERSHIP: 'Membership',
    SECRETARY: 'General Secretary',
    TRAINEE: 'Trainee/Probationary'
  });

  const VIEW_RULES = Object.freeze({
    [ROLES.ADMIN]: ['dashboardView', 'membersView', 'lookupView', 'contractView', 'monthlyReportView', 'attendanceView', 'dutyHoursView', 'alertsView', 'accountsView', 'dataView'],
    [ROLES.STAFF]: ['dashboardView', 'membersView', 'lookupView', 'contractView', 'monthlyReportView', 'attendanceView', 'dutyHoursView', 'alertsView', 'dataView'],
    [ROLES.MEMBERSHIP]: ['dashboardView', 'membersView', 'lookupView', 'contractView', 'monthlyReportView', 'attendanceView', 'dutyHoursView'],
    [ROLES.SECRETARY]: ['dashboardView', 'attendanceView'],
    [ROLES.TRAINEE]: ['dutyHoursView']
  });

  const ACTION_RULES = Object.freeze({
    manageAccounts: [ROLES.ADMIN],
    manageMembers: [ROLES.ADMIN, ROLES.MEMBERSHIP],
    generateContract: [ROLES.ADMIN, ROLES.MEMBERSHIP],
    editMonthlyReport: [ROLES.ADMIN, ROLES.MEMBERSHIP],
    manageEvents: [ROLES.ADMIN, ROLES.MEMBERSHIP, ROLES.SECRETARY],
    deleteEvents: [ROLES.ADMIN],
    saveDraftAttendance: [ROLES.ADMIN, ROLES.MEMBERSHIP, ROLES.SECRETARY],
    finalizeAttendance: [ROLES.ADMIN],
    unlockAttendance: [ROLES.ADMIN],
    reviewDutyPunches: [ROLES.ADMIN, ROLES.MEMBERSHIP],
    manageDutyHours: [ROLES.ADMIN, ROLES.MEMBERSHIP],
    manageSettings: [ROLES.ADMIN],
    manageInventory: [ROLES.ADMIN],
    manageData: [ROLES.ADMIN],
    writeActivityLog: [ROLES.ADMIN, ROLES.MEMBERSHIP, ROLES.SECRETARY],
    selfDutyPunch: [ROLES.TRAINEE]
  });

  const COLUMN_RULES = Object.freeze({
    [ROLES.ADMIN]: ['members', 'events', 'attendance', 'duty_hours', 'monthly_reports', 'monthly_reports_compat', 'instruments', 'settings', 'activity_log'],
    [ROLES.MEMBERSHIP]: ['members', 'events', 'attendance', 'duty_hours', 'monthly_reports', 'monthly_reports_compat', 'settings', 'activity_log'],
    [ROLES.SECRETARY]: ['events', 'attendance', 'activity_log'],
    [ROLES.STAFF]: [],
    [ROLES.TRAINEE]: []
  });

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function role(account = currentAccount()) {
    const value = account?.role;
    return Object.values(ROLES).includes(value) ? value : ROLES.STAFF;
  }

  function canAccessView(viewId, account = currentAccount()) {
    return (VIEW_RULES[role(account)] || []).includes(String(viewId || ''));
  }

  function can(action, account = currentAccount()) {
    return (ACTION_RULES[action] || []).includes(role(account));
  }

  function canWriteColumn(column, account = currentAccount()) {
    return (COLUMN_RULES[role(account)] || []).includes(String(column || ''));
  }

  function canUseAttendanceGroup(group, account = currentAccount()) {
    const accountRole = role(account);
    if (accountRole === ROLES.MEMBERSHIP) return ['Trainee Members', 'Probationary Members'].includes(String(group || ''));
    return [ROLES.ADMIN, ROLES.STAFF, ROLES.SECRETARY].includes(accountRole);
  }

  function defaultAttendanceGroup(account = currentAccount()) {
    return role(account) === ROLES.MEMBERSHIP ? 'Trainee Members' : 'Official Members';
  }

  function defaultView(account = currentAccount()) {
    return (VIEW_RULES[role(account)] || ['dashboardView'])[0] || 'dashboardView';
  }

  function roleDescription(account = currentAccount()) {
    const value = role(account);
    if (value === ROLES.ADMIN) return 'Administrator • Full Access';
    if (value === ROLES.MEMBERSHIP) return 'Membership • Membership, Reports, Attendance & Duty Hours';
    if (value === ROLES.SECRETARY) return 'General Secretary • Dashboard & Attendance';
    if (value === ROLES.TRAINEE) return 'Trainee/Probationary • Duty Hours Only';
    return 'Staff Account • Read Only';
  }

  function deniedMessage(action = '') {
    const value = role();
    if (value === ROLES.SECRETARY) {
      if (['finalizeAttendance', 'unlockAttendance'].includes(action)) return 'General Secretary access can create activities and save Draft attendance. Only the Administrator can finalize or unlock attendance.';
      return 'General Secretary access is limited to the Dashboard and Attendance workspace.';
    }
    if (value === ROLES.MEMBERSHIP) {
      if (action === 'attendanceGroup') return 'Membership attendance access is limited to Trainee and Probationary rosters.';
      if (['finalizeAttendance', 'unlockAttendance'].includes(action)) return 'Membership access can create activities and save Draft attendance for Trainee and Probationary rosters. Only the Administrator can finalize or unlock attendance.';
      return 'Membership access is limited to Dashboard, Members, Member Lookup, Contract, Monthly Report, Attendance, and Duty Hours.';
    }
    if (value === ROLES.TRAINEE) return 'Trainee/Probationary access is limited to personal Duty Hours submission.';
    if (value === ROLES.STAFF) return 'Staff Accounts are read-only.';
    return 'You do not have permission to perform this action.';
  }

  window.LSORoleAccess = {
    ROLES,
    role,
    currentAccount,
    canAccessView,
    can,
    canWriteColumn,
    canUseAttendanceGroup,
    defaultAttendanceGroup,
    defaultView,
    roleDescription,
    deniedMessage,
    viewsForRole: (account = currentAccount()) => [...(VIEW_RULES[role(account)] || [])]
  };
})();
