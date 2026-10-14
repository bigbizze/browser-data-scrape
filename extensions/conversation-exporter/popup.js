const CHATGPT_CONVERSATION_PATH_RE = /(?:^|\/)c\/[0-9a-f-]{36}(?:\/|$)/i;
const CLAUDE_ID_RE = /^[0-9a-f-]{16,}$/i;
const EXPORT_MODE_BUNDLE = "conversation-and-files";
const CHATGPT_EXPORT_MODE_CURRENT = "current-branch";
const CHATGPT_EXPORT_MODE_ALL = "all-branches";
const CHATGPT_EXPORT_MODE_DOWNLOAD_FILES = "download-files-all";
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

function makeBundleButton(tab, target) {
  return {
    label: "Download history + all files (ZIP)",
    variant: "secondary",
    onClick: () => runExport(tab, target, EXPORT_MODE_BUNDLE)
  };
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
    const fileCount = Number.isFinite(probe.fileCount) ? probe.fileCount : 0;
    const downloadFilesButton = {
      label: fileCount ? `Download all files (${fileCount})` : "Download all files",
      variant: "secondary",
      disabled: fileCount <= 0,
      onClick: fileCount > 0 ? () => runExport(tab, target, CHATGPT_EXPORT_MODE_DOWNLOAD_FILES) : null
    };

    renderButtons([
      {
        label: "Export current branch",
        onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_CURRENT)
      },
      {
        label: "Export all branches",
        variant: "secondary",
        onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_ALL)
      },
      downloadFilesButton,
      makeBundleButton(tab, target)
    ]);
    setStatus(formatChatGptReadyStatus(probe));
    return;
  }

  if (probe && probe.ok) {
    const fileCount = Number.isFinite(probe.fileCount) ? probe.fileCount : 0;
    renderButtons([
      {
        label: "Export conversation",
        onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_CURRENT)
      },
      {
        label: fileCount ? `Download all files (${fileCount})` : "Download all files",
        variant: "secondary",
        disabled: fileCount <= 0,
        onClick: fileCount > 0 ? () => runExport(tab, target, CHATGPT_EXPORT_MODE_DOWNLOAD_FILES) : null
      },
      makeBundleButton(tab, target)
    ]);
    setStatus(formatChatGptReadyStatus(probe));
  } else {
    renderButtons([{
      label: "Export conversation",
      onClick: () => runExport(tab, target, CHATGPT_EXPORT_MODE_CURRENT)
    }, makeBundleButton(tab, target)]);
    setStatus("Ready. Branch detection unavailable.");
  }
}

