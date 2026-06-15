/* ============================================================================
 * ChatGPT conversation exporter — paste into DevTools Console on the chat tab.
 *
 * Starts at the top, scrolls the virtualized list to the bottom, accumulates
 * every user prompt and assistant response (deduped, in conversation order),
 * records every uploaded-file reference, then downloads `conversation.json`.
 *
 * Run: open the chat, F12 -> Console, paste this whole file, press Enter.
 *      It returns a promise; when done it auto-downloads the JSON.
 * Tunables: window.__exportChat({ stepFrac, settleMs, idleRounds }).
 * ==========================================================================*/
window.__exportChat = async function exportChat(opts = {}) {
  const {
    stepFrac   = 0.8,   // fraction of viewport to scroll each step
    settleMs   = 700,   // wait after each scroll for virtualized rows to render
    idleRounds = 4,     // consecutive no-new-items rounds (at bottom) => done
    maxSteps   = 5000,  // hard safety cap
  } = opts;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- 1. locate the scroll container (the virtualized list's scroller) ------
  function findScroller() {
    const thread = document.getElementById('thread');
    // prefer the known scroll-root, else walk up from #thread to a scrollable el
    let el = document.querySelector('.group\\/scroll-root')
          || (thread && thread.closest('[class*="overflow-y-auto"]'));
    if (!el && thread) {
      for (let n = thread.parentElement; n; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) { el = n; break; }
      }
    }
    return el || document.scrollingElement || document.documentElement;
  }
  const scroller = findScroller();
  if (!scroller) throw new Error('Could not find the scroll container.');
  console.log('[export] scroller =', scroller.className.slice(0, 60) || scroller.tagName);

  // --- 2. accumulator. keyed by data-message-id, ordered by absolute Y -------
  const byId = new Map();   // id -> record
  let seq = 0;              // first-seen tiebreaker

  function absY(el) {
    // stable y within the scroll content: viewport-rel top + how far we've scrolled
    const cTop = scroller.getBoundingClientRect().top;
    return el.getBoundingClientRect().top - cTop + scroller.scrollTop;
  }

  // collect uploaded-file references attached to a message element
  function collectFiles(msgEl) {
    const files = [];
    const seen = new Set();
    // attachment chips/buttons and image-open buttons both expose the name via aria-label
    msgEl.querySelectorAll('button[aria-label], [role="button"][aria-label]').forEach((b) => {
      let label = (b.getAttribute('aria-label') || '').trim();
      if (!label) return;
      // image viewers look like: "Open image 2 of 3: photo.png" OR "Open image: photo.png"
      const m = label.match(/^Open image(?:\s+\d+\s+of\s+\d+)?:\s*(.+)$/i);
      if (m) label = m[1].trim();
      // keep only things that look like filenames (have an extension)
      if (!/\.[a-z0-9]{1,8}$/i.test(label)) return;
      if (seen.has(label)) return;
      seen.add(label);
      const ext = label.split('.').pop().toLowerCase();
      const kind = /^(png|jpg|jpeg|gif|webp|svg|heic)$/.test(ext) ? 'image'
                 : /^(pdf|docx?|txt|md|csv|xlsx?|pptx?)$/.test(ext) ? 'document'
                 : 'file';
      files.push({ name: label, ext, kind });
    });
    // also capture any <img> that carries a real src (for reference/manual save)
    msgEl.querySelectorAll('img[src]').forEach((img) => {
      const src = img.currentSrc || img.src;
      if (src && !src.startsWith('data:') && files.length) {
        const last = files[files.length - 1];
        if (last && !last.src) last.src = src;
      }
    });
    return files;
  }

  function capture() {
    let added = 0;
    document.querySelectorAll('[data-message-author-role][data-message-id]').forEach((el) => {
      const id = el.getAttribute('data-message-id');
      const role = el.getAttribute('data-message-role') || el.getAttribute('data-message-author-role');

      // Pick the real content node so we never grab the "Show more"/"Show less"
      // toggle label, and read FULL text even when the bubble is collapsed.
      let body;
      if (role === 'user') {
        body = el.querySelector('[data-testid="collapsible-user-message-content"]')
            || el.querySelector('.whitespace-pre-wrap')
            || el;
      } else {
        body = el.querySelector('.markdown') || el;
      }
      // textContent ignores CSS clipping (collapsed bubbles); innerText does not
      // and would also pick up the "Show more" label. For user bubbles the node is
      // whitespace-pre-wrap so newlines survive. For assistant markdown, innerText
      // renders block spacing better, so prefer it unless it's shorter (= clipped).
      const tc = (body.textContent || '').trim();
      const it = (body.innerText || '').trim();
      const text = (role === 'user' || tc.length > it.length) ? tc : it;

      const rec = byId.get(id);
      const data = {
        id,
        role,                                   // 'user' | 'assistant'
        model: el.getAttribute('data-message-model-slug') || null,
        text,
        html: body.innerHTML,
        files: collectFiles(el),
        y: absY(el),
      };
      if (!rec) {
        data.seq = seq++;
        byId.set(id, data);
        added++;
      } else {
        // refresh: keep richest text/files, update y (layout may have settled)
        if (data.text.length > rec.text.length) { rec.text = data.text; rec.html = data.html; }
        if (data.files.length > rec.files.length) rec.files = data.files;
        rec.y = data.y;
      }
    });
    return added;
  }

  // --- 3. jump to top, then walk down ----------------------------------------
  scroller.scrollTop = 0;
  await sleep(settleMs);
  capture();

  let idle = 0, steps = 0;
  while (steps++ < maxSteps) {
    const prevTop = scroller.scrollTop;
    scroller.scrollTop = Math.min(
      scroller.scrollTop + scroller.clientHeight * stepFrac,
      scroller.scrollHeight,
    );
    await sleep(settleMs);
    const added = capture();

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const stuck = scroller.scrollTop <= prevTop + 1;   // didn't actually move

    if (added > 0) {
      idle = 0;
    } else if (atBottom || stuck) {
      idle++;
      if (idle >= idleRounds) break;          // multiple settles, no new items, at bottom
      await sleep(settleMs);                   // extra wait before giving up
    } else {
      idle = 0;                                // mid-list with nothing new: keep going
    }
    if (steps % 10 === 0) console.log(`[export] step ${steps}, captured ${byId.size}, idle ${idle}`);
  }

  // --- 4. order, number, summarize -------------------------------------------
  const messages = [...byId.values()]
    .sort((a, b) => (a.y - b.y) || (a.seq - b.seq))
    .map(({ y, seq, ...m }, i) => ({ index: i, ...m }));

  const fileManifest = [];
  messages.forEach((m) => m.files.forEach((f) =>
    fileManifest.push({ messageIndex: m.index, messageId: m.id, owner: m.role, ...f })));

  const out = {
    exportedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    counts: {
      messages: messages.length,
      user: messages.filter((m) => m.role === 'user').length,
      assistant: messages.filter((m) => m.role === 'assistant').length,
      files: fileManifest.length,
    },
    messages,
    files: fileManifest,
  };

  // --- 5. download -----------------------------------------------------------
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chatgpt-export-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();

  console.log('[export] DONE', out.counts);
  console.table(fileManifest);
  window.__lastExport = out;        // also left on window for manual inspection
  return out;
};

// auto-run
window.__exportChat();
