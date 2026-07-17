(() => {
  'use strict';

  const assetUrl = (name) => new URL(name, document.baseURI || window.location.href).href;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'\"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;'
  }[character]));

  const logoUrl = assetUrl('lso-logo.png');
  const markUrl = assetUrl('lso-mark.png');

  const printCss = `
    .lso-print-header{display:flex;align-items:center;justify-content:space-between;gap:22px;border-bottom:4px solid #167055;padding-bottom:12px;margin-bottom:16px}
    .lso-print-brand{display:flex;align-items:center;gap:14px;min-width:0}
    .lso-print-logo{width:70px;height:78px;object-fit:contain;flex:0 0 auto}
    .lso-print-copy{min-width:0}
    .lso-print-copy .org{font-size:10px;text-transform:uppercase;letter-spacing:.13em;color:#167055;font-weight:700}
    .lso-print-copy h1{margin:4px 0 3px}
    .lso-print-meta{text-align:right;white-space:nowrap}
    .lso-print-badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#e1f5ea;color:#0d6c49;font-size:11px;font-weight:700;margin-top:7px}
    @media print{.lso-print-logo{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
  `;

  function printHeader({ title, subtitle = '', meta = '', badge = '' } = {}) {
    return `<div class="header head lso-print-header">
      <div class="lso-print-brand">
        <img class="lso-print-logo" src="${escapeHtml(logoUrl)}" alt="Lasallian Symphony Orchestra logo">
        <div class="lso-print-copy">
          <div class="org brand">Lasallian Symphony Orchestra</div>
          <h1>${escapeHtml(title)}</h1>
          ${subtitle ? `<div class="sub id">${escapeHtml(subtitle)}</div>` : ''}
          ${badge ? `<span class="lso-print-badge badge">${escapeHtml(badge)}</span>` : ''}
        </div>
      </div>
      ${meta ? `<div class="sub id lso-print-meta">${escapeHtml(meta)}</div>` : ''}
    </div>`;
  }

  window.LSOBrand = Object.freeze({ logoUrl, markUrl, printCss, printHeader });
})();
