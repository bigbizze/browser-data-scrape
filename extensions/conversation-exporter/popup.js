const CHATGPT_CONVERSATION_PATH_RE = /(?:^|\/)c\/[0-9a-f-]{36}(?:\/|$)/i;
const CLAUDE_ID_RE = /^[0-9a-f-]{16,}$/i;

const button = document.getElementById("exportButton");
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
      label: "ChatGPT",
      script: "exporters/chatgpt.js",
      isConversation: isChatGptConversationUrl(parsed)
    };
  }

  if (parsed.hostname === "claude.ai" || parsed.hostname === "app.claude.ai") {
    return {
      label: "Claude",
      script: "exporters/claude.js",
      isConversation: Boolean(getClaudeConversationId(parsed))
    };
  }

  return null;
}

button.addEventListener("click", async () => {
  button.disabled = true;
  setStatus("Exporting...");

  try {
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

    setStatus(`Exporting ${target.label}...`);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [target.script]
    });

    const result = getResult(results);
    if (!result || !result.ok) {
      throw new Error((result && result.error) || "The page did not return an export result.");
    }

    const counts = result.counts;
    const fallbackNote = result.source === "claude-dom-fallback" ? " visible" : "";
    setStatus(`Downloaded ${counts.messages}${fallbackNote} messages (${counts.files} files listed).`, "success");
  } catch (error) {
    setStatus(error && error.message ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
  }
});
