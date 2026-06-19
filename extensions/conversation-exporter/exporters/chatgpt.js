(async () => {
  if (window.__chatGptBackendExportInProgress) {
    return {
      ok: false,
      error: "An export is already running in this tab."
    };
  }

  window.__chatGptBackendExportInProgress = true;

  try {
    const out = await exportChatBackend();
    return {
      ok: true,
      counts: out.counts,
      conversationId: out.conversationId,
      downloadName: out.downloadName
    };
  } catch (error) {
    console.error("[backend-export] FAILED", error);
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    window.__chatGptBackendExportInProgress = false;
  }
})();

async function exportChatBackend() {
  const origin = location.origin;

  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const convId = getConversationId();
  if (!convId) {
    throw new Error("No conversation id in the URL.");
  }

  const convResponse = await fetch(`${origin}/backend-api/conversation/${convId}`, {
    headers,
    credentials: "include"
  });

  if (!convResponse.ok) {
    throw new Error(`Conversation request failed with HTTP ${convResponse.status}.`);
  }

  const conv = await convResponse.json();
  if (!conv || !conv.mapping) {
    throw new Error(`Unexpected response with no mapping: ${JSON.stringify(conv).slice(0, 200)}`);
  }

  const branch = await getRenderedBranchOrder(conv.mapping, conv.current_node);
  const order = branch.order;
  const { messages, files } = buildMessages(order, conv.mapping);

  const out = {
    exportedAt: new Date().toISOString(),
    source: "backend-api",
    branchSource: branch.source,
    url: location.href,
    conversationId: convId,
    title: conv.title || document.title,
    create_time: conv.create_time || null,
    update_time: conv.update_time || null,
    counts: {
      messages: messages.length,
      user: messages.filter((message) => message.role === "user").length,
      assistant: messages.filter((message) => message.role === "assistant").length,
      files: files.length
    },
    messages,
    files
  };

  const downloadName = `chatgpt-backend-export-${Date.now()}.json`;
  downloadJson(out, downloadName);

  out.downloadName = downloadName;
  window.__lastBackendExport = out;
  console.log("[backend-export] DONE", out.counts);
  console.table(files);

  return out;
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

function buildMessages(order, mapping) {
  const messages = [];
  const files = [];

  for (const nodeId of order) {
    const node = mapping[nodeId];
    const message = node && node.message;
    if (!message || !shouldIncludeMessage(message)) continue;

    const content = message.content || {};
    const messageFiles = [];
    const text = getTextAndAssetFiles(content, message, messages.length, messageFiles);

    addAttachmentFiles(message, messages.length, messageFiles);

    if (!text && messageFiles.length === 0) continue;

    const record = {
      index: messages.length,
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
