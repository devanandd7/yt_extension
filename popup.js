// popup.js

const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const refreshBtn = document.getElementById('refreshBtn');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');
const langSel = document.getElementById('lang');
const shotBtn = document.getElementById('shotBtn');
const previewsEl = document.getElementById('previews');

let fullData = [];
let capturedCards = []; // {imgDataUrl, caption}

async function buildTwoColumnPdf(cards) {
  // Page size: A4 595x842 pt at 72 DPI
  const pageW = 595, pageH = 842;
  const margin = 36; // 0.5 inch
  const gutter = 18;
  const contentW = pageW - margin * 2;
  const colW = Math.floor((contentW - gutter) / 2);

  // Render at higher pixel density
  const scale = 2;
  const pageWPx = Math.floor(pageW * scale);
  const pageHPx = Math.floor(pageH * scale);
  const marginPx = Math.floor(margin * scale);
  const gutterPx = Math.floor(gutter * scale);
  const colWPx = Math.floor(colW * scale);

  // Prepare card canvases sized to column width
  const cardCanvases = [];
  for (const card of cards) {
    const img = await dataUrlToImage(card.imgDataUrl);
    const cardCanvas = canvasFromCard(img, card.caption, colWPx);
    cardCanvases.push(cardCanvas);
  }

  const pages = [];
  let pageCanvas = document.createElement('canvas');
  pageCanvas.width = pageWPx; pageCanvas.height = pageHPx;
  let ctx = pageCanvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageWPx, pageHPx);

  const leftX = marginPx;
  const rightX = marginPx + colWPx + gutterPx;
  let curYLeft = marginPx;
  let curYRight = marginPx;

  for (const cc of cardCanvases) {
    // Place on the shorter column
    const placeRight = curYRight <= curYLeft;
    const x = placeRight ? rightX : leftX;
    let y = placeRight ? curYRight : curYLeft;

    // If it doesn't fit on current column, try the other; if still not, new page
    if (y + cc.height > pageHPx - marginPx) {
      const otherY = placeRight ? curYLeft : curYRight;
      const otherX = placeRight ? leftX : rightX;
      if (otherY + cc.height <= pageHPx - marginPx) {
        // place on other column
        ctx.drawImage(cc, otherX, otherY);
        if (placeRight) curYLeft = otherY + cc.height + 12; else curYRight = otherY + cc.height + 12;
        continue;
      }
      // new page
      pages.push(pageCanvas.toDataURL('image/jpeg', 0.98));
      pageCanvas = document.createElement('canvas');
      pageCanvas.width = pageWPx; pageCanvas.height = pageHPx;
      ctx = pageCanvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageWPx, pageHPx);
      curYLeft = marginPx; curYRight = marginPx;
      // reset positions
      y = placeRight ? curYRight : curYLeft;
    }

    ctx.drawImage(cc, x, y);
    if (placeRight) curYRight = y + cc.height + 12; else curYLeft = y + cc.height + 12;
  }

  // push last page
  pages.push(pageCanvas.toDataURL('image/jpeg', 0.98));

  const pdfBytes = buildSimplePdfFromJpegs(pages, pageW, pageH);
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

async function getSafeVideoTitle() {
  const tab = await getActiveTab();
  const raw = (tab && tab.title) ? tab.title.replace(/\s*-\s*YouTube\s*$/i, '') : '';
  const base = (raw || 'yt_transcript').trim().slice(0, 120);
  return base.replace(/[\\/:*?"<>|]+/g, '').trim() || 'yt_transcript';
}

async function downloadPdfFromCaptured() {
  if (!capturedCards.length) {
    // If nothing captured yet, run the capture flow (which will auto-download too)
    await takeScreenshotsFlow();
    return;
  }
  setStatus('Building PDF...', '');
  try {
    const pdfBlob = await buildTwoColumnPdf(capturedCards);
    const url = URL.createObjectURL(pdfBlob);
    const safeTitle = await getSafeVideoTitle();
    const filename = `${safeTitle || 'yt_transcript'}_${Date.now()}.pdf`;
    await chrome.downloads.download({ url, filename, saveAs: false });
    setStatus('PDF downloaded.', '');
  } catch (e) {
    setStatus('Failed to generate PDF', 'error');
  }
}

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + cls;
}

async function listTranscriptItems(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'LIST_TRANSCRIPTS' });
    if (res && res.ok) return res.data || [];
  } catch {}
  return [];
}

