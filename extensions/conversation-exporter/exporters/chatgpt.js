var CHATGPT_EXPORT_MODE_CURRENT = "current-branch";
var CHATGPT_EXPORT_MODE_ALL = "all-branches";
var CHATGPT_EXPORT_MODE_BACKEND_CURRENT = "backend-current";
var CHATGPT_EXPORT_MODE_DOWNLOAD_FILES = "download-files-all";
var CHATGPT_BRANCH_STRUCTURE = "segment-tree";
var CHATGPT_FILE_DOWNLOAD_CONCURRENCY = 5;

(async () => {
  if (window.__chatGptBackendExportInProgress) {
    return {
      ok: false,
      error: "An export is already running in this tab."
    };
  }

  const exportMode = normalizeChatGptExportMode(window.__chatGptExportMode);
  window.__chatGptBackendExportInProgress = true;

  try {
    const out = await exportChatBackend(exportMode);
    return {
      ok: true,
      source: out.source,
      exportMode: out.exportMode || exportMode,
      counts: out.totalCounts || out.counts,
      conversationId: out.conversationId,
      downloadName: out.downloadName,
      failures: out.failures
    };
  } catch (error) {
    console.error("[backend-export] FAILED", error);
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    delete window.__chatGptExportMode;
    window.__chatGptBackendExportInProgress = false;
  }
})();

function normalizeChatGptExportMode(mode) {
  if (mode === CHATGPT_EXPORT_MODE_BACKEND_CURRENT) return CHATGPT_EXPORT_MODE_BACKEND_CURRENT;
  if (mode === CHATGPT_EXPORT_MODE_DOWNLOAD_FILES) return CHATGPT_EXPORT_MODE_DOWNLOAD_FILES;
  return mode === CHATGPT_EXPORT_MODE_ALL ? CHATGPT_EXPORT_MODE_ALL : CHATGPT_EXPORT_MODE_CURRENT;
}

async function exportChatBackend(exportMode) {
  const convId = getConversationId();
  if (!convId) {
    throw new Error("No conversation id in the URL.");
  }

  if (exportMode === CHATGPT_EXPORT_MODE_DOWNLOAD_FILES) {
    return downloadChatGptConversationFiles(convId);
  }

  const conv = await fetchChatGptConversation(convId);
  const out = exportMode === CHATGPT_EXPORT_MODE_ALL
    ? buildChatGptAllBranchesExport(conv, convId)
    : await buildChatGptCurrentBranchExport(conv, convId);
  const downloadName = exportMode === CHATGPT_EXPORT_MODE_ALL
    ? `chatgpt-all-branches-export-${Date.now()}.json`
    : `chatgpt-backend-export-${Date.now()}.json`;

  downloadJson(out, downloadName);

  out.downloadName = downloadName;
  window.__lastBackendExport = out;
  console.log("[backend-export] DONE", out.totalCounts || out.counts);
  console.table(out.files || []);

  return out;
}

async function fetchChatGptConversation(convId) {
  const origin = location.origin;
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const convResponse = await fetchChatGptWithRetry(`${origin}/backend-api/conversation/${convId}`, {
    headers,
    credentials: "include"
  }, { label: "Conversation" });

  if (!convResponse.ok) {
    throw new Error(`Conversation request failed with HTTP ${convResponse.status}.`);
  }

  const conv = await convResponse.json();
  if (!conv || !conv.mapping) {
    throw new Error(`Unexpected response with no mapping: ${JSON.stringify(conv).slice(0, 200)}`);
  }

  return conv;
}

async function downloadChatGptConversationFiles(conversationId) {
  const token = await getAccessToken();
  const listData = await fetchChatGptConversationFiles(conversationId, token);
  const files = collectChatGptConversationFiles(listData, conversationId);

  if (!files.length) {
    throw new Error("No downloadable ChatGPT files found in this conversation.");
  }

  const archiveName = makeChatGptFilesArchiveName(conversationId);
  const downloadResult = await downloadChatGptFilesToZip(files, archiveName, token);
  const failures = downloadResult.results.filter((result) => !result.ok);
  const successful = downloadResult.results.filter((result) => result.ok);
  const downloaded = successful.length;

  if (!downloaded && failures.length) {
    throw new Error(`Failed to download ${failures.length} ChatGPT files. First error: ${failures[0].error}`);
  }

  const out = {
    exportedAt: new Date().toISOString(),
    source: "chatgpt-api-files",
    exportMode: CHATGPT_EXPORT_MODE_DOWNLOAD_FILES,
    url: location.href,
    conversationId,
    title: document.title || "ChatGPT conversation",
    counts: {
      files: files.length,
      downloaded,
      failed: failures.length
    },
    downloadName: downloadResult.downloadName,
    files,
    failures
  };

  window.__lastChatGptFileDownload = out;
  console.log("[backend-export] FILE DOWNLOAD DONE", out.counts);
  return out;
}

