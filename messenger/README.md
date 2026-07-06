# Messenger console exporter

`export-console.js` is a standalone browser-console script for an already-open Facebook Messenger conversation. It does not add extension code.

## Usage

1. Open the specific Messenger thread in a logged-in browser tab.
2. Open DevTools -> Console.
3. Paste `messenger/export-console.js`.
4. Run:

```js
await window.__exportMessenger({
  start: "2026-02-01",
  end: "2026-06-24",
});
```

The script scrolls upward through the open thread, captures visible messages, filters the final output by date range when timestamps are available, and downloads `messenger-export-<timestamp>.json`.

For older ranges in very large threads, manually scroll near the target range first and run:

```js
await window.__exportMessenger({
  start: "2026-02-01",
  end: "2026-06-24",
  startFromBottom: false
});
```

Useful options:

- `includeUndated: true` includes messages where Messenger did not expose a timestamp in the DOM.
- `maxScrolls: 1000` limits how far the script scrolls.
- `download: false` returns the JSON object without downloading.
- `includeRaw: true` adds raw DOM text and labels for debugging selector issues.
- `containerSelector: "#_r_24_"` overrides the auto-detected message log/container.
- `scrollerSelector: "..."` overrides the auto-detected scrollable element.
- `includeDataUrls: true` includes inline `data:image/...` URLs in file entries. By default those are omitted to keep JSON size sane.

## Output shape

The output mirrors the existing exporters where possible:

```json
{
  "exportedAt": "2026-06-23T00:00:00.000Z",
  "source": "messenger-dom",
  "url": "https://www.messenger.com/...",
  "conversationId": "...",
  "title": "...",
  "counts": {
    "messages": 123,
    "user": 40,
    "participant": 83,
    "files": 2
  },
  "messages": [
    {
      "index": 0,
      "id": "1187103743@msgr.7470821894889302962",
      "role": "user",
      "sender": "You",
      "model": null,
      "create_time": "2026-06-01T14:32:00.000Z",
      "text": "Message text",
      "files": []
    }
  ],
  "files": []
}
```

Messenger is a human-to-human chat, so `role` is `user`, `participant`, or `unknown` rather than `assistant`.

The current parser is built around Messenger's stable accessibility markers:

- Message log: `[role="log"][aria-label*="Messages in conversation"]`
- Message row: `[data-message-id][aria-roledescription="message"]`
- Message metadata: the message element's `aria-label`

## Backend API notes

It is possible in principle to export Messenger data from backend calls made inside the logged-in browser page, because the web app itself loads messages that way. For this repo, the DOM exporter is the safer first version:

- Messenger's private GraphQL/API request shapes, document IDs, cursors, and required form fields change frequently.
- A console script should not copy cookies or tokens out of the browser; if backend calls are added, they should be same-origin `fetch` calls from the Messenger tab using `credentials: "include"`.
- Date range paging is much better with backend cursors, but it requires inspecting the current Network requests for the open thread and normalizing whatever response shape Facebook is serving at that time.

For very large histories where exact date ranges matter, Facebook's official Download Your Information export is usually more reliable than DOM scrolling.