async function clickTranscriptAndGetRect(tabId, index) {
  const res = await chrome.tabs.sendMessage(tabId, { type: 'CLICK_TRANSCRIPT', index });
  return res;
}

function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function cropDataUrlToRect(dataUrl, rect) {
  const img = await dataUrlToImage(dataUrl);
  const dpr = rect.dpr || 1;
  const sx = rect.x * dpr;
  const sy = rect.y * dpr;
  const sw = rect.width * dpr;
  const sh = rect.height * dpr;
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/png');
}

function renderCard(imageDataUrl, captionText) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.src = imageDataUrl;
  const cap = document.createElement('div');
  cap.className = 'caption';
  cap.textContent = captionText;
  card.appendChild(img);
  card.appendChild(cap);
  previewsEl.appendChild(card);
  capturedCards.push({ imgDataUrl: imageDataUrl, caption: captionText });
}

async function takeScreenshotsFlow() {
  setStatus('Preparing screenshots...', '');
  previewsEl.innerHTML = '';
  capturedCards = [];
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus('No active tab found.', 'error');
    return;
  }
  await ensureContentScript(tab.id);

  // Ensure transcript list is ready
  let items = await listTranscriptItems(tab.id);
  if (!items.length) {
    await fetchTranscript(); // triggers opening transcript and scraping
    items = await listTranscriptItems(tab.id);
  }
  if (!items.length) {
    setStatus('No transcript items to capture.', 'warn');
    return;
  }

  for (let i = 0; i < items.length; i++) {
    setStatus(`Capturing ${i + 1}/${items.length}...`, '');
    const clickRes = await clickTranscriptAndGetRect(tab.id, items[i].index);
    if (!clickRes || !clickRes.ok || !clickRes.rect) continue;
    // Give the player a moment to update the frame
    await new Promise(r => setTimeout(r, 350));
    const fullShot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const cropped = await cropDataUrlToRect(fullShot, clickRes.rect);
    renderCard(cropped, `${clickRes.item.time}  ${clickRes.item.text}`);
  }

  setStatus('Screenshots completed. Building PDF...', '');
  try {
    const pdfBlob = await buildTwoColumnPdf(capturedCards);
    const url = URL.createObjectURL(pdfBlob);
    const safeTitle = await getSafeVideoTitle();
    const filename = `${safeTitle || 'yt_transcript'}_${Date.now()}.pdf`;
    await chrome.downloads.download({ url, filename, saveAs: false });
    setStatus('PDF downloaded.', '');
  } catch (e) {
    setStatus('Failed to generate PDF', 'error');
  }
}

// ---- PDF helpers (no external libs) ----
// We'll create an A4-sized canvas (72 DPI points). Default: 2-column layout of screenshot + caption cards.
// Cards are rendered at higher pixel density to improve sharpness, then embedded as JPEG pages in a PDF.

function canvasFromCard(cardImg, caption, maxWidthPx) {
  // Stack image then caption in a white card canvas up to maxWidthPx
  const pad = 8;
  const scale = Math.min(1, maxWidthPx / cardImg.width);
  const w = Math.round(cardImg.width * scale);
  const imgH = Math.round(cardImg.height * scale);
  const ctxCanvas = document.createElement('canvas');
  // estimate caption height with rough wrap
  const ctx = ctxCanvas.getContext('2d');
  ctx.font = '12px Arial';
  const lines = wrapText(ctx, caption, w - 2 * pad);
  const textH = lines.length * 16 + pad; // 16px per line approx
  ctxCanvas.width = w;
  ctxCanvas.height = imgH + textH + pad * 2;
  const c = ctxCanvas.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, ctxCanvas.width, ctxCanvas.height);
  c.drawImage(cardImg, 0, 0, w, imgH);
  c.fillStyle = '#111';
  c.font = '12px Arial';
  c.textBaseline = 'top';
  let y = imgH + pad;
  for (const line of lines) {
    c.fillText(line, pad, y);
    y += 16;
  }
  return ctxCanvas;
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function buildSingleColumnPdf(cards) {
  // Page size: A4 595x842 pt at 72 DPI
  const pageW = 595, pageH = 842;
  const margin = 36; // 0.5 inch
  const contentW = pageW - margin * 2;
  // Render at higher pixel density for sharper output
  const scale = 2; // 2x DPI
  const pageWPx = Math.floor(pageW * scale);
  const pageHPx = Math.floor(pageH * scale);
  const marginPx = Math.floor(margin * scale);
  const contentWPx = Math.floor(contentW * scale);

  // Convert each card to an image canvas sized to content width (in pixels)
  const cardCanvases = [];
  for (const card of cards) {
    const img = await dataUrlToImage(card.imgDataUrl);
    const cardCanvas = canvasFromCard(img, card.caption, contentWPx);
    cardCanvases.push(cardCanvas);
  }

  // Lay out canvases into pages (single column, full width)
  const pages = [];
  let pageCanvas = document.createElement('canvas');
  pageCanvas.width = pageWPx; pageCanvas.height = pageHPx;
  let ctx = pageCanvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageWPx, pageHPx);
  let curY = marginPx;

  for (const cc of cardCanvases) {
    if (curY + cc.height > pageHPx - marginPx) {
      // new page
      pages.push(pageCanvas.toDataURL('image/jpeg', 0.98));
      pageCanvas = document.createElement('canvas');
      pageCanvas.width = pageWPx; pageCanvas.height = pageHPx;
      ctx = pageCanvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageWPx, pageHPx);
      curY = marginPx;
    }
    ctx.drawImage(cc, marginPx, curY);
    curY += cc.height + 12; // spacing between cards
  }

  // push last page
  pages.push(pageCanvas.toDataURL('image/jpeg', 0.98));

  const pdfBytes = buildSimplePdfFromJpegs(pages, pageW, pageH);
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