async function fetchChatGptConversationFiles(conversationId, token) {
  const response = await fetchChatGptWithRetry(
    `${location.origin}/backend-api/conversations/${encodeURIComponent(conversationId)}/files?limit=200`,
    {
      credentials: "include",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    },
    { label: "Files list" }
  );

  const data = await response.json();
  if (!data || !Array.isArray(data.items)) {
    throw new Error("Unexpected ChatGPT files response with no items array.");
  }

  return data;
}

function collectChatGptConversationFiles(listData, conversationId) {
  const files = [];
  const seen = new Set();

  for (const item of Array.isArray(listData && listData.items) ? listData.items : []) {
    const file = normalizeChatGptConversationFile(item, conversationId);
    if (!file) continue;

    const key = getChatGptConversationFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }

  applyUniqueDownloadNames(files);
  return files;
}

function normalizeChatGptConversationFile(item, conversationId) {
  if (!item || typeof item !== "object") return null;
  const fileId = item.file_id || item.id || "";
  if (!fileId) return null;

  const name = sanitizeDownloadName(
    item.file_name || item.name || item.filename || `${fileId}.${item.file_extension || "bin"}`
  );

  return {
    id: fileId,
    libraryFileId: item.id || null,
    fileId: item.file_id || null,
    name,
    downloadNameBase: name,
    downloadName: name,
    mime: item.mime_type || "",
    size: Number.isFinite(item.file_size_bytes) ? item.file_size_bytes : null,
    extension: item.file_extension || "",
    state: item.state || null,
    source: "conversation-files",
    originationMessageId: item.origination_message_id || null,
    originationThreadId: item.origination_thread_id || null,
    url: `${location.origin}/backend-api/files/download/${encodeURIComponent(fileId)}`
      + `?inline=true&download_intent=false&check_context_scopes_for_conversation_id=${encodeURIComponent(conversationId)}`
  };
}

function getChatGptConversationFileKey(file) {
  if (file.fileId) return `file-id:${file.fileId}`;
  if (file.libraryFileId) return `library-id:${file.libraryFileId}`;
  return `meta:${file.name || ""}:${file.size || ""}:${file.mime || ""}`;
}

async function downloadChatGptFilesToZip(files, archiveName, token) {
  const zip = createZipAccumulator();
  const results = [];
  const rateLimitGate = createChatGptRateLimitGate();
  let nextIndex = 0;

  const workerCount = Math.min(CHATGPT_FILE_DOWNLOAD_CONCURRENCY, files.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < files.length) {
      const file = files[nextIndex++];
      try {
        const entry = await fetchChatGptDownloadEntry(file, token, rateLimitGate);
        await zip.addEntry({
          name: entry.name,
          parts: entry.parts,
          size: entry.size,
          crc: entry.crc,
          lastModified: new Date()
        });
        results.push({ file, ok: true, entry, downloadName: entry.name });
        await sleep(150);
      } catch (error) {
        console.warn("[backend-export] File download failed", file, error);
        results.push({
          file,
          ok: false,
          error: error && error.message ? error.message : String(error),
          status: error && error.status ? error.status : null,
          rateLimited: Boolean(error && error.rateLimited)
        });
      }
    }
  });

  await Promise.all(workers);

  if (zip.count > 0) {
    downloadBlob(zip.toBlob(), archiveName);
  }

  return {
    results,
    downloadName: zip.count > 0 ? archiveName : ""
  };
}

async function fetchChatGptDownloadEntry(file, token, rateLimitGate) {
  const response = await fetchChatGptWithRetry(file.url, {
    credentials: "include",
    headers: {
      Authorization: `Bearer ${token}`
    }
  }, {
    label: `File ${file.downloadName || file.name || file.id}`,
    rateLimitGate
  });

  const headerName = getFilenameFromContentDisposition(
    response.headers && response.headers.get("content-disposition")
  );
  const name = sanitizeDownloadName(headerName || file.downloadName || file.name || `${file.id || "file"}.bin`);
  const entryParts = await readResponseZipEntryParts(response);

  return {
    name,
    ...entryParts
  };
}

async function readResponseZipEntryParts(response) {
  const parts = [];
  let size = 0;
  let crc = 0xffffffff;

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      if (!chunk.length) continue;
      parts.push(chunk);
      size += chunk.length;
      crc = crc32Update(crc, chunk);
    }
  } else {
    const blob = await response.blob();
    const chunk = new Uint8Array(await blob.arrayBuffer());
    parts.push(chunk);
    size = chunk.length;
    crc = crc32Update(crc, chunk);
  }

  return {
    parts,
    size,
    crc: crc32Finalize(crc)
  };
}