async function initializeClaudeButtons(tab, target) {
  setStatus("Checking Claude conversation...");
  renderDisabledButton();

  let probe = null;
  try {
    await chrome.scripting.executeScript({target:{tabId:tab.id}, func:() => { window.__claudeInventoryOnly = true; }});
    await chrome.scripting.executeScript({target:{tabId:tab.id}, files:['exporters/claude.js']});
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
      downloadFilesButton,
      makeBundleButton(tab, target)
    ]);
    setStatus(formatClaudeReadyStatus(probe));
    return;
  }

  renderButtons([
    {
      label: "Export conversation",
      onClick: () => runExport(tab, target, CLAUDE_EXPORT_MODE_CURRENT)
    },
    downloadFilesButton,
    makeBundleButton(tab, target)
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
      files: ["exporters/bundle-docs.js", target.script]
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
  delete window.__claudeInventoryOnly;
  window.__claudeExportMode = mode;
}

function formatSuccessStatus(result) {
  const counts = result.counts || {};
  if (result.source === 'claude-api-files') {
    return `Exported ${counts.downloaded || 0} of ${counts.files || 0} items, including ${counts.versions || 0} artifact versions. ${counts.failed || 0} unresolved items; ${counts.discoveryFailures || 0} discovery failures; ${counts.cleanupFailures || 0} cleanup failures.`;
  }

  if (result.exportMode === EXPORT_MODE_BUNDLE || result.exportMode === CHATGPT_EXPORT_MODE_DOWNLOAD_FILES || result.exportMode === CLAUDE_EXPORT_MODE_DOWNLOAD_FILES) {
    const fileCount = Number.isFinite(counts.files) ? counts.files : 0;
    const downloaded = Number.isFinite(counts.downloaded) ? counts.downloaded : fileCount;
    const failed = Number.isFinite(counts.failed) ? counts.failed : 0;
    const failureNote = failed ? ` (${failed} failed)` : "";
    const historyNote = result.exportMode === EXPORT_MODE_BUNDLE ? `${counts.messages || 0} messages and ` : "";
    return `Downloaded ${historyNote}${downloaded} of ${fileCount} files${failureNote}.`;
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
  if (probe.fileProbeWarning) parts.push(probe.fileProbeWarning);

  if (probe.branchPoints > 0) {
    parts.push(`Found ${probe.branchPoints} branch ${probe.branchPoints === 1 ? "point" : "points"}.`);
  }

  if (probe.fileCount > 0) {
    parts.push(`Found ${probe.fileCount} file ${probe.fileCount === 1 ? "candidate" : "candidates"}.`);
  }

  return parts.join(" ");
}

function formatChatGptReadyStatus(probe) {
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
    const token = await getAccessToken();
    const data = await fetchChatGptConversation(conversationId, token);
    const stats = getChatGptBranchStats(data.mapping || {});
    let fileCount = 0;
    let fileProbeWarning = null;

    try {
      fileCount = getChatGptConversationFileCount(await fetchChatGptConversationFiles(conversationId, token));
    } catch (error) {
      fileProbeWarning = error && error.message ? error.message : String(error);
      console.warn("[conversation-exporter] ChatGPT file probe failed", error);
    }

    return {
      ok: true,
      hasBranches: stats.branchPoints > 0,
      branchPoints: stats.branchPoints,
      branchedChildren: stats.branchedChildren,
      hasFiles: fileCount > 0,
      fileCount,
      fileProbeWarning
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

  async function fetchChatGptConversation(convId, token) {
    const response = await fetchChatGptWithRetry(`${location.origin}/backend-api/conversation/${convId}`, {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${token}`
      }
    }, "Conversation");

    if (!response.ok) {
      throw new Error(`Conversation request failed with HTTP ${response.status}.`);
    }

    const data = await response.json();
    if (!data || !data.mapping) {
      throw new Error("Unexpected ChatGPT response with no mapping.");
    }

    return data;
  }

  async function fetchChatGptConversationFiles(convId, token) {
    const response = await fetchChatGptWithRetry(
      `${location.origin}/backend-api/conversations/${encodeURIComponent(convId)}/files?limit=200`,
      {
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      },
      "Files list"
    );

    const data = await response.json();
    if (!data || !Array.isArray(data.items)) {
      throw new Error("Unexpected ChatGPT files response with no items array.");
    }

    return data;
  }

  async function fetchChatGptWithRetry(url, init, label) {
    let lastResponse = null;
    for (let attempt = 0; attempt <= 10; attempt++) {
      const response = await fetch(url, init);
      if (response.ok) return response;

      lastResponse = response;
      if (response.status !== 429 || attempt >= 10) break;
      await sleep(getRetryDelayMs(response, attempt));
    }

    throw new Error(`${label} request failed with HTTP ${lastResponse ? lastResponse.status : "unknown"}.`);
  }

  function getRetryDelayMs(response, attempt) {
    const retryAfter = response && response.headers ? response.headers.get("retry-after") : "";
    const numeric = Number(retryAfter);
    if (Number.isFinite(numeric) && numeric > 0) return Math.min(Math.max(numeric * 1000, 3000), 20000);

    const parsedDate = Date.parse(retryAfter || "");
    if (Number.isFinite(parsedDate)) return Math.min(Math.max(parsedDate - Date.now(), 3000), 20000);

    return Math.min(Math.max(3000 * Math.pow(2, attempt), 3000), 20000);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function getChatGptConversationFileCount(data) {
    const seen = new Set();
    for (const item of Array.isArray(data && data.items) ? data.items : []) {
      if (!item || typeof item !== "object") continue;
      const key = item.file_id
        ? `file-id:${item.file_id}`
        : item.id
          ? `library-id:${item.id}`
          : `meta:${item.file_name || ""}:${item.file_size_bytes || ""}:${item.mime_type || ""}`;
      if (key !== "meta:::" && !seen.has(key)) seen.add(key);
    }
    return seen.size;
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
  const conversationId = getConversationId();
  let lastError;
  for (const orgId of await getClaudeOrgIds()) {
    try {
      const data = await fetchClaudeConversation(orgId, conversationId);
      const inventory = buildClaudeInventory(data, conversationId, orgId);

      return {ok:true, hasBranches:inventory.history.totalCounts.branchPoints > 0,
        branchPoints:inventory.history.totalCounts.branchPoints, fileCount:inventory.files.length + inventory.artifacts.length,
        fileProbeWarning:'Counts are preliminary. Versions and workspace files are checked during export.'};
    } catch (error) { lastError = error; }
  }
  return {ok:false, error:lastError?.message || 'Could not inspect Claude conversation'};
}

initializePopup().catch((error) => {
  renderDisabledButton();
  setStatus(error && error.message ? error.message : String(error), "error");
});
