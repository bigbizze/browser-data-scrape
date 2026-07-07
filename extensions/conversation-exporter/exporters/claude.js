var CLAUDE_EXPORT_MODE_CURRENT = "current-branch";
var CLAUDE_EXPORT_MODE_ALL = "all-branches";
var CLAUDE_EXPORT_MODE_DOWNLOAD_FILES = "download-files-all";
var CLAUDE_BRANCH_STRUCTURE = "segment-tree";
var CLAUDE_ROOT_PARENT_UUID = "00000000-0000-4000-8000-000000000000";

(async () => {
  if (window.__claudeConversationExportInProgress) {
    return {
      ok: false,
      error: "An export is already running in this tab."
    };
  }

  const exportMode = normalizeClaudeExportMode(window.__claudeExportMode);
  window.__claudeConversationExportInProgress = true;

  try {
    const out = await exportClaudeConversation(exportMode);
    return {
      ok: true,
      source: out.source,
      exportMode: out.exportMode || exportMode,
      counts: out.totalCounts || out.counts,
      conversationId: out.conversationId,
      downloadName: out.downloadName,
      failures: out.failures || []
    };
  } catch (error) {
    console.error("[claude-export] FAILED", error);
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    delete window.__claudeExportMode;
    window.__claudeConversationExportInProgress = false;
  }
})();

function normalizeClaudeExportMode(mode) {
  if (mode === CLAUDE_EXPORT_MODE_DOWNLOAD_FILES) return CLAUDE_EXPORT_MODE_DOWNLOAD_FILES;
  return mode === CLAUDE_EXPORT_MODE_ALL ? CLAUDE_EXPORT_MODE_ALL : CLAUDE_EXPORT_MODE_CURRENT;
}

async function exportClaudeConversation(exportMode) {
  const conversationId = getConversationId();
  if (!conversationId) {
    throw new Error("No Claude conversation id found in the URL.");
  }

  let apiError = null;
  const orgIds = await getClaudeOrgIds();

  for (const orgId of orgIds) {
    try {
      const data = await fetchClaudeConversation(orgId, conversationId);
      if (exportMode === CLAUDE_EXPORT_MODE_DOWNLOAD_FILES) {
        return downloadClaudeConversationFiles(data, conversationId, orgId);
      }

      const out = exportMode === CLAUDE_EXPORT_MODE_ALL
        ? buildClaudeAllBranchesExport(data, conversationId, orgId)
        : buildClaudeCurrentBranchExport(data, conversationId, orgId);
      const downloadName = exportMode === CLAUDE_EXPORT_MODE_ALL
        ? `claude-all-branches-export-${Date.now()}.json`
        : `claude-export-${Date.now()}.json`;

      return downloadAndReturn(out, downloadName);
    } catch (error) {
      apiError = error;
      console.warn(`[claude-export] API export failed for org ${orgId}`, error);
    }
  }

  if (exportMode === CLAUDE_EXPORT_MODE_ALL) {
    const reason = apiError && apiError.message ? ` Last API error: ${apiError.message}` : "";
    throw new Error(`Claude API all-branches export failed.${reason}`);
  }

  if (exportMode === CLAUDE_EXPORT_MODE_DOWNLOAD_FILES) {
    const reason = apiError && apiError.message ? ` Last API error: ${apiError.message}` : "";
    throw new Error(`Claude file discovery failed.${reason}`);
  }

  const fallback = buildClaudeDomFallbackExport(conversationId, apiError);
  if (!fallback.messages.length) {
    const reason = apiError && apiError.message ? ` Last API error: ${apiError.message}` : "";
    throw new Error(`Claude API export failed and no visible messages were found for DOM fallback.${reason}`);
  }

  return downloadAndReturn(fallback, `claude-dom-export-${Date.now()}.json`);
}

function getConversationId() {
  const parts = location.pathname.split("/").filter(Boolean);
  const chatIndex = parts.indexOf("chat");
  if (chatIndex >= 0 && parts[chatIndex + 1]) {
    return decodeURIComponent(parts[chatIndex + 1]);
  }

  const lastPart = parts[parts.length - 1] || "";
  return /^[0-9a-f-]{16,}$/i.test(lastPart) ? decodeURIComponent(lastPart) : null;
}

async function getClaudeOrgIds() {
  const ids = [];

  addUnique(ids, getOrgIdFromCookie());

  try {
    const response = await fetch(`${location.origin}/api/organizations`, {
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    });

    if (response.ok) {
      addUniqueMany(ids, extractOrgIds(await response.json()));
    }
  } catch (error) {
    console.warn("[claude-export] Could not fetch organizations", error);
  }

  return ids;
}

