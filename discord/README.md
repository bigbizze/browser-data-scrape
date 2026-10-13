# Discord custom emoji exporter

`export-emojis-console.js` exports custom server emojis into a ZIP file. On the
current Discord web client it uses a user token to list the servers and their
emoji metadata, then downloads the image files from Discord's public CDN.

> [!WARNING]
> Discord prohibits automating normal user accounts ("self-bots") and warns
> that doing so can result in account termination. This script is intended for
> a single, read-only personal export. Use it only if you accept that risk.
> See Discord's official
> [Automated User Accounts policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).

## Requirements

- Chrome or Edge
- The Discord web app at `https://discord.com/channels/...`
- Enough free disk space for the exported assets

The token is entered into a temporary masked field. The script keeps a reference
to it only while reading emoji metadata; it does not print it, add it to the ZIP,
or write it to browser storage.

## Usage

1. Open Discord in Chrome or Edge and wait for the server list to load.
2. Open `export-emojis-console.js`, review it, and copy the complete file.
3. Open DevTools (`F12`) and select the Console tab.
4. Paste the script and press Enter.
5. Run:

```js
await window.__exportDiscordEmojis()
```

6. Enter the user token in the masked dialog and acknowledge the warning.
7. Choose where to save the ZIP and keep the Discord tab open until the console
   reports completion.

Chrome may show a self-XSS warning before allowing code to be pasted into
DevTools. Follow Chrome's on-screen instructions only after reviewing the
script. Never paste your Discord token into the console or into this script.
Use only the masked input created by the exporter.

## Archive contents

The ZIP uses one flat emoji folder. Server and emoji IDs are included so that
identically named servers or emojis cannot overwrite one another.

```text
emojis/
  Server Name--123456789--emoji_name--987654321.webp
manifest.json
```

All assets are WebP. Animated emojis are requested as animated WebP. The
manifest records server and emoji metadata, CDN URLs, archive paths, byte sizes,
and any downloads that failed.

The ZIP is written incrementally without recompressing the already-compressed
image assets. Individual CDN failures do not stop the export; fatal file-write
errors abort the incomplete save.

Metadata requests are performed one at a time with a fixed pause between
servers. The exporter honors Discord's `Retry-After` response and uses bounded
backoff for transient errors. CDN downloads are deduplicated and use four
concurrent requests. API calls are ordinary same-origin `fetch` requests made by
the open Discord tab, so the browser supplies its normal request headers. The
script does not spoof a user agent or Discord client-fingerprint headers.

## Tests

Run the built-in Node tests from the repository root:

```bash
node --test discord/tests/export-emojis-console.test.js
```
