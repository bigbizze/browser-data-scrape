const CHATGPT_CONVERSATION_PATH_RE = /(?:^|\/)c\/[0-9a-f-]{36}(?:\/|$)/i;
const CLAUDE_ID_RE = /^[0-9a-f-]{16,}$/i;
const CHATGPT_EXPORT_MODE_CURRENT = "current-branch";
const CHATGPT_EXPORT_MODE_ALL = "all-branches";
const CHATGPT_EXPORT_MODE_BACKEND_CURRENT = "backend-current";
const CLAUDE_EXPORT_MODE_CURRENT = "current-branch";
const CLAUDE_EXPORT_MODE_ALL = "all-branches";
const CLAUDE_EXPORT_MODE_DOWNLOAD_FILES = "download-files-all";

const buttonArea = document.getElementById("buttonArea");
const statusEl = document.getElementById("status");

function setStatus(message, state = "") {
  statusEl.textContent = message;
  if (state) {
    statusEl.dataset.state = state;
  } else {
    delete statusEl.dataset.state;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getResult(results) {
  if (!Array.isArray(results) || !results[0]) return null;
  return results[0].result || null;
}

function parseHttpUrl(url) {
  try {
    return new URL(url);
  } catch (error) {
    return null;
  }
}

function isChatGptConversationUrl(parsed) {
  return CHATGPT_CONVERSATION_PATH_RE.test(parsed.pathname);
}

function getClaudeConversationId(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const chatIndex = parts.indexOf("chat");
  if (chatIndex >= 0 && parts[chatIndex + 1] && CLAUDE_ID_RE.test(parts[chatIndex + 1])) {
    return parts[chatIndex + 1];
  }

  const lastPart = parts[parts.length - 1] || "";
  return CLAUDE_ID_RE.test(lastPart) ? lastPart : null;
}

function getExportTarget(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed || parsed.protocol !== "https:") return null;

  if (parsed.hostname === "chatgpt.com") {
    return {
      type: "chatgpt",
      label: "ChatGPT",
      script: "exporters/chatgpt.js",
      isConversation: isChatGptConversationUrl(parsed)
    };
  }

  if (parsed.hostname === "claude.ai" || parsed.hostname === "app.claude.ai") {
    return {
      type: "claude",
      label: "Claude",
      script: "exporters/claude.js",
      isConversation: Boolean(getClaudeConversationId(parsed))
    };
  }

  return null;
}

function renderButtons(buttons) {
  buttonArea.replaceChildren();

  for (const config of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = config.label;
    button.disabled = Boolean(config.disabled);
    button.dataset.defaultDisabled = config.disabled ? "true" : "false";
    if (config.variant) button.dataset.variant = config.variant;
    if (config.onClick) button.addEventListener("click", config.onClick);
    buttonArea.appendChild(button);
  }
}

function setButtonsDisabled(disabled) {
  buttonArea.querySelectorAll("button").forEach((button) => {
    button.disabled = disabled || button.dataset.defaultDisabled === "true";
  });
}

function renderDisabledButton(label = "Export conversation") {
  renderButtons([{ label, disabled: true }]);
}

async function initializePopup() {
  renderDisabledButton();
  setStatus("Checking page...");

  const tab = await getActiveTab();
  const url = tab && tab.url ? tab.url : "";

  if (!tab || !tab.id) {
    setStatus("Could not find the active tab.", "error");
    return;
  }

  const target = getExportTarget(url);
  if (!target) {
    setStatus("Open a ChatGPT or Claude conversation first.", "error");
    return;
  }

  if (!target.isConversation) {
    setStatus(`Open a ${target.label} conversation URL first.`, "error");
    return;
  }

  if (target.type === "chatgpt") {
    await initializeChatGptButtons(tab, target);
    return;
  }

  await initializeClaudeButtons(tab, target);
}

async function initializeChatGptButtons(tab, target) {
  setStatus("Checking ChatGPT branches...");
  renderDisabledButton();

  let probe = null;
  try {
    probe = getResult(await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probeChatGptBranchesInPage
    }));
  } catch (error) {
    console.warn("[conversation-exporter] ChatGPT branch probe failed", error);
  }

  if (probe && probe.ok && probe.hasBranches) {
    renderButtons([
      {
        label: "Export current branch",
        onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_CURRENT)
      },
      {
        label: "Export all branches",
        variant: "secondary",
        onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_ALL)
      }
    ]);
    setStatus(`Ready. Found ${probe.branchPoints} branch ${probe.branchPoints === 1 ? "point" : "points"}.`);
    return;
  }

  if (probe && probe.ok) {
    renderButtons([{
      label: "Export conversation",
      onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_BACKEND_CURRENT)
    }]);
    setStatus("Ready.");
  } else {
    renderButtons([{
      label: "Export conversation",
      onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_CURRENT)
    }]);
    setStatus("Ready. Branch detection unavailable.");
  }
}

