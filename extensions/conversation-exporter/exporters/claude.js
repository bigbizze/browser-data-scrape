var CLAUDE_EXPORT_MODE_CURRENT = "current-branch";
var CLAUDE_EXPORT_MODE_ALL = "all-branches";
var CLAUDE_EXPORT_MODE_DOWNLOAD_FILES = "download-files-all";
var CLAUDE_EXPORT_MODE_BUNDLE = "conversation-and-files";
var CLAUDE_BRANCH_STRUCTURE = "segment-tree";
var CLAUDE_ROOT_PARENT_UUID = "00000000-0000-4000-8000-000000000000";
var CLAUDE_FILE_DOWNLOAD_CONCURRENCY = 10;
var claudeToolCallCache = new WeakMap();

(async () => {
  if (window.__claudeInventoryOnly) return;
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
  if (mode === CLAUDE_EXPORT_MODE_BUNDLE) return CLAUDE_EXPORT_MODE_BUNDLE;
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
      if (exportMode === CLAUDE_EXPORT_MODE_DOWNLOAD_FILES || exportMode === CLAUDE_EXPORT_MODE_BUNDLE) {
        const history = exportMode === CLAUDE_EXPORT_MODE_BUNDLE
          ? buildClaudeAllBranchesExport(data, conversationId, orgId) : null;
        return downloadClaudeConversationFiles(data, conversationId, orgId, history);
      }

      const out = exportMode === CLAUDE_EXPORT_MODE_ALL
        ? buildClaudeInventory(data, conversationId, orgId).history
        : buildClaudeCurrentBranchExport(data, conversationId, orgId);
      if (exportMode !== CLAUDE_EXPORT_MODE_ALL) out.fileInventory = buildClaudeInventory({...data, chat_messages:getActiveClaudeThread(data)}, conversationId, orgId).history.fileInventory;
      const downloadName = exportMode === CLAUDE_EXPORT_MODE_ALL
        ? `claude-all-branches-export-${Date.now()}.json`
        : `claude-export-${Date.now()}.json`;

      return downloadAndReturn(out, downloadName);
    } catch (error) {
      apiError = error;
      console.warn(`[claude-export] API export failed for org ${orgId}`, error);
    }
  }

  if (exportMode === CLAUDE_EXPORT_MODE_ALL || exportMode === CLAUDE_EXPORT_MODE_BUNDLE) {
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

  const response = await fetchClaudeWithRetry(url, {
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  }, { label: "Conversation" });

  if (!response.ok) {
    throw new Error(`Conversation request failed with HTTP ${response.status}.`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.chat_messages)) {
    throw new Error("Unexpected Claude response with no chat_messages array.");
  }

  return data;
}

async function fetchClaudeWiggleFiles(conversationId, orgId) {
  const url = `${location.origin}/api/organizations/${encodeURIComponent(orgId)}`
    + `/conversations/${encodeURIComponent(conversationId)}`
    + "/wiggle/list-files?prefix=";

  const response = await fetchClaudeWithRetry(url, {
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  }, { label: "Workspace file list" });

  if (!response.ok) {
    throw new Error(`Workspace file list request failed with HTTP ${response.status}.`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.files)) {
    throw new Error("Unexpected Claude workspace file list response.");
  }

  return data;
}

async function downloadClaudeConversationFiles(data, conversationId, orgId, history = null) {
  const inventory = buildClaudeInventory(data, conversationId, orgId);
  const files = inventory.files;
  await addClaudePublishedArtifactFiles(files, data, orgId, inventory);

  try {
    addClaudeWiggleFiles(files, await fetchClaudeWiggleFiles(conversationId, orgId), conversationId, orgId);
  } catch (error) {
    inventory.discoveryFailures.push({kind:"workspace-list", error:error.message});
    if (history) history.warnings = [...(history.warnings || []), `Workspace file discovery failed: ${error.message || error}`];
    console.warn("[claude-export] Workspace file list unavailable", error);
  }

  if (history) history.fileInventory = {stage:"discovery", files:files.map(claudeInventoryDescriptor), artifacts:inventory.artifacts, discoveryFailures:inventory.discoveryFailures};
  const archiveName = makeClaudeFilesArchiveName(data, conversationId).replace(/-files\.zip$/, history ? "-complete.zip" : "-files.zip");
  const downloadResult = await downloadClaudeFilesToZip(files, archiveName, history, inventory.discoveryFailures, orgId);
  const results = downloadResult.results;

  const failures = results.filter((result) => !result.ok);
  const successful = results.filter((result) => result.ok);
  const downloaded = successful.length;


  const out = {
    exportedAt: new Date().toISOString(),
    source: "claude-api-files",
    exportMode: history ? CLAUDE_EXPORT_MODE_BUNDLE : CLAUDE_EXPORT_MODE_DOWNLOAD_FILES,
    url: location.href,
    conversationId: data.uuid || conversationId,
    organizationId: orgId,
    title: data.name || document.title || "Claude conversation",
    counts: {
      messages: history ? history.totalCounts.messages : (Array.isArray(data.chat_messages) ? data.chat_messages.length : 0),
      ...(history ? { leafBranches: history.totalCounts.leafBranches } : {}),
      files: results.length,
      downloaded,
      failed: failures.length,
      versions: downloadResult.versionCount,
      discoveryFailures: inventory.discoveryFailures.length,
      cleanupFailures: downloadResult.cleanupFailures.length
    },
    downloadName: downloadResult.downloadName,
    files,
    failures
  };

  window.__lastClaudeFileDownload = out;
  console.log("[claude-export] FILE DOWNLOAD DONE", out.counts);
  return out;
}

