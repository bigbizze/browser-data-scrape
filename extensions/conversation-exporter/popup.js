const CHATGPT_CONVERSATION_PATH_RE = /(?:^|\/)c\/[0-9a-f-]{36}(?:\/|$)/i;
const CLAUDE_ID_RE = /^[0-9a-f-]{16,}$/i;
const CLAUDE_EXPORT_MODE_CURRENT = "current-branch";
const CLAUDE_EXPORT_MODE_ALL = "all-branches";

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
    if (config.variant) button.dataset.variant = config.variant;
    if (config.onClick) button.addEventListener("click", config.onClick);
    buttonArea.appendChild(button);
  }
}

function setButtonsDisabled(disabled) {
  buttonArea.querySelectorAll("button").forEach((button) => {
    button.disabled = disabled;
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
    renderButtons([{
      label: "Export conversation",
      onClick: () => runExport(tab, target)
    }]);
    setStatus("Ready.");
    return;
  }

  await initializeClaudeButtons(tab, target);
}

async function initializeClaudeButtons(tab, target) {
  setStatus("Checking Claude branches...");
  renderDisabledButton();

  let probe = null;
  try {
    probe = getResult(await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probeClaudeBranchesInPage
    }));
  } catch (error) {
    console.warn("[conversation-exporter] Claude branch probe failed", error);
  }

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
      }
    ]);
    setStatus(`Ready. Found ${probe.branchPoints} branch ${probe.branchPoints === 1 ? "point" : "points"}.`);
    return;
  }

  renderButtons([{
    label: "Export conversation",
    onClick: () => runExport(tab, target, CLAUDE_EXPORT_MODE_CURRENT)
  }]);

  if (probe && probe.ok) {
    setStatus("Ready.");
  } else {
    setStatus("Ready. Branch detection unavailable.");
  }
}

async function runExport(tab, target, mode = null) {
  setButtonsDisabled(true);
  setStatus(`Exporting ${target.label}...`);

  try {
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

function setClaudeExportModeInPage(mode) {
  window.__claudeExportMode = mode;
}

function formatSuccessStatus(result) {
  const counts = result.counts || {};
  const messageCount = Number.isFinite(counts.messages) ? counts.messages : 0;
  const fileCount = Number.isFinite(counts.files) ? counts.files : 0;
  const fallbackNote = result.source === "claude-dom-fallback" ? " visible" : "";
  const branchNote = result.exportMode === CLAUDE_EXPORT_MODE_ALL && counts.leafBranches
    ? ` across ${counts.leafBranches} leaf branches`
    : "";

  return `Downloaded ${messageCount}${fallbackNote} messages${branchNote} (${fileCount} files listed).`;
}

async function probeClaudeBranchesInPage() {
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
      return {
        ok: true,
        hasBranches: stats.branchPoints > 0,
        branchPoints: stats.branchPoints,
        branchedChildren: stats.branchedChildren
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
}

initializePopup().catch((error) => {
  renderDisabledButton();
  setStatus(error && error.message ? error.message : String(error), "error");
});
