# Conversation Exporter

Unpacked Chromium extension for exporting ChatGPT or Claude conversations and downloading their files.

## Load it

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select this folder: `/home/userc/WebstormProjects/browser-data-scrape/extensions/conversation-exporter`.
5. Open or reload a supported conversation:
   - `https://chatgpt.com/c/...`
   - `https://claude.ai/chat/...`
   - `https://app.claude.ai/chat/...`
6. Click the extension button.
7. Select a conversation export or click "Download all files".

Conversation exports use JSON. File downloads use one ZIP archive with standard Deflate compression. Already-compressed formats stay stored; compression failure falls back to stored entries. No compression library or remote code is required.

Use **Download history + all files (ZIP)** for one archive with `conversation.json` (all branches) and a `files/` folder. The button also works for conversations without files. If individual downloads fail, the ZIP keeps the history and lists failures in `export-failures.json`.

## Notes

- ChatGPT exports use the private `/api/auth/session` and `/backend-api/conversation/<id>` endpoints through your existing logged-in browser session.
- ChatGPT current-branch exports follow the backend response's `current_node`; they do not scroll or crawl the rendered conversation.
- ChatGPT file downloads follow the signed `download_url` from each JSON download descriptor.
- Claude exports use the private `/api/organizations/<org>/chat_conversations/<id>` endpoint through your existing logged-in browser session. If the Claude API export fails, the extension tries a best-effort visible DOM fallback.
- Conversation JSON includes attachment and image references. Use "Download all files" to download attachment bytes.
- If the extension icon stays disabled right after loading the extension, reload the ChatGPT or Claude tab.

## ZIP contents

Both providers include a short `README.md`. Combined exports include `conversation.json`, `conversation.schema.json`, and `files/`. The schema describes the segment tree: each branch contains only its own messages, after its ancestors. ChatGPT retrieval behavior is unchanged.

Claude ZIPs also include `export-manifest.json`: identities, message and branch associations, version metadata, attempted routes, ZIP paths, byte counts, SHA-256, and copy cleanup. `export-failures.json` records unresolved downloads, discovery gaps, and cleanup failures. A ZIP can be incomplete.

## Claude retrieval

Discovery includes message uploads, successful `SendUserFile` receipts, real account-artifact listings, reads, publications, and explicit links. Built-in `Artifact.quickstart` template catalogues and their template-link instructions are replaced by an omission marker in exported results. Unrelated messages remain intact. `tool_use_id` links results to calls.

Downloads try direct access, then a recorded workspace path. Failed workspace listing does not disable known-path downloads. Artifact requests use `x-frame-cp: go`. Available versions use their own tokens and paths: `artifacts/<artifact-id>/<version-id>/` beneath the content directory. Historical content is never replaced with current content. If a historical supporting-file list is unavailable, the known HTML entry is attempted and the discovery gap is reported.

`recorded-source/` holds reconstructed Write/Edit evidence, not verified delivered bytes. Shell commands are never executed; unsupported shell mutations invalidate reconstructed state.

When current artifact source lacks access, an explicitly copyable artifact can be duplicated, exported, then deleted. The extension records a token-free journal in `chrome.storage.local`. Deletion requires a validated creation response, a new ID absent from the pre-copy inventory, confirmed account ownership, and a receipt held only in the current run. Failed downloads also attempt cleanup. Uncertain identity prevents deletion. Cleanup failures include a URL for manual removal.

Known journal mappings can reuse an accessible copy of the same original version after interruption. Reused copies and old journal entries are never automatically deleted. Titles do not establish identity. An ambiguous creation request is never retried. Popup inventory checks do not create copies.

Reload the unpacked extension after updating it. The existing extension ZIP is not updated.
