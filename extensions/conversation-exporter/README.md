# Conversation Exporter

Unpacked Chromium extension for exporting the active ChatGPT or Claude conversation as JSON.

## Load it

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select this folder: `/home/userc/WebstormProjects/browser-data-scrape/extensions/conversation-exporter`.
5. Open or reload a supported conversation:
   - `https://chatgpt.com/c/...`
   - `https://claude.ai/chat/...`
   - `https://app.claude.ai/chat/...`
6. Click the extension button, then click "Export conversation".

The exported file is downloaded as JSON.

## Notes

- ChatGPT exports use the private `/api/auth/session` and `/backend-api/conversation/<id>` endpoints through your existing logged-in browser session.
- Claude exports use the private `/api/organizations/<org>/chat_conversations/<id>` endpoint through your existing logged-in browser session. If the Claude API export fails, the extension tries a best-effort visible DOM fallback.
- The JSON includes attachment and image references in the file manifest. It does not download attached file binaries.
- If the extension icon stays disabled right after loading the extension, reload the ChatGPT or Claude tab.