function buildSimplePdfFromJpegs(jpegDataUrls, pageW, pageH) {
  // Very small PDF generator (minimal). Not feature complete, but enough for embedding full-page JPEGs.
  // Units are in points (1/72 inch). JPEGs must match page size.
  const enc = (s) => new TextEncoder().encode(s);
  const buffers = [];
  const xrefs = [];
  let offset = 0;
  const push = (buf) => { buffers.push(buf); offset += buf.length; };

  push(enc('%PDF-1.4\n'));

  const objIndex = [];
  const objects = [];

  // Create JPEG image objects
  const imgObjs = [];
  for (const dataUrl of jpegDataUrls) {
    const b64 = dataUrl.split(',')[1];
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const len = bin.length;
    const header = enc(`${objects.length + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pageW} /Height ${pageH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${len} >>\nstream\n`);
    const footer = enc(`\nendstream\nendobj\n`);
    objects.push({ header, stream: bin, footer });
    imgObjs.push(objects.length); // index (1-based in PDF)
  }

  // Create content stream objects (one per page)
  const contentsObjs = [];
  for (let i = 0; i < jpegDataUrls.length; i++) {
    const content = enc(`q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im${i} Do\nQ\n`);
    const contentObj = { header: enc(`${objects.length + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n`), stream: content, footer: enc(`\nendstream\nendobj\n`) };
    objects.push(contentObj);
    contentsObjs.push(objects.length);
  }

  // We will add page objects now, but they need the /Parent (Pages) object reference.
  // Compute the Pages object number which will be appended AFTER page objects.
  const pageCount = jpegDataUrls.length;
  const pagesObjNum = objects.length + pageCount + 1; // after all page objects

  // Create page objects
  const pageObjs = [];
  for (let i = 0; i < pageCount; i++) {
    const imgRef = `${imgObjs[i]} 0 R`;
    const pageObj = enc(`${objects.length + 1} 0 obj\n<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im${i} ${imgRef} >> >> /Contents ${contentsObjs[i]} 0 R >>\nendobj\n`);
    objects.push({ raw: pageObj });
    pageObjs.push(objects.length);
  }

  // Pages tree
  const kids = pageObjs.map((n) => `${n} 0 R`).join(' ');
  const pagesObj = enc(`${pagesObjNum} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageObjs.length} >>\nendobj\n`);
  objects.push({ raw: pagesObj });

  // Catalog (added last)
  const catalogObjNum = objects.length + 1;
  const catalogObj = enc(`${catalogObjNum} 0 obj\n<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>\nendobj\n`);
  objects.push({ raw: catalogObj });

  // Now write all objects and build xref
  let idx = 1;
  for (const obj of objects) {
    xrefs.push(offset);
    if (obj.header) push(obj.header);
    if (obj.stream) push(obj.stream);
    if (obj.footer) push(obj.footer);
    if (obj.raw) push(obj.raw);
  }

  const xrefOffset = offset;
  push(enc(`xref\n0 ${objects.length + 1}\n`));
  push(enc(`0000000000 65535 f \n`));
  for (const off of xrefs) {
    push(enc(`${String(off).padStart(10, '0')} 00000 n \n`));
  }
  push(enc(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));

  // Merge buffers
  let totalLen = 0; for (const b of buffers) totalLen += b.length;
  const out = new Uint8Array(totalLen);
  let p = 0; for (const b of buffers) { out.set(b, p); p += b.length; }
  return out;
}

