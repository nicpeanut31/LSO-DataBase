(() => {
  'use strict';

  const DUTY_KEY = 'lso_duty_hours_v1';
  const PERIODS = ['Trainee Period', 'Probationary Period'];
  const el = (id) => document.getElementById(id);
  const safeText = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));

  let selectedMemberId = '';
  let searchTerm = '';

  function today() {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function uid(prefix = 'duty') {
    return window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function currentAccount() {
    return window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || null;
  }

  function isAdmin() {
    return currentAccount()?.role === 'Administrator';
  }

  function getMembers() {
    return window.LSOApp?.getMembers?.() || [];
  }

  function defaultData() {
    return { version: 1, commitments: {}, entries: [] };
  }

  function loadData() {
    try {
      const parsed = JSON.parse(window.LSOStorage?.getItem(DUTY_KEY) || '{}');
      return {
        version: 1,
        commitments: parsed?.commitments && typeof parsed.commitments === 'object' && !Array.isArray(parsed.commitments)
          ? parsed.commitments
          : {},
        entries: Array.isArray(parsed?.entries) ? parsed.entries : []
      };
    } catch {
      return defaultData();
    }
  }

  function saveData(data, activity = null) {
    window.LSOStorage?.setItem(DUTY_KEY, JSON.stringify({
      version: 1,
      commitments: data.commitments || {},
      entries: Array.isArray(data.entries) ? data.entries : []
    }));
    window.dispatchEvent(new CustomEvent('lso:duty-hours-changed'));
    if (activity) window.LSOOperations?.logActivity?.(activity.action, 'Duty Hours', activity.details || '');
  }

  function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function hoursLabel(value, signed = false) {
    const number = numberValue(value);
    const sign = signed && number > 0 ? '+' : '';
    return `${sign}${number.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} hr${Math.abs(number) === 1 ? '' : 's'}`;
  }

  function dateLabel(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function commitmentKey(period) {
    return period === 'Probationary Period' ? 'probationary' : 'trainee';
  }

  function getCommitment(data, memberId, period) {
    return Math.max(0, numberValue(data.commitments?.[memberId]?.[commitmentKey(period)]));
  }

  function entriesFor(data, memberId, period = '') {
    return data.entries.filter((entry) => entry.memberId === memberId && (!period || entry.period === period));
  }

  function calculatePeriod(data, memberId, period) {
    const entries = entriesFor(data, memberId, period);
    const rendered = entries
      .filter((entry) => entry.entryType === 'Duty')
      .reduce((sum, entry) => sum + Math.max(0, numberValue(entry.hours)), 0);
    const incentives = entries
      .filter((entry) => entry.entryType === 'Incentive')
      .reduce((sum, entry) => sum + numberValue(entry.hours), 0);
    const committed = getCommitment(data, memberId, period);
    const credited = rendered + incentives;
    const balance = committed - credited;
    const progress = committed > 0 ? Math.max(0, Math.min(100, Math.round((credited / committed) * 100))) : 0;
    return { period, committed, rendered, incentives, credited, balance, progress, entries };
  }

  function calculateMember(data, memberId) {
    const trainee = calculatePeriod(data, memberId, 'Trainee Period');
    const probationary = calculatePeriod(data, memberId, 'Probationary Period');
    return {
      trainee,
      probationary,
      combined: {
        committed: trainee.committed + probationary.committed,
        rendered: trainee.rendered + probationary.rendered,
        incentives: trainee.incentives + probationary.incentives,
        credited: trainee.credited + probationary.credited,
        balance: trainee.balance + probationary.balance,
        entries: [...trainee.entries, ...probationary.entries]
      }
    };
  }

  function balanceText(balance, committed = null, credited = 0) {
    const value = numberValue(balance);
    if (numberValue(committed) === 0 && numberValue(credited) === 0) return 'Not set';
    if (Math.abs(value) < 0.0001) return 'Completed';
    return value > 0 ? `${hoursLabel(value)} remaining` : `${hoursLabel(Math.abs(value))} excess`;
  }

  function balanceBadge(balance, committed = null, credited = 0) {
    const value = numberValue(balance);
    const unset = numberValue(committed) === 0 && numberValue(credited) === 0;
    const className = unset ? 'badge-gray' : value > 0 ? 'badge-gold' : 'badge-green';
    return `<span class="badge ${className}">${safeText(balanceText(value, committed, credited))}</span>`;
  }

  function memberHasDutyData(data, member) {
    const commitments = data.commitments?.[member.id] || {};
    return member.periodGroup === 'Trainee Period' || member.periodGroup === 'Probationary Period' ||
      numberValue(commitments.trainee) !== 0 || numberValue(commitments.probationary) !== 0 ||
      data.entries.some((entry) => entry.memberId === member.id);
  }

  function filteredMembers() {
    const query = searchTerm.trim().toLowerCase();
    return getMembers()
      .filter((member) => !query || [member.fullName, member.membershipId, member.studentNumber, member.periodGroup]
        .some((value) => String(value || '').toLowerCase().includes(query)))
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  }

  function renderMemberPicker() {
    const select = el('dutyMemberSelect');
    if (!select) return;
    const members = filteredMembers();
    const selectedExists = getMembers().some((member) => member.id === selectedMemberId);
    const selectedMember = selectedExists ? getMembers().find((member) => member.id === selectedMemberId) : null;
    const visibleMembers = [...members];
    if (selectedMember && !visibleMembers.some((member) => member.id === selectedMember.id)) visibleMembers.unshift(selectedMember);
    select.innerHTML = '<option value="">Choose a member…</option>' + visibleMembers.map((member) =>
      `<option value="${safeText(member.id)}">${safeText(member.fullName)} — ${safeText(member.periodGroup || 'No period')}</option>`
    ).join('');
    if (selectedExists) select.value = selectedMemberId;
  }

  function periodCardMarkup(summary, label, helper) {
    return `<article class="duty-period-card">
      <div class="duty-period-card-header"><div><small>${safeText(helper)}</small><h4>${safeText(label)}</h4></div>${balanceBadge(summary.balance, summary.committed, summary.credited)}</div>
      <div class="duty-progress-track"><span style="width:${summary.progress}%"></span></div>
      <div class="duty-period-stat-grid">
        <div><span>Committed</span><strong>${safeText(hoursLabel(summary.committed))}</strong></div>
        <div><span>Rendered</span><strong>${safeText(hoursLabel(summary.rendered))}</strong></div>
        <div><span>Incentives</span><strong class="${summary.incentives < 0 ? 'negative-value' : ''}">${safeText(hoursLabel(summary.incentives, true))}</strong></div>
        <div><span>Credited Total</span><strong>${safeText(hoursLabel(summary.credited))}</strong></div>
      </div>
    </article>`;
  }

  function renderSelectedMember() {
    const data = loadData();
    const member = getMembers().find((item) => item.id === selectedMemberId);
    const summaryContainer = el('dutyHoursSummary');
    const adminControls = el('dutyHoursAdminControls');
    const ledgerSection = el('dutyLedgerSection');
    const printButton = el('printDutyHoursIndividual');

    if (!summaryContainer || !adminControls || !ledgerSection || !printButton) return;

    if (!member) {
      summaryContainer.innerHTML = '<div class="dashboard-empty-state"><span>◷</span><strong>Select a member</strong><small>Their Trainee, Probationary, and combined duty-hour totals will appear here.</small></div>';
      adminControls.classList.add('hidden');
      ledgerSection.classList.add('hidden');
      printButton.disabled = true;
      return;
    }

    const summary = calculateMember(data, member.id);
    const initials = String(member.fullName || 'M').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    summaryContainer.innerHTML = `<div class="duty-member-heading">
      <div class="member-avatar">${safeText(initials)}</div>
      <div><p class="eyebrow">Duty Hours Profile</p><h4>${safeText(member.fullName)}</h4><small>${safeText(member.membershipId)} • ${safeText(member.periodGroup || 'No period')}</small></div>
      <div class="duty-combined-balance"><span>Combined Balance</span><strong>${safeText(balanceText(summary.combined.balance, summary.combined.committed, summary.combined.credited))}</strong></div>
    </div>
    <div class="duty-period-cards">
      ${periodCardMarkup(summary.trainee, 'Trainee Period', 'Training requirement')}
      ${periodCardMarkup(summary.probationary, 'Probationary Period', 'Evaluation requirement')}
      <article class="duty-period-card combined-card">
        <div class="duty-period-card-header"><div><small>Both periods together</small><h4>Combined Total</h4></div>${balanceBadge(summary.combined.balance, summary.combined.committed, summary.combined.credited)}</div>
        <div class="duty-period-stat-grid">
          <div><span>Committed</span><strong>${safeText(hoursLabel(summary.combined.committed))}</strong></div>
          <div><span>Rendered</span><strong>${safeText(hoursLabel(summary.combined.rendered))}</strong></div>
          <div><span>Incentives</span><strong class="${summary.combined.incentives < 0 ? 'negative-value' : ''}">${safeText(hoursLabel(summary.combined.incentives, true))}</strong></div>
          <div><span>Credited Total</span><strong>${safeText(hoursLabel(summary.combined.credited))}</strong></div>
        </div>
      </article>
    </div>`;

    const commitments = data.commitments?.[member.id] || {};
    if (el('dutyTraineeCommitted')) el('dutyTraineeCommitted').value = numberValue(commitments.trainee) || '';
    if (el('dutyProbationaryCommitted')) el('dutyProbationaryCommitted').value = numberValue(commitments.probationary) || '';
    if (el('dutyEntryPeriod') && PERIODS.includes(member.periodGroup)) el('dutyEntryPeriod').value = member.periodGroup;

    adminControls.classList.toggle('hidden', !isAdmin());
    ledgerSection.classList.remove('hidden');
    printButton.disabled = false;
    renderLedger(data, member);
  }

  function renderLedger(data, member) {
    const body = el('dutyLedgerTableBody');
    const caption = el('dutyLedgerCaption');
    if (!body || !caption) return;
    const entries = entriesFor(data, member.id)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    caption.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
    body.innerHTML = entries.length ? entries.map((entry) => {
      const hours = numberValue(entry.hours);
      const isIncentive = entry.entryType === 'Incentive';
      const effect = isIncentive
        ? hours >= 0 ? `Reduces requirement by ${hoursLabel(hours)}` : `Adds ${hoursLabel(Math.abs(hours))} to requirement`
        : `Adds ${hoursLabel(hours)} rendered`;
      return `<tr>
        <td>${safeText(dateLabel(entry.date))}</td>
        <td><span class="badge ${entry.period === 'Trainee Period' ? 'badge-blue' : 'badge-gold'}">${safeText(entry.period)}</span></td>
        <td>${safeText(isIncentive ? 'Incentive / Adjustment' : 'Rendered Duty')}</td>
        <td><strong class="${hours < 0 ? 'negative-value' : ''}">${safeText(hoursLabel(hours, isIncentive))}</strong></td>
        <td>${safeText(effect)}</td>
        <td>${safeText(entry.description || '—')}<small class="table-subtext">${safeText(entry.createdBy || '')}</small></td>
        <td class="admin-only"><button class="table-action danger" data-duty-delete="${safeText(entry.id)}" type="button" aria-label="Delete duty entry">×</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="7"><div class="empty-state compact-empty"><h4>No duty entries yet</h4><p>Add rendered duty hours or an incentive adjustment above.</p></div></td></tr>';

    body.querySelectorAll('.admin-only').forEach((node) => node.classList.toggle('hidden', !isAdmin()));
  }

  function trackedMembers(data) {
    return getMembers()
      .filter((member) => memberHasDutyData(data, member))
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  }

  function renderOverall() {
    const data = loadData();
    const members = trackedMembers(data);
    const metrics = el('dutyOverallMetrics');
    const body = el('dutyOverallTableBody');
    const caption = el('dutyOverallCaption');
    if (!metrics || !body || !caption) return;

    const summaries = members.map((member) => ({ member, summary: calculateMember(data, member.id) }));
    const totals = summaries.reduce((result, item) => {
      result.committed += item.summary.combined.committed;
      result.rendered += item.summary.combined.rendered;
      result.incentives += item.summary.combined.incentives;
      result.credited += item.summary.combined.credited;
      result.outstanding += Math.max(0, item.summary.combined.balance);
      return result;
    }, { committed: 0, rendered: 0, incentives: 0, credited: 0, outstanding: 0 });

    metrics.innerHTML = [
      ['Tracked Members', members.length, 'Trainee / Probationary records'],
      ['Committed', hoursLabel(totals.committed), 'Required across both periods'],
      ['Rendered', hoursLabel(totals.rendered), 'Actual duty completed'],
      ['Incentives', hoursLabel(totals.incentives, true), 'Net credits or deductions'],
      ['Credited', hoursLabel(totals.credited), 'Rendered plus incentives'],
      ['Outstanding', hoursLabel(totals.outstanding), 'Remaining requirements']
    ].map(([label, value, helper]) => `<div class="attendance-kpi"><span>${safeText(label)}</span><strong>${safeText(value)}</strong><small>${safeText(helper)}</small></div>`).join('');

    caption.textContent = members.length
      ? `${members.length} member${members.length === 1 ? '' : 's'} with current or historical duty-hour tracking`
      : 'No Trainee or Probationary duty-hour records yet.';

    body.innerHTML = summaries.length ? summaries.map(({ member, summary }) => `<tr>
      <td><strong>${safeText(member.fullName)}</strong><small class="table-subtext">${safeText(member.membershipId)} • ${safeText(member.periodGroup || 'No period')}</small></td>
      <td>${safeText(hoursLabel(summary.trainee.committed))}</td>
      <td>${safeText(hoursLabel(summary.trainee.credited))}</td>
      <td>${balanceBadge(summary.trainee.balance, summary.trainee.committed, summary.trainee.credited)}</td>
      <td>${safeText(hoursLabel(summary.probationary.committed))}</td>
      <td>${safeText(hoursLabel(summary.probationary.credited))}</td>
      <td>${balanceBadge(summary.probationary.balance, summary.probationary.committed, summary.probationary.credited)}</td>
      <td>${balanceBadge(summary.combined.balance, summary.combined.committed, summary.combined.credited)}</td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty-state compact-empty"><h4>No duty-hour records</h4><p>Select a Trainee or Probationary member and set their committed hours.</p></div></td></tr>';
  }

  function setSelectedMember(memberId) {
    selectedMemberId = memberId || '';
    renderMemberPicker();
    renderSelectedMember();
  }

  function saveCommitments(event) {
    event.preventDefault();
    const member = getMembers().find((item) => item.id === selectedMemberId);
    if (!member || !isAdmin()) return;
    const trainee = numberValue(el('dutyTraineeCommitted')?.value);
    const probationary = numberValue(el('dutyProbationaryCommitted')?.value);
    if (trainee < 0 || probationary < 0) {
      window.LSOApp?.showToast?.('Committed hours cannot be negative.', true);
      return;
    }
    const data = loadData();
    data.commitments[member.id] = {
      trainee,
      probationary,
      updatedAt: new Date().toISOString(),
      updatedBy: currentAccount()?.displayName || currentAccount()?.username || 'Administrator'
    };
    saveData(data, {
      action: 'Updated committed duty hours',
      details: `${member.fullName} • Trainee ${hoursLabel(trainee)} • Probationary ${hoursLabel(probationary)}`
    });
    window.LSOApp?.showToast?.('Committed duty hours saved.');
    renderAll();
  }

  function saveEntry(event) {
    event.preventDefault();
    const member = getMembers().find((item) => item.id === selectedMemberId);
    if (!member || !isAdmin()) return;
    const period = el('dutyEntryPeriod')?.value;
    const entryType = el('dutyEntryType')?.value;
    const date = el('dutyEntryDate')?.value;
    const hours = numberValue(el('dutyEntryHours')?.value);
    const description = el('dutyEntryDescription')?.value.trim() || '';

    if (!PERIODS.includes(period) || !['Duty', 'Incentive'].includes(entryType) || !date) {
      window.LSOApp?.showToast?.('Complete the duty-hour entry fields.', true);
      return;
    }
    if (entryType === 'Duty' && hours <= 0) {
      window.LSOApp?.showToast?.('Rendered duty hours must be greater than zero.', true);
      return;
    }
    if (entryType === 'Incentive' && hours === 0) {
      window.LSOApp?.showToast?.('The incentive or adjustment cannot be zero.', true);
      return;
    }

    const account = currentAccount();
    const data = loadData();
    data.entries.push({
      id: uid('duty-entry'),
      memberId: member.id,
      period,
      entryType,
      date,
      hours,
      description,
      createdAt: new Date().toISOString(),
      createdBy: account?.displayName || account?.username || 'Administrator',
      createdByUsername: account?.username || ''
    });
    saveData(data, {
      action: entryType === 'Duty' ? 'Recorded rendered duty hours' : 'Recorded duty-hour incentive',
      details: `${member.fullName} • ${period} • ${hoursLabel(hours, entryType === 'Incentive')}`
    });
    el('dutyEntryHours').value = '';
    el('dutyEntryDescription').value = '';
    window.LSOApp?.showToast?.(entryType === 'Duty' ? 'Rendered duty hours added.' : 'Incentive adjustment added.');
    renderAll();
  }

  function deleteEntry(entryId) {
    if (!isAdmin()) return;
    const data = loadData();
    const entry = data.entries.find((item) => item.id === entryId);
    const member = getMembers().find((item) => item.id === entry?.memberId);
    if (!entry || !window.confirm('Delete this duty-hour ledger entry?')) return;
    data.entries = data.entries.filter((item) => item.id !== entryId);
    saveData(data, {
      action: 'Deleted duty-hour entry',
      details: `${member?.fullName || 'Member'} • ${entry.period} • ${hoursLabel(entry.hours, entry.entryType === 'Incentive')}`
    });
    window.LSOApp?.showToast?.('Duty-hour entry deleted.');
    renderAll();
  }

  function printStyles(orientation = 'landscape') {
    return `@page{size:A4 ${orientation};margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17362d;margin:0}.header{display:flex;justify-content:space-between;gap:25px;border-bottom:4px solid #167055;padding-bottom:12px;margin-bottom:16px}.org{font-size:10px;text-transform:uppercase;letter-spacing:.13em;color:#167055;font-weight:700}h1{font-size:23px;margin:5px 0}.sub{font-size:11px;color:#60766e}.summary{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin:14px 0}.summary>div{border:1px solid #d8e6df;padding:9px;border-radius:7px}.summary span{display:block;font-size:8px;text-transform:uppercase;color:#6b8078}.summary strong{font-size:17px}.period-table{margin:14px 0}table{width:100%;border-collapse:collapse;font-size:9px}th,td{border:1px solid #d8e6df;padding:6px;text-align:left;vertical-align:top}th{background:#eff8f3;text-transform:uppercase;font-size:8px}.positive{color:#126443}.negative{color:#a2333d}.sign{display:grid;grid-template-columns:1fr 1fr;gap:90px;margin-top:40px;text-align:center}.sign div{border-top:1px solid #333;padding-top:6px}.footer{font-size:8px;color:#6c8079;margin-top:14px;text-align:center}`;
  }

  function openPrint(html) {
    const popup = window.open('', '_blank', 'width=1100,height=800');
    if (!popup) {
      window.LSOApp?.showToast?.('Allow pop-ups to generate the printable report.', true);
      return;
    }
    popup.document.write(html);
    popup.document.close();
  }

  function printIndividual() {
    const data = loadData();
    const member = getMembers().find((item) => item.id === selectedMemberId);
    if (!member) return;
    const summary = calculateMember(data, member.id);
    const periodRows = [summary.trainee, summary.probationary, { period: 'Combined Total', ...summary.combined }].map((item) => `<tr>
      <td><strong>${safeText(item.period)}</strong></td><td>${safeText(hoursLabel(item.committed))}</td><td>${safeText(hoursLabel(item.rendered))}</td><td>${safeText(hoursLabel(item.incentives, true))}</td><td>${safeText(hoursLabel(item.credited))}</td><td>${safeText(balanceText(item.balance, item.committed, item.credited))}</td>
    </tr>`).join('');
    const entries = entriesFor(data, member.id).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const ledgerRows = entries.map((entry, index) => `<tr><td>${index + 1}</td><td>${safeText(dateLabel(entry.date))}</td><td>${safeText(entry.period)}</td><td>${safeText(entry.entryType === 'Duty' ? 'Rendered Duty' : 'Incentive / Adjustment')}</td><td class="${numberValue(entry.hours) < 0 ? 'negative' : 'positive'}">${safeText(hoursLabel(entry.hours, entry.entryType === 'Incentive'))}</td><td>${safeText(entry.description || '—')}</td><td>${safeText(entry.createdBy || '—')}</td></tr>`).join('');
    const html = `<!doctype html><html><head><title>${safeText(member.fullName)} — Duty Hours</title><style>${printStyles('landscape')}</style></head><body>
      <div class="header"><div><div class="org">Lasallian Symphony Orchestra</div><h1>Individual Duty Hours Report</h1><div class="sub">${safeText(member.fullName)} • ${safeText(member.membershipId)} • ${safeText(member.periodGroup || 'No period')}</div></div><div class="sub">Generated ${safeText(dateLabel(today()))}</div></div>
      <div class="summary">${[
        ['Combined Committed', hoursLabel(summary.combined.committed)], ['Duty Rendered', hoursLabel(summary.combined.rendered)], ['Net Incentives', hoursLabel(summary.combined.incentives, true)], ['Total Credited', hoursLabel(summary.combined.credited)], ['Combined Balance', balanceText(summary.combined.balance, summary.combined.committed, summary.combined.credited)], ['Ledger Entries', entries.length]
      ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>
      <table class="period-table"><thead><tr><th>Period</th><th>Committed</th><th>Rendered</th><th>Incentives</th><th>Credited</th><th>Balance</th></tr></thead><tbody>${periodRows}</tbody></table>
      <table><thead><tr><th>#</th><th>Date</th><th>Period</th><th>Entry Type</th><th>Hours</th><th>Description / Basis</th><th>Recorded By</th></tr></thead><tbody>${ledgerRows || '<tr><td colspan="7">No duty-hour ledger entries.</td></tr>'}</tbody></table>
      <div class="sign"><div>Member Signature</div><div>Authorized Officer</div></div><div class="footer">Generated from the LSO Orchestra Management System.</div><script>window.onload=()=>window.print()<\/script></body></html>`;
    openPrint(html);
  }

  function printOverall() {
    const data = loadData();
    const members = trackedMembers(data);
    const summaries = members.map((member) => ({ member, summary: calculateMember(data, member.id) }));
    const totals = summaries.reduce((result, item) => {
      result.committed += item.summary.combined.committed;
      result.rendered += item.summary.combined.rendered;
      result.incentives += item.summary.combined.incentives;
      result.credited += item.summary.combined.credited;
      result.outstanding += Math.max(0, item.summary.combined.balance);
      return result;
    }, { committed: 0, rendered: 0, incentives: 0, credited: 0, outstanding: 0 });
    const rows = summaries.map(({ member, summary }, index) => `<tr><td>${index + 1}</td><td>${safeText(member.fullName)}</td><td>${safeText(member.periodGroup || '—')}</td><td>${safeText(hoursLabel(summary.trainee.committed))}</td><td>${safeText(hoursLabel(summary.trainee.credited))}</td><td>${safeText(balanceText(summary.trainee.balance, summary.trainee.committed, summary.trainee.credited))}</td><td>${safeText(hoursLabel(summary.probationary.committed))}</td><td>${safeText(hoursLabel(summary.probationary.credited))}</td><td>${safeText(balanceText(summary.probationary.balance, summary.probationary.committed, summary.probationary.credited))}</td><td>${safeText(balanceText(summary.combined.balance, summary.combined.committed, summary.combined.credited))}</td></tr>`).join('');
    const html = `<!doctype html><html><head><title>Overall Duty Hours Report</title><style>${printStyles('landscape')}</style></head><body>
      <div class="header"><div><div class="org">Lasallian Symphony Orchestra</div><h1>Overall Duty Hours Report</h1><div class="sub">Trainee and Probationary Period monitoring</div></div><div class="sub">Generated ${safeText(dateLabel(today()))}</div></div>
      <div class="summary">${[
        ['Tracked Members', members.length], ['Committed', hoursLabel(totals.committed)], ['Rendered', hoursLabel(totals.rendered)], ['Net Incentives', hoursLabel(totals.incentives, true)], ['Credited', hoursLabel(totals.credited)], ['Outstanding', hoursLabel(totals.outstanding)]
      ].map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join('')}</div>
      <table><thead><tr><th>#</th><th>Member</th><th>Current Period</th><th>Trainee Required</th><th>Trainee Credited</th><th>Trainee Balance</th><th>Probationary Required</th><th>Probationary Credited</th><th>Probationary Balance</th><th>Combined Balance</th></tr></thead><tbody>${rows || '<tr><td colspan="10">No duty-hour records.</td></tr>'}</tbody></table>
      <div class="sign"><div>Prepared by</div><div>Authorized Officer</div></div><div class="footer">Generated from the LSO Orchestra Management System.</div><script>window.onload=()=>window.print()<\/script></body></html>`;
    openPrint(html);
  }

  function updateEntryHelp() {
    const type = el('dutyEntryType')?.value;
    const hours = el('dutyEntryHours');
    const help = el('dutyEntryHelp');
    if (!hours || !help) return;
    if (type === 'Duty') {
      hours.min = '0.25';
      hours.placeholder = 'e.g., 3';
      help.textContent = 'Rendered duty hours must be positive and are added to the member’s credited total.';
    } else {
      hours.removeAttribute('min');
      hours.placeholder = 'e.g., 2 or -1';
      help.textContent = 'A positive incentive reduces the remaining requirement. A negative adjustment adds required hours back.';
    }
  }

  function renderAll() {
    renderMemberPicker();
    renderSelectedMember();
    renderOverall();
  }

  function wireEvents() {
    el('dutyMemberSearch')?.addEventListener('input', (event) => {
      searchTerm = event.target.value;
      renderMemberPicker();
    });
    el('dutyMemberSelect')?.addEventListener('change', (event) => setSelectedMember(event.target.value));
    el('dutyCommitmentForm')?.addEventListener('submit', saveCommitments);
    el('dutyEntryForm')?.addEventListener('submit', saveEntry);
    el('dutyEntryType')?.addEventListener('change', updateEntryHelp);
    el('dutyLedgerTableBody')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-duty-delete]');
      if (button) deleteEntry(button.dataset.dutyDelete);
    });
    el('printDutyHoursIndividual')?.addEventListener('click', printIndividual);
    el('printDutyHoursOverall')?.addEventListener('click', printOverall);

    ['lso:members-changed', 'lso:duty-hours-changed', 'lso:cloud-state-changed', 'lso:auth-changed'].forEach((name) => {
      window.addEventListener(name, () => setTimeout(renderAll, 25));
    });
  }

  function initialize() {
    if (!el('dutyHoursSummary')) return;
    if (el('dutyEntryDate')) el('dutyEntryDate').value = today();
    updateEntryHelp();
    wireEvents();
    renderAll();
  }

  window.LSODutyHours = {
    getData: loadData,
    calculateMember: (memberId) => calculateMember(loadData(), memberId),
    refresh: renderAll
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