async function fetchChatGptWithRetry(url, init, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 10;
  const label = options.label || "Request";
  const rateLimitGate = options.rateLimitGate || null;
  let lastResponse = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForChatGptRateLimitGate(rateLimitGate);
    const response = await fetch(url, init);
    if (response.ok) return response;

    lastResponse = response;
    if (response.status !== 429 || attempt >= retries) break;

    const delayMs = getChatGptRetryDelayMs(response, attempt);
    console.warn(`[backend-export] ${label} was rate limited; retrying in ${delayMs}ms.`);
    await pauseChatGptRateLimitGate(rateLimitGate, delayMs);
  }

  const error = new Error(`${label} request failed with HTTP ${lastResponse ? lastResponse.status : "unknown"}.`);
  if (lastResponse) {
    error.status = lastResponse.status;
    error.rateLimited = lastResponse.status === 429;
    if (error.rateLimited) {
      const retryAfter = lastResponse.headers && lastResponse.headers.get("retry-after");
      error.message = `${label} request was rate limited by ChatGPT${retryAfter ? `; retry after ${retryAfter}` : ""}.`;
    }
  }
  throw error;
}

function createChatGptRateLimitGate() {
  return {
    waitUntil: 0,
    promise: null
  };
}

async function waitForChatGptRateLimitGate(gate) {
  if (!gate) return;
  while (gate.promise && Date.now() < gate.waitUntil) {
    await gate.promise;
  }
}

async function pauseChatGptRateLimitGate(gate, delayMs) {
  if (!gate) {
    await sleep(delayMs);
    return;
  }

  const waitUntil = Date.now() + delayMs;
  if (!gate.promise || waitUntil > gate.waitUntil) {
    gate.waitUntil = waitUntil;
    gate.promise = sleep(delayMs).then(() => {
      if (gate.waitUntil <= waitUntil) {
        gate.promise = null;
      }
    });
  }

  await gate.promise;
}

function getChatGptRetryDelayMs(response, attempt) {
  const retryAfter = response && response.headers ? response.headers.get("retry-after") : "";
  const numeric = Number(retryAfter);

  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(Math.max(numeric * 1000, 3000), 20000);
  }

  const parsedDate = Date.parse(retryAfter || "");
  if (Number.isFinite(parsedDate)) {
    return Math.min(Math.max(parsedDate - Date.now(), 3000), 20000);
  }

  return Math.min(Math.max(3000 * Math.pow(2, attempt), 3000), 20000);
}

function makeChatGptFilesArchiveName(conversationId) {
  const title = sanitizeDownloadName(document.title || "chatgpt-files")
    .replace(/\.[^.]+$/, "");
  const id = String(conversationId || "conversation").slice(0, 8);
  return sanitizeDownloadName(`${title || "chatgpt-files"}-${id}-files.zip`);
}

function applyUniqueDownloadNames(files) {
  const used = new Map();

  for (const file of files) {
    const name = sanitizeDownloadName(file.downloadNameBase || file.name || file.downloadName || "chatgpt-file");
    const key = name.toLowerCase();
    const count = used.get(key) || 0;
    used.set(key, count + 1);
    file.downloadName = count ? addFileNameSuffix(name, count + 1) : name;
  }
}

function addFileNameSuffix(name, suffix) {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex > 0) {
    return `${name.slice(0, dotIndex)} (${suffix})${name.slice(dotIndex)}`;
  }

  return `${name} (${suffix})`;
}

function sanitizeDownloadName(name) {
  const baseName = String(name || "chatgpt-file")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "chatgpt-file";

  return baseName
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "chatgpt-file")
    || "chatgpt-file";
}

