/* ============================================================================
 * Facebook Messenger conversation exporter - browser console script.
 *
 * Paste this into DevTools Console with a specific Messenger thread open, then:
 *
 *   await window.__exportMessenger({
 *     start: "2026-06-01",
 *     end: "2026-06-23"
 *   });
 *
 * It uses only the current logged-in browser tab. It does not copy cookies or
 * tokens anywhere. The exporter scrolls upward through the open conversation,
 * reads Messenger's message accessibility metadata, filters by date range, and
 * downloads JSON shaped like the other exporters in this repo.
 *
 * Messenger's current useful DOM markers:
 *   - Conversation log: [role="log"][aria-label*="Messages in conversation"]
 *   - Message:          [data-message-id][aria-roledescription="message"]
 *   - Timestamp/sender: message aria-label, e.g.
 *       At June 11, 2026, 8:59 AM, You: phone booth
 * ==========================================================================*/

window.__exportMessenger = async function exportMessenger(opts = {}) {
  if (window.__messengerExportInProgress) {
    throw new Error("A Messenger export is already running in this tab.");
  }

  window.__messengerExportInProgress = true;

  try {
    const options = normalizeOptions(opts);
    const range = normalizeDateRange(options);
    const log = findMessageLog(options);
    const scroller = findScroller(log, options);
    const originalTop = scroller.scrollTop;
    const originalBehavior = scroller.style.scrollBehavior;
    const records = new Map();
    const scannedIds = new Set();
    const warnings = [];
    let sawUndated = false;
    let pass = 0;
    let pastStartRounds = 0;
    let idleRounds = 0;

    scroller.style.scrollBehavior = "auto";

    console.log("[messenger-export] log =", describeElement(log));
    console.log("[messenger-export] scroller =", describeElement(scroller));
    if (range.hasRange) {
      console.log("[messenger-export] date range =", {
        start: range.startIso,
        end: range.endIso,
        includeUndated: options.includeUndated
      });
    }

    try {
      if (options.startFromBottom) {
        await scrollToBottom(scroller, options.settleMs);
      }

      while (pass < options.maxScrolls) {
        const batch = captureVisibleMessages(log, scroller, pass, options);
        for (const record of batch.records) {
          scannedIds.add(record.id);
          if (!record.create_time) sawUndated = true;
        }

        const retained = batch.records.filter((record) => shouldRetain(record, range, options));
        const added = mergeRecords(records, retained);

        if (pass % options.logEvery === 0 || added > 0) {
          console.log(
            `[messenger-export] pass ${pass}, kept ${records.size}, scanned ${scannedIds.size}, added ${added}, scrollTop ${Math.round(scroller.scrollTop)}`
          );
        }

        if (shouldStopForDateRange(batch.records, range)) {
          pastStartRounds++;
          if (pastStartRounds >= options.stopAfterPastStartRounds) {
            console.log("[messenger-export] stopping after passing start of range.");
            break;
          }
        } else {
          pastStartRounds = 0;
        }

        const previousTop = scroller.scrollTop;
        const previousHeight = scroller.scrollHeight;
        clickLoadOlder(log);
        scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * options.stepFrac);

        await sleep(options.settleMs);

        const atTop = scroller.scrollTop <= 2;
        const moved = Math.abs(previousTop - scroller.scrollTop) > 1;
        const heightChanged = Math.abs(previousHeight - scroller.scrollHeight) > 1;

        if (added === 0 && atTop && !moved && !heightChanged) {
          idleRounds++;
          if (idleRounds >= options.idleRounds) break;
        } else {
          idleRounds = 0;
        }

        pass++;
      }
    } finally {
      if (options.restoreScroll) scroller.scrollTop = originalTop;
      scroller.style.scrollBehavior = originalBehavior;
    }

    if (!records.size) {
      warnings.push("No messages were retained. Check the date range, or run with includeRaw: true and startFromBottom: false near visible messages.");
    }

    if (sawUndated && range.hasRange) {
      warnings.push("Some visible messages did not expose a parseable timestamp. They were handled according to includeUndated.");
    }

    const messages = sortRecords([...records.values()])
      .map((message, index) => normalizeMessageForOutput(message, index, options));

    const files = [];
    for (const message of messages) {
      for (const file of message.files) files.push(file);
    }

    const out = {
      exportedAt: new Date().toISOString(),
      source: "messenger-dom",
      url: location.href,
      conversationId: getConversationId(),
      title: getConversationTitle(log),
      dateRange: {
        start: range.startIso,
        end: range.endIso,
        includeUndated: options.includeUndated,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null
      },
      counts: {
        messages: messages.length,
        user: messages.filter((message) => message.role === "user").length,
        participant: messages.filter((message) => message.role === "participant").length,
        unknown: messages.filter((message) => message.role === "unknown").length,
        files: files.length,
        scanned: scannedIds.size
      },
      warnings,
      messages,
      files
    };

    const downloadName = `messenger-export-${Date.now()}.json`;
    if (options.download) downloadJson(out, downloadName);

    out.downloadName = options.download ? downloadName : null;
    window.__lastMessengerExport = out;
    console.log("[messenger-export] DONE", out.counts);
    if (warnings.length) console.warn("[messenger-export] warnings", warnings);
    if (files.length) console.table(files);

    return out;
  } finally {
    window.__messengerExportInProgress = false;
  }
};

