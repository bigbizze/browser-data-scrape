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

Conversation exports use JSON. File downloads use one ZIP archive.

## Notes

- ChatGPT exports use the private `/api/auth/session` and `/backend-api/conversation/<id>` endpoints through your existing logged-in browser session.
- ChatGPT current-branch exports follow the backend response's `current_node`; they do not scroll or crawl the rendered conversation.
- ChatGPT file downloads follow the signed `download_url` from each JSON download descriptor.
- Claude exports use the private `/api/organizations/<org>/chat_conversations/<id>` endpoint through your existing logged-in browser session. If the Claude API export fails, the extension tries a best-effort visible DOM fallback.
- Conversation JSON includes attachment and image references. Use "Download all files" to download attachment bytes.
- If the extension icon stays disabled right after loading the extension, reload the ChatGPT or Claude tab.

## Claude artifact files

“Download all files” also downloads source from `https://claude.ai/artifact/...` links in the conversation. It uses the signed-in account and saves the current published version under `artifacts/<artifact-id>/`. Supporting files keep their relative paths. The artifact service needs the `x-frame-cp: go` routing header.

The ZIP also saves source recorded by `Write` and `Edit` calls when Claude publishes it with `Artifact` or sends it with `SendUserFile`. These copies are under `recorded-source/`. They can predate changes made through shell commands or external tools. Branches keep separate source histories.

Each ZIP entry has a unique name. If some downloads fail, `export-failures.json` lists them. A failed attachment URL can coexist with a successful copy under `uploads/`. Conversation JSON exports still contain references. Use the file ZIP to transfer file contents to another session.