function renderTranscript(items) {
  listEl.innerHTML = '';
  const tpl = document.getElementById('row');
  for (const item of items) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.querySelector('.time').textContent = item.time || '';
    li.querySelector('.text').textContent = item.text || '';
    listEl.appendChild(li);
  }
  countEl.textContent = String(items.length);
}

function applyFilter() {
  const q = (searchInput.value || '').trim().toLowerCase();
  if (!q) {
    renderTranscript(fullData);
    return;
  }
  const filtered = fullData.filter(x => (x.text || '').toLowerCase().includes(q) || (x.time || '').toLowerCase().includes(q));
  renderTranscript(filtered);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  // Try a ping; if it fails, inject content.js then retry later
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function getSelectedLang() {
  const v = (langSel && langSel.value) || '';
  return v || undefined;
}

function rememberLang(lang) {
  if (!lang) return;
  try { localStorage.setItem('yttr_lang', lang); } catch {}
}

function restoreLang() {
  try { return localStorage.getItem('yttr_lang') || ''; } catch { return ''; }
}

async function loadLangs() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;
  await ensureContentScript(tab.id);
  langSel.innerHTML = '';
  const optAuto = document.createElement('option');
  optAuto.value = '';
  optAuto.textContent = 'Auto';
  langSel.appendChild(optAuto);
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_LANGS' });
    if (res && res.ok && Array.isArray(res.tracks)) {
      const saved = restoreLang();
      for (const t of res.tracks) {
        const code = t.lang_code || '';
        if (!code) continue;
        const label = `${code}${t.kind === 'asr' ? ' (auto)' : ''}${t.name ? ' - ' + t.name : ''}`;
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = label;
        if (saved && saved === code) opt.selected = true;
        langSel.appendChild(opt);
      }
    }
  } catch {}
}

async function fetchTranscript() {
  setStatus('Fetching transcript...', '');
  listEl.innerHTML = '';

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus('No active tab found.', 'error');
    return;
  }

  if (!/^https?:\/\/(www\.)?youtube\.com\//.test(tab.url || '')) {
    setStatus('Open a YouTube video page, then click the extension.', 'warn');
    return;
  }

  // Ensure content script is present
  await ensureContentScript(tab.id);

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT', lang: getSelectedLang() });
    if (!res || !res.ok) {
      setStatus(res ? res.reason : 'Unknown error while getting transcript.', 'error');
      fullData = [];
      renderTranscript(fullData);
      return;
    }
    fullData = res.data || [];
    if (res.lang) {
      rememberLang(res.lang);
      // reflect selected
      for (const o of langSel.options) { o.selected = (o.value === res.lang); }
    }
    if (!fullData.length) {
      setStatus('Transcript is empty.', 'warn');
      renderTranscript(fullData);
      return;
    }

    setStatus(`Found ${fullData.length} lines.`);
    applyFilter();
  } catch (e) {
    setStatus('Unable to communicate with the page. Try reloading the YouTube tab and click again.', 'error');
    fullData = [];
    renderTranscript(fullData);
  }
}

function copyAll() {
  const text = fullData.map(x => `${x.time}\t${x.text}`).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    setStatus('Copied transcript to clipboard.', '');
  }, () => {
    setStatus('Copy failed.', 'error');
  });
}

function downloadTxt() {
  const text = fullData.map(x => `${x.time}\t${x.text}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transcript.txt';
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}

refreshBtn.addEventListener('click', fetchTranscript);
copyBtn.addEventListener('click', copyAll);
downloadBtn.addEventListener('click', downloadPdfFromCaptured);
searchInput.addEventListener('input', applyFilter);
langSel.addEventListener('change', () => {
  rememberLang(getSelectedLang());
  // Optional: auto-refetch when language changes
  fetchTranscript();
});
shotBtn.addEventListener('click', takeScreenshotsFlow);

document.addEventListener('DOMContentLoaded', async () => {
  await loadLangs();
  await fetchTranscript();
});