function getOrgIdFromCookie() {
  const match = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]).replace(/^"|"$/g, "");
  } catch (error) {
    return match[1].replace(/^"|"$/g, "");
  }
}

function extractOrgIds(data) {
  const ids = [];
  const collections = [];

  if (Array.isArray(data)) collections.push(data);
  if (data && Array.isArray(data.organizations)) collections.push(data.organizations);
  if (data && Array.isArray(data.data)) collections.push(data.data);
  if (data && Array.isArray(data.results)) collections.push(data.results);

  for (const collection of collections) {
    for (const item of collection) {
      if (typeof item === "string") {
        addUnique(ids, item);
      } else if (item && typeof item === "object") {
        addUnique(ids, item.uuid);
        addUnique(ids, item.id);
        addUnique(ids, item.organization_uuid);
        addUnique(ids, item.organization_id);
        if (item.organization && typeof item.organization === "object") {
          addUnique(ids, item.organization.uuid);
          addUnique(ids, item.organization.id);
        }
      }
    }
  }

  return ids;
}

function addUnique(list, value) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (clean && !list.includes(clean)) list.push(clean);
}

function addUniqueMany(list, values) {
  for (const value of values || []) addUnique(list, value);
}

async function fetchClaudeConversation(orgId, conversationId) {
  const url = `${location.origin}/api/organizations/${encodeURIComponent(orgId)}`
    + `/chat_conversations/${encodeURIComponent(conversationId)}`
    + "?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong";

  const response = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Conversation request failed with HTTP ${response.status}.`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.chat_messages)) {
    throw new Error("Unexpected Claude response with no chat_messages array.");
  }

  return data;
}

async function downloadClaudeConversationFiles(data, conversationId, orgId) {
  const files = collectClaudeDownloadableFiles(data, conversationId, orgId);
  if (!files.length) {
    throw new Error("No downloadable Claude files found in this conversation.");
  }

  const results = [];
  for (const file of files) {
    try {
      const download = await fetchClaudeDownloadBlob(file);
      results.push({ file, ok: true, blob: download.blob, downloadName: download.name });
      await sleep(150);
    } catch (error) {
      console.warn("[claude-export] File download failed", file, error);
      results.push({
        file,
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  const failures = results.filter((result) => !result.ok);
  const downloaded = results.length - failures.length;
  if (!downloaded && failures.length) {
    throw new Error(`Failed to download ${failures.length} Claude files. First error: ${failures[0].error}`);
  }

  const successful = results.filter((result) => result.ok);
  const archiveName = makeClaudeFilesArchiveName(data, conversationId);
  const downloadedName = await downloadClaudeFileResults(successful, archiveName);

  const out = {
    exportedAt: new Date().toISOString(),
    source: "claude-api-files",
    exportMode: CLAUDE_EXPORT_MODE_DOWNLOAD_FILES,
    url: location.href,
    conversationId: data.uuid || conversationId,
    organizationId: orgId,
    title: data.name || document.title || "Claude conversation",
    counts: {
      messages: Array.isArray(data.chat_messages) ? data.chat_messages.length : 0,
      files: files.length,
      downloaded,
      failed: failures.length
    },
    downloadName: downloadedName,
    files,
    failures
  };

  window.__lastClaudeFileDownload = out;
  console.log("[claude-export] FILE DOWNLOAD DONE", out.counts);
  return out;
}

async function downloadClaudeFileResults(results, archiveName) {
  if (results.length === 1) {
    downloadBlob(results[0].blob, results[0].downloadName);
    return results[0].downloadName;
  }

  const entries = results.map((result) => ({
    name: result.downloadName,
    blob: result.blob,
    lastModified: new Date()
  }));
  const zipBlob = await createZipBlob(entries);
  downloadBlob(zipBlob, archiveName);
  return archiveName;
}

function makeClaudeFilesArchiveName(data, conversationId) {
  const title = sanitizeDownloadName(data.name || document.title || "claude-files")
    .replace(/\.[^.]+$/, "");
  const id = String(data.uuid || conversationId || "conversation").slice(0, 8);
  return sanitizeDownloadName(`${title || "claude-files"}-${id}-files.zip`);
}

function collectClaudeDownloadableFiles(data, conversationId, orgId) {
  const messages = Array.isArray(data && data.chat_messages) ? data.chat_messages : [];
  const files = [];
  const seen = new Set();

  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;

    const owner = normalizeClaudeRole(message.sender) || "unknown";
    const add = (file, source) => {
      const normalized = normalizeClaudeDownloadableFile(file, message, messageIndex, owner, source, conversationId, orgId);
      if (!normalized) return;

      const key = getClaudeDownloadFileKey(normalized);
      if (seen.has(key)) return;
      seen.add(key);
      files.push(normalized);
    };

    for (const attachment of message.attachments || []) add(attachment, "attachment");
    for (const file of message.files || []) add(file, "files");
    for (const file of message.files_v2 || []) add(file, "files_v2");
    for (const file of message.generated_files || []) add(file, "generated_files");

    for (const artifact of getClaudeArtifactDownloadFiles(message, messageIndex, owner)) {
      const key = getClaudeDownloadFileKey(artifact);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(artifact);
    }
  });

  applyUniqueDownloadNames(files);
  return files;
}

function normalizeClaudeDownloadableFile(file, message, messageIndex, owner, source, conversationId, orgId) {
  if (!file || typeof file !== "object") return null;

  const id = getClaudeFileId(file);
  const rawName = getClaudeFileName(file, id);
  const mime = file.mime_type || file.file_type || file.type || "";
  const textContent = source === "attachment" && typeof file.extracted_content === "string"
    ? file.extracted_content
    : null;
  const url = textContent === null ? getClaudeDownloadUrl(file, source, conversationId, orgId, rawName) : "";

  if (textContent === null && !url) return null;

  const name = textContent === null
    ? sanitizeDownloadName(rawName || id || "claude-file")
    : ensureTextDownloadName(rawName || id || "claude-attachment");

  const out = {
    messageIndex,
    messageId: message.uuid || null,
    owner,
    id,
    name,
    downloadName: name,
    mime: textContent === null ? mime : "text/plain;charset=utf-8",
    size: file.file_size || file.size || null,
    kind: textContent === null ? inferFileKind(name, mime) : "document",
    source,
    url
  };

  if (textContent !== null) out.content = textContent;
  return out;
}

function getClaudeArtifactDownloadFiles(message, messageIndex, owner) {
  const out = [];
  const content = Array.isArray(message.content) ? message.content : [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const input = block.input && typeof block.input === "object" ? block.input : null;
    if (!input || typeof input.content !== "string") continue;
    if (block.type !== "tool_use" || (block.name !== "artifacts" && block.name !== "create_file")) continue;

    const rawName = inferClaudeArtifactFileName(input);
    out.push({
      messageIndex,
      messageId: message.uuid || null,
      owner,
      id: block.id || input.id || input.filename || input.title || rawName,
      name: rawName,
      downloadName: sanitizeDownloadName(rawName),
      mime: inferClaudeArtifactMime(input),
      size: input.content.length,
      kind: "document",
      source: block.name === "create_file" ? "artifact-create-file" : "artifact",
      url: "",
      content: input.content
    });
  }

  return out;
}

function getClaudeFileId(file) {
  return String(
    file.file_uuid
      || file.uuid
      || file.id
      || file.file_id
      || file.path
      || file.url
      || file.preview_url
      || ""
  );
}

function getClaudeFileName(file, id) {
  const pathName = file.path ? String(file.path).split("/").filter(Boolean).pop() : "";
  return file.file_name || file.name || file.filename || pathName || id || "claude-file";
}

function getClaudeDownloadUrl(file, source, conversationId, orgId, name) {
  const direct = file.download_url
    || file.downloadUrl
    || file.url
    || file.preview_url
    || (file.document_asset && file.document_asset.url);

  if (direct) return absolutizeClaudeUrl(direct);

  if (source === "files_v2" && file.path && orgId && conversationId) {
    return `${location.origin}/api/organizations/${encodeURIComponent(orgId)}`
      + `/conversations/${encodeURIComponent(conversationId)}`
      + `/wiggle/download-file?path=${encodeURIComponent(file.path)}`;
  }

  if (file.file_kind === "blob" && file.file_uuid && orgId) {
    return `${location.origin}/api/organizations/${encodeURIComponent(orgId)}`
      + `/files/${encodeURIComponent(file.file_uuid)}/contents`;
  }

  if (file.file_uuid && orgId && name) {
    const extension = getFileExtension(name);
    if (extension) {
      return `${location.origin}/api/${encodeURIComponent(orgId)}`
        + `/files/${encodeURIComponent(file.file_uuid)}`
        + `/document_${encodeURIComponent(extension)}`
        + `/${encodeURIComponent(name)}`;
    }
  }

  return "";
}

function absolutizeClaudeUrl(url) {
  try {
    return new URL(url, location.origin).href;
  } catch (error) {
    return String(url || "");
  }
}

function getClaudeDownloadFileKey(file) {
  if (file.content !== undefined) {
    if (String(file.source || "").startsWith("artifact")) {
      return `${file.source}:content:${file.id}:${file.name}:${file.messageId || ""}`;
    }

    return `${file.source}:content:${file.id}:${file.name}`;
  }

  return file.id
    ? `binary:${file.id}`
    : `binary:${file.url}:${file.name}`;
}

function applyUniqueDownloadNames(files) {
  const used = new Map();

  for (const file of files) {
    const name = sanitizeDownloadName(file.downloadName || file.name || "claude-file");
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

function ensureTextDownloadName(name) {
  const clean = sanitizeDownloadName(name || "claude-attachment");
  return /\.txt$/i.test(clean) ? clean : `${clean}.txt`;
}

function sanitizeDownloadName(name) {
  const baseName = String(name || "claude-file")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "claude-file";

  return baseName
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "claude-file")
    || "claude-file";
}

function getFileExtension(name) {
  const clean = String(name || "");
  const dotIndex = clean.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === clean.length - 1) return "";
  return clean.slice(dotIndex + 1).toLowerCase();
}

function inferClaudeArtifactFileName(input) {
  const existing = input.filename || input.file_name || input.title || "artifact";
  if (getFileExtension(existing)) return sanitizeDownloadName(existing);

  const language = String(input.language || input.artifact_type || input.type || "").toLowerCase();
  const extensionByLanguage = {
    javascript: "js",
    typescript: "ts",
    python: "py",
    html: "html",
    css: "css",
    json: "json",
    markdown: "md",
    "text/markdown": "md",
    "text/html": "html",
    "application/json": "json"
  };
  const extension = extensionByLanguage[language] || "txt";
  return sanitizeDownloadName(`${existing}.${extension}`);
}

function inferClaudeArtifactMime(input) {
  const type = input.artifact_type || input.type || "";
  if (typeof type === "string" && type.includes("/")) return type;
  return "text/plain;charset=utf-8";
}

async function fetchClaudeDownloadBlob(file) {
  if (file.content !== undefined) {
    return {
      blob: new Blob([String(file.content)], { type: file.mime || "text/plain;charset=utf-8" }),
      name: file.downloadName
    };
  }

  const response = await fetch(file.url, {
    credentials: "include",
    headers: {
      Accept: "*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`File request failed with HTTP ${response.status}.`);
  }

  const blob = await response.blob();
  const headerName = getFilenameFromContentDisposition(response.headers.get("content-disposition"));
  return {
    blob,
    name: sanitizeDownloadName(headerName || file.downloadName || file.name)
  };
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

  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function createZipBlob(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(sanitizeZipEntryName(entry.name));
    const crc = crc32(bytes);
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
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
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
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, bytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + bytes.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, endRecord], { type: "application/zip" });
}

function sanitizeZipEntryName(name) {
  return sanitizeDownloadName(name).replace(/^\/+/, "") || "claude-file";
}

function getZipDosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function getZipDosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function crc32(bytes) {
  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index++) {
    crc = (crc >>> 8) ^ getCrc32Table()[(crc ^ bytes[index]) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getCrc32Table() {
  if (window.__claudeExportCrc32Table) return window.__claudeExportCrc32Table;

  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  window.__claudeExportCrc32Table = table;
  return table;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClaudeCurrentBranchExport(data, conversationId, orgId) {
  const thread = getActiveClaudeThread(data);
  const segment = buildClaudeMessageSegment(thread, data, null);

  return {
    exportedAt: new Date().toISOString(),
    source: "claude-api",
    exportMode: CLAUDE_EXPORT_MODE_CURRENT,
    url: location.href,
    conversationId: data.uuid || conversationId,
    organizationId: orgId,
    title: data.name || document.title || "Claude conversation",
    create_time: data.created_at || null,
    update_time: data.updated_at || null,
    counts: segment.counts,
    messages: segment.messages,
    files: segment.files
  };
}

function getActiveClaudeThread(data) {
  const messages = data.chat_messages || [];
  if (!messages.length) return [];

  const byUuid = new Map(messages.filter((message) => message && message.uuid)
    .map((message) => [message.uuid, message]));
  let nodeId = data.current_leaf_message_uuid || findLatestClaudeLeaf(messages);
  const ordered = [];
  const guard = new Set();

  while (nodeId && byUuid.has(nodeId) && !guard.has(nodeId)) {
    guard.add(nodeId);
    const message = byUuid.get(nodeId);
    ordered.push(message);
    nodeId = getClaudeParentId(message);
  }

  if (!ordered.length) {
    return messages.slice();
  }

  return ordered.reverse();
}

function findLatestClaudeLeaf(messages) {
  const parentIds = new Set(messages.map((message) => getClaudeParentId(message)).filter(Boolean));
  const leaves = messages.filter((message) => message.uuid && !parentIds.has(message.uuid));

  leaves.sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    return rightTime - leftTime;
  });

  return (leaves[0] && leaves[0].uuid) || (messages[messages.length - 1] && messages[messages.length - 1].uuid);
}

function buildClaudeAllBranchesExport(data, conversationId, orgId) {
  const context = buildClaudeTreeContext(data);
  const exportedAt = new Date().toISOString();
  const root = createClaudeBranchNode({
    data,
    conversationId,
    orgId,
    exportedAt,
    branchPath: [],
    branchIndex: null,
    branchLabel: null,
    parentMessageId: null,
    startMessageId: null
  });

  if (!context.messages.length) {
    root.localCounts = buildCounts(root.messages, root.files, 0, 0);
    root.totalCounts = { ...root.localCounts };
    return root;
  }

  const roots = getClaudeTrueRootMessages(context);
  const missingParentRoots = getClaudeMissingParentRootMessages(context);
  if (!roots.length && !missingParentRoots.length) {
    const fallback = context.messages[0];
    context.warnings.push(`No root message found; using ${fallback.uuid} as traversal root.`);
    populateClaudeBranchNode(root, fallback.uuid, context, []);
  } else if (roots.length === 1) {
    populateClaudeBranchNode(root, roots[0].uuid, context, []);
  } else {
    root.startMessageId = null;
    root.branches = roots.map((message, index) => buildClaudeChildBranchNode({
      data,
      conversationId,
      orgId,
      exportedAt,
      context,
      parentMessageId: null,
      startMessageId: message.uuid,
      branchPath: [index + 1],
      branchIndex: index + 1,
      siblingCount: roots.length,
      seenPath: new Set()
    }));
  }

  appendMissingParentClaudeComponents(root, context, data, conversationId, orgId, exportedAt, missingParentRoots);
  appendUnvisitedClaudeComponents(root, context, data, conversationId, orgId, exportedAt);
  applyClaudeBranchCounts(root);
  if (context.warnings.length) root.warnings = context.warnings.slice();
  return root;
}

function buildClaudeTreeContext(data) {
  const messages = [];
  const byUuid = new Map();
  const apiIndexByUuid = new Map();
  const warnings = [];

  (data.chat_messages || []).forEach((message, index) => {
    if (!message || !message.uuid) return;

    if (byUuid.has(message.uuid)) {
      warnings.push(`Duplicate message uuid ignored: ${message.uuid}`);
      return;
    }

    messages.push(message);
    byUuid.set(message.uuid, message);
    apiIndexByUuid.set(message.uuid, index);
  });

  const childrenByParent = new Map();
  for (const message of messages) {
    const parentId = getClaudeParentId(message) || "";
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(message.uuid);
  }

  for (const children of childrenByParent.values()) {
    children.sort((leftId, rightId) => compareClaudeMessageIds(leftId, rightId, byUuid, apiIndexByUuid));
  }

  return { messages, byUuid, apiIndexByUuid, childrenByParent, warnings, data, visited: new Set() };
}

function compareClaudeMessageIds(leftId, rightId, byUuid, apiIndexByUuid) {
  const left = byUuid.get(leftId);
  const right = byUuid.get(rightId);
  const leftTime = Date.parse((left && left.created_at) || "") || 0;
  const rightTime = Date.parse((right && right.created_at) || "") || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;

  const leftIndex = apiIndexByUuid.get(leftId) ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = apiIndexByUuid.get(rightId) ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;

  return String(leftId).localeCompare(String(rightId));
}

function getClaudeTrueRootMessages(context) {
  return context.messages
    .filter((message) => !getClaudeParentId(message))
    .sort((left, right) => compareClaudeMessageIds(left.uuid, right.uuid, context.byUuid, context.apiIndexByUuid));
}

function getClaudeMissingParentRootMessages(context) {
  return context.messages
    .filter((message) => {
      const parentId = getClaudeParentId(message);
      return parentId && !context.byUuid.has(parentId);
    })
    .sort((left, right) => compareClaudeMessageIds(left.uuid, right.uuid, context.byUuid, context.apiIndexByUuid));
}

function createClaudeBranchNode({
  data,
  conversationId,
  orgId,
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
    source: "claude-api",
    exportMode: CLAUDE_EXPORT_MODE_ALL,
    branchStructure: CLAUDE_BRANCH_STRUCTURE,
    url: location.href,
    conversationId: data.uuid || conversationId,
    organizationId: orgId,
    title: data.name || document.title || "Claude conversation",
    create_time: data.created_at || null,
    update_time: data.updated_at || null,
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

function buildClaudeChildBranchNode({
  data,
  conversationId,
  orgId,
  exportedAt,
  context,
  parentMessageId,
  startMessageId,
  branchPath,
  branchIndex,
  siblingCount,
  seenPath
}) {
  const node = createClaudeBranchNode({
    data,
    conversationId,
    orgId,
    exportedAt,
    branchPath,
    branchIndex,
    branchLabel: `${branchIndex} / ${siblingCount}`,
    parentMessageId,
    startMessageId
  });

  populateClaudeBranchNode(node, startMessageId, context, seenPath);
  applyClaudeBranchCounts(node);
  return node;
}

function populateClaudeBranchNode(node, startMessageId, context, incomingSeenPath) {
  let nodeId = startMessageId;
  const seenPath = new Set(incomingSeenPath || []);

  while (nodeId) {
    if (seenPath.has(nodeId)) {
      context.warnings.push(`Cycle detected at message ${nodeId}; stopped branch ${node.branchPath.join(".") || "root"}.`);
      return;
    }

    const message = context.byUuid.get(nodeId);
    if (!message) {
      context.warnings.push(`Missing message ${nodeId}; stopped branch ${node.branchPath.join(".") || "root"}.`);
      return;
    }

    context.visited.add(nodeId);
    seenPath.add(nodeId);
    const normalized = normalizeClaudeMessage(message, context.data, node.messages.length, node.branchPath);
    if (normalized) {
      node.messages.push(normalized.record);
      node.files.push(...normalized.files);
      if (!node.startMessageId) node.startMessageId = normalized.record.id;
    }

    const children = context.childrenByParent.get(nodeId) || [];
    if (!children.length) return;

    if (children.length === 1) {
      nodeId = children[0];
      continue;
    }

    node.branches = children.map((childId, index) => buildClaudeChildBranchNode({
      data: context.data,
      conversationId: node.conversationId,
      orgId: node.organizationId,
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

function appendUnvisitedClaudeComponents(root, context, data, conversationId, orgId, exportedAt) {
  appendClaudeRecoveryComponents({
    root,
    context,
    data,
    conversationId,
    orgId,
    exportedAt,
    recovery: "orphan-component",
    labelPrefix: "orphan",
    getNextMessage: () => getFirstUnvisitedClaudeMessage(context),
    getWarning: (message, index) => `Unreachable message component found at ${message.uuid}; exported as orphan branch ${index}.`
  });
}

function appendMissingParentClaudeComponents(root, context, data, conversationId, orgId, exportedAt, messages) {
  let index = 0;
  appendClaudeRecoveryComponents({
    root,
    context,
    data,
    conversationId,
    orgId,
    exportedAt,
    recovery: "missing-parent",
    labelPrefix: "missing parent",
    getNextMessage: () => {
      while (index < messages.length) {
        const message = messages[index++];
        if (!context.visited.has(message.uuid)) return message;
      }
      return null;
    },
    getWarning: (message, recoveryIndex) => (
      `Missing parent ${message.parent_message_uuid} for message ${message.uuid}; `
      + `exported as missing-parent branch ${recoveryIndex}.`
    )
  });
}

function appendClaudeRecoveryComponents({
  root,
  context,
  data,
  conversationId,
  orgId,
  exportedAt,
  recovery,
  labelPrefix,
  getNextMessage,
  getWarning
}) {
  let orphanIndex = 1;
  let message = getNextMessage();

  while (message) {
    const branchIndex = root.branches.length + 1;
    const branchPath = [branchIndex];
    const node = createClaudeBranchNode({
      data,
      conversationId,
      orgId,
      exportedAt,
      branchPath,
      branchIndex,
      branchLabel: `${labelPrefix} ${orphanIndex}`,
      parentMessageId: message.parent_message_uuid || null,
      startMessageId: message.uuid,
      recovery
    });

    context.warnings.push(getWarning(message, orphanIndex));
    populateClaudeBranchNode(node, message.uuid, context, new Set());
    applyClaudeBranchCounts(node);
    root.branches.push(node);

    orphanIndex++;
    message = getNextMessage();
  }
}

function getFirstUnvisitedClaudeMessage(context) {
  return context.messages.find((message) => !context.visited.has(message.uuid)) || null;
}

function applyClaudeBranchCounts(node) {
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
    if (!branch.totalCounts) applyClaudeBranchCounts(branch);
    addCounts(node.totalCounts, branch.totalCounts);
  }

  return node.totalCounts;
}

function buildClaudeMessageSegment(thread, data, branchPath) {
  const messages = [];
  const files = [];

  for (const message of thread) {
    const normalized = normalizeClaudeMessage(message, data, messages.length, branchPath);
    if (!normalized) continue;

    messages.push(normalized.record);
    files.push(...normalized.files);
  }

  return {
    messages,
    files,
    counts: buildLinearCounts(messages, files)
  };
}

function normalizeClaudeMessage(message, data, messageIndex, branchPath) {
  const role = normalizeClaudeRole(message.sender);
  if (!role) return null;

  const messageFiles = getClaudeMessageFiles(message, messageIndex, role, branchPath);
  const blocks = getClaudeBlocks(message);
  const text = getClaudeText(message, blocks);

  if (!text && !blocks.length && !messageFiles.length) return null;

  const record = {
    index: messageIndex,
    id: message.uuid || null,
    role,
    model: message.model || data.model || null,
    create_time: message.created_at || null,
    text,
    files: messageFiles
  };

  if (blocks.some((block) => block.type !== "text")) {
    record.blocks = blocks;
  }

  return { record, files: messageFiles };
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

function buildLinearCounts(messages, files) {
  return {
    messages: messages.length,
    user: messages.filter((message) => message.role === "user").length,
    assistant: messages.filter((message) => message.role === "assistant").length,
    files: files.length
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

function getClaudeParentId(message) {
  const parentId = message && message.parent_message_uuid;
  return !parentId || parentId === CLAUDE_ROOT_PARENT_UUID ? null : parentId;
}

function normalizeClaudeRole(sender) {
  if (sender === "human" || sender === "user") return "user";
  if (sender === "assistant" || sender === "claude") return "assistant";
  return null;
}

function getClaudeBlocks(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  const blocks = [];

  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }

    if (!part || typeof part !== "object") continue;

    const type = part.type || (typeof part.text === "string" ? "text" : "unknown");
    const block = { type };

    if (typeof part.text === "string") block.text = part.text;
    if (typeof part.thinking === "string") block.thinking = part.thinking;
    if (typeof part.name === "string") block.name = part.name;
    if (part.input !== undefined) block.input = part.input;
    if (part.content !== undefined) block.content = part.content;
    if (part.is_error !== undefined) block.is_error = Boolean(part.is_error);
    if (typeof part.id === "string") block.id = part.id;

    blocks.push(block);
  }

  if (!blocks.length && typeof message.text === "string" && message.text) {
    blocks.push({ type: "text", text: message.text });
  }

  return blocks;
}

function getClaudeText(message, blocks) {
  const textParts = [];

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      textParts.push(block.text);
    }
  }

  if (!textParts.length && typeof message.text === "string" && message.text) {
    textParts.push(message.text);
  }

  return textParts.join("\n").trim();
}

function getClaudeMessageFiles(message, messageIndex, owner, branchPath) {
  const out = [];

  for (const attachment of message.attachments || []) {
    out.push(normalizeClaudeFile(attachment, message, messageIndex, owner, "attachment", branchPath));
  }

  for (const file of message.files || []) {
    out.push(normalizeClaudeFile(file, message, messageIndex, owner, "files", branchPath));
  }

  for (const file of message.files_v2 || []) {
    out.push(normalizeClaudeFile(file, message, messageIndex, owner, "files_v2", branchPath));
  }

  for (const file of message.generated_files || []) {
    out.push(normalizeClaudeFile(file, message, messageIndex, owner, "generated_files", branchPath));
  }

  return dedupeFiles(out);
}

function normalizeClaudeFile(file, message, messageIndex, owner, source, branchPath) {
  const id = String(
    file.uuid
      || file.id
      || file.file_uuid
      || file.file_id
      || file.name
      || file.file_name
      || ""
  );
  const name = file.file_name || file.name || file.filename || id || "attachment";
  const mime = file.mime_type || file.file_type || file.type || "";
  const out = {
    messageIndex,
    messageId: message.uuid || null,
    owner,
    id,
    name,
    mime,
    size: file.file_size || file.size || null,
    kind: inferFileKind(name, mime),
    source
  };

  if (file.file_uuid) out.fileUuid = file.file_uuid;
  if (file.path) out.path = file.path;
  if (file.preview_url) out.previewUrl = file.preview_url;
  if (file.document_asset && file.document_asset.url) out.documentAssetUrl = file.document_asset.url;

  if (Array.isArray(branchPath)) {
    out.branchPath = branchPath.slice();
  }

  return out;
}

function dedupeFiles(files) {
  const seen = new Set();
  const out = [];

  for (const file of files) {
    const key = `${file.source}:${file.id}:${file.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }

  return out;
}