async function initializeClaudeButtons(tab, target) {
  setStatus("Checking Claude conversation...");
  renderDisabledButton();

  let probe = null;
  try {
    probe = getResult(await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probeClaudeConversationInPage
    }));
  } catch (error) {
    console.warn("[conversation-exporter] Claude probe failed", error);
  }

  const fileCount = probe && probe.ok && Number.isFinite(probe.fileCount) ? probe.fileCount : 0;
  const downloadFilesButton = {
    label: fileCount ? `Download all files (${fileCount})` : "Download all files",
    variant: "secondary",
    disabled: fileCount <= 0,
    onClick: fileCount > 0 ? () => runExport(tab, target, CLAUDE_EXPORT_MODE_DOWNLOAD_FILES) : null
  };

  if (probe && probe.ok && probe.hasBranches) {
    renderButtons([
      {
        label: "Export current branch",
        onClick: () => runExport(tab, target, CLAUDE_EXPORT_MODE_CURRENT)
      },
      {
        label: "Export all branches",
        variant: "secondary",
        onClick: () => runExport(tab, target, CLAUDE_EXPORT_MODE_ALL)
      },
      downloadFilesButton
    ]);
    setStatus(formatClaudeReadyStatus(probe));
    return;
  }

  renderButtons([
    {
      label: "Export conversation",
      onClick: () => runExport(tab, target, CLAUDE_EXPORT_MODE_CURRENT)
    },
    downloadFilesButton
  ]);

  if (probe && probe.ok) {
    setStatus(formatClaudeReadyStatus(probe));
  } else {
    setStatus("Ready. Claude API probe unavailable.");
  }
}

async function runExport(tab, target, mode = null) {
  setButtonsDisabled(true);
  setStatus(`Exporting ${target.label}...`);

  try {
    if (target.type === "chatgpt") {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: setChatGptExportModeInPage,
        args: [mode || CHATGPT_EXPORT_MODE_CURRENT]
      });
    }

    if (target.type === "claude") {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: setClaudeExportModeInPage,
        args: [mode || CLAUDE_EXPORT_MODE_CURRENT]
      });
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [target.script]
    });

    const result = getResult(results);
    if (!result || !result.ok) {
      throw new Error((result && result.error) || "The page did not return an export result.");
    }

    setStatus(formatSuccessStatus(result), "success");
  } catch (error) {
    setStatus(error && error.message ? error.message : String(error), "error");
  } finally {
    setButtonsDisabled(false);
  }
}

function setChatGptExportModeInPage(mode) {
  window.__chatGptExportMode = mode;
}

function setClaudeExportModeInPage(mode) {
  window.__claudeExportMode = mode;
}

function formatSuccessStatus(result) {
  const counts = result.counts || {};

  if (result.exportMode === CLAUDE_EXPORT_MODE_DOWNLOAD_FILES) {
    const fileCount = Number.isFinite(counts.files) ? counts.files : 0;
    const downloaded = Number.isFinite(counts.downloaded) ? counts.downloaded : fileCount;
    const failed = Number.isFinite(counts.failed) ? counts.failed : 0;
    const failureNote = failed ? ` (${failed} failed)` : "";
    return `Downloaded ${downloaded} of ${fileCount} files${failureNote}.`;
  }

  const messageCount = Number.isFinite(counts.messages) ? counts.messages : 0;
  const fileCount = Number.isFinite(counts.files) ? counts.files : 0;
  const fallbackNote = result.source === "claude-dom-fallback" ? " visible" : "";
  const branchNote = result.exportMode === "all-branches" && counts.leafBranches
    ? ` across ${counts.leafBranches} leaf branches`
    : "";

  return `Downloaded ${messageCount}${fallbackNote} messages${branchNote} (${fileCount} files listed).`;
}

