(() => {
  'use strict';

  const TEMPLATE_URL = new URL('lso-contract-template.pdf?v=20260718-contract-v3', document.baseURI).href;
  const el = (id) => document.getElementById(id);
  let selectedMemberId = '';
  let templateBytesPromise = null;
  let previewUrl = '';
  let previewTimer = null;
  let generationSequence = 0;
  let lastGeneratedBytes = null;
  let lastGenerationKey = '';
  let templateSource = '';


  function safeText(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function initials(name) {
    const parts = String(name || 'LSO').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'LSO';
  }

  function canGenerateContract() {
    return window.LSORoleAccess?.can?.('generateContract') ?? ['Administrator', 'Membership'].includes((window.LSOAuth?.getActiveAccount?.() || window.LSOCurrentAccount || {}).role);
  }

  function allMembers() {
    return window.LSOApp?.getMembers?.() || [];
  }

  function officialMembers() {
    return allMembers()
      .filter((member) => member.periodGroup === 'Membership Period' || member.membershipStage === 'Regular Member')
      .filter((member) => !['Nonactive', 'LOA'].includes(member.memberStatus))
      .sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || '')));
  }

  function selectedMember() {
    return allMembers().find((member) => String(member.id) === String(selectedMemberId)) || null;
  }

  function todayValue() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
  }

  function setMessage(message = '', success = false) {
    const node = el('contractFormMessage');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('hidden', !message);
    node.classList.toggle('success', Boolean(message && success));
  }

  function setStatus(message, state = '') {
    const ready = el('contractReadyState');
    if (ready) {
      ready.textContent = message;
      ready.classList.remove('ready', 'warning');
      if (state) ready.classList.add(state);
    }
  }

  function setPreviewStatus(message, state = '') {
    const node = el('contractPreviewStatus');
    if (!node) return;
    node.textContent = message;
    node.classList.remove('ready', 'warning');
    if (state) node.classList.add(state);
  }

  function showRoleState() {
    const allowed = canGenerateContract();
    el('contractReadOnlyNotice')?.classList.toggle('hidden', allowed);
    el('contractAdminWorkspace')?.classList.toggle('hidden', !allowed);
    if (allowed) renderMemberList();
  }

  function renderMemberList() {
    const list = el('contractMemberList');
    if (!list) return;
    const search = normalize(el('contractMemberSearch')?.value);
    const members = officialMembers();
    const filtered = members.filter((member) => !search || normalize([
      member.fullName, member.membershipId, member.studentNumber, member.homeAddress
    ].join(' ')).includes(search));

    if (el('contractMemberCount')) el('contractMemberCount').textContent = String(members.length);
    list.innerHTML = filtered.length ? filtered.map((member) => {
      const addressReady = Boolean(String(member.homeAddress || '').trim());
      return `<button class="contract-member-card ${String(member.id) === String(selectedMemberId) ? 'active' : ''}" data-contract-member="${safeText(member.id)}" type="button" aria-label="Create contract for ${safeText(member.fullName || 'member')}">
        <span class="contract-member-avatar">${safeText(initials(member.fullName))}</span>
        <span class="contract-member-copy">
          <strong>${safeText(member.fullName || 'Unnamed member')}</strong>
          <small>${safeText(member.membershipId || 'No Membership ID')} • ${safeText(member.studentNumber || 'No Student No.')}</small>
          <span class="contract-member-flags"><span class="contract-period-chip">Official member</span><span class="contract-member-address-state ${addressReady ? '' : 'missing'}">${addressReady ? 'Address ready' : 'Address needed'}</span></span>
        </span>
        <span class="contract-member-chevron" aria-hidden="true">›</span>
      </button>`;
    }).join('') : `<div class="contract-empty-list"><strong>No official members found</strong><p>${search ? 'Try a different search.' : 'Members in the Membership Period will appear here.'}</p></div>`;
  }

  function populateMember(member) {
    selectedMemberId = String(member?.id || '');
    lastGeneratedBytes = null;
    lastGenerationKey = '';
    if (el('contractMemberId')) el('contractMemberId').value = selectedMemberId;
    if (el('contractSigneeName')) el('contractSigneeName').value = member?.fullName || '';
    if (el('contractAddress')) el('contractAddress').value = member?.homeAddress || '';
    if (el('contractProfileName')) el('contractProfileName').textContent = member?.fullName || '—';
    if (el('contractProfileIdentity')) el('contractProfileIdentity').textContent = [member?.membershipId, member?.studentNumber, member?.course].filter(Boolean).join(' • ') || 'Official member';
    if (el('contractProfileAvatar')) el('contractProfileAvatar').textContent = initials(member?.fullName);
    el('contractSelectedProfile')?.classList.toggle('hidden', !member);
    setMessage(member && !String(member.homeAddress || '').trim() ? 'This member has no Home Address on record. Enter the complete postal address before downloading.' : '');
    updateButtons();
    renderMemberList();
    if (member) schedulePreview(30);
  }

  function clearSelection() {
    selectedMemberId = '';
    lastGeneratedBytes = null;
    lastGenerationKey = '';
    el('contractMakerForm')?.reset();
    if (el('contractDate')) el('contractDate').value = todayValue();
    if (el('contractSemester')) el('contractSemester').value = '';
    if (el('contractAcademicYear')) el('contractAcademicYear').value = '';
    if (el('contractMemberId')) el('contractMemberId').value = '';
    if (el('contractSigneeName')) el('contractSigneeName').value = '';
    el('contractSelectedProfile')?.classList.add('hidden');
    setMessage();
    setStatus('Select a member');
    setPreviewStatus('Waiting for member');
    revokePreview();
    el('contractPreviewFrame')?.classList.add('hidden');
    el('contractPreviewPlaceholder')?.classList.remove('hidden');
    el('openContractPreviewButton')?.classList.add('hidden');
    updateButtons();
    renderMemberList();
  }

  function formData() {
    const member = selectedMember();
    return {
      member,
      name: String(el('contractSigneeName')?.value || member?.fullName || '').trim(),
      address: String(el('contractAddress')?.value || '').trim(),
      date: String(el('contractDate')?.value || '').trim(),
      officer: String(el('contractOfficer')?.value || '').trim(),
      semester: String(el('contractSemester')?.value || '').trim(),
      academicYear: String(el('contractAcademicYear')?.value || '').trim()
    };
  }

  function updateButtons() {
    const data = formData();
    const canPreview = Boolean(data.member && data.name && data.address && data.date && data.semester && data.academicYear);
    const canDownload = Boolean(canPreview && data.officer);
    if (el('previewContractButton')) el('previewContractButton').disabled = !canPreview;
    if (el('downloadContractButton')) el('downloadContractButton').disabled = !canDownload;
    if (!data.member) setStatus('Select a member');
    else if (!data.address) setStatus('Address required', 'warning');
    else if (!data.semester) setStatus('Enter semester', 'warning');
    else if (!data.academicYear) setStatus('Enter academic year', 'warning');
    else if (!data.officer) setStatus('Enter officer name', 'warning');
    else setStatus('Ready to download', 'ready');
  }

  function pdfSafe(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[–—]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\x20-\x7EÀ-ÿ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function ordinal(day) {
    const n = Number(day);
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
  }

  function formattedDate(value) {
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    return {
      day: ordinal(date.getDate()),
      month: new Intl.DateTimeFormat('en-US', { month: 'long' }).format(date),
      year: date.getFullYear()
    };
  }

  function wrapText(font, text, size, maxWidth) {
    const words = pdfSafe(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    words.forEach((word) => {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else { lines.push(line); line = word; }
    });
    if (line) lines.push(line);
    return lines;
  }

  function fitTextSize(font, text, maxWidth, preferred = 10.5, minimum = 7.5) {
    let size = preferred;
    while (size > minimum && font.widthOfTextAtSize(pdfSafe(text), size) > maxWidth) size -= 0.25;
    return Math.max(minimum, size);
  }

  function drawWrapped(page, text, options) {
    const { font, x, y, maxWidth, preferredSize = 10.5, minimumSize = 8.5, maxLines = 3, lineHeight = 13.5, color } = options;
    let size = preferredSize;
    let lines = wrapText(font, text, size, maxWidth);
    while (lines.length > maxLines && size > minimumSize) {
      size -= 0.25;
      lines = wrapText(font, text, size, maxWidth);
    }
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      let last = kept[maxLines - 1];
      while (last.length > 1 && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) last = last.slice(0, -1);
      kept[maxLines - 1] = `${last}...`;
      lines = kept;
    }
    lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, size, font, color }));
    return { lines, size };
  }

  function styledTokens(segments) {
    const tokens = [];
    segments.forEach((segment) => {
      const words = pdfSafe(segment.text).split(/\s+/).filter(Boolean);
      words.forEach((word) => tokens.push({
        text: word,
        font: segment.font,
        underline: Boolean(segment.underline),
        segmentId: segment.segmentId || ''
      }));
    });
    return tokens;
  }

  function wrapStyledTokens(tokens, size, maxWidth, regularFont) {
    const spaceWidth = regularFont.widthOfTextAtSize(' ', size) * 1.15;
    const lines = [];
    let current = [];
    let width = 0;
    tokens.forEach((token) => {
      const tokenWidth = token.font.widthOfTextAtSize(token.text, size);
      const extra = current.length ? spaceWidth : 0;
      if (current.length && width + extra + tokenWidth > maxWidth) {
        lines.push({ tokens: current, width });
        current = [];
        width = 0;
      }
      current.push({ ...token, width: tokenWidth, spaceBefore: current.length ? spaceWidth : 0 });
      width += (current.length > 1 ? spaceWidth : 0) + tokenWidth;
    });
    if (current.length) lines.push({ tokens: current, width });
    return lines;
  }

  function drawStyledParagraph(page, segments, options) {
    const {
      x, y, maxWidth, regularFont, preferredSize = 10.5, minimumSize = 8.5,
      maxLines = 3, lineHeight = 14.5, color, align = 'left'
    } = options;
    const tokens = styledTokens(segments);
    let size = preferredSize;
    let lines = wrapStyledTokens(tokens, size, maxWidth, regularFont);
    while (lines.length > maxLines && size > minimumSize) {
      size -= 0.25;
      lines = wrapStyledTokens(tokens, size, maxWidth, regularFont);
    }
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
    lines.forEach((line, lineIndex) => {
      let cursorX = align === 'center' ? x + (maxWidth - line.width) / 2 : x;
      let underlineStart = null;
      let underlineEnd = null;
      let activeSegment = '';
      const flushUnderline = () => {
        const underlineY = Number(y) - Number(lineIndex) * Number(lineHeight) - 1.6;
        if (Number.isFinite(underlineStart) && Number.isFinite(underlineEnd) && Number.isFinite(underlineY)) {
          page.drawLine({
            start: { x: Number(underlineStart), y: underlineY },
            end: { x: Number(underlineEnd), y: underlineY },
            thickness: 0.75,
            color
          });
        }
        underlineStart = underlineEnd = null;
        activeSegment = '';
      };
      line.tokens.forEach((token) => {
        cursorX += Number.isFinite(token.spaceBefore) ? token.spaceBefore : 0;
        page.drawText(token.text, { x: cursorX, y: y - lineIndex * lineHeight, size, font: token.font, color });
        if (token.underline) {
          if (activeSegment !== token.segmentId) {
            flushUnderline();
            underlineStart = cursorX;
            activeSegment = token.segmentId;
          }
          underlineEnd = cursorX + (Number.isFinite(token.width) ? token.width : token.font.widthOfTextAtSize(token.text, size));
        } else {
          flushUnderline();
        }
        cursorX += Number.isFinite(token.width) ? token.width : token.font.widthOfTextAtSize(token.text, size);
      });
      flushUnderline();
    });
    return { lines, size };
  }

  function drawSignature(page, text, x, width, font, boldFont, black, white) {
    page.drawRectangle({ x, y: 107, width, height: 28, color: white });
    page.drawLine({ start: { x: x + 4, y: 111 }, end: { x: x + width - 4, y: 111 }, thickness: 0.8, color: black });
    if (!text) return;
    const upper = pdfSafe(text).toUpperCase();
    const size = fitTextSize(boldFont, upper, width - 12, 10.5, 7.5);
    const textWidth = boldFont.widthOfTextAtSize(upper, size);
    page.drawText(upper, { x: x + (width - textWidth) / 2, y: 116, size, font: boldFont, color: black });
  }

  function decodeBase64ToArrayBuffer(base64) {
    const clean = String(base64 || '').replace(/\s+/g, '');
    if (!clean) throw new Error('The embedded contract template is empty.');
    const binary = window.atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  async function getTemplateBytes() {
    if (!templateBytesPromise) {
      templateBytesPromise = (async () => {
        if (window.LSO_CONTRACT_TEMPLATE_BASE64) {
          templateSource = 'embedded';
          return decodeBase64ToArrayBuffer(window.LSO_CONTRACT_TEMPLATE_BASE64);
        }
        try {
          const response = await fetch(TEMPLATE_URL, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          templateSource = 'file';
          return await response.arrayBuffer();
        } catch (error) {
          templateBytesPromise = null;
          throw new Error('The official contract template could not be loaded. Upload contract-template-data.js and lso-contract-template.pdf beside index.html, then refresh the page.');
        }
      })();
    }
    return templateBytesPromise;
  }

  function generationKey(data, requireOfficer) {
    return JSON.stringify([data.member?.id || '', data.name, data.address, data.date, data.semester, data.academicYear, requireOfficer ? data.officer : (data.officer || '')]);
  }

  async function generatePdfBytes({ requireOfficer = false, force = false } = {}) {
    const data = formData();
    if (!data.member) throw new Error('Select an official member first.');
    if (!data.name) throw new Error('The member name is missing.');
    if (!data.address) throw new Error('Enter the member postal address.');
    if (!data.date) throw new Error('Choose the contract date.');
    if (!data.semester) throw new Error('Enter the contract semester.');
    if (!data.academicYear) throw new Error('Enter the academic year.');
    if (requireOfficer && !data.officer) throw new Error('Enter the Officer in Charge.');
    if (!window.PDFLib) throw new Error('The PDF generator library did not load. Make sure pdf-lib.min.js is uploaded beside index.html, then refresh the page.');

    const cacheKey = generationKey(data, requireOfficer);
    if (!force && lastGeneratedBytes && lastGenerationKey === cacheKey) return lastGeneratedBytes.slice(0);

    const date = formattedDate(data.date);
    if (!date) throw new Error('Choose a valid contract date.');
    const template = await getTemplateBytes();
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const pdf = await PDFDocument.load(template.slice(0));
    const pages = pdf.getPages();
    if (pages.length < 2) throw new Error('The official contract template must contain two pages.');
    const regular = await pdf.embedFont(StandardFonts.TimesRoman);
    const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const black = rgb(0, 0, 0);
    const white = rgb(1, 1, 1);

    const page1 = pages[0];
    page1.drawRectangle({ x: 68, y: 526, width: 470, height: 49, color: white });
    const dateLine = `This contract, made and entered into this ${date.day} day of ${date.month}, ${date.year}, at Dasmariñas City, Cavite,`;
    drawWrapped(page1, dateLine, { font: regular, x: 72, y: 555, maxWidth: 455, preferredSize: 10.5, minimumSize: 9, maxLines: 2, lineHeight: 15, color: black });
    page1.drawText('by and between:', { x: 72, y: 535, size: 10.5, font: regular, color: black });

    page1.drawRectangle({ x: 68, y: 341, width: 470, height: 51, color: white });
    drawStyledParagraph(page1, [
      { text: `${pdfSafe(data.name).toUpperCase()},`, font: bold, underline: true, segmentId: 'name' },
      { text: 'with the postal address of', font: regular },
      { text: `${pdfSafe(data.address).toUpperCase()},`, font: bold, underline: true, segmentId: 'address' },
      { text: 'referred to as the SIGNEE.', font: regular }
    ], {
      x: 72, y: 372, maxWidth: 455, regularFont: regular,
      preferredSize: 10.25, minimumSize: 8.25, maxLines: 3, lineHeight: 14.5,
      color: black, align: 'center'
    });

    page1.drawRectangle({ x: 87, y: 169, width: 442, height: 45, color: white });
    drawStyledParagraph(page1, [
      { text: '1.', font: regular },
      { text: 'Term:', font: bold },
      { text: 'The duration of this contract of Membership shall take effect on the', font: regular },
      { text: pdfSafe(data.semester), font: bold, underline: true, segmentId: 'semester' },
      { text: 'of the Academic Year', font: regular },
      { text: `${pdfSafe(data.academicYear)}.`, font: bold, underline: true, segmentId: 'academic-year' }
    ], {
      x: 90, y: 198, maxWidth: 434, regularFont: regular,
      preferredSize: 10.25, minimumSize: 8.5, maxLines: 2, lineHeight: 18,
      color: black, align: 'left'
    });

    const page2 = pages[1];
    drawSignature(page2, data.name, 70, 200, regular, bold, black, white);
    drawSignature(page2, data.officer, 350, 180, regular, bold, black, white);

    pdf.setTitle(`LSO Membership Contract - ${pdfSafe(data.name)}`);
    pdf.setAuthor('Lasallian Symphony Orchestra');
    pdf.setSubject('Membership Contract');
    pdf.setKeywords(['LSO', 'membership', 'contract']);
    pdf.setCreator('LSO Orchestra Management System');
    pdf.setProducer('LSO Orchestra Management System');
    pdf.setCreationDate(new Date());
    pdf.setModificationDate(new Date());
    const output = await pdf.save({ useObjectStreams: false });
    lastGeneratedBytes = output.slice(0);
    lastGenerationKey = cacheKey;
    return output;
  }

  function revokePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }

  async function renderPreview() {
    const sequence = ++generationSequence;
    const data = formData();
    if (!data.member || !data.address || !data.date || !data.semester || !data.academicYear) return;
    setPreviewStatus('Generating preview…', 'warning');
    el('contractPreviewPanel')?.classList.add('is-generating');
    setMessage();
    try {
      const bytes = await generatePdfBytes({ requireOfficer: false });
      if (sequence !== generationSequence) return;
      revokePreview();
      previewUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const frame = el('contractPreviewFrame');
      if (frame) frame.src = `${previewUrl}#toolbar=1&navpanes=0&scrollbar=1&view=FitH&page=1`;
      frame?.classList.remove('hidden');
      el('contractPreviewPlaceholder')?.classList.add('hidden');
      setPreviewStatus(data.officer ? 'Complete preview' : 'Preview - officer pending', data.officer ? 'ready' : 'warning');
      el('openContractPreviewButton')?.classList.remove('hidden');
    } catch (error) {
      setPreviewStatus('Preview unavailable', 'warning');
      setMessage(error.message || 'The contract preview could not be generated.');
      el('contractPreviewFrame')?.classList.add('hidden');
      el('contractPreviewPlaceholder')?.classList.remove('hidden');
      el('openContractPreviewButton')?.classList.add('hidden');
    } finally {
      el('contractPreviewPanel')?.classList.remove('is-generating');
    }
  }

  function schedulePreview(delay = 500) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      updateButtons();
      renderPreview();
    }, delay);
  }

  function openPreview() {
    if (!previewUrl) return;
    window.open(previewUrl, '_blank', 'noopener,noreferrer');
  }

  function downloadBlob(filename, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function fileSafeName(value) {
    return String(value || 'Member').trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 70) || 'Member';
  }

  async function downloadContract() {
    if (!window.LSOPermissions?.require?.('generateContract', 'Administrator or Membership access is required to generate a membership contract.')) return;
    setMessage();
    const button = el('downloadContractButton');
    const original = button?.textContent || 'Download Contract PDF';
    if (button) { button.disabled = true; button.textContent = 'Preparing PDF…'; }
    try {
      const data = formData();
      const bytes = await generatePdfBytes({ requireOfficer: true });
      downloadBlob(`LSO_Membership_Contract_${fileSafeName(data.name)}.pdf`, bytes);
      setMessage('The completed two-page contract was downloaded.', true);
      window.LSOApp?.showToast?.('Membership contract downloaded.');
    } catch (error) {
      setMessage(error.message || 'The contract could not be generated.');
    } finally {
      if (button) { button.textContent = original; }
      updateButtons();
    }
  }

  function wireEvents() {
    el('contractMemberSearch')?.addEventListener('input', renderMemberList);
    el('contractMemberList')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-contract-member]');
      if (!button) return;
      const member = allMembers().find((item) => String(item.id) === String(button.dataset.contractMember));
      if (member) populateMember(member);
    });
    ['contractAddress', 'contractDate', 'contractOfficer', 'contractSemester', 'contractAcademicYear'].forEach((id) => {
      el(id)?.addEventListener('input', () => { lastGeneratedBytes = null; lastGenerationKey = ''; schedulePreview(550); });
      el(id)?.addEventListener('change', () => schedulePreview(100));
    });
    el('contractMakerForm')?.addEventListener('submit', (event) => { event.preventDefault(); downloadContract(); });
    el('previewContractButton')?.addEventListener('click', renderPreview);
    el('downloadContractButton')?.addEventListener('click', downloadContract);
    el('openContractPreviewButton')?.addEventListener('click', openPreview);
    el('resetContractButton')?.addEventListener('click', clearSelection);
    document.querySelector('[data-view="contractView"]')?.addEventListener('click', () => setTimeout(() => {
      renderMemberList();
      showRoleState();
    }, 0));
    window.addEventListener('beforeunload', revokePreview);
  }

  function refreshMembers() {
    if (selectedMemberId) {
      const member = selectedMember();
      if (member) populateMember(member);
      else clearSelection();
    } else renderMemberList();
  }

  function initialize() {
    if (el('contractDate') && !el('contractDate').value) el('contractDate').value = todayValue();
    if (el('contractSemester') && !el('contractSemester').value) el('contractSemester').value = '';
    if (el('contractAcademicYear') && !el('contractAcademicYear').value) el('contractAcademicYear').value = '';
    wireEvents();
    showRoleState();
    renderMemberList();
    updateButtons();
    window.addEventListener('lso:auth-changed', () => setTimeout(showRoleState, 0));
    window.addEventListener('lso:members-changed', () => setTimeout(refreshMembers, 30));
    window.addEventListener('lso:cloud-state-changed', (event) => {
      if (!event.detail?.key || event.detail.key === 'lso_member_database_v1') setTimeout(refreshMembers, 30);
    });
  }

  window.LSOContractMaker = {
    refresh: refreshMembers,
    generatePdfBytes,
    getSelectedMember: selectedMember,
    getDiagnostics: () => ({ templateSource, hasEmbeddedTemplate: Boolean(window.LSO_CONTRACT_TEMPLATE_BASE64), hasPdfLib: Boolean(window.PDFLib), previewReady: Boolean(previewUrl) })
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