async function downloadClaudeFilesToZip(files, archiveName, history = null, discoveryFailures = [], orgId = null) {
  const zip = createZipAccumulator();
  reserveConversationBundlePaths(files, history);
  await addConversationBundleDocs(zip, 'claude', history);
  if (history) await addJsonZipEntry(zip, "conversation.json", history);
  const results = [], manifest = [], cleanupFailures = [], copyFallbacks = [];
  const copies = createClaudeCopyManager(orgId);
  const rateLimitGate = createClaudeRateLimitGate();
  // Serialize copy lifecycles and ZIP insertion. Account state must be checked before each POST.
  async function processFile(file) {
    let receipt = null;
    const records = [];
    let outputTargets = file.copyTargets || [file];
    try {
      if (file.copyEligible) {
        file.routesAttempted ||= [{route:'direct', outcome:'unavailable', error:file.error}];
        receipt = await copies.acquire(file);
        if (receipt.sourceVersionError) throw new Error(receipt.sourceVersionError);
        const metadata = receipt.metadata;
        if (!metadata.assetToken) throw new Error('Copy access token unavailable');
        if (!Array.isArray(metadata.files) || !metadata.files.length) throw new Error('Copy source file list unavailable');
        const requested = file.copyTargets;
        const sourceFiles = requested ? metadata.files.filter(item => requested.some(f => f.sourcePath === item.path)) : metadata.files;
        if (requested && sourceFiles.length !== requested.length) throw new Error('Copy does not contain all requested source paths');
        if (!requested) outputTargets = sourceFiles.map(item => ({...file, id:`${file.artifactId}/${file.version}/${item.path}`, name:item.path}));
        for (const item of sourceFiles) {
          const target = requested?.find(f => f.sourcePath === item.path) || file;
          const copyFile = {...target, routesAttempted:[...(target.routesAttempted || []), {route:'temporary-copy', outcome:receipt.reused ? 'reused' : 'created'}], error:null, copyEligible:false, provenance:'exported-through-copy',
            id:`${file.artifactId}/${file.version}/${item.path}`, name:item.path,
            zipPath:target.zipPath || `artifacts/${file.artifactId}/${file.version}/${item.path}`, size:item.size_bytes ?? item.size ?? null,
            url:claudeSourceUrl(receipt.copyId, metadata.ver, item.path, metadata.assetToken), credentials:'omit'};
          const entry = await fetchClaudeDownloadEntry(copyFile, rateLimitGate);
          const path = (history ? 'files/' : '') + copyFile.zipPath;
          await zip.addEntry({...entry, name:path});
          records.push(await claudeManifestEntry(copyFile, entry, path));
        }
      } else {
        const entry = await fetchClaudeDownloadEntry(file, rateLimitGate);
        const path = (history ? 'files/' : '') + (file.zipPath || file.downloadName || entry.name);
        await zip.addEntry({...entry, name:path});
        records.push(await claudeManifestEntry(file, entry, path));
      }
      for (const target of outputTargets) results.push({file:target, ok:true});
    } catch (error) {
      if (!file.copyEligible && file.copyCapable && [403,404,410].includes(error.status)) {
        copyFallbacks.push(file);
        return;
      }
      if (error.retainedCopy) cleanupFailures.push({kind:'cleanup', ...error.retainedCopy});
      for (const target of outputTargets) {
        const stored = records.some(r => r.id === target.id && r.sha256);
        results.push({file:target, ok:stored, ...(!stored ? {error:error.message, status:error.status || null} : {})});
        if (!stored) records.push({id:target.id, artifactId:target.artifactId, filename:target.name, source:target.source, version:target.version,
          associations:target.associations || [], routesAttempted:[...(target.routesAttempted || []), ...(file.copyEligible ? [{route:'temporary-copy',outcome:'failed',error:error.message}] : [])], error:error.message});
      }
    } finally {
      if (receipt) {
        const cleanup = receipt.reused ? {copyId:receipt.copyId, cleanup:'reused-not-deletable'} : await copies.cleanup(receipt);
        for (const record of records) record.temporaryCopy = cleanup;
        if (cleanup.cleanup === 'failed') cleanupFailures.push({kind:'cleanup', ...cleanup});
      }
      manifest.push(...records);
    }
  }
  const ordinary = files.filter(f => !f.copyEligible);
  let next = 0;
  await Promise.all(Array.from({length:Math.min(CLAUDE_FILE_DOWNLOAD_CONCURRENCY, ordinary.length)}, async () => {
    while (next < ordinary.length) await processFile(ordinary[next++]);
  }));
  for (const file of files.filter(f => f.copyEligible)) await processFile(file);
  const groups = new Map();
  for (const file of copyFallbacks) {
    const key = `${file.artifactId}/${file.version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  for (const targets of groups.values()) await processFile({...targets[0], copyEligible:true, copyTargets:targets});
  const failures = [...discoveryFailures, ...results.filter(r => !r.ok).map(r => ({kind:'download', id:r.file.id, error:r.error})), ...cleanupFailures];
  await addJsonZipEntry(zip, 'export-manifest.json', {schemaVersion:1, exportedAt:new Date().toISOString(), candidates:manifest, discoveryFailures, cleanupFailures});
  if (failures.length) await addJsonZipEntry(zip, 'export-failures.json', failures);
  downloadBlob(zip.toBlob(), archiveName);
  return {results, downloadName:archiveName, cleanupFailures,
    versionCount:new Set(manifest.filter(m => m.sha256 && m.version).map(m => `${m.artifactId}/${m.version}`)).size};
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
      normalized.associations = [{messageId:normalized.messageId, relationship:source}];
      if (seen.has(key)) {
        const existing = files.find(f => getClaudeDownloadFileKey(f) === key);
        existing.associations.push(...normalized.associations);
        return;
      }
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

  files.push(...getClaudeWrittenArtifactFiles(messages));
  applyUniqueDownloadNames(files);
  return files;
}

function addClaudeWiggleFiles(files, listData, conversationId, orgId) {
  const metadataByPath = new Map();
  const metadataList = Array.isArray(listData && listData.files_metadata) ? listData.files_metadata : [];
  const seen = new Set(files.map((file) => getClaudeDownloadFileKey(file)));

  for (const metadata of metadataList) {
    if (metadata && typeof metadata.path === "string") {
      metadataByPath.set(metadata.path, metadata);
    }
  }

  for (const path of Array.isArray(listData && listData.files) ? listData.files : []) {
    const normalized = normalizeClaudeWiggleFile(path, metadataByPath.get(path), conversationId, orgId);
    if (!normalized) continue;

    const key = getClaudeDownloadFileKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(normalized);
  }

  applyUniqueDownloadNames(files);
}

function normalizeClaudeWiggleFile(path, metadata, conversationId, orgId) {
  if (!path || typeof path !== "string" || !conversationId || !orgId) return null;

  const customMetadata = metadata && metadata.custom_metadata && typeof metadata.custom_metadata === "object"
    ? metadata.custom_metadata
    : {};
  const rawName = customMetadata.filename || path.split("/").filter(Boolean).pop() || "claude-file";
  const name = sanitizeDownloadName(rawName);
  const mime = (metadata && metadata.content_type) || "";

  return {
    messageIndex: null,
    messageId: null,
    owner: "workspace",
    id: path,
    name,
    downloadName: name,
    downloadNameBase: name,
    zipPath: makeClaudeWiggleZipPath(path, name),
    mime,
    size: metadata && Number.isFinite(metadata.size) ? metadata.size : null,
    kind: inferFileKind(name, mime),
    source: "wiggle-list-files",
    url: `${location.origin}/api/organizations/${encodeURIComponent(orgId)}`
      + `/conversations/${encodeURIComponent(conversationId)}`
      + `/wiggle/download-file?path=${encodeURIComponent(path)}`
  };
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
    downloadNameBase: name,
    mime: textContent === null ? mime : "text/plain;charset=utf-8",
    size: file.size_bytes ?? file.file_size ?? file.size ?? null,
    kind: textContent === null ? inferFileKind(name, mime) : "document",
    source,
    url
  };

  out.path = file.path || null;
  out.workspaceUrl = file.path && conversationId && orgId ? claudeWorkspaceUrl(file.path, conversationId, orgId) : null;
  out.provenance = textContent !== null ? "extracted-text" : "original-source";
  if (textContent !== null) { out.content = textContent; out.size = null; }
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
      downloadNameBase: sanitizeDownloadName(rawName),
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

// Save recorded source separately from the live published artifact. It may predate
// changes made through shell commands or external tools.
function getClaudeWrittenArtifactFiles(messages) {
  const byId = new Map(messages.filter(Boolean).map((message) => [message.uuid, message]));
  const statesById = new Map();
  const visiting = new Set();
  const failed = new Set(messages.flatMap((message) => Array.isArray(message && message.content) ? message.content : [])
    .filter((block) => block && block.type === "tool_result" && block.is_error)
    .map((block) => block.tool_use_id));
  const out = [];
  function visit(message, messageIndex) {
    if (!message || statesById.has(message.uuid)) return statesById.get(message && message.uuid) || new Map();
    if (visiting.has(message.uuid)) return new Map();
    visiting.add(message.uuid);
    const parent = byId.get(message.parent_message_uuid);
    const states = new Map(parent ? visit(parent, messages.indexOf(parent)) : []);
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_use" || failed.has(block.id)) continue;
      const input = block.input;
      if (!input || typeof input !== "object") continue;
      const path = input.file_path;
      if (block.name === "Write" && typeof path === "string" && typeof input.content === "string") {
        states.set(path, input.content);
      } else if (block.name === "Edit" && typeof path === "string") {
        const previous = states.get(path);
        const old = input.old_string;
        if (typeof previous !== "string" || typeof old !== "string" || !old
            || typeof input.new_string !== "string" || !previous.includes(old)
            || (!input.replace_all && previous.indexOf(old) !== previous.lastIndexOf(old))) {
          states.delete(path);
          continue;
        }
        states.set(path, input.replace_all
          ? previous.split(old).join(input.new_string)
          : previous.replace(old, () => input.new_string));
      } else if (block.name === "Bash") {
        states.clear(); // Shell mutations cannot be reconstructed safely.
      } else if (block.name === "Artifact" || block.name === "SendUserFile") {
        const paths = block.name === "Artifact" ? [path] : input.files;
        for (const path of Array.isArray(paths) ? paths : []) {
          if (typeof path !== "string" || !states.has(path)) continue;
          const name = sanitizeDownloadName(path);
          out.push({
            messageIndex, messageId: message.uuid || null,
            owner: normalizeClaudeRole(message.sender) || "unknown",
            id: block.id || path, name, downloadName: name, downloadNameBase: name,
            zipPath: `recorded-source/${name}`,
            mime: "text/plain;charset=utf-8", kind: "document",
            provenance: "reconstructed-source", exactSnapshot: false, source: "artifact-recorded-source", url: "", content: states.get(path)
          });
        }
      }
    }
    visiting.delete(message.uuid);
    statesById.set(message.uuid, states);
    return states;
  }
  messages.forEach(visit);
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
  // Image previews can be resized; their bytes do not match original size metadata.
  if (file.file_kind === "image" && file.file_uuid && orgId) {
    return `${location.origin}/api/organizations/${encodeURIComponent(orgId)}/files/${encodeURIComponent(file.file_uuid)}/contents`;
  }
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

  return file.path && orgId && conversationId ? claudeWorkspaceUrl(file.path, conversationId, orgId) : "";
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
  const used = new Set();
  for (const file of files) {
    const base = file.zipPath
      ? sanitizeZipEntryName(file.zipPathBase || file.zipPath)
      : sanitizeDownloadName(file.downloadNameBase || file.name || "claude-file");
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) name = addFileNameSuffix(base, suffix++);
    used.add(name.toLowerCase());
    if (file.zipPath) {
      file.zipPathBase = base;
      file.zipPath = name;
    }
    file.downloadName = name;
  }
}

function makeClaudeWiggleZipPath(path, fallbackName) {
  const withoutRoot = String(path || "")
    .replace(/^\/+mnt\/user-data\/+/i, "")
    .replace(/^\/+/, "");
  const sanitized = sanitizeZipEntryName(withoutRoot);
  return sanitized === "claude-file" ? sanitizeZipEntryName(fallbackName) : sanitized;
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

async function fetchClaudeDownloadEntry(file, rateLimitGate = null) {
  if (file.error) throw new Error(file.error);
  if (file.content !== undefined) {
    const bytes = new TextEncoder().encode(String(file.content));
    return {
      parts: [bytes],
      size: bytes.length,
      crc: crc32(bytes),
      name: file.downloadName
    };
  }

  file.routesAttempted ||= [];
  const routes = [{route:'direct', url:file.url}, {route:'workspace', url:file.workspaceUrl}]
    .filter((r, i, all) => r.url && all.findIndex(other => other.url === r.url) === i);
  let lastError = new Error('No eligible download route');
  for (const route of routes) {
    try {
      const response = await fetchClaudeWithRetry(route.url, {credentials:file.credentials || 'include', headers:{Accept:'*/*'}}, {label:'File', rateLimitGate});
      const entry = await readResponseZipEntryParts(response);
      const length = response.headers.get('content-length');
      if (new URL(route.url, location.origin).origin === location.origin && length !== null && length !== '' && !response.headers.get('content-encoding') && Number(length) !== entry.size) throw new Error('Downloaded byte count differs from Content-Length');
      if (Number.isFinite(file.size) && file.size !== entry.size) throw new Error('Downloaded byte count differs from file metadata');
      file.routesAttempted.push({route:route.route, outcome:'downloaded', bytes:entry.size});
      return {...entry, name:file.downloadName || file.name};
    } catch (error) {
      lastError = error;
      file.routesAttempted.push({route:route.route, outcome:'failed', status:error.status || null, error:error.message});
      if (error.rateLimited || ![403,404,410].includes(error.status)) break;
    }
  }
  throw lastError;
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

async function fetchClaudeWithRetry(url, init, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 10;
  const label = options.label || "Request";
  const rateLimitGate = options.rateLimitGate || null;
  let lastResponse = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForClaudeRateLimitGate(rateLimitGate);
    const response = await fetch(url, init);
    if (response.ok) return response;

    lastResponse = response;
    if (response.status !== 429 || attempt >= retries) break;

    const delayMs = getClaudeRetryDelayMs(response, attempt);
    console.warn(`[claude-export] ${label} was rate limited; retrying in ${delayMs}ms.`);
    await pauseClaudeRateLimitGate(rateLimitGate, delayMs);
  }

  const error = new Error(`${label} request failed with HTTP ${lastResponse ? lastResponse.status : "unknown"}.`);
  if (lastResponse) {
    error.status = lastResponse.status;
    error.rateLimited = lastResponse.status === 429;
    if (error.rateLimited) {
      const retryAfter = lastResponse.headers && lastResponse.headers.get("retry-after");
      error.message = `${label} request was rate limited by Claude${retryAfter ? `; retry after ${retryAfter}` : ""}.`;
    }
  }
  throw error;
}

function createClaudeRateLimitGate() {
  return {
    waitUntil: 0,
    promise: null
  };
}

async function waitForClaudeRateLimitGate(gate) {
  if (!gate) return;
  while (gate.promise && Date.now() < gate.waitUntil) {
    await gate.promise;
  }
}

async function pauseClaudeRateLimitGate(gate, delayMs) {
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

function getClaudeRetryDelayMs(response, attempt) {
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
      const packed = await compressConversationZipParts(parts, size, entry.name);
      appendZipEntry(entry, packed.parts, size, crc, packed.method, packed.compressedSize);
    },

    toBlob() {
      return finalizeZipBlob();
    }
  };

  function appendZipEntry(entry, parts, size, crc, method, compressedSize) {
    const nameBytes = new TextEncoder().encode(sanitizeZipEntryName(entry.name));
    const time = getZipDosTime(entry.lastModified || new Date());
    const date = getZipDosDate(entry.lastModified || new Date());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressedSize, true);
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
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressedSize, true);
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
    offset += localHeader.length + compressedSize;
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

  return parts.join("/") || "claude-file";
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
  const blocks = getClaudeBlocks(claudeFilterMessage(message, claudeToolCalls(data)));
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
    if (typeof part.tool_use_id === "string") block.tool_use_id = part.tool_use_id;

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
    size: file.size_bytes ?? file.file_size ?? file.size ?? null,
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

async function addJsonZipEntry(zip, name, data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
  await zip.addEntry({ name, parts: [bytes], size: bytes.length, crc: crc32(bytes), lastModified: new Date() });
}

// Inventory is shared by previews, transcripts and downloads. No account mutations here.
function claudeToolCalls(data) {
  if (!claudeToolCallCache.has(data)) claudeToolCallCache.set(data, new Map((data.chat_messages || []).flatMap(m => m.content || [])
    .filter(b => b && b.type === 'tool_use').map(b => [b.id, b])));
  return claudeToolCallCache.get(data);
}
function claudeQuickstart(call) {
  return call && (call.name === 'Artifact.quickstart' || (call.name === 'Artifact' && call.input?.action === 'quickstart'));
}
function claudeFilterMessage(message, calls) {
  function filter(value) {
    if (typeof value === 'string') {
      const end = value.indexOf('For a plain page,');
      if (value.includes('type_url') && end >= 0) return '[Built-in artifact template catalogue and template-link instructions omitted.]\n\n' + value.slice(end);
      return value;
    }
    if (Array.isArray(value)) return value.map(filter);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, filter(v)]));
    return value;
  }
  return {...message, content: (message.content || []).map(b =>
    b?.type === 'tool_result' && claudeQuickstart(calls.get(b.tool_use_id)) ? filter(b) : b)};
}
function claudeWorkspaceUrl(path, conversationId, orgId) {
  return `${location.origin}/api/organizations/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/wiggle/download-file?path=${encodeURIComponent(path)}`;
}
function claudeAssociation(message, block, relationship, branches) {
  return {messageId: message.uuid, parentMessageId: message.parent_message_uuid || null,
    branchPath: branches.get(message.uuid) || [], toolCallId: block?.tool_use_id || block?.id || null, relationship};
}
function buildClaudeInventory(data, conversationId, orgId) {
  const calls = claudeToolCalls(data), branches = new Map();
  const history = buildClaudeAllBranchesExport(data, conversationId, orgId);
  function index(node) { for (const m of node.messages) branches.set(m.id, node.branchPath); node.branches.forEach(index); }
  index(history);
  const files = collectClaudeDownloadableFiles(data, conversationId, orgId);
  const artifacts = new Map();
  for (const file of files) file.associations = (file.associations || [{messageId:file.messageId, relationship:file.source}]).map(a => ({...a, branchPath:branches.get(a.messageId) || []}));
  for (const message of data.chat_messages || []) {
    for (const b of message.content || []) {
      if (!b || typeof b !== 'object') continue;
      const call = b.type === 'tool_result' ? calls.get(b.tool_use_id) : b.type === 'tool_use' ? b : null;
      if (b.is_error || claudeQuickstart(call)) continue;
      const action = call?.input?.action || call?.name?.split('.').at(-1);
      const relationship = /list/i.test(action || '') ? 'listed' : /read|get/i.test(action || '') ? 'read' : /publish|update|create/i.test(action || '') ? 'published' : 'explicitly-linked';
      const association = claudeAssociation(message, b, relationship, branches);
      const text = JSON.stringify(b);
      if (b.type === 'tool_result' && /(?:^|\.)SendUserFile$/.test(call?.name || '')) {
        // Receipts supply the identity of delivered bytes, even when Bash created the file.
        const receipt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        for (const match of receipt.matchAll(/([^\s"\\]+)\s*→\s*file_uuid:\s*([0-9a-f-]{36})/gi)) {
          const path = match[1], id = match[2];
          const file = normalizeClaudeDownloadableFile({file_uuid:id, file_kind:'blob', path}, message, null, 'assistant', 'delivered', conversationId, orgId);
          file.associations = [{...association, relationship:'delivered'}];
          files.push(file);
        }
      }
      for (const match of text.matchAll(/https:\/\/claude\.ai\/artifact\/([A-Za-z0-9_-]+)/g)) {
        const slug = match[1];
        if (/^(PENDING|PLACEHOLDER)$/i.test(slug)) continue;
        if (!artifacts.has(slug)) artifacts.set(slug, {slug, artifactUrl:`https://claude.ai/artifact/${slug}`, associations:[], explicitVersions:[]});
        const artifact = artifacts.get(slug);
        artifact.associations.push(association);
        if ([...text.matchAll(/https:\/\/claude\.ai\/artifact\/([A-Za-z0-9_-]+)/g)].length === 1) {
          const eventVersions = [...text.matchAll(/(?:version|ver)[\s\"':=]+(\d{10}-[0-9a-f]{4})\b/gi)].map(v => v[1]);
          association.versions = eventVersions;
          for (const v of eventVersions) if (!artifact.explicitVersions.includes(v)) artifact.explicitVersions.push(v);
        }
      }
    }
  }
  const unique = new Map();
  for (const file of files) {
    const key = getClaudeDownloadFileKey(file);
    if (unique.has(key)) unique.get(key).associations.push(...file.associations);
    else unique.set(key, file);
  }
  const result = [...unique.values()];
  applyUniqueDownloadNames(result);
  history.fileInventory = {stage:"discovery", files:result.map(claudeInventoryDescriptor), artifacts:[...artifacts.values()], discoveryFailures:[]};
  return {files:result, artifacts:[...artifacts.values()], discoveryFailures:[], history};
}
function collectClaudePublishedArtifactUrls(data) {
  return buildClaudeInventory(data, data.uuid || 'unknown', '').artifacts.map(a => a.artifactUrl);
}
async function claudeFrame(path, orgId, init = {}) {
  return fetchClaudeWithRetry(`${location.origin}/api/frame/${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgId)}`,
    {...init, credentials:'include', headers:{'x-frame-cp':'go'}}, {label:'Artifact API', retries:init.method ? 0 : 10});
}
function claudeSourceUrl(id, version, path, token) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid artifact source path');
  const url = new URL(`https://${id}.frame.claudeusercontent.com/_f/${encodeURIComponent(version)}/_src/${path.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('__frame_t', token);
  return url.href;
}
async function addClaudePublishedArtifactFiles(files, data, orgId, inventory = null) {
  const refs = (inventory || buildClaudeInventory(data, data.uuid, orgId)).artifacts;
  for (const ref of refs) {
    try {
      const response = await fetchClaudeWithRetry(ref.artifactUrl, {credentials:'include'});
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const id = doc.documentElement.dataset.frameUuid;
      if (!/^[0-9a-f-]{36}$/i.test(id || '') || doc.documentElement.dataset.frameUchost !== `${id}.frame.claudeusercontent.com`) throw new Error('Invalid artifact identity');
      const metadata = await (await claudeFrame(id, orgId)).json();
      let versions = {history:[], versions:{}};
      try { versions = await (await claudeFrame(`versions/${id}`, orgId)).json(); }
      catch (error) { inventory?.discoveryFailures.push({kind:'version-discovery', artifactId:id, error:error.message}); }
      const ids = new Set([metadata.ver, ...(versions.history || []), ...(metadata.history || []), ...ref.explicitVersions].filter(Boolean));
      if (!ids.size) throw new Error('Artifact has no available version identity');
      for (const version of ids) {
        const info = versions.versions?.[version] || {};
        let token = version === metadata.ver ? metadata.assetToken : null;
        if (!token && info.thumb_img_url) token = new URL(info.thumb_img_url).searchParams.get('__frame_t');
        const base = {artifactId:id, artifactUrl:ref.artifactUrl, version, versionLabel:info.label || null, versionDate:info.created_at || null,
          associations:ref.associations.filter(a => !a.versions?.length || a.versions.includes(version)), source:'artifact-published-source', provenance:'original-source', orgId, copyCapable:version === metadata.ver && (metadata.duplicable === true || metadata.duplicateAvailable === true)};
        if (!token) {
          files.push({...base, id:`${id}/${version}`, name:metadata.title || ref.slug, downloadName:ref.slug,
            copyEligible:version === metadata.ver && (metadata.duplicable === true || metadata.duplicateAvailable === true),
            error:version === metadata.ver ? 'Artifact access token unavailable' : 'Historical version access token unavailable'});
          continue;
        }
        let sourceFiles = version === metadata.ver ? metadata.files : null;
        if (!sourceFiles) {
          // Old versions must not silently inherit the current supporting-file list.
          try {
            const url = claudeSourceUrl(id, version, 'index.html', token).replace('/_src/index.html', '/_files.json');
            const listing = await (await fetchClaudeWithRetry(url, {credentials:'omit'}, {label:'Version file list'})).json();
            sourceFiles = Array.isArray(listing) ? listing : listing.files;
          } catch (error) {
            inventory?.discoveryFailures.push({kind:'version-file-list', artifactId:id, version, error:error.message});
            sourceFiles = [{path:'index.html'}]; // Retrieve the known HTML entry; report the unknown supporting list.
          }
        }
        if (!Array.isArray(sourceFiles) || !sourceFiles.length) {
          files.push({...base, id:`${id}/${version}`, name:ref.slug, downloadName:ref.slug, error:'Artifact source file list unavailable'});
          continue;
        }
        for (const item of sourceFiles) {
          const path = typeof item === 'string' ? item : item?.path;
          const file = {...base, routesAttempted:[], sourcePath:path, id:`${id}/${version}/${path}`, name:typeof path === 'string' ? path : 'invalid-source-path', downloadName:typeof path === 'string' ? path : 'invalid-source-path'};
          try {
            file.url = claudeSourceUrl(id, version, path, token);
            file.zipPath = `artifacts/${id}/${version}/${path}`;
            file.size = item.size_bytes ?? item.size ?? null;
            file.credentials = 'omit';
          } catch (error) { file.error = error.message; }
          files.push(file);
        }
      }
    } catch (error) { files.push({...ref, id:ref.slug, name:ref.slug, downloadName:ref.slug, error:error.message}); }
  }
  const unique = new Map();
  for (const file of files) {
    const key = getClaudeDownloadFileKey(file);
    if (unique.has(key)) unique.get(key).associations = [...(unique.get(key).associations || []), ...(file.associations || [])];
    else unique.set(key, file);
  }
  files.splice(0, files.length, ...unique.values());
  applyUniqueDownloadNames(files);
}

// Only this closure can mint cleanup receipts. Stored journals confer no deletion authority.
function createClaudeCopyManager(orgId, storage = globalThis.chrome?.storage?.local) {
  const receipts = new WeakSet();
  const run = crypto.randomUUID();
  const journalKey = `claudeExportCopies:${orgId}:${run}`;
  const journal = [];
  const save = () => storage.set({[journalKey]:journal});
  async function inventory() {
    // The observed account-list page size is 60. Without a verified continuation contract, fail closed at that boundary.
    const data = await (await claudeFrame('frames?limit=60', orgId)).json();
    if (!Array.isArray(data.frames) || data.has_more || data.next_cursor || data.cursor || data.frames.length >= 60 || data.frames.some(f => !/^[0-9a-f-]{36}$/i.test(f.slug || ''))) throw new Error('Cannot establish complete pre-copy account inventory');
    return new Set(data.frames.map(f => f.slug.toLowerCase()));
  }
  return {
    async acquire(file) {
      if (!storage) throw new Error('Extension-local journal unavailable; copy creation disabled');
      const old = await storage.get(null);
      for (const [key, rows] of Object.entries(old)) {
        if (!key.startsWith(`claudeExportCopies:${orgId}:`) || !Array.isArray(rows)) continue;
        for (const row of rows) {
          if (row.originalId !== file.artifactId || row.originalVersion !== file.version || row.cleanup === 'deleted' || row.sourceVerified !== true || row.copyId === file.artifactId || !/^[0-9a-f-]{36}$/i.test(row.copyId || '')) continue;
          try {
            const metadata = await (await claudeFrame(row.copyId, orgId)).json();
            if (metadata.assetToken && metadata.ver === row.copyVersion) return {copyId:row.copyId, metadata, reused:true, cleanup:'reused-not-deletable'};
          } catch (error) { if (![403,404,410].includes(error.status)) throw error; }
        }
      }
      const before = await inventory();
      for (const [key, rows] of Object.entries(old)) {
        if (key.startsWith(`claudeExportCopies:${orgId}:`) && Array.isArray(rows)) {
          for (const row of rows) if (typeof row.copyId === 'string') before.add(row.copyId.toLowerCase());
        }
      }
      const account = await (await fetchClaudeWithRetry(`${location.origin}/api/account`, {credentials:"include"})).json();
      if (!account.uuid) throw new Error("Signed-in account identity unavailable");
      const original = await (await claudeFrame(file.artifactId, orgId)).json();
      if (original.ver !== file.version || !(original.duplicable === true || original.duplicateAvailable === true)) throw new Error('Original version or copy capability changed');
      // POST is intentionally never retried, including on 429 or an unreadable response.
      let created;
      try {
        const response = await claudeFrame(`duplicate/${file.artifactId}`, orgId, {method:'POST'});
        created = await response.json();
      } catch (error) {
        const uncertain = {run, originalId:file.artifactId, originalVersion:file.version, cleanup:'creation-unknown', cleanupError:error.message};
        journal.push(uncertain);
        try { await save(); } catch { /* Report uncertainty even if journaling fails. */ }
        throw Object.assign(new Error(`Copy creation outcome unknown: ${error.message}. No automatic retry or deletion.`), {retainedCopy:uncertain});
      }
      const id = typeof created.slug === "string" ? created.slug.toLowerCase() : null;
      if (!/^[0-9a-f-]{36}$/i.test(id || '') || id === file.artifactId.toLowerCase() || before.has(id)) {
        throw Object.assign(new Error('Copy response has unsafe identity; no reliable new copy ID. No deletion permitted.'),
          {retainedCopy:{run, originalId:file.artifactId, originalVersion:file.version, cleanup:'creation-unknown'}});
      }
      const row = {run, originalId:file.artifactId, originalVersion:file.version, copyId:id, copyVersion:created.version, sourceVerified:false, cleanup:'pending', copyUrl:`https://claude.ai/artifact/${id}`};
      journal.push(row);
      // Journal first: a crash after this point can reuse the copy but never delete it in another run.
      const retained = (reason) => {
        row.cleanup = 'identity-unconfirmed'; row.cleanupError = reason;
        return Object.assign(new Error(`${reason}; retained copy ${row.copyUrl}`), {retainedCopy:{...row}});
      };
      try { await save(); } catch { throw retained('Cannot persist copy journal'); }
      let metadata;
      try { metadata = await (await claudeFrame(id, orgId)).json(); } catch (error) { throw retained(error.message); }
      if (created.owned !== true || created.owner_account_id !== account.uuid || metadata.viewer?.owner !== true || metadata.perm?.role !== 'owner' || metadata.ver !== created.version) {
        row.cleanup = 'identity-unconfirmed';
        try { await save(); } catch { /* The first journal already identifies this retained copy. */ }
        throw retained('Copy ownership or version unconfirmed');
      }
      let sourceVersionError = null;
      try {
        const after = await (await claudeFrame(file.artifactId, orgId)).json();
        if (after.ver !== file.version) sourceVersionError = 'Original version changed while copying; copied bytes cannot represent the requested version';
      } catch (error) { sourceVersionError = `Could not verify original version after copying: ${error.message}`; }
      row.sourceVerified = !sourceVersionError;
      try { await save(); } catch (error) { sourceVersionError ||= `Could not persist verified copy mapping: ${error.message}`; }
      const receipt = Object.freeze({copyId:id, originalId:file.artifactId, run, metadata, row, copyVersion:created.version, accountId:account.uuid, sourceVersionError});
      receipts.add(receipt);
      return receipt;
    },
    async cleanup(receipt) {
      if (!receipt || !receipts.has(receipt) || receipt.run !== run) throw new Error('Deletion refused: no creation receipt from this run');
      receipts.delete(receipt); // One attempt only; a replay cannot delete anything.
      try {
        const account = await (await fetchClaudeWithRetry(`${location.origin}/api/account`, {credentials:'include'})).json();
        if (account.uuid !== receipt.accountId) throw new Error('Signed-in account changed; retained');
        const current = await (await claudeFrame(receipt.copyId, orgId)).json();
        if (current.viewer?.owner !== true || current.perm?.role !== 'owner' || current.ver !== receipt.copyVersion) throw new Error('Copy identity, owner or version changed; retained');
        await claudeFrame(receipt.copyId, orgId, {method:'DELETE'});
        receipt.row.cleanup = 'deleted';
      } catch (error) { receipt.row.cleanup = 'failed'; receipt.row.cleanupError = error.message; }
      try { await save(); } catch (error) { receipt.row.journalError = error.message; }
      return {...receipt.row};
    }
  };
}
async function claudeManifestEntry(file, entry, zipPath) {
  const bytes = await new Blob(entry.parts).arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return {id:file.id, artifactId:file.artifactId, filename:file.name, source:file.source,
    associations:file.associations || [], version:file.version, versionLabel:file.versionLabel, versionDate:file.versionDate,
    routesAttempted:file.routesAttempted || [], zipPath, bytes:entry.size,
    sha256:Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join(''),
    provenance:file.provenance || (file.content !== undefined ? 'reconstructed-source' : 'original-source')};
}

function claudeInventoryDescriptor(file) {
  return {id:file.id, name:file.name, source:file.source, provenance:file.provenance,
    path:file.path, artifactId:file.artifactId, version:file.version,
    associations:file.associations || [], copyEligible:Boolean(file.copyEligible), error:file.error || null};
}
