var CHATGPT_EXPORT_MODE_CURRENT = "current-branch";
var CHATGPT_EXPORT_MODE_ALL = "all-branches";
var CHATGPT_EXPORT_MODE_BACKEND_CURRENT = "backend-current";
var CHATGPT_BRANCH_STRUCTURE = "segment-tree";

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
      downloadName: out.downloadName
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
  return mode === CHATGPT_EXPORT_MODE_ALL ? CHATGPT_EXPORT_MODE_ALL : CHATGPT_EXPORT_MODE_CURRENT;
}

async function exportChatBackend(exportMode) {
  const convId = getConversationId();
  if (!convId) {
    throw new Error("No conversation id in the URL.");
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

  return conv;
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
