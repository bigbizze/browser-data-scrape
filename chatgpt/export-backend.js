/* ============================================================================
 * ChatGPT conversation exporter — BACKEND-API version.
 * Paste into DevTools Console on the chat tab.
 *
 * Instead of scraping the rendered DOM (virtualized, collapsed, "Show more"),
 * this asks the same private endpoint the website itself uses:
 *     GET /backend-api/conversation/<id>
 * and reads the clean source data: full text, roles, order, timestamps, files.
 *
 * It walks the ACTIVE branch only (current_node -> root), so edited/regenerated
 * dead branches are excluded — matching what you see on screen.
 *
 * Run: open the chat, F12 -> Console, paste this whole file, Enter.
 *      Auto-downloads chatgpt-backend-export-<ts>.json.
 * Free: uses your existing login session — no API key, no billing.
 * ==========================================================================*/
window.__exportChatBackend = async function exportChatBackend() {
  const origin = location.origin;

  // --- session token ---------------------------------------------------------
  let token = null;
  try { token = (await (await fetch('/api/auth/session', { credentials: 'include' })).json()).accessToken; } catch (e) {}
  if (!token) throw new Error('Could not read access token from /api/auth/session — are you logged in?');
  const headers = { Authorization: `Bearer ${token}` };

  // --- conversation id -------------------------------------------------------
  const convId = (location.pathname.match(/\/c\/([0-9a-f-]{36})/) || [])[1]
              || (location.pathname.match(/([0-9a-f-]{36})/) || [])[1];
  if (!convId) throw new Error('No conversation id in the URL.');

  const conv = await (await fetch(`${origin}/backend-api/conversation/${convId}`, {
    headers, credentials: 'include',
  })).json();
  if (!conv || !conv.mapping) throw new Error('Unexpected response (no mapping). ' + JSON.stringify(conv).slice(0, 200));

  // --- walk the active branch: current_node -> root, then reverse ------------
  const mapping = conv.mapping;
  const order = [];
  let nodeId = conv.current_node;
  if (!nodeId) { // fallback: pick the deepest leaf
    nodeId = Object.keys(mapping).find((k) => !(mapping[k].children || []).length) || Object.keys(mapping)[0];
  }
  const guard = new Set();
  while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
    guard.add(nodeId);
    order.push(nodeId);
    nodeId = mapping[nodeId].parent;
  }
  order.reverse();

  const norm = (id) => String(id || '').replace(/^file-service:\/\//, '').replace(/^sediment:\/\//, '');

  // --- build messages --------------------------------------------------------
  const messages = [];
  const fileManifest = [];
  for (const nid of order) {
    const m = mapping[nid] && mapping[nid].message;
    if (!m) continue;
    const role = m.author && m.author.role;
    if (role !== 'user' && role !== 'assistant') continue;                 // skip system/tool
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
    if (m.recipient && m.recipient !== 'all') continue;                    // skip tool calls

    const c = m.content || {};
    const ctype = c.content_type || '';
    if (!['text', 'multimodal_text'].includes(ctype)) continue;           // skip thoughts/code-exec etc.

    // text: join string parts; collect image parts as files
    const textParts = [];
    for (const part of c.parts || []) {
      if (typeof part === 'string') { if (part) textParts.push(part); }
      else if (part && typeof part === 'object' && part.asset_pointer) {
        const id = norm(part.asset_pointer);
        const name = `${id.replace(/^file[-_]/, 'file_')}.png`;
        fileManifest.push({ messageIndex: messages.length, messageId: m.id, owner: role, id, name, mime: 'image/png', kind: 'image', source: 'asset_pointer' });
      }
    }
    const text = textParts.join('\n').trim();

    // explicit attachments (pdf, docx, md, images, …)
    for (const a of (m.metadata && m.metadata.attachments) || []) {
      const ext = (a.name || '').split('.').pop().toLowerCase();
      const kind = /^(png|jpe?g|gif|webp|svg|heic)$/.test(ext) ? 'image'
                 : /^(pdf|docx?|txt|md|csv|xlsx?|pptx?)$/.test(ext) ? 'document' : 'file';
      fileManifest.push({ messageIndex: messages.length, messageId: m.id, owner: role, id: norm(a.id), name: a.name || norm(a.id), mime: a.mime_type || '', size: a.size || null, kind, source: 'attachment' });
    }

    if (!text && !(m.metadata && (m.metadata.attachments || []).length)) continue; // empty placeholder

    messages.push({
      index: messages.length,
      id: m.id,
      role,
      model: (m.metadata && m.metadata.model_slug) || null,
      create_time: m.create_time || null,
      text,
    });
  }
  // back-fill file list onto each message for convenience
  messages.forEach((msg) => { msg.files = fileManifest.filter((f) => f.messageId === msg.id); });

  const out = {
    exportedAt: new Date().toISOString(),
    source: 'backend-api',
    url: location.href,
    conversationId: convId,
    title: conv.title || document.title,
    create_time: conv.create_time || null,
    update_time: conv.update_time || null,
    counts: {
      messages: messages.length,
      user: messages.filter((m) => m.role === 'user').length,
      assistant: messages.filter((m) => m.role === 'assistant').length,
      files: fileManifest.length,
    },
    messages,
    files: fileManifest,
  };

  // --- download --------------------------------------------------------------
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chatgpt-backend-export-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();

  console.log('[backend-export] DONE', out.counts);
  console.table(fileManifest);
  window.__lastBackendExport = out;
  return out;
};

window.__exportChatBackend();
