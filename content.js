// content.js - injected on YouTube pages

(function() {
  const SEL = {
    // From ids.txt and common YouTube transcript DOM
    showMoreBtn: 'tp-yt-paper-button#expand',
    showTranscriptBtn: 'ytd-button-renderer.ytd-video-description-transcript-section-renderer',
    // Generic transcript item and fallbacks
    transcriptItem: 'ytd-transcript-segment-renderer',
    transcriptItemAlt: 'ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer',
    transcriptTime: '.segment-timestamp, yt-formatted-string.segment-timestamp, .segment-timestamp.style-scope',
    transcriptText: '.segment-text, yt-formatted-string.segment-text, .segment-text.style-scope',
    videoEl: 'video.video-stream.html5-main-video'
  };

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Abortable fetch with timeout
  async function fetchWithTimeout(url, ms = 2000, options = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), ms);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  async function waitFor(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(50);
    }
    return null;
  }

  // Wait for the first element that matches any of the provided selectors
  async function waitForAnySelector(selectors, timeout = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      await sleep(50);
    }
    return null;
  }

  // Poll until transcript items appear (fast exit as soon as found)
  async function waitForTranscriptItems(timeout = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (document.querySelector(SEL.transcriptItem) || document.querySelector(SEL.transcriptItemAlt)) return true;
      await sleep(50);
    }
    return false;
  }

  // Use precise selectors from ids.txt to open transcript via description section quickly
  async function openTranscriptViaDescriptionPrecise(maxTimeMs = 3000) {
    const deadline = Date.now() + maxTimeMs;
    // 1) Click ...more (#expand)
    const more = document.querySelector('tp-yt-paper-button#expand');
    if (more) {
      realClick(more);
    }
    // 2) Wait for the transcript section to appear
    const section = await waitFor('ytd-video-description-transcript-section-renderer', Math.max(400, deadline - Date.now()));
    if (!section) return false;
    // 3) Click Show transcript button inside the section
    const btn = section.querySelector('ytd-button-renderer.ytd-video-description-transcript-section-renderer button, ytd-button-renderer.ytd-video-description-transcript-section-renderer tp-yt-paper-button');
    if (btn) {
      realClick(btn);
    }
    // 4) Wait for items
    const remaining = Math.max(300, deadline - Date.now());
    return await waitForTranscriptItems(remaining);
  }

  function scrapeTranscript() {
    let nodes = Array.from(document.querySelectorAll(SEL.transcriptItem));
    if (!nodes.length) {
      nodes = Array.from(document.querySelectorAll(SEL.transcriptItemAlt));
    }
    if (!nodes.length) return [];
    return nodes.map((n, i) => {
      const t = n.querySelector(SEL.transcriptTime);
      const x = n.querySelector(SEL.transcriptText);
      return {
        index: i,
        time: t ? t.textContent.trim() : '',
        text: x ? x.textContent.trim() : ''
      };
    }).filter(item => item.text);
  }

  async function tryOpenTranscriptPanel() {
    // Fast exit if already present
    if (document.querySelector(SEL.transcriptItem) || document.querySelector(SEL.transcriptItemAlt)) return;

    // 1) Fast path via description using precise selectors from ids.txt
    const fast = await openTranscriptViaDescriptionPrecise(3000);
    if (fast) return;

    // 3) Use overflow menu (three dots) → "Show transcript"
    try {
      const overflow = await waitForAnySelector([
        'ytd-menu-renderer tp-yt-paper-icon-button',
        'ytd-menu-renderer button'
      ], 1200);
      if (overflow) {
        realClick(overflow);
        const transItem = await (async () => {
          const listSel = ['ytd-menu-service-item-renderer', 'tp-yt-paper-item', 'ytd-compact-link-renderer'];
          const start = Date.now();
          while (Date.now() - start < 2000) {
            const items = Array.from(document.querySelectorAll(listSel.join(', ')));
            const found = items.find(i => i.textContent.toLowerCase().includes('transcript'));
            if (found) return found;
            await sleep(50);
          }
          return null;
        })();
        if (transItem) {
          realClick(transItem);
          await waitForTranscriptItems(2000);
        }
      }
    } catch {}
  }

  // ====== Timedtext API fallback ======
  function getVideoIdFromUrl() {
    const u = new URL(location.href);
    return u.searchParams.get('v');
  }

  async function fetchTimedtextTracks(videoId, timeoutMs = 2000) {
    // Returns available tracks list
    const url = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
    const res = await fetchWithTimeout(url, timeoutMs, { credentials: 'omit' });
    if (!res.ok) return [];
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return Array.from(doc.getElementsByTagName('track')).map(t => ({
      lang_code: t.getAttribute('lang_code') || '',
      lang_original: t.getAttribute('lang_original') || '',
      lang_translated: t.getAttribute('lang_translated') || '',
      name: t.getAttribute('name') || '',
      kind: t.getAttribute('kind') || '' // 'asr' means auto-generated
    }));
  }

  async function fetchTimedtextTranscript(videoId, lang, timeoutMs = 2000) {
    const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`;
    const res = await fetchWithTimeout(url, timeoutMs, { credentials: 'omit' });
    if (!res.ok) return [];
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const texts = Array.from(doc.getElementsByTagName('text'));
    if (!texts.length) return [];
    const decode = (s) => {
      // xml text may contain HTML entities
      const div = document.createElement('div');
      div.innerHTML = s;
      return div.textContent || div.innerText || '';
    };
    return texts.map(t => {
      const start = parseFloat(t.getAttribute('start') || '0');
      const dur = parseFloat(t.getAttribute('dur') || '0');
      const secs = Math.floor(start);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      const time = (h > 0 ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      return { time, text: decode(t.textContent || '') };
    });
  }

  async function fallbackTranscript(preferredLang, timeouts = { list: 1500, fetch: 1500 }) {
    const videoId = getVideoIdFromUrl();
    if (!videoId) return { ok: false, reason: 'Cannot determine video id.' };
    const tracks = await fetchTimedtextTracks(videoId, timeouts.list ?? 1500);
    if (!tracks.length) return { ok: false, reason: 'No transcript tracks available for this video.' };

    // Choose language
    const langsByPref = [];
    if (preferredLang) langsByPref.push(preferredLang);
    // Prefer English variants, then first track
    const englishish = tracks
      .map(t => t.lang_code)
      .filter(Boolean)
      .filter(lc => /^(en|en-\w+)/i.test(lc));
    langsByPref.push(...englishish, tracks[0].lang_code);

    // Try top 3 candidates in parallel for speed
    const uniq = Array.from(new Set(langsByPref.filter(Boolean)));
    const top = uniq.slice(0, 3);
    if (!top.length) return { ok: false, reason: 'No candidate languages.' };
    const promises = top.map(l => (async () => {
      const data = await fetchTimedtextTranscript(videoId, l, timeouts.fetch ?? 1500);
      if (data && data.length) return { ok: true, data, lang: l, tracks };
      throw new Error('empty');
    })());
    try {
      const first = await Promise.any(promises);
      return first;
    } catch {
      // Fallback sequential on remaining
      for (const l of uniq.slice(3)) {
        try {
          const data = await fetchTimedtextTranscript(videoId, l, timeouts.fetch ?? 1500);
          if (data && data.length) return { ok: true, data, lang: l, tracks };
        } catch {}
      }
      return { ok: false, reason: 'Timedtext returned no items for available tracks.' };
    }
  }

  // Strict fast DOM attempt (~<=1.2s): check existing items, then precise description path quick open
  async function getTranscriptFastFlow() {
    if (!location.pathname.startsWith('/watch')) {
      throw new Error('not-watch');
    }
    let data = scrapeTranscript();
    if (data.length) return { ok: true, data };
    const opened = await openTranscriptViaDescriptionPrecise(1200);
    if (opened) {
      data = scrapeTranscript();
      if (data.length) return { ok: true, data };
    }
    throw new Error('dom-fast-empty');
  }

  async function getTranscriptFlow() {
    // Ensure we are on a watch page
    const urlOk = location.pathname.startsWith('/watch');
    if (!urlOk) {
      return { ok: false, reason: 'Not on a YouTube watch page.' };
    }

    // If transcript not present, try to open it
    let data = scrapeTranscript();
    if (!data.length) {
      await tryOpenTranscriptPanel();
      data = scrapeTranscript();
    }

    if (!data.length) {
      return { ok: false, reason: 'Transcript not found in DOM.' };
    }

    return { ok: true, data };
  }

  function getVideoRect() {
    const el = document.querySelector(SEL.videoEl);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 };
  }

  function realClick(el) {
    try {
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch {
      try { el.click(); } catch {}
    }
  }

  function parseTimeToSeconds(tstr) {
    if (!tstr) return null;
    const parts = tstr.trim().split(':').map(s => parseInt(s, 10));
    if (parts.some(n => Number.isNaN(n))) return null;
    let s = 0;
    if (parts.length === 3) s = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) s = parts[0] * 60 + parts[1];
    else if (parts.length === 1) s = parts[0];
    return s;
  }

  function waitForSeek(video, targetSeconds, prevTime, timeout = 1500) {
    return new Promise(resolve => {
      let done = false;
      const clear = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('timeupdate', onTimeupdate);
        video.removeEventListener('seeking', onSeeking);
      };
      const onSeeked = () => { clear(); resolve(true); };
      const onSeeking = () => { /* seeking started */ };
      const onTimeupdate = () => {
        if (Math.abs(video.currentTime - prevTime) > 0.25) { clear(); resolve(true); }
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('seeking', onSeeking);
      video.addEventListener('timeupdate', onTimeupdate);
      setTimeout(() => { clear(); resolve(false); }, timeout);
    });
  }

  async function clickTranscriptItem(index) {
    // Prefer exact class per ids.txt: ytd-transcript-segment-renderer.style-scope.ytd-transcript-segment-list-renderer
    let list = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer.style-scope.ytd-transcript-segment-list-renderer'));
    if (!list.length) list = Array.from(document.querySelectorAll(SEL.transcriptItem));
    const target = list[index];
    if (!target) return { ok: false, reason: 'Transcript item not found for index ' + index };
    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {}
    // Simulate a real click on the item (or timestamp inside) to jump
    const tsEl = target.querySelector(SEL.transcriptTime) || target;
    const vid = document.querySelector(SEL.videoEl);
    const prevTime = vid ? vid.currentTime : 0;
    const tsText = target.querySelector(SEL.transcriptTime)?.textContent?.trim() || '';
    const tsSecs = parseTimeToSeconds(tsText);

    realClick(tsEl);
    // Wait for seek; if not, try setting currentTime directly
    if (vid) {
      const moved = await waitForSeek(vid, tsSecs, prevTime, 2000);
      if (!moved && tsSecs != null) {
        try { vid.currentTime = tsSecs; } catch {}
        await waitForSeek(vid, tsSecs, prevTime, 800);
      }
    } else {
      await sleep(500);
    }

    // Small delay for the new frame to render fully
    await sleep(250);
    const rect = getVideoRect();
    const t = target.querySelector(SEL.transcriptTime);
    const x = target.querySelector(SEL.transcriptText);
    return {
      ok: !!rect,
      rect,
      item: {
        index,
        time: t ? t.textContent.trim() : '',
        text: x ? x.textContent.trim() : ''
      }
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg && msg.type === 'GET_TRANSCRIPT') {
        try {
          const domPromise = (async () => {
            const res = await getTranscriptFastFlow();
            if (res.ok && res.data?.length) return res;
            throw new Error('dom-empty');
          })();
          const timedtextPromise = (async () => {
            const fb = await fallbackTranscript(msg.lang, { list: 1500, fetch: 1500 });
            if (fb.ok && fb.data?.length) return fb;
            throw new Error('timedtext-empty');
          })();
          // Return whichever finishes first with data
          const fast = await Promise.any([domPromise, timedtextPromise]);
          sendResponse(fast);
        } catch (e) {
          // If race rejected, try one last quick timedtext attempt
          try {
            const fb2 = await fallbackTranscript(msg.lang, { list: 1500, fetch: 1500 });
            sendResponse(fb2);
          } catch (e2) {
            sendResponse({ ok: false, reason: 'Unexpected error: ' + (e2 && e2.message ? e2.message : String(e2)) });
          }
        }
      } else if (msg && msg.type === 'OPEN_TRANSCRIPT_PANEL') {
        try {
          await tryOpenTranscriptPanel();
          const data = scrapeTranscript();
          if (data.length) {
            sendResponse({ ok: true, data });
          } else {
            // As a convenience, fallback here too
            const fb = await fallbackTranscript(msg.lang);
            if (fb.ok) sendResponse(fb); else sendResponse({ ok: false, reason: 'Tried to open the panel, but no transcript items found.' });
          }
        } catch (e) {
          sendResponse({ ok: false, reason: 'Failed to open panel: ' + (e && e.message ? e.message : String(e)) });
        }
      } else if (msg && msg.type === 'GET_LANGS') {
        try {
          const videoId = getVideoIdFromUrl();
          if (!videoId) {
            sendResponse({ ok: false, reason: 'Cannot determine video id.' });
            return;
          }
          const tracks = await fetchTimedtextTracks(videoId);
          sendResponse({ ok: true, tracks });
        } catch (e) {
          sendResponse({ ok: false, reason: 'Failed to list languages.' });
        }
      } else if (msg && msg.type === 'LIST_TRANSCRIPTS') {
        try {
          let data = scrapeTranscript();
          if (!data.length) {
            await tryOpenTranscriptPanel();
            data = scrapeTranscript();
          }
          if (!data.length) {
            // Fallback to timedtext if DOM still empty (faster for some videos/locales)
            const videoId = getVideoIdFromUrl();
            if (videoId) {
              const fb = await fallbackTranscript();
              if (fb.ok) { sendResponse(fb); return; }
            }
          }
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, reason: 'Failed to list transcripts.' });
        }
      } else if (msg && msg.type === 'CLICK_TRANSCRIPT') {
        try {
          const res = await clickTranscriptItem(msg.index);
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, reason: 'Failed to click transcript item.' });
        }
      }
    })();
    return true; // keep the message channel open for async
  });
})();
