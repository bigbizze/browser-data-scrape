(async () => {
  if (window.__claudeConversationExportInProgress) {
    return {
      ok: false,
      error: "An export is already running in this tab."
    };
  }

  window.__claudeConversationExportInProgress = true;

  try {
    const out = await exportClaudeConversation();
    return {
      ok: true,
      source: out.source,
      counts: out.counts,
      conversationId: out.conversationId,
      downloadName: out.downloadName
    };
  } catch (error) {
    console.error("[claude-export] FAILED", error);
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    window.__claudeConversationExportInProgress = false;
  }
})();

async function exportClaudeConversation() {
  const conversationId = getConversationId();
  if (!conversationId) {
    throw new Error("No Claude conversation id found in the URL.");
  }

  let apiError = null;
  const orgIds = await getClaudeOrgIds();

  for (const orgId of orgIds) {
    try {
      const data = await fetchClaudeConversation(orgId, conversationId);
      const out = buildClaudeApiExport(data, conversationId, orgId);
      return downloadAndReturn(out, `claude-export-${Date.now()}.json`);
    } catch (error) {
      apiError = error;
      console.warn(`[claude-export] API export failed for org ${orgId}`, error);
    }
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
    + "?tree=true&rendering_mode=messages&render_all_tools=true";

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

function buildClaudeApiExport(data, conversationId, orgId) {
  const thread = getActiveClaudeThread(data);
  const messages = [];
  const files = [];

  for (const message of thread) {
    const role = normalizeClaudeRole(message.sender);
    if (!role) continue;

    const messageFiles = getClaudeMessageFiles(message, messages.length, role);
    const blocks = getClaudeBlocks(message);
    const text = getClaudeText(message, blocks);

    if (!text && !blocks.length && !messageFiles.length) continue;

    const record = {
      index: messages.length,
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

    messages.push(record);
    files.push(...messageFiles);
  }

  return {
    exportedAt: new Date().toISOString(),
    source: "claude-api",
    url: location.href,
    conversationId: data.uuid || conversationId,
    organizationId: orgId,
    title: data.name || document.title || "Claude conversation",
    create_time: data.created_at || null,
    update_time: data.updated_at || null,
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

function getActiveClaudeThread(data) {
  const messages = data.chat_messages || [];
  if (!messages.length) return [];

  const byUuid = new Map(messages.map((message) => [message.uuid, message]));
  let nodeId = data.current_leaf_message_uuid || findLatestClaudeLeaf(messages);
  const ordered = [];
  const guard = new Set();

  while (nodeId && byUuid.has(nodeId) && !guard.has(nodeId)) {
    guard.add(nodeId);
    const message = byUuid.get(nodeId);
    ordered.push(message);
    nodeId = message.parent_message_uuid || null;
  }

  if (!ordered.length) {
    return messages.slice();
  }

  return ordered.reverse();
}

function findLatestClaudeLeaf(messages) {
  const parentIds = new Set(messages.map((message) => message.parent_message_uuid).filter(Boolean));
  const leaves = messages.filter((message) => message.uuid && !parentIds.has(message.uuid));

  leaves.sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "") || 0;
    const rightTime = Date.parse(right.created_at || "") || 0;
    return rightTime - leftTime;
  });

  return (leaves[0] && leaves[0].uuid) || (messages[messages.length - 1] && messages[messages.length - 1].uuid);
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

function getClaudeMessageFiles(message, messageIndex, owner) {
  const out = [];

  for (const attachment of message.attachments || []) {
    out.push(normalizeClaudeFile(attachment, message, messageIndex, owner, "attachment"));
  }

  for (const file of message.files_v2 || []) {
    out.push(normalizeClaudeFile(file, message, messageIndex, owner, "files_v2"));
  }

  return dedupeFiles(out);
}

function normalizeClaudeFile(file, message, messageIndex, owner, source) {
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

  return {
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
  console.log("[claude-export] DONE", out.source, out.counts);
  console.table(out.files);

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
