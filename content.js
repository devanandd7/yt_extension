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

  async function waitFor(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  function scrapeTranscript() {
    let nodes = Array.from(document.querySelectorAll(`${SEL.transcriptItem}.style-scope.ytd-transcript-segment-list-renderer, ${SEL.transcriptItem}`));
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
    // Best-effort attempts. YouTube changes often, so this may fail.
    // 1) Try clicking a visible "Show transcript" under the description section
    let clicked = false;
    const section = document.querySelector('ytd-video-description-transcript-section-renderer');
    if (section) {
      const btnIn = section.querySelector('ytd-button-renderer button, ytd-button-renderer tp-yt-paper-button');
      if (btnIn) {
        btnIn.click();
        clicked = true;
        await sleep(900);
      }
    }

    // 2) Click "...more" to expand description, then try again if not clicked
    if (!clicked) {
      const more = document.querySelector(SEL.showMoreBtn);
      if (more) {
        more.click();
        await sleep(600);
        const section2 = document.querySelector('ytd-video-description-transcript-section-renderer');
        const btnIn2 = section2 && section2.querySelector('ytd-button-renderer button, ytd-button-renderer tp-yt-paper-button');
        if (btnIn2) {
          btnIn2.click();
          clicked = true;
          await sleep(900);
        }
      }
    }

    // 3) Some UIs expose transcript via the overflow menu (three dots) -> "Show transcript"
    // Try to open the menu and click an item containing the word "Transcript".
    try {
      const menuButtons = Array.from(document.querySelectorAll('ytd-menu-renderer tp-yt-paper-icon-button, ytd-menu-renderer button'));
      const overflow = menuButtons.find(b => b.getAttribute('aria-label')?.toLowerCase().includes('more') || b.title?.toLowerCase().includes('more')) || menuButtons[0];
      if (overflow) {
        overflow.click();
        await sleep(500);
        const items = Array.from(document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item, ytd-compact-link-renderer'));
        const transItem = items.find(i => i.textContent.toLowerCase().includes('transcript'));
        if (transItem) {
          transItem.click();
          await sleep(1000);
        }
      }
    } catch (e) {
      // ignore
    }

    // 3) Wait for transcript items to appear a bit
    await sleep(800);
  }

  // ====== Timedtext API fallback ======
  function getVideoIdFromUrl() {
    const u = new URL(location.href);
    return u.searchParams.get('v');
  }

  async function fetchTimedtextTracks(videoId) {
    // Returns available tracks list
    const url = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
    const res = await fetch(url, { credentials: 'omit' });
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

  async function fetchTimedtextTranscript(videoId, lang) {
    const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`;
    const res = await fetch(url, { credentials: 'omit' });
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

  async function fallbackTranscript(preferredLang) {
    const videoId = getVideoIdFromUrl();
    if (!videoId) return { ok: false, reason: 'Cannot determine video id.' };
    const tracks = await fetchTimedtextTracks(videoId);
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

    for (const lang of langsByPref) {
      if (!lang) continue;
      const data = await fetchTimedtextTranscript(videoId, lang);
      if (data && data.length) return { ok: true, data, lang, tracks };
    }
    return { ok: false, reason: 'Timedtext returned no items for available tracks.' };
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
    // Crop strictly from the HTML5 video element as requested
    const el = document.querySelector(SEL.videoEl);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 };
  }

  function getVideoEl() {
    return document.querySelector(SEL.videoEl);
  }

  function getVideoTime() {
    const v = getVideoEl();
    return v ? v.currentTime : NaN;
  }

  function parseTimestampToSeconds(str) {
    if (!str) return NaN;
    const parts = str.trim().split(':').map(x => parseInt(x, 10));
    if (parts.some(isNaN)) return NaN;
    let s = 0;
    if (parts.length === 3) s = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) s = parts[0] * 60 + parts[1];
    else if (parts.length === 1) s = parts[0];
    return s;
  }

  function smartClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new MouseEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  async function clickTranscriptItem(index) {
    const list = Array.from(document.querySelectorAll(`${SEL.transcriptItem}.style-scope.ytd-transcript-segment-list-renderer, ${SEL.transcriptItem}`));
    const target = list[index];
    if (!target) return { ok: false, reason: 'Transcript item not found for index ' + index };
    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {}
    // Prefer clicking timestamp or text inside the item; then fallback to the item itself.
    const clickable = target.querySelector('.segment-timestamp, .segment-text, a, button') || target;
    const before = getVideoTime();
    smartClick(clickable);
    await sleep(900);
    let after = getVideoTime();
    // Fallback: if time didn't move, parse the timestamp and set currentTime
    if (isFinite(before) && isFinite(after) && Math.abs(after - before) < 0.2) {
      const tEl = target.querySelector(SEL.transcriptTime);
      const tStr = tEl ? tEl.textContent.trim() : '';
      const secs = parseTimestampToSeconds(tStr);
      const v = getVideoEl();
      if (v && isFinite(secs)) {
        v.currentTime = secs;
        after = v.currentTime;
      }
    }
    await sleep(200);
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
          // Try DOM first
          const domRes = await getTranscriptFlow();
          if (domRes.ok && domRes.data?.length) {
            sendResponse(domRes);
            return;
          }
          // Fallback to timedtext
          const fb = await fallbackTranscript(msg.lang);
          sendResponse(fb);
        } catch (e) {
          sendResponse({ ok: false, reason: 'Unexpected error: ' + (e && e.message ? e.message : String(e)) });
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