function normalizeOptions(opts) {
  const hasRange = Boolean(opts.start || opts.end);

  return {
    start: opts.start || null,
    end: opts.end || null,
    containerSelector: opts.containerSelector || null,
    scrollerSelector: opts.scrollerSelector || null,
    messageSelector: opts.messageSelector || '[data-message-id][aria-roledescription="message"]',
    stepFrac: Number.isFinite(opts.stepFrac) ? opts.stepFrac : 0.85,
    settleMs: Number.isFinite(opts.settleMs) ? opts.settleMs : 900,
    idleRounds: Number.isFinite(opts.idleRounds) ? opts.idleRounds : 5,
    maxScrolls: Number.isFinite(opts.maxScrolls) ? opts.maxScrolls : 5000,
    stopAfterPastStartRounds: Number.isFinite(opts.stopAfterPastStartRounds) ? opts.stopAfterPastStartRounds : 3,
    logEvery: Number.isFinite(opts.logEvery) ? opts.logEvery : 10,
    startFromBottom: opts.startFromBottom !== false,
    restoreScroll: opts.restoreScroll === true,
    includeUndated: opts.includeUndated === true || (!hasRange && opts.includeUndated !== false),
    includeHtml: opts.includeHtml === true,
    includeRaw: opts.includeRaw === true,
    includeDataUrls: opts.includeDataUrls === true,
    download: opts.download !== false
  };
}

function normalizeDateRange(options) {
  const start = options.start ? parseBoundaryDate(options.start, "start") : null;
  const end = options.end ? parseBoundaryDate(options.end, "end") : null;

  if (start && end && start.getTime() > end.getTime()) {
    throw new Error("Date range start is after end.");
  }

  return {
    hasRange: Boolean(start || end),
    startMs: start ? start.getTime() : null,
    endMs: end ? end.getTime() : null,
    startIso: start ? start.toISOString() : null,
    endIso: end ? end.toISOString() : null
  };
}

