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
const saveHtmlBtn = document.getElementById('saveHtmlBtn');
const previewsEl = document.getElementById('previews');

let fullData = [];

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
}

async function takeScreenshotsFlow() {
  setStatus('Preparing screenshots...', '');
  previewsEl.innerHTML = '';
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
    await new Promise(r => setTimeout(r, 500));
    const fullShot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const cropped = await cropDataUrlToRect(fullShot, clickRes.rect);
    renderCard(cropped, `${clickRes.item.time}  ${clickRes.item.text}`);
  }

  setStatus('Screenshots completed.', '');
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
downloadBtn.addEventListener('click', downloadPdf);
searchInput.addEventListener('input', applyFilter);
langSel.addEventListener('change', () => {
  rememberLang(getSelectedLang());
  // Optional: auto-refetch when language changes
  fetchTranscript();
});
shotBtn.addEventListener('click', takeScreenshotsFlow);

function exportPreviewsAsHtml() {
  if (!previewsEl.children.length) {
    setStatus('No preview cards to save. Run screenshots first.', 'warn');
    return;
  }
  const escHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const parts = Array.from(previewsEl.querySelectorAll('.card')).map(card => {
    const img = card.querySelector('img');
    const cap = card.querySelector('.caption');
    const src = img ? img.src : '';
    const captionRaw = cap ? cap.textContent : '';
    let time = '';
    let text = captionRaw || '';
    const m = /^(\s*\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/s.exec(captionRaw || '');
    if (m) { time = m[1].trim(); text = m[2].trim(); }
    return `
    <div class=\"card vertical\">
      <div class=\"meta\">
        <div class=\"time\">${escHtml(time)}</div>
        <div class=\"text\">${escHtml(text)}</div>
      </div>
      <div class=\"image\"><img src=\"${escHtml(src)}\" alt=\"frame\"></div>
    </div>`;
  }).join('');

  const styles = `
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 20px; }
    h1 { font-size: 18px; margin: 0 0 12px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .card { border: none; border-radius: 0; overflow: visible; }
    .card.vertical { display: block; }
    .card .meta { margin-bottom: 8px; }
    .card .time { color: #1e40af; font-weight: 700; font-size: 12px; margin-bottom: 2px; }
    .card .text { color: #333; font-size: 12px; line-height: 1.35; }
    .card .image img { width: 100%; height: auto; display: block; background: #000; }
    @media print {
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .card { break-inside: avoid; page-break-inside: avoid; }
    }
  </style>`;

  const html = `<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">${styles}</head><body>
  <h1>YouTube Transcript Cards</h1>
  <div class=\"grid\">${parts}</div>
  </body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date();
  const fn = `yt-cards-${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}-${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}.html`;
  a.href = url;
  a.download = fn;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 500);
  setStatus('Saved preview HTML.', '');
}

saveHtmlBtn.addEventListener('click', exportPreviewsAsHtml);

document.addEventListener('DOMContentLoaded', async () => {
  // Run in parallel to minimize TTF (time-to-first) transcript
  loadLangs();
  fetchTranscript();
});

function downloadPdf() {
  // Requires preview cards. If none, ask user to generate first.
  if (!previewsEl.children.length) {
    setStatus('Generating cards for PDF...', '');
    takeScreenshotsFlow().then(() => setTimeout(downloadPdf, 200));
    return;
  }

  const escHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const parts = Array.from(previewsEl.querySelectorAll('.card')).map(card => {
    const img = card.querySelector('img');
    const cap = card.querySelector('.caption');
    const src = img ? img.src : '';
    const captionRaw = cap ? cap.textContent : '';
    let time = '';
    let text = captionRaw || '';
    const m = /^(\s*\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/s.exec(captionRaw || '');
    if (m) { time = m[1].trim(); text = m[2].trim(); }
    return `
    <div class=\"card vertical\">
      <div class=\"meta\">
        <div class=\"time\">${escHtml(time)}</div>
        <div class=\"text\">${escHtml(text)}</div>
      </div>
      <div class=\"image\"><img src=\"${escHtml(src)}\" alt=\"frame\"></div>
    </div>`;
  }).join('');

  const styles = `
  <style>
    @page { size: A4; margin: 10mm; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 12px 0; padding: 10mm 10mm 0 10mm; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 0 10mm 10mm 10mm; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .card { border: none; border-radius: 0; overflow: visible; }
    .card.vertical { display: block; }
    .card .meta { margin-bottom: 8px; }
    .card .time { color: #1e40af; font-weight: 700; font-size: 12px; margin-bottom: 2px; }
    .card .text { color: #333; font-size: 12px; line-height: 1.35; }
    .card .image img { width: 100%; height: auto; display: block; background: #000; }
    @media print {
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .card { break-inside: avoid; page-break-inside: avoid; }
    }
  </style>`;

  const script = `
  <script>
    (function(){
      function waitImages(){
        const imgs = Array.from(document.images);
        return Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = img.onerror = r; })));
      }
      waitImages().then(() => {
        setTimeout(() => { window.print(); }, 300);
      });
      window.onafterprint = () => { window.close(); };
    })();
  <\/script>`;

  const html = `<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">${styles}</head><body>
  <h1>YouTube Transcript Cards</h1>
  <div class=\"grid\">${parts}</div>
  ${script}
  </body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setStatus('Opening print dialog for PDF...', '');
}