function formatClaudeReadyStatus(probe) {
  const parts = ["Ready."];

  if (probe.branchPoints > 0) {
    parts.push(`Found ${probe.branchPoints} branch ${probe.branchPoints === 1 ? "point" : "points"}.`);
  }

  if (probe.fileCount > 0) {
    parts.push(`Found ${probe.fileCount} downloadable ${probe.fileCount === 1 ? "file" : "files"}.`);
  }

  return parts.join(" ");
}

async function probeChatGptBranchesInPage() {
  const conversationId = getConversationId();
  if (!conversationId) {
    return { ok: false, error: "No ChatGPT conversation id found in the URL." };
  }

  try {
    const data = await fetchChatGptConversation(conversationId);
    const stats = getChatGptBranchStats(data.mapping || {});
    return {
      ok: true,
      hasBranches: stats.branchPoints > 0,
      branchPoints: stats.branchPoints,
      branchedChildren: stats.branchedChildren
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : "Could not inspect ChatGPT branches."
    };
  }

  function getConversationId() {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{36})/i)
      || location.pathname.match(/([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  }

  async function fetchChatGptConversation(convId) {
    const token = await getAccessToken();
    const response = await fetch(`${location.origin}/backend-api/conversation/${convId}`, {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Conversation request failed with HTTP ${response.status}.`);
    }

    const data = await response.json();
    if (!data || !data.mapping) {
      throw new Error("Unexpected ChatGPT response with no mapping.");
    }

    return data;
  }

  async function getAccessToken() {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Session request failed with HTTP ${response.status}.`);
    }

    const session = await response.json();
    if (!session || !session.accessToken) {
      throw new Error("No access token found in /api/auth/session.");
    }

    return session.accessToken;
  }

  function getChatGptBranchStats(mapping) {
    const childrenByParent = new Map();
    for (const [nodeId, node] of Object.entries(mapping)) {
      const parentId = node && node.parent;
      if (!parentId || !mapping[parentId]) continue;
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(nodeId);
    }

    let branchPoints = 0;
    let branchedChildren = 0;

    for (const [nodeId, node] of Object.entries(mapping)) {
      if (!node || typeof node !== "object") continue;
      const children = unique([
        ...(Array.isArray(node.children) ? node.children.filter((childId) => (
          childId && mapping[childId] && mapping[childId].parent === nodeId
        )) : []),
        ...(childrenByParent.get(nodeId) || [])
      ].filter((childId) => childId && mapping[childId]));
      if (children.length > 1) {
        branchPoints++;
        branchedChildren += children.length;
      }
    }

    return { branchPoints, branchedChildren };
  }

  function unique(values) {
    const seen = new Set();
    const out = [];

    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }

    return out;
  }
}

function getChatGptBranchStats(mapping) {
  const childrenByParent = new Map();
  for (const [nodeId, node] of Object.entries(mapping)) {
    const parentId = node && node.parent;
    if (!parentId || !mapping[parentId]) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(nodeId);
  }

  let branchPoints = 0;
  let branchedChildren = 0;

  for (const [nodeId, node] of Object.entries(mapping)) {
    if (!node || typeof node !== "object") continue;
    const children = unique([
      ...(Array.isArray(node.children) ? node.children.filter((childId) => (
        childId && mapping[childId] && mapping[childId].parent === nodeId
      )) : []),
      ...(childrenByParent.get(nodeId) || [])
    ].filter((childId) => childId && mapping[childId]));
    if (children.length > 1) {
      branchPoints++;
      branchedChildren += children.length;
    }
  }

  return { branchPoints, branchedChildren };
}

function unique(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }

  return out;
}