function parseBoundaryDate(value, side) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`Invalid ${side} date.`);
    return value;
  }

  const text = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = dateOnly ? parseLocalDateOnly(text) : new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${side} date: ${text}`);
  }

  if (dateOnly && side === "end") date.setHours(23, 59, 59, 999);
  return date;
}

function parseLocalDateOnly(text) {
  const [year, month, day] = text.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day);
}

function findMessageLog(options) {
  if (options.containerSelector) {
    const selected = document.querySelector(options.containerSelector);
    if (!selected) throw new Error(`containerSelector did not match: ${options.containerSelector}`);
    return selected.matches('[role="log"]') ? selected : selected.querySelector('[role="log"]') || selected;
  }

  const logs = Array.from(document.querySelectorAll('[role="log"]'));
  const byLabel = logs.find((element) =>
    /messages in conversation/i.test(element.getAttribute("aria-label") || "")
    && element.querySelector('[data-message-id][aria-roledescription="message"]')
  );
  if (byLabel) return byLabel;

  const withMessages = logs.find((element) => element.querySelector('[data-message-id][aria-roledescription="message"]'));
  if (withMessages) return withMessages;

  const firstMessage = document.querySelector('[data-message-id][aria-roledescription="message"]');
  const closestLog = firstMessage && firstMessage.closest('[role="log"]');
  if (closestLog) return closestLog;
  if (firstMessage) return firstMessage.parentElement || document.body;

  throw new Error('Could not find Messenger messages. Expected [data-message-id][aria-roledescription="message"].');
}

function findScroller(log, options) {
  if (options.scrollerSelector) {
    const selected = document.querySelector(options.scrollerSelector);
    if (!selected) throw new Error(`scrollerSelector did not match: ${options.scrollerSelector}`);
    return selected;
  }

  const candidates = [];
  addCandidate(candidates, log);

  for (let node = log.parentElement; node && node !== document.body; node = node.parentElement) {
    addCandidate(candidates, node);
  }

  for (const node of log.querySelectorAll("div, main, section")) {
    addCandidate(candidates, node);
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates.length ? candidates[0].element : document.scrollingElement || document.documentElement;
}

function addCandidate(candidates, element) {
  if (!element || element.nodeType !== 1) return;

  const rect = element.getBoundingClientRect();
  if (rect.height < 220 || rect.width < 260) return;
  if (element.scrollHeight <= element.clientHeight + 80) return;

  const style = getComputedStyle(element);
  const overflowY = style.overflowY || "";
  const messages = element.querySelectorAll('[data-message-id][aria-roledescription="message"]').length;
  let score = 0;

  if (/auto|scroll|overlay/i.test(overflowY)) score += 100;
  if (/messages/i.test(element.getAttribute("aria-label") || "")) score += 20;
  if (element.getAttribute("role") === "log") score += 20;
  score += Math.min(40, messages * 3);
  score += Math.min(25, element.clientHeight / 30);
  score += Math.min(20, element.scrollHeight / Math.max(1, element.clientHeight));

  candidates.push({ element, score });
}

async function scrollToBottom(scroller, settleMs) {
  let previousTop = -1;

  for (let i = 0; i < 12; i++) {
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(settleMs);
    if (Math.abs(scroller.scrollTop - previousTop) <= 2) break;
    previousTop = scroller.scrollTop;
  }
}

function captureVisibleMessages(log, scroller, pass, options) {
  const elements = Array.from(log.querySelectorAll(options.messageSelector))
    .filter(isVisibleElement)
    .filter((element) => element.getAttribute("data-message-id"));

  const records = [];

  for (let index = 0; index < elements.length; index++) {
    const record = normalizeMessageElement(elements[index], scroller, pass, index, options);
    if (record) records.push(record);
  }

  return { records };
}

function normalizeMessageElement(element, scroller, pass, index, options) {
  const id = element.getAttribute("data-message-id");
  const label = normalizeSpaces(element.getAttribute("aria-label") || findFallbackMessageLabel(element));
  const parsed = parseMessengerLabel(label);
  const files = collectFiles(element, id, parsed.sender, options);
  const text = extractMessageText(element, parsed);

  if (!text && !files.length && !parsed.sender) return null;

  const role = parsed.sender === "You"
    ? "user"
    : parsed.sender
      ? "participant"
      : "unknown";

  const message = {
    id,
    role,
    sender: parsed.sender || null,
    model: null,
    create_time: parsed.date ? parsed.date.toISOString() : null,
    timestampText: parsed.timestampText || null,
    timestampConfidence: parsed.date ? parsed.timestampConfidence : "none",
    type: inferMessageType(text, files),
    text,
    files,
    y: getAbsoluteY(element, scroller),
    pass,
    visibleIndex: index,
    orderKey: getMessageOrderKey(id)
  };

  if (options.includeHtml) message.html = element.innerHTML;
  if (options.includeRaw) {
    message.rawAriaLabel = label;
    message.rawText = normalizeNewlines(element.innerText || element.textContent || "");
  }

  return message;
}

function findFallbackMessageLabel(element) {
  const node = element.querySelector('[aria-label^="Enter, Message sent" i]');
  return node ? node.getAttribute("aria-label") || "" : "";
}

function parseMessengerLabel(label) {
  const clean = normalizeSpaces(label);
  if (!clean) return emptyParsedLabel();

  if (/^At\s+/i.test(clean)) {
    return parseAtLabel(clean.replace(/^At\s+/i, ""));
  }

  if (/^Enter,\s*Message sent\s+/i.test(clean)) {
    return parseSentLabel(clean.replace(/^Enter,\s*Message sent\s+/i, ""));
  }

  return emptyParsedLabel();
}

function parseAtLabel(text) {
  const timestamp = takeTimestampPrefix(text);
  if (!timestamp) return emptyParsedLabel();

  const rest = timestamp.rest.replace(/^,\s*/, "");
  const senderAndBody = splitSenderAndBody(rest);

  return {
    sender: senderAndBody.sender,
    body: senderAndBody.body,
    timestampText: timestamp.text,
    timestampConfidence: timestamp.confidence,
    date: parseTimestamp(timestamp.text)
  };
}

function parseSentLabel(text) {
  const timestamp = takeTimestampPrefix(text);
  if (!timestamp) return emptyParsedLabel();

  const rest = timestamp.rest.replace(/^by\s+/i, "");
  const senderAndBody = splitSenderAndBody(rest);

  return {
    sender: senderAndBody.sender,
    body: senderAndBody.body,
    timestampText: timestamp.text,
    timestampConfidence: timestamp.confidence,
    date: parseTimestamp(timestamp.text)
  };
}

function takeTimestampPrefix(text) {
  const clean = normalizeSpaces(text);
  const patterns = [
    {
      confidence: "exact",
      regex: /^((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}\s*(?:AM|PM))\b\s*/i
    },
    {
      confidence: "relative",
      regex: /^((?:Today|Yesterday)(?:\s+at)?\s+\d{1,2}:\d{2}\s*(?:AM|PM))\b\s*/i
    },
    {
      confidence: "weekday",
      regex: /^((?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:\s+at)?\s+\d{1,2}:\d{2}\s*(?:AM|PM))\b\s*/i
    }
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern.regex);
    if (!match) continue;
    return {
      text: match[1],
      confidence: pattern.confidence,
      rest: clean.slice(match[0].length).trim()
    };
  }

  return null;
}

function splitSenderAndBody(text) {
  const clean = normalizeSpaces(text).replace(/^,\s*/, "");
  if (!clean) return { sender: null, body: "" };

  const colon = clean.indexOf(": ");
  if (colon >= 0) {
    return {
      sender: clean.slice(0, colon).trim() || null,
      body: clean.slice(colon + 2).trim()
    };
  }

  return { sender: clean.trim() || null, body: "" };
}

function emptyParsedLabel() {
  return {
    sender: null,
    body: "",
    timestampText: null,
    timestampConfidence: "none",
    date: null
  };
}

function parseTimestamp(text) {
  const clean = normalizeSpaces(text).replace(/\bat\b/gi, "").replace(/\s+/g, " ").trim();
  const monthDate = clean.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (monthDate) {
    return buildLocalDate(
      Number(monthDate[3]),
      monthIndex(monthDate[1]),
      Number(monthDate[2]),
      Number(monthDate[4]),
      Number(monthDate[5]),
      monthDate[6]
    );
  }

  const relative = clean.match(/^(Today|Yesterday)\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (relative) {
    const now = new Date();
    const offset = /^yesterday$/i.test(relative[1]) ? -1 : 0;
    return buildLocalDate(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + offset,
      Number(relative[2]),
      Number(relative[3]),
      relative[4]
    );
  }

  const weekday = clean.match(/^(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (weekday) {
    const base = nearestPastWeekday(weekdayIndex(weekday[1]), new Date());
    return buildLocalDate(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      Number(weekday[2]),
      Number(weekday[3]),
      weekday[4]
    );
  }

  const date = new Date(clean);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildLocalDate(year, month, day, hour, minute, ampm) {
  let hours = hour;
  const marker = String(ampm || "").toLowerCase();

  if (marker === "pm" && hours < 12) hours += 12;
  if (marker === "am" && hours === 12) hours = 0;

  const date = new Date(year, month, day, hours, minute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthIndex(value) {
  const month = String(value || "").slice(0, 3).toLowerCase();
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(month);
}

function weekdayIndex(value) {
  const day = String(value || "").slice(0, 3).toLowerCase();
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(day);
}

function nearestPastWeekday(targetDay, referenceDate) {
  const base = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  let diff = base.getDay() - targetDay;
  if (diff < 0) diff += 7;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() - diff);
}

function extractMessageText(element, parsed) {
  if (parsed.body) return parsed.body;

  const clone = element.cloneNode(true);
  clone.querySelectorAll([
    "script",
    "style",
    "svg",
    "input",
    "textarea",
    '[contenteditable="true"]',
    '[role="toolbar"]',
    '[aria-label="Message actions"]',
    '[aria-label^="Enter, Message sent" i]',
    '[aria-label^="Seen by" i]',
    '[aria-label="Forward" i]',
    '[aria-label^="React" i]',
    '[aria-label="More actions" i]',
    '[aria-label="Call back" i]',
    '[aria-label="Call again" i]',
    '[aria-label^="Open messenger profile" i]'
  ].join(",")).forEach((node) => node.remove());

  const lines = normalizeNewlines(clone.innerText || clone.textContent || "")
    .split("\n")
    .map((line) => normalizeSpaces(line))
    .filter(Boolean)
    .filter((line) => !isUiLine(line))
    .filter((line) => !isTimestampOnly(line));

  return dedupeConsecutive(lines).join("\n").trim();
}

function isUiLine(line) {
  return /^(Forward|React with an emoji|More actions|Call back|Call again|Reply|Copy|Remove|Delete|Unsend|Edit|Pin|Open photo|Open GIF|Tap to play GIF)$/i.test(line)
    || /^Enter,\s*Message sent\b/i.test(line)
    || /^Seen by\b/i.test(line);
}

function isTimestampOnly(line) {
  return /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(line)
    || /^(?:Today|Yesterday)\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(line)
    || /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(line);
}

function dedupeConsecutive(lines) {
  const out = [];

  for (const line of lines) {
    if (out[out.length - 1] !== line) out.push(line);
  }

  return out;
}

function collectFiles(element, messageId, sender, options) {
  const files = [];

  for (const node of element.querySelectorAll("img[src], video[src], video[poster], audio[src], a[href]")) {
    const file = normalizeFileNode(node, messageId, sender, options);
    if (file) files.push(file);
  }

  return dedupeFiles(files);
}

function normalizeFileNode(node, messageId, sender, options) {
  if (node.tagName === "A") {
    const href = node.href;
    const label = normalizeSpaces(node.innerText || node.getAttribute("aria-label") || node.getAttribute("title") || "");
    if (!href || href.startsWith("javascript:")) return null;
    if (/facebook\.com\/profile|messenger\.com\/t\//i.test(href) && !label) return null;

    return {
      id: hashString(href),
      name: label || filenameFromUrl(href) || "link",
      url: href,
      mime: "",
      size: null,
      kind: inferFileKind(label || href, ""),
      source: "link"
    };
  }

  const src = node.currentSrc || node.src || node.poster;
  if (!src) return null;

  if (node.tagName === "IMG" && shouldSkipImage(node, src, sender)) {
    return null;
  }

  const isData = src.startsWith("data:");
  const isBlob = src.startsWith("blob:");
  const mime = isData ? (src.match(/^data:([^;,]+)/) || [])[1] || "" : "";
  const kind = node.tagName === "VIDEO"
    ? "video"
    : node.tagName === "AUDIO"
      ? "audio"
      : inferImageKind(node, src, mime);
  const extension = extensionForKind(kind, mime);
  const name = filenameFromUrl(src)
    || `${kind}-${sanitizeForFilename(messageId)}-${hashString(src)}${extension ? `.${extension}` : ""}`;

  const file = {
    id: hashString(src),
    name,
    url: isData && !options.includeDataUrls ? null : src,
    mime,
    size: isData ? Math.round(src.length * 0.75) : null,
    kind,
    source: node.tagName.toLowerCase()
  };

  if (isData && !options.includeDataUrls) file.dataUrlOmitted = true;
  if (isBlob) file.temporaryUrl = true;

  return file;
}

function shouldSkipImage(node, src, sender) {
  const alt = normalizeSpaces(node.alt || node.getAttribute("aria-label") || "");
  const rect = node.getBoundingClientRect();

  if (/\/emoji\.php\//i.test(src)) return true;
  if (node.closest('[aria-label^="Seen by" i]')) return true;
  if (/^Seen by\b/i.test(alt)) return true;
  if (sender && alt === sender && rect.width <= 80 && rect.height <= 80) return true;
  if (/profile picture|avatar/i.test(alt) && rect.width <= 100 && rect.height <= 100) return true;
  if (/s100x100/.test(src) && rect.width <= 80 && rect.height <= 80) return true;

  return false;
}

function inferImageKind(node, src, mime) {
  const label = normalizeSpaces(
    node.alt
    || node.getAttribute("aria-label")
    || (node.closest("[aria-label]") && node.closest("[aria-label]").getAttribute("aria-label"))
    || ""
  );

  if (/gif/i.test(label)) return "gif";
  if (/^image\/gif/i.test(mime) || /\.gif(?:$|\?)/i.test(src)) return "gif";
  return "image";
}

function inferFileKind(name, mime) {
  const text = String(name || "").toLowerCase();
  const type = String(mime || "").toLowerCase();

  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|heic|avif)(?:$|\?)/i.test(text)) return "image";
  if (type.startsWith("video/") || /\.(mp4|mov|webm|m4v)(?:$|\?)/i.test(text)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|m4a|wav|ogg)(?:$|\?)/i.test(text)) return "audio";
  if (/\.(pdf|docx?|txt|md|csv|xlsx?|pptx?|json|rtf)(?:$|\?)/i.test(text)) return "document";
  return "link";
}

function extensionForKind(kind, mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif" || kind === "gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (kind === "video") return "mp4";
  if (kind === "audio") return "mp3";
  return "";
}

function filenameFromUrl(url) {
  if (url.startsWith("data:") || url.startsWith("blob:")) return "";

  try {
    const parsed = new URL(url, location.href);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last).slice(0, 160) : "";
  } catch (error) {
    return "";
  }
}

function dedupeFiles(files) {
  const seen = new Set();
  const out = [];

  for (const file of files) {
    const key = `${file.kind}:${file.url || file.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }

  return out;
}

