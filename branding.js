(() => {
  'use strict';

  const assetUrl = (name) => new URL(name, document.baseURI || window.location.href).href;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'\"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;'
  }[character]));

  const logoUrl = assetUrl('lso-logo.png');
  const markUrl = assetUrl('lso-mark.png');
  const officialTemplatePdfUrl = assetUrl('lso-official-template.pdf');
  const officialTemplateUrl = assetUrl('lso-official-template.png');
  const officialHeaderUrl = assetUrl('lso-official-header.png');
  const officialFooterUrl = assetUrl('lso-official-footer.png');

  /*
   * Print output is built as exact A4 portrait sheets. Each sheet contains the
   * complete official template as a background image, while generated content
   * is placed only inside the safe white body area. JavaScript pagination
   * duplicates the sheet whenever the report is longer than one page.
   */
  const printCss = `
    @page{size:A4 portrait;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0!important;padding:0!important;background:#edf2ef!important;color:#17362d!important;font-family:Arial,sans-serif!important;line-height:1.28!important;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
    body{min-width:210mm}
    body.lso-print-ready> :not(.lso-print-pages):not(script){display:none!important}
    .lso-official-template-header,.lso-official-template-footer{display:none!important}
    .lso-print-pages{display:block;width:210mm;margin:0 auto}
    .lso-print-page{position:relative;width:210mm;height:297mm;margin:8mm auto;background:#fff;overflow:hidden;break-after:page;page-break-after:always;box-shadow:0 4mm 12mm rgba(11,59,46,.18)}
    .lso-print-page:last-child{break-after:auto;page-break-after:auto}
    .lso-page-template{position:absolute;inset:0;width:210mm;height:297mm;object-fit:fill;display:block;z-index:0;pointer-events:none;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
    .lso-page-content{position:absolute;left:12mm;right:12mm;top:48mm;bottom:30mm;z-index:1;overflow:hidden}
    .lso-page-number{position:absolute;right:12mm;bottom:24.2mm;z-index:2;font-size:6.5px;font-weight:700;color:#4f6f63;letter-spacing:.04em}
    .lso-document-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;border-bottom:1.2px solid #167055;padding:0 0 3mm;margin:0 0 4mm;break-inside:avoid;page-break-inside:avoid}
    .lso-document-heading-main{min-width:0}
    .lso-document-heading h1{font-size:17px!important;line-height:1.15!important;margin:1.5mm 0 1mm!important;color:#123a2f!important;overflow-wrap:anywhere}
    .lso-document-subtitle,.lso-document-meta{font-size:8px!important;color:#60766e!important;line-height:1.35}
    .lso-document-meta{text-align:right;max-width:55mm}
    .lso-document-badge{display:inline-block;margin-top:2mm;padding:1.2mm 2.4mm;border:1px solid #b8dcca;border-radius:999px;background:#f0faf5;color:#0d6c49;font-size:7.5px;font-weight:700}
    .lso-print-header,.lso-print-brand,.lso-print-copy,.lso-print-logo{all:unset}
    h1{font-size:17px!important;line-height:1.15!important}
    h2{font-size:13px!important}
    h3{font-size:11px!important}
    .summary{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:2mm!important;margin:3mm 0 4mm!important;break-inside:avoid;page-break-inside:avoid}
    .summary>div{padding:2mm!important;border-radius:2mm!important;min-width:0}
    .summary span{font-size:6.5px!important;overflow-wrap:anywhere}
    .summary strong{font-size:12px!important;overflow-wrap:anywhere}
    table{width:100%!important;max-width:100%!important;table-layout:fixed!important;border-collapse:collapse!important;font-size:7.2px!important;margin:2.5mm 0 0!important}
    thead{display:table-header-group}
    tfoot{display:table-footer-group}
    tr{break-inside:avoid;page-break-inside:avoid}
    th,td{padding:2mm 2.2mm!important;line-height:1.36!important;overflow-wrap:anywhere!important;word-break:break-word!important;hyphens:auto!important;vertical-align:middle!important}
    th{font-size:6.5px!important;line-height:1.25!important;vertical-align:middle!important}
    tbody tr{min-height:8mm!important}
    tbody td{height:8mm!important}
    .monthly-roster{font-size:6.7px!important}
    .monthly-roster th{font-size:6px!important}
    .monthly-roster td{padding:1.55mm 1.7mm!important;line-height:1.3!important;height:7mm!important}
    .grid{break-inside:auto;page-break-inside:auto}
    .field{min-height:0!important;padding:2.2mm!important;break-inside:avoid;page-break-inside:avoid}
    .field span{font-size:6.5px!important}
    .field strong{font-size:8px!important;overflow-wrap:anywhere}
    .notes{font-size:8px!important;min-height:0!important;break-inside:avoid;page-break-inside:avoid}
    .report-note{font-size:7px!important;padding:2mm!important;margin:2mm 0 3mm!important}
    .report-section,.section-title{break-after:avoid;page-break-after:avoid}
    .section-title{margin:4mm 0 2mm!important}
    .section-title h2{font-size:12px!important}
    .sign{gap:28mm!important;margin-top:13mm!important;break-inside:avoid;page-break-inside:avoid;font-size:8px!important}
    .sign div{padding-top:1.5mm!important}
    .footer,.foot{display:none!important}
    .page-break{break-before:page;page-break-before:always}
    img,svg{max-width:100%}
    @media print{
      html,body{width:210mm!important;min-width:210mm!important;background:#fff!important}
      .lso-print-pages{margin:0!important}
      .lso-print-page{margin:0!important;box-shadow:none!important}
      button,.no-print{display:none!important}
    }
  `;

  function printHeader({ title, subtitle = '', meta = '', badge = '' } = {}) {
    return `<section class="header head lso-document-heading">
      <div class="lso-document-heading-main">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<div class="sub id lso-document-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        ${badge ? `<span class="badge lso-document-badge">${escapeHtml(badge)}</span>` : ''}
      </div>
      ${meta ? `<div class="sub id lso-document-meta">${escapeHtml(meta)}</div>` : ''}
    </section>`;
  }

  const printRuntimeScript = `<script>
  (()=>{
    'use strict';
    const TEMPLATE_URL=${JSON.stringify(officialTemplateUrl)};
    const CONTENT_HEIGHT_MM=219;
    const pxPerMm=()=>{const probe=document.createElement('div');probe.style.cssText='position:absolute;visibility:hidden;width:100mm;height:1mm';document.body.appendChild(probe);const value=probe.getBoundingClientRect().width/100;probe.remove();return value||3.7795275591};
    const directContent=()=>Array.from(document.body.children).filter((node)=>node.tagName!=='SCRIPT'&&!node.classList.contains('lso-print-pages')&&!node.classList.contains('lso-official-template-header')&&!node.classList.contains('lso-official-template-footer'));
    const makePage=(container)=>{const page=document.createElement('section');page.className='lso-print-page';const template=document.createElement('img');template.className='lso-page-template';template.alt='';template.src=TEMPLATE_URL;const content=document.createElement('div');content.className='lso-page-content';page.append(template,content);container.appendChild(page);return {page,content};};
    const overflows=(content)=>content.scrollHeight>content.clientHeight+1;
    const addSimple=(node,state,newPage)=>{const clone=node.cloneNode(true);state.content.appendChild(clone);if(overflows(state.content)&&state.content.children.length>1){clone.remove();state=newPage();state.content.appendChild(clone);}return state;};
    const cloneTableShell=(table)=>{const next=table.cloneNode(false);Array.from(table.children).forEach((child)=>{if(child.tagName==='COLGROUP'||child.tagName==='THEAD')next.appendChild(child.cloneNode(true));});const body=document.createElement('tbody');next.appendChild(body);return {table:next,body};};
    const addTable=(source,state,newPage)=>{
      const rows=Array.from(source.querySelectorAll(':scope > tbody > tr'));
      if(!rows.length)return addSimple(source,state,newPage);
      let shell=cloneTableShell(source);state.content.appendChild(shell.table);
      if(overflows(state.content)&&state.content.children.length>1){shell.table.remove();state=newPage();shell=cloneTableShell(source);state.content.appendChild(shell.table);}
      rows.forEach((row)=>{const clone=row.cloneNode(true);shell.body.appendChild(clone);if(overflows(state.content)&&shell.body.children.length>1){clone.remove();state=newPage();shell=cloneTableShell(source);state.content.appendChild(shell.table);shell.body.appendChild(clone);}});
      return state;
    };
    const paginate=()=>{
      const nodes=directContent();
      const pages=document.createElement('main');pages.className='lso-print-pages';
      document.body.appendChild(pages);
      let state=makePage(pages);
      const newPage=()=>makePage(pages);
      nodes.forEach((node)=>{
        if(node.classList.contains('page-break')){state=newPage();return;}
        state=node.tagName==='TABLE'?addTable(node,state,newPage):addSimple(node,state,newPage);
      });
      Array.from(pages.querySelectorAll('.lso-print-page')).forEach((page)=>{if(!page.querySelector('.lso-page-content')?.children.length)page.remove();});
      const finalPages=Array.from(pages.querySelectorAll('.lso-print-page'));
      finalPages.forEach((page,index)=>{const label=document.createElement('div');label.className='lso-page-number';label.textContent='Page '+(index+1)+' of '+finalPages.length;page.appendChild(label);});
      document.body.classList.add('lso-print-ready');
      document.title='';
      return Promise.all(Array.from(pages.querySelectorAll('img')).map((image)=>image.complete?Promise.resolve():new Promise((resolve)=>{image.onload=image.onerror=resolve;})));
    };
    const start=async()=>{try{if(document.fonts&&document.fonts.ready)await document.fonts.ready;await paginate();await new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));window.print();}catch(error){console.error('LSO print preparation failed',error);window.print();}};
    if(document.readyState==='complete')start();else window.addEventListener('load',start,{once:true});
  })();
  <\/script>`;

  window.LSOBrand = Object.freeze({
    logoUrl,
    markUrl,
    officialTemplatePdfUrl,
    officialTemplateUrl,
    officialHeaderUrl,
    officialFooterUrl,
    printCss,
    printHeader,
    printRuntimeScript
  });
})();