async function probeClaudeConversationInPage() {
  const rootParentUuid = "00000000-0000-4000-8000-000000000000";
  const conversationId = getConversationId();
  if (!conversationId) {
    return { ok: false, error: "No Claude conversation id found in the URL." };
  }

  let lastError = null;
  const orgIds = await getClaudeOrgIds();

  for (const orgId of orgIds) {
    try {
      const data = await fetchClaudeConversation(orgId, conversationId);
      const stats = getClaudeBranchStats(data.chat_messages || []);
      const fileCount = getClaudeDownloadableFileCount(data.chat_messages || [], orgId, conversationId);
      return {
        ok: true,
        hasBranches: stats.branchPoints > 0,
        branchPoints: stats.branchPoints,
        branchedChildren: stats.branchedChildren,
        hasFiles: fileCount > 0,
        fileCount
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    error: lastError && lastError.message ? lastError.message : "Could not inspect Claude branches."
  };

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
      // The caller will fall back to any ids found from cookies.
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

  function getClaudeBranchStats(messages) {
    const childrenByParent = new Map();
    const seenUuids = new Set();

    for (const message of messages) {
      if (!message || !message.uuid || !normalizeClaudeRole(message.sender)) continue;
      if (seenUuids.has(message.uuid)) continue;
      seenUuids.add(message.uuid);

      const parentId = getClaudeParentId(message) || "";
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(message.uuid);
    }

    let branchPoints = 0;
    let branchedChildren = 0;
    for (const children of childrenByParent.values()) {
      if (children.length > 1) {
        branchPoints++;
        branchedChildren += children.length;
      }
    }

    return { branchPoints, branchedChildren };
  }

  function getClaudeParentId(message) {
    const parentId = message && message.parent_message_uuid;
    return !parentId || parentId === rootParentUuid ? null : parentId;
  }

  function normalizeClaudeRole(sender) {
    if (sender === "human" || sender === "user") return "user";
    if (sender === "assistant" || sender === "claude") return "assistant";
    return null;
  }

  function getClaudeDownloadableFileCount(messages, orgId, convId) {
    const seen = new Set();
    let count = 0;

    for (const message of messages) {
      if (!message || typeof message !== "object") continue;

      const candidates = []
        .concat(getArray(message.attachments).map((file) => ({ file, source: "attachment" })))
        .concat(getArray(message.files).map((file) => ({ file, source: "files" })))
        .concat(getArray(message.files_v2).map((file) => ({ file, source: "files_v2" })))
        .concat(getArray(message.generated_files).map((file) => ({ file, source: "generated_files" })));

      for (const candidate of candidates) {
        const key = getClaudeFileKey(candidate.file, candidate.source);
        if (!key || seen.has(key)) continue;
        if (!hasClaudeDownloadMethod(candidate.file, candidate.source, orgId, convId)) continue;
        seen.add(key);
        count++;
      }

      for (const artifact of getClaudeArtifactContentFiles(message)) {
        const key = `artifact:${artifact.id}:${artifact.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count++;
      }
    }

    return count;
  }

  function getArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function getClaudeFileKey(file, source) {
    if (!file || typeof file !== "object") return "";
    const id = file.file_uuid || file.uuid || file.id || file.file_id || file.path || file.url || file.preview_url || "";
    const name = file.file_name || file.name || file.filename || "";

    if (source === "attachment" && typeof file.extracted_content === "string") {
      return `attachment:${id}:${name}`;
    }

    return id ? `binary:${id}` : `${source}:${name}`;
  }

  function hasClaudeDownloadMethod(file, source, orgId, convId) {
    if (!file || typeof file !== "object") return false;
    if (source === "attachment" && typeof file.extracted_content === "string") return true;
    if (file.url || file.download_url || file.downloadUrl || file.preview_url || (file.document_asset && file.document_asset.url)) {
      return true;
    }
    if (source === "files_v2" && file.path && orgId && convId) return true;
    if (file.file_kind === "blob" && file.file_uuid && orgId) return true;
    return Boolean(file.file_uuid && orgId && (file.file_name || file.name || file.filename));
  }

  function getClaudeArtifactContentFiles(message) {
    const out = [];

    for (const block of getArray(message.content)) {
      if (!block || typeof block !== "object") continue;
      const input = block.input && typeof block.input === "object" ? block.input : null;
      if (!input) continue;

      if (block.type === "tool_use" && (block.name === "artifacts" || block.name === "create_file") && typeof input.content === "string") {
        out.push({
          id: block.id || input.id || input.filename || input.title || "",
          name: input.filename || input.title || "artifact",
          content: input.content
        });
      }
    }

    return out;
  }
}

initializePopup().catch((error) => {
  renderDisabledButton();
  setStatus(error && error.message ? error.message : String(error), "error");
});