function inferMessageType(text, files) {
  if (/deleted a message/i.test(text)) return "deleted";
  if (/\b(audio call|video call|missed audio call|missed video call|call ended)\b/i.test(text)) return "call";
  if (!text && files.length) return "media";
  return "message";
}

function shouldRetain(record, range, options) {
  if (!range.hasRange) return true;
  if (!record.create_time) return options.includeUndated;

  const time = Date.parse(record.create_time);
  if (!Number.isFinite(time)) return options.includeUndated;
  if (range.startMs !== null && time < range.startMs) return false;
  if (range.endMs !== null && time > range.endMs) return false;

  return true;
}

function shouldStopForDateRange(records, range) {
  if (!range.hasRange || range.startMs === null) return false;

  const times = records
    .map((record) => record.create_time ? Date.parse(record.create_time) : null)
    .filter((time) => Number.isFinite(time));

  return times.length > 0 && Math.max(...times) < range.startMs;
}

function mergeRecords(records, batchRecords) {
  let added = 0;

  for (const record of batchRecords) {
    const existing = records.get(record.id);
    if (!existing) {
      records.set(record.id, record);
      added++;
      continue;
    }

    if ((record.text || "").length > (existing.text || "").length) existing.text = record.text;
    if (record.files.length > existing.files.length) existing.files = record.files;
    if (!existing.create_time && record.create_time) {
      existing.create_time = record.create_time;
      existing.timestampText = record.timestampText;
      existing.timestampConfidence = record.timestampConfidence;
    }
    existing.y = Math.min(existing.y, record.y);
    existing.pass = Math.min(existing.pass, record.pass);
  }

  return added;
}