function inferFileKind(name, mime) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  const type = String(mime || "").toLowerCase();

  if (type.startsWith("image/") || /^(png|jpe?g|gif|webp|svg|heic|avif)$/.test(ext)) {
    return "image";
  }

  if (
    type.includes("pdf")
    || type.includes("document")
    || /^(pdf|docx?|txt|md|csv|xlsx?|pptx?|json|rtf)$/.test(ext)
  ) {
    return "document";
  }

  return "file";
}

function buildClaudeDomFallbackExport(conversationId, apiError) {
  const messages = getVisibleClaudeMessages();
  const files = [];

  return {
    exportedAt: new Date().toISOString(),
    source: "claude-dom-fallback",
    exportMode: CLAUDE_EXPORT_MODE_CURRENT,
    apiError: apiError && apiError.message ? apiError.message : null,
    url: location.href,
    conversationId,
    title: resolveClaudeDomTitle(),
    create_time: null,
    update_time: null,
    counts: {
      messages: messages.length,
      user: messages.filter((message) => message.role === "user").length,
      assistant: messages.filter((message) => message.role === "assistant").length,
      files: files.length
    },
    messages,
    files
  };
}

function getVisibleClaudeMessages() {
  const knownMessages = getVisibleClaudeMessagesFromKnownSelectors();
  if (knownMessages.length) return knownMessages;

  return getVisibleClaudeMessagesFromActionGroups();
}