function getFilenameFromContentDisposition(value) {
  const header = String(value || "");
  const encoded = header.match(/filename\*=([^']*)''([^;]+)/i);
  if (encoded && encoded[2]) {
    try {
      return decodeURIComponent(encoded[2].replace(/^"|"$/g, ""));
    } catch (error) {
      return encoded[2].replace(/^"|"$/g, "");
    }
  }

  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain && plain[1] ? plain[1].trim() : "";
}

function downloadBlob(blob, downloadName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  const revokeTimer = setTimeout(() => URL.revokeObjectURL(url), 30000);
  if (revokeTimer && typeof revokeTimer.unref === "function") revokeTimer.unref();
}

async function createZipBlob(entries) {
  const zip = createZipAccumulator();

  for (const entry of entries) {
    const parts = await normalizeZipEntryParts(entry);
    await zip.addEntry({
      ...entry,
      parts,
      size: Number.isFinite(entry.size) ? entry.size : parts.reduce((total, part) => total + part.length, 0),
      crc: Number.isFinite(entry.crc) ? entry.crc : crc32Parts(parts)
    });
  }

  return zip.toBlob();
}

function createZipAccumulator() {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let count = 0;

  return {
    get count() {
      return count;
    },

    async addEntry(entry) {
      const parts = await normalizeZipEntryParts(entry);
      const size = Number.isFinite(entry.size) ? entry.size : parts.reduce((total, part) => total + part.length, 0);
      const crc = Number.isFinite(entry.crc) ? entry.crc : crc32Parts(parts);
      appendZipEntry(entry, parts, size, crc);
    },

    toBlob() {
      return finalizeZipBlob();
    }
  };

  function appendZipEntry(entry, parts, size, crc) {
    const nameBytes = new TextEncoder().encode(sanitizeZipEntryName(entry.name));
    const time = getZipDosTime(entry.lastModified || new Date());
    const date = getZipDosDate(entry.lastModified || new Date());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, ...parts);
    centralParts.push(centralHeader);
    offset += localHeader.length + size;
    count++;
  }

  function finalizeZipBlob() {
    const centralOffset = offset;
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, count, true);
    endView.setUint16(10, count, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, endRecord], { type: "application/zip" });
  }
}

async function normalizeZipEntryParts(entry) {
  if (Array.isArray(entry.parts)) {
    return entry.parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part));
  }

  if (entry.blob) {
    return [new Uint8Array(await entry.blob.arrayBuffer())];
  }

  return [new Uint8Array()];
}

function sanitizeZipEntryName(name) {
  const parts = String(name || "")
    .split(/[\\/]/)
    .map(sanitizeZipPathSegment)
    .filter(Boolean);

  return parts.join("/") || "chatgpt-file";
}

function sanitizeZipPathSegment(segment) {
  return String(segment || "")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")
    || "";
}

function getZipDosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function getZipDosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function crc32(bytes) {
  return crc32Finalize(crc32Update(0xffffffff, bytes));
}

function crc32Parts(parts) {
  let crc = 0xffffffff;
  for (const part of parts) crc = crc32Update(crc, part);
  return crc32Finalize(crc);
}

function crc32Update(crc, bytes) {
  for (let index = 0; index < bytes.length; index++) {
    crc = (crc >>> 8) ^ getCrc32Table()[(crc ^ bytes[index]) & 0xff];
  }

  return crc;
}