function sortRecords(records) {
  return records.sort((left, right) => {
    const leftTime = left.create_time ? Date.parse(left.create_time) : null;
    const rightTime = right.create_time ? Date.parse(right.create_time) : null;

    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    const order = compareOrderKeys(left.orderKey, right.orderKey);
    if (order !== 0) return order;

    if (left.pass !== right.pass) return right.pass - left.pass;
    return left.y - right.y || left.visibleIndex - right.visibleIndex;
  });
}

function getMessageOrderKey(id) {
  const match = String(id || "").match(/@msgr\.(\d+)/);
  return match ? match[1] : "";
}

function compareOrderKeys(left, right) {
  if (!left || !right || left === right) return 0;
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : 1;
}

function normalizeMessageForOutput(message, index, options) {
  const files = message.files.map((file) => ({
    messageIndex: index,
    messageId: message.id,
    owner: message.role,
    ...file
  }));

  const out = {
    index,
    id: message.id,
    role: message.role,
    sender: message.sender,
    model: null,
    create_time: message.create_time,
    timestampText: message.timestampText,
    timestampConfidence: message.timestampConfidence,
    type: message.type,
    text: message.text,
    files
  };

  if (options.includeHtml && message.html) out.html = message.html;
  if (options.includeRaw) {
    out.rawAriaLabel = message.rawAriaLabel || null;
    out.rawText = message.rawText || null;
  }

  return out;
}