function getVisibleClaudeMessagesFromKnownSelectors() {
  const selectors = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    '[data-is-streaming]',
    '[data-message-author-role]'
  ].join(",");

  const elements = Array.from(document.querySelectorAll(selectors));
  return normalizeDomMessageElements(elements.map((element) => {
    const testId = element.getAttribute("data-testid") || "";
    const authorRole = element.getAttribute("data-message-author-role") || "";
    const role = /user|human/i.test(testId) || /user|human/i.test(authorRole)
      ? "user"
      : "assistant";

    return { element, role };
  }));
}

function getVisibleClaudeMessagesFromActionGroups() {
  const groups = Array.from(document.querySelectorAll('[role="group"][aria-label="Message actions"]'));

  return normalizeDomMessageElements(groups.map((group) => {
    const role = group.querySelector('button[aria-label*="positive feedback" i], button[aria-label*="negative feedback" i]')
      ? "assistant"
      : "user";
    const element = findLikelyMessageContainer(group);
    return { element, role };
  }).filter((item) => item.element));
}

function normalizeDomMessageElements(items) {
  const seen = new Set();
  const out = [];

  items
    .map((item) => ({
      ...item,
      y: item.element.getBoundingClientRect().top + window.scrollY,
      text: cleanDomText(item.element)
    }))
    .filter((item) => item.text)
    .sort((left, right) => left.y - right.y)
    .forEach((item) => {
      const key = `${item.role}:${item.text}`;
      if (seen.has(key)) return;
      seen.add(key);

      out.push({
        index: out.length,
        id: null,
        role: item.role,
        model: null,
        create_time: null,
        text: item.text,
        files: []
      });
    });

  return out;
}

function findLikelyMessageContainer(actionGroup) {
  let current = actionGroup;

  for (let depth = 0; current && depth < 8; depth++) {
    const text = cleanDomText(current);
    if (text.length > 20 && text.length < 50000) {
      return current;
    }
    current = current.parentElement;
  }

  return actionGroup.parentElement;
}

function cleanDomText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll("button, svg, nav, menu, textarea, input, [role='group'][aria-label='Message actions']").forEach((node) => node.remove());

  return (clone.innerText || clone.textContent || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveClaudeDomTitle() {
  const titleEl = document.querySelector(
    '[data-testid="chat-title-button"] .truncate, button[data-testid="chat-title-button"] div.truncate'
  );
  const title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
  if (title && title !== "Claude") return title;
  return document.title || "Claude conversation";
}

function downloadAndReturn(out, downloadName) {
  downloadJson(out, downloadName);

  out.downloadName = downloadName;
  window.__lastClaudeExport = out;
  console.log("[claude-export] DONE", out.source, out.totalCounts || out.counts);
  console.table(out.files || []);

  return out;
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
