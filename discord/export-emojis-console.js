/* ============================================================================
 * Discord custom emoji exporter
 *
 * Paste this file into DevTools on https://discord.com/channels/... and run:
 *
 *   await window.__exportDiscordEmojis()
 *
 * The exporter first tries to read guild and emoji metadata already present in
 * Discord's web client. On current clients, those stores may not be exposed, so
 * it falls back to a user token entered into a temporary masked dialog. The
 * token is used only for read-only, same-origin metadata requests and is never
 * logged, archived, or written to browser storage. Emoji files are fetched from
 * Discord's public CDN and written to a ZIP chosen with Chromium's File System
 * Access API.
 * ========================================================================== */
(function initializeDiscordEmojiExporter(root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root && root.window === root && root.document) {
    let activeExport = null;

    Object.defineProperty(root, "__exportDiscordEmojis", {
      configurable: true,
      value: function exportDiscordEmojisFromConsole() {
        if (activeExport) {
          throw new Error("A Discord emoji export is already running in this tab.");
        }

        activeExport = api.runBrowserExport(root).finally(() => {
          activeExport = null;
        });
        return activeExport;
      },
    });

    root.console.info(
      "[discord-emoji-export] Ready. Run: await window.__exportDiscordEmojis()",
    );
  }
})(
  typeof globalThis === "object" ? globalThis : this,
  function createDiscordEmojiExporter() {
    "use strict";

    const UTF8_ZIP_FLAG = 0x0800;
    const ZIP_STORE_METHOD = 0;
    const ZIP_VERSION_20 = 20;
    const ZIP_VERSION_45 = 45;
    const UINT16_MAX = 0xffff;
    const UINT32_MAX = 0xffffffff;
    const UINT32_MAX_BIGINT = 0xffffffffn;
    const DEFAULT_CONCURRENCY = 4;
    const DEFAULT_MAX_ATTEMPTS = 3;
    const API_MAX_ATTEMPTS = 4;
    const API_REQUEST_DELAY_MS = 250;
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    class DownloadError extends Error {
      constructor(message, options) {
        super(message);
        this.name = "DownloadError";
        this.retryable = Boolean(options && options.retryable);
        this.retryAfterMs =
          options && Number.isFinite(options.retryAfterMs)
            ? options.retryAfterMs
            : null;
        this.status =
          options && Number.isInteger(options.status) ? options.status : null;
      }
    }

    class DiscordApiError extends Error {
      constructor(message, status) {
        super(message);
        this.name = "DiscordApiError";
        this.status = Number.isInteger(status) ? status : null;
      }
    }

    function toUint8Array(value) {
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      throw new TypeError("Expected binary data as Uint8Array or ArrayBuffer.");
    }

    function concatBytes(parts) {
      const arrays = parts.map(toUint8Array);
      const total = arrays.reduce((sum, part) => sum + part.byteLength, 0);
      const result = new Uint8Array(total);
      let offset = 0;

      for (const part of arrays) {
        result.set(part, offset);
        offset += part.byteLength;
      }
      return result;
    }

    function setUint64(view, offset, value) {
      const number = BigInt(value);
      view.setUint32(offset, Number(number & UINT32_MAX_BIGINT), true);
      view.setUint32(
        offset + 4,
        Number((number >> 32n) & UINT32_MAX_BIGINT),
        true,
      );
    }

    function getUint64(view, offset) {
      return (
        BigInt(view.getUint32(offset, true)) |
        (BigInt(view.getUint32(offset + 4, true)) << 32n)
      );
    }

    const crcTable = (() => {
      const table = new Uint32Array(256);
      for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value =
            value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
      }
      return table;
    })();

    function crc32(value) {
      const bytes = toUint8Array(value);
      let crc = 0xffffffff;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    function getDosDateTime(value) {
      const input = value instanceof Date ? value : new Date(value);
      const safeDate = Number.isNaN(input.getTime()) ? new Date() : input;
      const year = Math.min(2107, Math.max(1980, safeDate.getUTCFullYear()));
      const month = safeDate.getUTCMonth() + 1;
      const day = safeDate.getUTCDate();
      const hour = safeDate.getUTCHours();
      const minute = safeDate.getUTCMinutes();
      const second = Math.floor(safeDate.getUTCSeconds() / 2);

      return {
        date: ((year - 1980) << 9) | (month << 5) | day,
        time: (hour << 11) | (minute << 5) | second,
      };
    }

    function buildLocalFileRecord(entry) {
      const header = new Uint8Array(30);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, ZIP_VERSION_20, true);
      view.setUint16(6, UTF8_ZIP_FLAG, true);
      view.setUint16(8, ZIP_STORE_METHOD, true);
      view.setUint16(10, entry.time, true);
      view.setUint16(12, entry.date, true);
      view.setUint32(14, entry.crc, true);
      view.setUint32(18, Number(entry.size), true);
      view.setUint32(22, Number(entry.size), true);
      view.setUint16(26, entry.nameBytes.byteLength, true);
      view.setUint16(28, 0, true);
      return concatBytes([header, entry.nameBytes]);
    }

    function buildZip64OffsetExtra(localHeaderOffset) {
      const extra = new Uint8Array(12);
      const view = new DataView(extra.buffer);
      view.setUint16(0, 0x0001, true);
      view.setUint16(2, 8, true);
      setUint64(view, 4, localHeaderOffset);
      return extra;
    }

    function buildCentralDirectoryRecord(entry) {
      const needsZip64Offset = entry.localHeaderOffset > UINT32_MAX_BIGINT;
      const extra = needsZip64Offset
        ? buildZip64OffsetExtra(entry.localHeaderOffset)
        : new Uint8Array();
      const header = new Uint8Array(46);
      const view = new DataView(header.buffer);

      view.setUint32(0, 0x02014b50, true);
      view.setUint16(
        4,
        needsZip64Offset ? ZIP_VERSION_45 : ZIP_VERSION_20,
        true,
      );
      view.setUint16(
        6,
        needsZip64Offset ? ZIP_VERSION_45 : ZIP_VERSION_20,
        true,
      );
      view.setUint16(8, UTF8_ZIP_FLAG, true);
      view.setUint16(10, ZIP_STORE_METHOD, true);
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, Number(entry.size), true);
      view.setUint32(24, Number(entry.size), true);
      view.setUint16(28, entry.nameBytes.byteLength, true);
      view.setUint16(30, extra.byteLength, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(
        42,
        needsZip64Offset ? UINT32_MAX : Number(entry.localHeaderOffset),
        true,
      );

      return concatBytes([header, entry.nameBytes, extra]);
    }

    function buildZip64EndOfCentralDirectory(details) {
      const record = new Uint8Array(56);
      const view = new DataView(record.buffer);
      view.setUint32(0, 0x06064b50, true);
      setUint64(view, 4, 44n);
      view.setUint16(12, ZIP_VERSION_45, true);
      view.setUint16(14, ZIP_VERSION_45, true);
      view.setUint32(16, 0, true);
      view.setUint32(20, 0, true);
      setUint64(view, 24, details.entryCount);
      setUint64(view, 32, details.entryCount);
      setUint64(view, 40, details.centralSize);
      setUint64(view, 48, details.centralOffset);
      return record;
    }

    function buildZip64Locator(zip64RecordOffset) {
      const locator = new Uint8Array(20);
      const view = new DataView(locator.buffer);
      view.setUint32(0, 0x07064b50, true);
      view.setUint32(4, 0, true);
      setUint64(view, 8, zip64RecordOffset);
      view.setUint32(16, 1, true);
      return locator;
    }

    function buildClassicEndOfCentralDirectory(details) {
      const record = new Uint8Array(22);
      const view = new DataView(record.buffer);
      const entryCount =
        details.entryCount > BigInt(UINT16_MAX)
          ? UINT16_MAX
          : Number(details.entryCount);
      const centralSize =
        details.centralSize > UINT32_MAX_BIGINT
          ? UINT32_MAX
          : Number(details.centralSize);
      const centralOffset =
        details.centralOffset > UINT32_MAX_BIGINT
          ? UINT32_MAX
          : Number(details.centralOffset);

      view.setUint32(0, 0x06054b50, true);
      view.setUint16(4, 0, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, entryCount, true);
      view.setUint16(10, entryCount, true);
      view.setUint32(12, centralSize, true);
      view.setUint32(16, centralOffset, true);
      view.setUint16(20, 0, true);
      return record;
    }

    function buildEndRecords(details) {
      const needsZip64 =
        details.entryCount > BigInt(UINT16_MAX) ||
        details.centralSize > UINT32_MAX_BIGINT ||
        details.centralOffset > UINT32_MAX_BIGINT;
      const parts = [];

      if (needsZip64) {
        parts.push(buildZip64EndOfCentralDirectory(details));
        parts.push(buildZip64Locator(details.zip64RecordOffset));
      }
      parts.push(buildClassicEndOfCentralDirectory(details));
      return parts;
    }

    class StreamingZipWriter {
      constructor(writable) {
        if (!writable || typeof writable.write !== "function") {
          throw new TypeError("A writable file stream is required.");
        }
        this.writable = writable;
        this.entries = [];
        this.offset = 0n;
        this.finished = false;
      }

      async write(value) {
        if (this.finished) throw new Error("The ZIP writer is already finished.");
        const bytes = toUint8Array(value);
        if (bytes.byteLength === 0) return;
        await this.writable.write(bytes);
        this.offset += BigInt(bytes.byteLength);
      }

      async addFile(name, value, modifiedAt) {
        if (this.finished) throw new Error("The ZIP writer is already finished.");
        const nameBytes = textEncoder.encode(String(name));
        if (nameBytes.byteLength === 0 || nameBytes.byteLength > UINT16_MAX) {
          throw new Error(`Invalid ZIP entry name length for "${name}".`);
        }

        const bytes = toUint8Array(value);
        if (BigInt(bytes.byteLength) > UINT32_MAX_BIGINT) {
          throw new Error(`ZIP entry "${name}" exceeds the 4 GiB file limit.`);
        }

        const timestamp = getDosDateTime(modifiedAt || new Date());
        const entry = {
          name: String(name),
          nameBytes,
          crc: crc32(bytes),
          size: BigInt(bytes.byteLength),
          time: timestamp.time,
          date: timestamp.date,
          localHeaderOffset: this.offset,
        };

        await this.write(buildLocalFileRecord(entry));
        await this.write(bytes);
        this.entries.push(entry);
        return entry;
      }

      async addText(name, value, modifiedAt) {
        return this.addFile(name, textEncoder.encode(String(value)), modifiedAt);
      }

      async finalize() {
        if (this.finished) throw new Error("The ZIP writer is already finished.");

        const centralOffset = this.offset;
        for (const entry of this.entries) {
          await this.write(buildCentralDirectoryRecord(entry));
        }
        const centralSize = this.offset - centralOffset;
        const zip64RecordOffset = this.offset;
        const endRecords = buildEndRecords({
          entryCount: BigInt(this.entries.length),
          centralSize,
          centralOffset,
          zip64RecordOffset,
        });

        for (const record of endRecords) {
          await this.write(record);
        }

        if (typeof this.writable.close === "function") {
          await this.writable.close();
        }
        this.finished = true;

        return {
          entries: this.entries.length,
          archiveBytes: this.offset,
          usedZip64: endRecords.length > 1,
        };
      }

      async abort(reason) {
        if (this.finished) return;
        this.finished = true;
        if (typeof this.writable.abort === "function") {
          await this.writable.abort(reason);
        }
      }
    }

    function sanitizeSegment(value, maximumCodePoints) {
      const limit = Number.isInteger(maximumCodePoints)
        ? maximumCodePoints
        : 64;
      let segment = String(value == null ? "" : value)
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/_+/g, "_")
        .replace(/^[ .]+|[ .]+$/g, "");

      segment = Array.from(segment).slice(0, limit).join("");
      segment = segment.replace(/[ .]+$/g, "");
      if (!segment) segment = "unnamed";

      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
        segment = `_${segment}`;
      }
      return segment;
    }

    function createArchivePath(guild, emoji) {
      const guildName = sanitizeSegment(guild.name, 64);
      const emojiName = sanitizeSegment(emoji.name, 32);
      const emojiId = sanitizeSegment(emoji.id, 32);
      const guildId =
        guild.id == null || String(guild.id).trim() === ""
          ? ""
          : `--${sanitizeSegment(guild.id, 32)}`;
      return `emojis/${guildName}${guildId}--${emojiName}--${emojiId}.webp`;
    }

    function getEmojiCdnUrl(emoji) {
      const id = encodeURIComponent(String(emoji.id));
      return `https://cdn.discordapp.com/emojis/${id}.webp${
        emoji.animated ? "?animated=true" : ""
      }`;
    }

    function getModuleCandidates(moduleExports) {
      const candidates = [];
      const seen = new Set();
      const addCandidate = (value) => {
        if (
          (typeof value !== "object" || value === null) &&
          typeof value !== "function"
        ) {
          return;
        }
        if (seen.has(value)) return;
        seen.add(value);
        candidates.push(value);
      };

      addCandidate(moduleExports);
      let isWindowObject = false;
      try {
        isWindowObject =
          moduleExports &&
          moduleExports.window === moduleExports &&
          moduleExports.document;
      } catch (_error) {
        // Treat proxy-like exports conservatively and inspect no nested values.
        return candidates;
      }
      if (isWindowObject) return candidates;

      let keys;
      try {
        keys = Reflect.ownKeys(moduleExports || {});
      } catch (_error) {
        return candidates;
      }
      for (const key of keys.slice(0, 500)) {
        if (key === "prototype" || key === "constructor") continue;
        try {
          addCandidate(moduleExports[key]);
        } catch (_error) {
          // Some Discord module getters throw until their feature is loaded.
        }
      }
      return candidates;
    }

    function hasMethods(candidate, methodNames) {
      return methodNames.every(
        (methodName) => typeof candidate[methodName] === "function",
      );
    }

    function matchesStoreName(candidate, storeName) {
      try {
        if (candidate.constructor?.displayName === storeName) return true;
      } catch (_error) {
        // Ignore unusual proxy objects.
      }
      try {
        if (
          typeof candidate.getName === "function" &&
          typeof candidate.addChangeListener === "function" &&
          candidate.getName() === storeName
        ) {
          return true;
        }
      } catch (_error) {
        // Ignore non-store getName implementations.
      }
      return false;
    }

    function findStoreInCache(cache, storeName, requiredMethods) {
      for (const cachedModule of Object.values(cache || {})) {
        const moduleExports = cachedModule && cachedModule.exports;
        for (const candidate of getModuleCandidates(moduleExports)) {
          if (!matchesStoreName(candidate, storeName)) continue;
          let hasRequiredMethods = false;
          try {
            hasRequiredMethods = hasMethods(candidate, requiredMethods);
          } catch (_error) {
            continue;
          }
          if (hasRequiredMethods) return candidate;
        }
      }
      return null;
    }

    function captureWebpackRequire(root) {
      const chunks = root.webpackChunkdiscord_app;
      if (!chunks || typeof chunks.push !== "function") {
        throw new Error(
          "Discord's webpack runtime was not found. Open the Discord web app, wait for it to finish loading, and try again.",
        );
      }

      let webpackRequire = null;
      const chunkId = `discord-emoji-export-${Date.now()}-${Math.random()}`;
      const payload = [
        [chunkId],
        {},
        (requireFunction) => {
          webpackRequire = requireFunction;
        },
      ];

      chunks.push(payload);
      if (typeof chunks.indexOf === "function" && typeof chunks.splice === "function") {
        const payloadIndex = chunks.indexOf(payload);
        if (payloadIndex >= 0) chunks.splice(payloadIndex, 1);
      }

      if (!webpackRequire || !webpackRequire.c) {
        throw new Error(
          "Discord's module cache could not be captured. The web client may have changed.",
        );
      }
      return webpackRequire;
    }

    function discoverDiscordStores(root) {
      const webpackRequire = captureWebpackRequire(root);
      const guildStore = findStoreInCache(
        webpackRequire.c,
        "GuildStore",
        ["getGuilds", "getGuild", "getGuildCount"],
      );
      const emojiStore = findStoreInCache(
        webpackRequire.c,
        "EmojiStore",
        ["getGuilds", "getGuildEmoji", "getCustomEmojiById"],
      );

      if (!guildStore || !emojiStore) {
        const missing = [
          !guildStore && "GuildStore",
          !emojiStore && "EmojiStore",
        ]
          .filter(Boolean)
          .join(" and ");
        throw new Error(
          `${missing} could not be found. Discord's internal client modules may have changed.`,
        );
      }
      return { guildStore, emojiStore };
    }

    function compareText(left, right) {
      return String(left || "").localeCompare(String(right || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      });
    }

    function collectEmojiInventory(guildStore, emojiStore) {
      const rawGuilds = guildStore.getGuilds();
      const guildValues = Object.values(rawGuilds || {}).filter(
        (guild) => guild && guild.id,
      );
      guildValues.sort(
        (left, right) =>
          compareText(left.name, right.name) ||
          compareText(left.id, right.id),
      );

      if (guildValues.length === 0) {
        throw new Error(
          "No Discord servers are loaded. Wait for Discord to finish loading and try again.",
        );
      }

      const guilds = [];
      const emojis = [];
      const seen = new Set();

      for (const guild of guildValues) {
        const guildSummary = {
          id: String(guild.id),
          name: String(guild.name || "Unnamed server"),
          emojiCount: 0,
          collectionError: null,
        };
        guilds.push(guildSummary);

        let rawEmojis;
        try {
          rawEmojis = emojiStore.getGuildEmoji(guildSummary.id) || [];
        } catch (error) {
          guildSummary.collectionError = serializeError(error);
          continue;
        }

        for (const emoji of rawEmojis) {
          if (!emoji || !emoji.id) continue;
          const identity = `${guildSummary.id}:${emoji.id}`;
          if (seen.has(identity)) continue;
          seen.add(identity);

          const record = {
            guildId: guildSummary.id,
            guildName: guildSummary.name,
            id: String(emoji.id),
            name: String(emoji.name || emoji.originalName || "unnamed"),
            animated: Boolean(emoji.animated),
            available:
              typeof emoji.available === "boolean" ? emoji.available : null,
            managed:
              typeof emoji.managed === "boolean" ? emoji.managed : null,
            roles: Array.isArray(emoji.roles)
              ? emoji.roles.map(String)
              : [],
          };
          record.archivePath = createArchivePath(guildSummary, record);
          record.cdnUrl = getEmojiCdnUrl(record);
          emojis.push(record);
          guildSummary.emojiCount += 1;
        }
      }

      emojis.sort(
        (left, right) =>
          compareText(left.guildName, right.guildName) ||
          compareText(left.guildId, right.guildId) ||
          compareText(left.name, right.name) ||
          compareText(left.id, right.id),
      );

      return {
        source: "discord-web-client-store",
        guilds,
        emojis,
      };
    }

    function parseRetryAfter(headers) {
      if (!headers || typeof headers.get !== "function") return null;
      const rawValue = headers.get("retry-after");
      if (!rawValue) return null;

      const seconds = Number(rawValue);
      if (Number.isFinite(seconds)) {
        return Math.min(30_000, Math.max(0, seconds * 1000));
      }

      const timestamp = Date.parse(rawValue);
      if (Number.isNaN(timestamp)) return null;
      return Math.min(30_000, Math.max(0, timestamp - Date.now()));
    }

    function isWebP(bytes) {
      return (
        bytes.byteLength >= 12 &&
        textDecoder.decode(bytes.subarray(0, 4)) === "RIFF" &&
        textDecoder.decode(bytes.subarray(8, 12)) === "WEBP"
      );
    }

    function delay(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    async function fetchEmojiAsset(url, options) {
      const fetchImpl = options.fetchImpl;
      const response = await fetchImpl(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "force-cache",
        redirect: "follow",
      });

      if (!response || !response.ok) {
        const status = response && Number.isInteger(response.status)
          ? response.status
          : null;
        const statusText =
          response && response.statusText ? ` ${response.statusText}` : "";
        throw new DownloadError(
          status == null
            ? "Discord CDN returned an invalid response."
            : `Discord CDN returned HTTP ${status}${statusText}.`,
          {
            status,
            retryable: status === 429 || (status != null && status >= 500),
            retryAfterMs:
              status === 429 ? parseRetryAfter(response.headers) : null,
          },
        );
      }

      const contentType =
        response.headers && typeof response.headers.get === "function"
          ? response.headers.get("content-type")
          : null;
      if (contentType && !/^image\/webp(?:;|$)/i.test(contentType)) {
        throw new DownloadError(
          `Discord CDN returned unexpected content type "${contentType}".`,
          { retryable: false, status: response.status },
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!isWebP(bytes)) {
        throw new DownloadError(
          "Discord CDN response was not a valid WebP asset.",
          { retryable: false, status: response.status },
        );
      }
      return bytes;
    }

    async function fetchAssetWithRetry(url, options) {
      const maxAttempts =
        Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
          ? options.maxAttempts
          : DEFAULT_MAX_ATTEMPTS;
      const sleep = options.sleep || delay;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await fetchEmojiAsset(url, options);
        } catch (error) {
          if (error && error.name === "AbortError") throw error;
          lastError = error;
          const retryable =
            error instanceof DownloadError ? error.retryable : true;
          if (!retryable || attempt === maxAttempts) break;

          const fallbackDelay = 500 * 2 ** (attempt - 1);
          const retryDelay =
            error instanceof DownloadError && error.retryAfterMs != null
              ? error.retryAfterMs
              : fallbackDelay;
          await sleep(retryDelay);
        }
      }
      throw lastError || new Error("Discord CDN download failed.");
    }

    function serializeError(error) {
      if (!error) return "Unknown error";
      if (typeof error === "string") return error;
      return error.message ? String(error.message) : String(error);
    }

    async function getApiRetryDelay(response, attempt) {
      const headerDelay = parseRetryAfter(response && response.headers);
      if (headerDelay != null) return headerDelay;

      if (
        response &&
        response.status === 429 &&
        typeof response.clone === "function"
      ) {
        try {
          const body = await response.clone().json();
          const seconds = Number(body && body.retry_after);
          if (Number.isFinite(seconds)) {
            return Math.min(60_000, Math.max(0, seconds * 1000));
          }
        } catch (_error) {
          // Fall through to bounded exponential backoff.
        }
      }
      return Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
    }

    async function fetchDiscordApiJson(path, options) {
      const maxAttempts =
        Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
          ? options.maxAttempts
          : DEFAULT_MAX_ATTEMPTS;
      const sleep = options.sleep || delay;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response;
        try {
          response = await options.fetchImpl(path, {
            method: "GET",
            mode: "same-origin",
            credentials: "omit",
            cache: "no-store",
            redirect: "follow",
            headers: {
              Accept: "application/json",
              Authorization: options.token,
            },
          });
        } catch (error) {
          lastError = error;
          if (error && error.name === "AbortError") throw error;
          if (attempt < maxAttempts) {
            await sleep(Math.min(10_000, 500 * 2 ** (attempt - 1)));
            continue;
          }
          break;
        }

        if (response && response.ok) {
          try {
            return await response.json();
          } catch (_error) {
            throw new DiscordApiError(
              `Discord returned invalid JSON for ${path}.`,
              response.status,
            );
          }
        }

        const status =
          response && Number.isInteger(response.status)
            ? response.status
            : null;
        const retryable =
          status === 429 || (status != null && status >= 500);
        if (retryable && attempt < maxAttempts) {
          await sleep(await getApiRetryDelay(response, attempt));
          continue;
        }

        if (status === 401) {
          throw new DiscordApiError(
            "Discord rejected the user token (HTTP 401).",
            status,
          );
        }
        throw new DiscordApiError(
          status == null
            ? `Discord returned an invalid response for ${path}.`
            : `Discord API request failed with HTTP ${status}.`,
          status,
        );
      }

      throw new DiscordApiError(
        `Discord API request failed: ${serializeError(lastError)}`,
        null,
      );
    }

    async function collectEmojiInventoryFromUserApi(options) {
      const logger = options.logger || console;
      const throttleSleep = options.sleep || delay;
      const guildPayload = [];
      const seenCursors = new Set();
      let after = null;

      for (;;) {
        const cursor = after
          ? `&after=${encodeURIComponent(after)}`
          : "";
        const page = await fetchDiscordApiJson(
          `/api/v10/users/@me/guilds?limit=200${cursor}`,
          options,
        );
        if (!Array.isArray(page)) {
          throw new DiscordApiError(
            "Discord returned an unexpected guild-list response.",
            null,
          );
        }
        guildPayload.push(...page);
        if (page.length < 200) break;

        const nextCursor =
          page.length > 0 && page[page.length - 1]
            ? String(page[page.length - 1].id || "")
            : "";
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new DiscordApiError(
            "Discord returned an invalid guild-list pagination cursor.",
            null,
          );
        }
        seenCursors.add(nextCursor);
        after = nextCursor;
        await throttleSleep(API_REQUEST_DELAY_MS);
      }

      const guilds = Array.from(
        new Map(
          guildPayload
            .filter((guild) => guild && guild.id)
            .map((guild) => [String(guild.id), guild]),
        ).values(),
      )
        .map((guild) => ({
          id: String(guild.id),
          name: String(guild.name || "Unnamed server"),
          emojiCount: 0,
          collectionError: null,
        }))
        .sort(
          (left, right) =>
            compareText(left.name, right.name) ||
            compareText(left.id, right.id),
        );
      const emojis = [];
      const seen = new Set();
      const concurrency = 1;
      let processedGuilds = 0;

      for (let start = 0; start < guilds.length; start += concurrency) {
        const batch = guilds.slice(start, start + concurrency);
        const results = await Promise.all(
          batch.map(async (guild) => {
            try {
              const payload = await fetchDiscordApiJson(
                `/api/v10/guilds/${encodeURIComponent(guild.id)}/emojis`,
                options,
              );
              if (!Array.isArray(payload)) {
                throw new DiscordApiError(
                  "Discord returned an unexpected emoji-list response.",
                  null,
                );
              }
              return { guild, payload, error: null };
            } catch (error) {
              if (error instanceof DiscordApiError && error.status === 401) {
                throw error;
              }
              return { guild, payload: [], error };
            }
          }),
        );

        for (const result of results) {
          if (result.error) {
            result.guild.collectionError = serializeError(result.error);
          }

          for (const emoji of result.payload) {
            if (!emoji || !emoji.id) continue;
            const emojiId = String(emoji.id);
            if (seen.has(emojiId)) continue;
            seen.add(emojiId);

            const record = {
              guildId: result.guild.id,
              guildName: result.guild.name,
              id: emojiId,
              name: String(emoji.name || "unnamed"),
              animated: Boolean(emoji.animated),
              available:
                typeof emoji.available === "boolean"
                  ? emoji.available
                  : null,
              managed:
                typeof emoji.managed === "boolean" ? emoji.managed : null,
              roles: Array.isArray(emoji.roles)
                ? emoji.roles.map(String)
                : [],
            };
            record.archivePath = createArchivePath(result.guild, record);
            record.cdnUrl = getEmojiCdnUrl(record);
            emojis.push(record);
            result.guild.emojiCount += 1;
          }
          processedGuilds += 1;
        }

        if (
          processedGuilds === guilds.length ||
          processedGuilds % 20 === 0
        ) {
          logger.info(
            `[discord-emoji-export] Read emoji metadata from ${processedGuilds}/${guilds.length} servers.`,
          );
        }
        if (processedGuilds < guilds.length) {
          await throttleSleep(API_REQUEST_DELAY_MS);
        }
      }

      emojis.sort(
        (left, right) =>
          compareText(left.guildName, right.guildName) ||
          compareText(left.guildId, right.guildId) ||
          compareText(left.name, right.name) ||
          compareText(left.id, right.id),
      );

      return {
        source: "discord-user-rest-api",
        guilds,
        emojis,
      };
    }

    function requestDiscordUserToken(root) {
      return new Promise((resolve, reject) => {
        const document = root.document;
        let settled = false;
        const previous = document.getElementById(
          "__discord-emoji-export-token-dialog",
        );
        if (previous) previous.remove();

        const overlay = document.createElement("div");
        overlay.id = "__discord-emoji-export-token-dialog";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Discord emoji export token");
        Object.assign(overlay.style, {
          position: "fixed",
          inset: "0",
          zIndex: "2147483647",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          background: "rgba(0, 0, 0, 0.72)",
          color: "#f2f3f5",
          font: "14px/1.45 system-ui, sans-serif",
        });

        const form = document.createElement("form");
        Object.assign(form.style, {
          width: "min(520px, 100%)",
          padding: "24px",
          borderRadius: "12px",
          background: "#313338",
          boxShadow: "0 18px 48px rgba(0, 0, 0, 0.45)",
        });

        const title = document.createElement("h2");
        title.textContent = "Export Discord server emojis";
        Object.assign(title.style, {
          margin: "0 0 12px",
          fontSize: "20px",
        });

        const warning = document.createElement("p");
        warning.textContent =
          "Warning: automating a normal Discord account violates Discord's self-bot policy and can put the account at risk. The script uses the token only for this export and does not log, archive, or store it.";
        Object.assign(warning.style, {
          margin: "0 0 18px",
          color: "#f0b232",
        });

        const label = document.createElement("label");
        label.textContent = "Discord user token";
        Object.assign(label.style, {
          display: "block",
          marginBottom: "6px",
          fontWeight: "600",
        });

        const input = document.createElement("input");
        input.type = "password";
        input.required = true;
        input.autocomplete = "new-password";
        input.spellcheck = false;
        input.placeholder = "Token is not displayed or stored";
        Object.assign(input.style, {
          boxSizing: "border-box",
          width: "100%",
          marginBottom: "8px",
          padding: "10px 12px",
          border: "1px solid #1e1f22",
          borderRadius: "6px",
          outline: "none",
          background: "#1e1f22",
          color: "#f2f3f5",
        });

        const errorText = document.createElement("div");
        Object.assign(errorText.style, {
          minHeight: "20px",
          marginBottom: "12px",
          color: "#fa777c",
        });

        const actions = document.createElement("div");
        Object.assign(actions.style, {
          display: "flex",
          justifyContent: "flex-end",
          gap: "8px",
        });

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.textContent = "Cancel";
        Object.assign(cancelButton.style, {
          padding: "8px 14px",
          border: "0",
          borderRadius: "5px",
          background: "transparent",
          color: "#f2f3f5",
          cursor: "pointer",
        });

        const continueButton = document.createElement("button");
        continueButton.type = "submit";
        continueButton.textContent = "Choose ZIP location";
        Object.assign(continueButton.style, {
          padding: "8px 14px",
          border: "0",
          borderRadius: "5px",
          background: "#5865f2",
          color: "white",
          cursor: "pointer",
          fontWeight: "600",
        });

        const cleanup = () => {
          input.value = "";
          overlay.remove();
        };
        const cancel = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new DOMException("Token entry cancelled.", "AbortError"));
        };

        cancelButton.addEventListener("click", cancel, { once: true });
        overlay.addEventListener("keydown", (event) => {
          if (event.key === "Escape") cancel();
        });
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (settled) return;
          const token = input.value.trim();
          if (!token) {
            errorText.textContent = "Enter a Discord user token.";
            input.focus();
            return;
          }
          settled = true;
          cleanup();
          resolve(token);
        });

        actions.append(cancelButton, continueButton);
        form.append(title, warning, label, input, errorText, actions);
        overlay.append(form);
        document.body.append(overlay);
        input.focus();
      });
    }

    function buildManifest(inventory, records, details) {
      const downloaded = records.filter(
        (record) => record.status === "downloaded",
      );
      const failed = records.filter((record) => record.status === "failed");
      const assetBytes = downloaded.reduce(
        (sum, record) => sum + record.byteSize,
        0,
      );

      return {
        schemaVersion: 1,
        exportedAt: details.exportedAt.toISOString(),
        source: inventory.source || "discord-web-client-store",
        sourceUrl: details.sourceUrl,
        assetFormat: "webp",
        archiveLayout: "flat",
        counts: {
          guilds: inventory.guilds.length,
          discovered: records.length,
          downloaded: downloaded.length,
          failed: failed.length,
          assetBytes,
        },
        guilds: inventory.guilds,
        emojis: records,
      };
    }

    async function exportInventoryToZip(options) {
      const inventory = options.inventory;
      const zipWriter = options.zipWriter;
      const logger = options.logger || console;
      const exportedAt = options.exportedAt || new Date();
      const concurrency =
        Number.isInteger(options.concurrency) && options.concurrency > 0
          ? options.concurrency
          : DEFAULT_CONCURRENCY;
      const records = inventory.emojis.map((emoji) => ({
        ...emoji,
        roles: Array.isArray(emoji.roles) ? [...emoji.roles] : [],
        status: "pending",
        byteSize: null,
        error: null,
      }));
      let processed = 0;
      let lastLogged = 0;

      for (let start = 0; start < records.length; start += concurrency) {
        const batch = records.slice(start, start + concurrency);
        const downloads = await Promise.all(
          batch.map(async (record) => {
            try {
              const bytes = await fetchAssetWithRetry(record.cdnUrl, {
                fetchImpl: options.fetchImpl,
                maxAttempts: options.maxAttempts,
                sleep: options.sleep,
              });
              return { record, bytes, error: null };
            } catch (error) {
              return { record, bytes: null, error };
            }
          }),
        );

        for (const download of downloads) {
          if (download.error) {
            download.record.status = "failed";
            download.record.error = serializeError(download.error);
          } else {
            await zipWriter.addFile(
              download.record.archivePath,
              download.bytes,
              exportedAt,
            );
            download.record.status = "downloaded";
            download.record.byteSize = download.bytes.byteLength;
          }
          processed += 1;
        }

        if (
          processed === records.length ||
          processed - lastLogged >= 25
        ) {
          const failed = records
            .slice(0, processed)
            .filter((record) => record.status === "failed").length;
          logger.info(
            `[discord-emoji-export] ${processed}/${records.length} processed (${failed} failed).`,
          );
          lastLogged = processed;
        }
      }

      const manifest = buildManifest(inventory, records, {
        exportedAt,
        sourceUrl: options.sourceUrl,
      });
      await zipWriter.addText(
        "manifest.json",
        `${JSON.stringify(manifest, null, 2)}\n`,
        exportedAt,
      );
      const archive = await zipWriter.finalize();
      return { manifest, archive };
    }

    function createSuggestedFileName(exportedAt) {
      const timestamp = exportedAt
        .toISOString()
        .replace(/[:.]/g, "-");
      return `discord-server-emojis-${timestamp}.zip`;
    }

    function assertSupportedDiscordPage(root) {
      const location = root.location;
      const isDiscordHost =
        location &&
        /(^|\.)discord\.com$/i.test(String(location.hostname || ""));
      const isChannelsPage =
        location && String(location.pathname || "").startsWith("/channels/");

      if (!isDiscordHost || !isChannelsPage) {
        throw new Error(
          "Run this exporter from the loaded Discord web app at https://discord.com/channels/...",
        );
      }
      if (typeof root.showSaveFilePicker !== "function") {
        throw new Error(
          "This exporter requires Chrome or Edge with the File System Access API.",
        );
      }
      if (typeof root.fetch !== "function") {
        throw new Error("This browser does not provide the Fetch API.");
      }
    }

    async function runBrowserExport(root) {
      assertSupportedDiscordPage(root);
      const logger = root.console || console;
      const exportedAt = new Date();
      let inventory = null;
      let userToken = null;
      try {
        try {
          const stores = discoverDiscordStores(root);
          inventory = collectEmojiInventory(
            stores.guildStore,
            stores.emojiStore,
          );
        } catch (storeError) {
          logger.warn(
            "[discord-emoji-export] Discord client stores are unavailable; switching to one-time user-token API mode.",
          );
          userToken = await requestDiscordUserToken(root);
        }

        const fileHandle = await root.showSaveFilePicker({
          suggestedName: createSuggestedFileName(exportedAt),
          types: [
            {
              description: "ZIP archive",
              accept: { "application/zip": [".zip"] },
            },
          ],
          excludeAcceptAllOption: true,
        });

        if (!inventory) {
          inventory = await collectEmojiInventoryFromUserApi({
            fetchImpl: root.fetch.bind(root),
            token: userToken,
            maxAttempts: API_MAX_ATTEMPTS,
            logger,
          });
          userToken = null;
        }

        logger.info(
          `[discord-emoji-export] Found ${inventory.emojis.length} custom emojis across ${inventory.guilds.length} servers.`,
        );

        const writable = await fileHandle.createWritable();
        const zipWriter = new StreamingZipWriter(writable);
        try {
          const result = await exportInventoryToZip({
            inventory,
            zipWriter,
            fetchImpl: root.fetch.bind(root),
            exportedAt,
            sourceUrl: String(root.location.href),
            concurrency: DEFAULT_CONCURRENCY,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
            logger,
          });
          const summary = {
            fileName: fileHandle.name || createSuggestedFileName(exportedAt),
            guilds: result.manifest.counts.guilds,
            discovered: result.manifest.counts.discovered,
            downloaded: result.manifest.counts.downloaded,
            failed: result.manifest.counts.failed,
            assetBytes: result.manifest.counts.assetBytes,
            archiveBytes: result.archive.archiveBytes.toString(),
          };

          logger.info("[discord-emoji-export] Complete.", summary);
          if (summary.failed > 0) {
            logger.warn(
              `[discord-emoji-export] ${summary.failed} assets failed; see manifest.json for details.`,
            );
          }
          return summary;
        } catch (error) {
          try {
            await zipWriter.abort(error);
          } catch (abortError) {
            logger.warn(
              "[discord-emoji-export] Could not abort the partial file cleanly.",
              abortError,
            );
          }
          throw error;
        }
      } finally {
        userToken = null;
      }
    }

    return {
      StreamingZipWriter,
      buildCentralDirectoryRecord,
      buildEndRecords,
      collectEmojiInventoryFromUserApi,
      collectEmojiInventory,
      concatBytes,
      createArchivePath,
      createSuggestedFileName,
      crc32,
      discoverDiscordStores,
      exportInventoryToZip,
      fetchDiscordApiJson,
      fetchAssetWithRetry,
      findStoreInCache,
      getEmojiCdnUrl,
      getUint64,
      isWebP,
      runBrowserExport,
      sanitizeSegment,
    };
  },
);