function crc32Finalize(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

function getCrc32Table() {
  if (window.__chatGptExportCrc32Table) return window.__chatGptExportCrc32Table;

  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  window.__chatGptExportCrc32Table = table;
  return table;
}

async function buildChatGptCurrentBranchExport(conv, convId) {
  const branch = window.__chatGptExportMode === CHATGPT_EXPORT_MODE_BACKEND_CURRENT
    ? {
        order: getActiveBranchOrder(conv.mapping, conv.current_node),
        source: "backend-current-node"
      }
    : await getRenderedBranchOrder(conv.mapping, conv.current_node);
  const segment = buildMessages(branch.order, conv.mapping, null);

  return {
    exportedAt: new Date().toISOString(),
    source: "backend-api",
    exportMode: CHATGPT_EXPORT_MODE_CURRENT,
    branchSource: branch.source,
    url: location.href,
    conversationId: conv.conversation_id || convId,
    title: conv.title || document.title,
    create_time: conv.create_time || null,
    update_time: conv.update_time || null,
    counts: buildLinearCounts(segment.messages, segment.files),
    messages: segment.messages,
    files: segment.files
  };
}

function buildChatGptAllBranchesExport(conv, convId) {
  const context = buildChatGptTreeContext(conv.mapping);
  context.conv = conv;
  const exportedAt = new Date().toISOString();
  const root = createChatGptBranchNode({
    conv,
    convId,
    exportedAt,
    branchPath: [],
    branchIndex: null,
    branchLabel: null,
    parentMessageId: null,
    startMessageId: null
  });

  if (!context.nodeIds.length) {
    root.localCounts = buildCounts(root.messages, root.files, 0, 0);
    root.totalCounts = { ...root.localCounts };
    return root;
  }

  const roots = getChatGptTrueRootNodeIds(context);
  const missingParentRoots = getChatGptMissingParentRootNodeIds(context);

  if (!roots.length && !missingParentRoots.length) {
    const fallback = context.nodeIds[0];
    context.warnings.push(`No root node found; using ${fallback} as traversal root.`);
    populateChatGptBranchNode(root, fallback, context, []);
  } else if (roots.length === 1) {
    populateChatGptBranchNode(root, roots[0], context, []);
  } else {
    root.startMessageId = null;
    root.branches = roots.map((nodeId, index) => buildChatGptChildBranchNode({
      conv,
      convId,
      exportedAt,
      context,
      parentMessageId: null,
      startMessageId: nodeId,
      branchPath: [index + 1],
      branchIndex: index + 1,
      siblingCount: roots.length,
      seenPath: new Set()
    }));
  }

  appendMissingParentChatGptComponents(root, context, conv, convId, exportedAt, missingParentRoots);
  appendUnvisitedChatGptComponents(root, context, conv, convId, exportedAt);
  applyChatGptBranchCounts(root);
  if (context.warnings.length) root.warnings = context.warnings.slice();
  return root;
}

function buildChatGptTreeContext(mapping) {
  const nodeIds = [];
  const warnings = [];

  for (const [nodeId, node] of Object.entries(mapping || {})) {
    if (!nodeId || !node || typeof node !== "object") continue;
    nodeIds.push(nodeId);
  }

  const childrenByParent = new Map();
  for (const nodeId of nodeIds) {
    const node = mapping[nodeId];
    const parentId = node && node.parent;
    if (!parentId || !mapping[parentId]) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(nodeId);
  }

  return { mapping, nodeIds, childrenByParent, warnings, visited: new Set() };
}

function getChatGptTrueRootNodeIds(context) {
  return context.nodeIds.filter((nodeId) => {
    const parentId = context.mapping[nodeId] && context.mapping[nodeId].parent;
    return !parentId;
  });
}

function getChatGptMissingParentRootNodeIds(context) {
  return context.nodeIds.filter((nodeId) => {
    const parentId = context.mapping[nodeId] && context.mapping[nodeId].parent;
    return parentId && !context.mapping[parentId];
  });
}

function createChatGptBranchNode({
  conv,
  convId,
  exportedAt,
  branchPath,
  branchIndex,
  branchLabel,
  parentMessageId,
  startMessageId,
  recovery = null
}) {
  return {
    exportedAt,
    source: "backend-api",
    exportMode: CHATGPT_EXPORT_MODE_ALL,
    branchStructure: CHATGPT_BRANCH_STRUCTURE,
    url: location.href,
    conversationId: conv.conversation_id || convId,
    title: conv.title || document.title,
    create_time: conv.create_time || null,
    update_time: conv.update_time || null,
    branchPath,
    branchIndex,
    branchLabel,
    parentMessageId,
    startMessageId,
    recovery,
    localCounts: null,
    totalCounts: null,
    messages: [],
    files: [],
    branches: []
  };
}

function buildChatGptChildBranchNode({
  conv,
  convId,
  exportedAt,
  context,
  parentMessageId,
  startMessageId,
  branchPath,
  branchIndex,
  siblingCount,
  seenPath
}) {
  const node = createChatGptBranchNode({
    conv,
    convId,
    exportedAt,
    branchPath,
    branchIndex,
    branchLabel: `${branchIndex} / ${siblingCount}`,
    parentMessageId,
    startMessageId
  });

  populateChatGptBranchNode(node, startMessageId, context, seenPath);
  applyChatGptBranchCounts(node);
  return node;
}

function populateChatGptBranchNode(node, startNodeId, context, incomingSeenPath) {
  let nodeId = startNodeId;
  const seenPath = new Set(incomingSeenPath || []);

  while (nodeId) {
    if (seenPath.has(nodeId)) {
      context.warnings.push(`Cycle detected at node ${nodeId}; stopped branch ${node.branchPath.join(".") || "root"}.`);
      return;
    }

    const mappingNode = context.mapping[nodeId];
    if (!mappingNode) {
      context.warnings.push(`Missing node ${nodeId}; stopped branch ${node.branchPath.join(".") || "root"}.`);
      return;
    }

    context.visited.add(nodeId);
    seenPath.add(nodeId);

    const segment = buildMessages([nodeId], context.mapping, node.branchPath, node.messages.length);
    if (segment.messages.length) {
      node.messages.push(segment.messages[0]);
      node.files.push(...segment.files);
      if (!node.startMessageId) node.startMessageId = segment.messages[0].id;
    }

    const children = getChatGptChildNodeIds(nodeId, context);
    if (!children.length) return;

    if (children.length === 1) {
      nodeId = children[0];
      continue;
    }

    node.branches = children.map((childId, index) => buildChatGptChildBranchNode({
      conv: context.conv,
      convId: node.conversationId,
      exportedAt: node.exportedAt,
      context,
      parentMessageId: nodeId,
      startMessageId: childId,
      branchPath: node.branchPath.concat(index + 1),
      branchIndex: index + 1,
      siblingCount: children.length,
      seenPath
    }));
    return;
  }
}

function getChatGptChildNodeIds(nodeId, context) {
  const node = context.mapping[nodeId];
  const children = [];
  const seen = new Set();

  if (Array.isArray(node && node.children)) {
    for (const childId of node.children) {
      addChatGptChildNodeId(children, seen, childId, nodeId, context, true);
    }
  }

  for (const childId of context.childrenByParent.get(nodeId) || []) {
    addChatGptChildNodeId(children, seen, childId, nodeId, context, false);
  }

  return children;
}

function addChatGptChildNodeId(children, seen, childId, parentId, context, warnOnMismatch) {
  if (!childId || seen.has(childId)) return;

  const child = context.mapping[childId];
  if (!child) {
    context.warnings.push(`Missing child ${childId} referenced by node ${parentId}; ignored.`);
    return;
  }

  if (child.parent !== parentId) {
    if (warnOnMismatch) {
      context.warnings.push(
        `Child ${childId} referenced by node ${parentId} has parent ${child.parent || "null"}; ignored.`
      );
    }
    return;
  }

  seen.add(childId);
  children.push(childId);
}

function appendMissingParentChatGptComponents(root, context, conv, convId, exportedAt, nodeIds) {
  let index = 0;
  appendChatGptRecoveryComponents({
    root,
    context,
    conv,
    convId,
    exportedAt,
    recovery: "missing-parent",
    labelPrefix: "missing parent",
    getNextNodeId: () => {
      while (index < nodeIds.length) {
        const nodeId = nodeIds[index++];
        if (!context.visited.has(nodeId)) return nodeId;
      }
      return null;
    },
    getWarning: (nodeId, recoveryIndex) => (
      `Missing parent ${context.mapping[nodeId].parent} for node ${nodeId}; `
      + `exported as missing-parent branch ${recoveryIndex}.`
    )
  });
}

function appendUnvisitedChatGptComponents(root, context, conv, convId, exportedAt) {
  appendChatGptRecoveryComponents({
    root,
    context,
    conv,
    convId,
    exportedAt,
    recovery: "orphan-component",
    labelPrefix: "orphan",
    getNextNodeId: () => getFirstUnvisitedChatGptNodeId(context),
    getWarning: (nodeId, index) => `Unreachable node component found at ${nodeId}; exported as orphan branch ${index}.`
  });
}

function appendChatGptRecoveryComponents({
  root,
  context,
  conv,
  convId,
  exportedAt,
  recovery,
  labelPrefix,
  getNextNodeId,
  getWarning
}) {
  let orphanIndex = 1;
  let nodeId = getNextNodeId();

  while (nodeId) {
    const branchIndex = root.branches.length + 1;
    const branchPath = [branchIndex];
    const mappingNode = context.mapping[nodeId] || {};
    const node = createChatGptBranchNode({
      conv,
      convId,
      exportedAt,
      branchPath,
      branchIndex,
      branchLabel: `${labelPrefix} ${orphanIndex}`,
      parentMessageId: mappingNode.parent || null,
      startMessageId: nodeId,
      recovery
    });

    context.warnings.push(getWarning(nodeId, orphanIndex));
    populateChatGptBranchNode(node, nodeId, context, new Set());
    applyChatGptBranchCounts(node);
    root.branches.push(node);

    orphanIndex++;
    nodeId = getNextNodeId();
  }
}

function getFirstUnvisitedChatGptNodeId(context) {
  return context.nodeIds.find((nodeId) => !context.visited.has(nodeId)) || null;
}

function applyChatGptBranchCounts(node) {
  const hasBranches = node.branches.length > 0;
  const hasRealBranches = node.branches.some((branch) => !branch.recovery);
  const localBranchPointCount = hasRealBranches ? 1 : 0;
  const localLeafBranchCount = hasBranches
    ? hasRealBranches
      ? 0
      : (node.messages.length ? 1 : 0)
    : (node.messages.length ? 1 : 0);
  node.localCounts = buildCounts(node.messages, node.files, localBranchPointCount, localLeafBranchCount);
  node.totalCounts = { ...node.localCounts };

  for (const branch of node.branches) {
    if (!branch.totalCounts) applyChatGptBranchCounts(branch);
    addCounts(node.totalCounts, branch.totalCounts);
  }

  return node.totalCounts;
}

async function getAccessToken() {
  let session;

  try {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    session = await response.json();
  } catch (error) {
    throw new Error("Could not read access token from /api/auth/session. Are you logged in?");
  }

  if (!session || !session.accessToken) {
    throw new Error("No access token found in /api/auth/session. Are you logged in?");
  }

  return session.accessToken;
}

function getConversationId() {
  const match = location.pathname.match(/\/c\/([0-9a-f-]{36})/i)
    || location.pathname.match(/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

function getActiveBranchOrder(mapping, currentNode) {
  const order = [];
  let nodeId = currentNode || findLeafNode(mapping);
  const guard = new Set();

  while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
    guard.add(nodeId);
    order.push(nodeId);
    nodeId = mapping[nodeId].parent;
  }

  return order.reverse();
}

async function getRenderedBranchOrder(mapping, currentNode) {
  const fallback = () => ({
    order: getActiveBranchOrder(mapping, currentNode),
    source: "backend-current-node"
  });

  let rendered;
  try {
    rendered = await collectRenderedChatGptMessageIds();
  } catch (error) {
    console.warn("[backend-export] Could not read rendered ChatGPT branch; using backend current_node.", error);
    return fallback();
  }

  const messageIds = rendered.messageIds || [];
  if (!messageIds.length) {
    return fallback();
  }

  const nodeIdByMessageId = indexNodeIdsByMessageId(mapping);
  const visibleNodeIds = unique(messageIds
    .map((messageId) => nodeIdByMessageId.get(messageId))
    .filter(Boolean));

  if (!visibleNodeIds.length) {
    return fallback();
  }

  const selectedLeaf = visibleNodeIds[visibleNodeIds.length - 1];
  const leafOrder = getActiveBranchOrder(mapping, selectedLeaf);
  const leafOrderSet = new Set(leafOrder);

  if (leafOrder.length && visibleNodeIds.every((nodeId) => leafOrderSet.has(nodeId))) {
    return {
      order: leafOrder,
      source: rendered.reachedBottom ? "visible-dom-leaf" : "visible-dom-leaf-partial-scroll"
    };
  }

  return {
    order: visibleNodeIds,
    source: rendered.reachedBottom ? "visible-dom-order" : "visible-dom-order-partial-scroll"
  };
}

function indexNodeIdsByMessageId(mapping) {
  const out = new Map();

  for (const [nodeId, node] of Object.entries(mapping)) {
    const messageId = node && node.message && node.message.id;
    if (messageId && !out.has(messageId)) {
      out.set(messageId, nodeId);
    }

    if (nodeId && !out.has(nodeId)) {
      out.set(nodeId, nodeId);
    }
  }

  return out;
}

function unique(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

async function collectRenderedChatGptMessageIds() {
  const scroller = findChatGptScroller();
  const originalTop = scroller.scrollTop;
  const originalBehavior = scroller.style.scrollBehavior;
  const records = new Map();
  let sequence = 0;
  let reachedBottom = false;

  scroller.style.scrollBehavior = "auto";

  try {
    scroller.scrollTop = 0;
    await sleep(350);
    captureRenderedMessages(scroller, records, () => sequence++);

    let idle = 0;
    let steps = 0;
    const maxSteps = 5000;

    while (steps++ < maxSteps) {
      const previousTop = scroller.scrollTop;
      scroller.scrollTop = Math.min(
        scroller.scrollTop + scroller.clientHeight * 0.85,
        scroller.scrollHeight
      );

      await sleep(350);
      const added = captureRenderedMessages(scroller, records, () => sequence++);
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const stuck = scroller.scrollTop <= previousTop + 1;

      if (atBottom) reachedBottom = true;

      if (added > 0) {
        idle = 0;
      } else if (atBottom || stuck) {
        idle++;
        if (idle >= 3) break;
        await sleep(350);
      } else {
        idle = 0;
      }
    }
  } finally {
    scroller.scrollTop = originalTop;
    scroller.style.scrollBehavior = originalBehavior;
  }

  const messageIds = [...records.values()]
    .sort((a, b) => (a.y - b.y) || (a.sequence - b.sequence))
    .map((record) => record.id);

  return { messageIds, reachedBottom };
}

function findChatGptScroller() {
  const thread = document.getElementById("thread");
  let element = document.querySelector(".group\\/scroll-root")
    || (thread && thread.closest('[class*="overflow-y-auto"]'));

  if (!element && thread) {
    for (let node = thread.parentElement; node; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
        element = node;
        break;
      }
    }
  }

  return element || document.scrollingElement || document.documentElement;
}

function captureRenderedMessages(scroller, records, nextSequence) {
  let added = 0;

  document.querySelectorAll("[data-message-author-role][data-message-id]").forEach((element) => {
    const id = element.getAttribute("data-message-id");
    const role = element.getAttribute("data-message-role")
      || element.getAttribute("data-message-author-role");

    if (!id || (role !== "user" && role !== "assistant")) return;
    if (!isVisibleElement(element)) return;

    const y = getAbsoluteY(element, scroller);
    const record = records.get(id);

    if (!record) {
      records.set(id, { id, y, sequence: nextSequence() });
      added++;
    } else {
      record.y = y;
    }
  });

  return added;
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height) return false;

  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function getAbsoluteY(element, scroller) {
  const scrollerTop = scroller.getBoundingClientRect().top;
  return element.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findLeafNode(mapping) {
  return Object.keys(mapping).find((key) => !(mapping[key].children || []).length)
    || Object.keys(mapping)[0];
}

function buildMessages(order, mapping, branchPath = null, startIndex = 0) {
  const messages = [];
  const files = [];

  for (const nodeId of order) {
    const node = mapping[nodeId];
    const message = node && node.message;
    if (!message || !shouldIncludeMessage(message)) continue;

    const content = message.content || {};
    const messageFiles = [];
    const messageIndex = startIndex + messages.length;
    const text = getTextAndAssetFiles(content, message, messageIndex, messageFiles);

    addAttachmentFiles(message, messageIndex, messageFiles);
    if (branchPath) addBranchPathToFiles(messageFiles, branchPath);

    if (!text && messageFiles.length === 0) continue;

    const record = {
      index: messageIndex,
      id: message.id,
      role: message.author.role,
      model: (message.metadata && message.metadata.model_slug) || null,
      create_time: message.create_time || null,
      text,
      files: messageFiles
    };

    messages.push(record);
    files.push(...messageFiles);
  }

  return { messages, files };
}

function addBranchPathToFiles(files, branchPath) {
  for (const file of files) {
    file.branchPath = branchPath.slice();
  }
}

function shouldIncludeMessage(message) {
  const role = message.author && message.author.role;
  if (role !== "user" && role !== "assistant") return false;
  if (message.metadata && message.metadata.is_visually_hidden_from_conversation) return false;
  if (message.recipient && message.recipient !== "all") return false;

  const contentType = message.content && message.content.content_type;
  return contentType === "text" || contentType === "multimodal_text";
}

function getTextAndAssetFiles(content, message, messageIndex, messageFiles) {
  const textParts = [];

  for (const part of content.parts || []) {
    if (typeof part === "string") {
      if (part) textParts.push(part);
      continue;
    }

    if (part && typeof part === "object" && part.asset_pointer) {
      const id = normalizeFileId(part.asset_pointer);
      messageFiles.push({
        messageIndex,
        messageId: message.id,
        owner: message.author.role,
        id,
        name: `${id.replace(/^file[-_]/, "file_")}.png`,
        mime: "image/png",
        kind: "image",
        source: "asset_pointer"
      });
    }
  }

  return textParts.join("\n").trim();
}

function addAttachmentFiles(message, messageIndex, messageFiles) {
  const attachments = (message.metadata && message.metadata.attachments) || [];

  for (const attachment of attachments) {
    const name = attachment.name || normalizeFileId(attachment.id);
    const ext = name.split(".").pop().toLowerCase();
    const kind = /^(png|jpe?g|gif|webp|svg|heic)$/.test(ext)
      ? "image"
      : /^(pdf|docx?|txt|md|csv|xlsx?|pptx?)$/.test(ext)
        ? "document"
        : "file";

    messageFiles.push({
      messageIndex,
      messageId: message.id,
      owner: message.author.role,
      id: normalizeFileId(attachment.id),
      name,
      mime: attachment.mime_type || "",
      size: attachment.size || null,
      kind,
      source: "attachment"
    });
  }
}

function normalizeFileId(id) {
  return String(id || "")
    .replace(/^file-service:\/\//, "")
    .replace(/^sediment:\/\//, "");
}

function buildLinearCounts(messages, files) {
  return {
    messages: messages.length,
    user: messages.filter((message) => message.role === "user").length,
    assistant: messages.filter((message) => message.role === "assistant").length,
    files: files.length
  };
}

function buildCounts(messages, files, branchPoints, leafBranches) {
  return {
    messages: messages.length,
    user: messages.filter((message) => message.role === "user").length,
    assistant: messages.filter((message) => message.role === "assistant").length,
    files: files.length,
    branchPoints,
    leafBranches
  };
}

function addCounts(target, source) {
  target.messages += source.messages;
  target.user += source.user;
  target.assistant += source.assistant;
  target.files += source.files;
  target.branchPoints += source.branchPoints;
  target.leafBranches += source.leafBranches;
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