function clickLoadOlder(root) {
  const button = Array.from(root.querySelectorAll('button, [role="button"]'))
    .find((element) => {
      const label = normalizeSpaces(element.innerText || element.getAttribute("aria-label") || "");
      return isVisibleElement(element) && /see older|load older|show older|view older/i.test(label);
    });

  if (!button) return false;
  button.click();
  return true;
}

function getConversationId() {
  const parts = location.pathname.split("/").filter(Boolean);
  const threadIndex = parts.findIndex((part) => part === "t" || part === "messages");

  if (threadIndex >= 0 && parts[threadIndex + 1]) {
    return decodeURIComponent(parts[threadIndex + 1]);
  }

  return parts.length ? decodeURIComponent(parts[parts.length - 1]) : null;
}

function getConversationTitle(log) {
  const label = log.getAttribute("aria-label") || "";
  const match = label.match(/Messages in conversation with\s+(.+)$/i);
  if (match) return match[1].trim();

  const heading = document.querySelector('h1, h2, [role="heading"][aria-level="1"], [role="heading"][aria-level="2"]');
  const text = heading && normalizeSpaces(heading.innerText || heading.textContent || "");
  return text && !/^messages$/i.test(text) ? text : document.title || "Messenger conversation";
}

function downloadJson(data, downloadName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height) return false;

  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
}

function getAbsoluteY(element, scroller) {
  const top = scroller.getBoundingClientRect().top;
  return element.getBoundingClientRect().top - top + scroller.scrollTop;
}

function describeElement(element) {
  const role = element.getAttribute("role");
  const label = element.getAttribute("aria-label");
  const id = element.id ? `#${element.id}` : "";
  const cls = typeof element.className === "string" && element.className
    ? `.${element.className.split(/\s+/).slice(0, 3).join(".")}`
    : "";

  return `${element.tagName.toLowerCase()}${id}${cls}${role ? `[role=${role}]` : ""}${label ? `[aria-label="${label.slice(0, 80)}"]` : ""}`;
}

function normalizeNewlines(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSpaces(value) {
  return String(value || "")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeForFilename(value) {
  return String(value || "").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80);
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('[messenger-export] Loaded. Run await window.__exportMessenger({ start: "YYYY-MM-DD", end: "YYYY-MM-DD" });');
