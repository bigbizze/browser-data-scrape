"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  StreamingZipWriter,
  buildCentralDirectoryRecord,
  buildEndRecords,
  collectEmojiInventoryFromUserApi,
  collectEmojiInventory,
  concatBytes,
  createArchivePath,
  crc32,
  exportInventoryToZip,
  fetchDiscordApiJson,
  findStoreInCache,
  getEmojiCdnUrl,
  getUint64,
  sanitizeSegment,
} = require("../export-emojis-console.js");

class MemoryWritable {
  constructor() {
    this.chunks = [];
    this.closed = false;
    this.aborted = false;
  }

  async write(value) {
    this.chunks.push(Uint8Array.from(value));
  }

  async close() {
    this.closed = true;
  }

  async abort() {
    this.aborted = true;
  }

  bytes() {
    return concatBytes(this.chunks);
  }
}

function makeWebP(marker) {
  return Uint8Array.from([
    0x52,
    0x49,
    0x46,
    0x46,
    0x05,
    0x00,
    0x00,
    0x00,
    0x57,
    0x45,
    0x42,
    0x50,
    marker,
  ]);
}

function mockResponse(status, body, headers) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get(name) {
        return normalizedHeaders[String(name).toLowerCase()] || null;
      },
    },
    async arrayBuffer() {
      const bytes = Uint8Array.from(body || []);
      return bytes.buffer;
    },
  };
}

function mockJsonResponse(status, payload, headers) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders[String(name).toLowerCase()] || null;
      },
    },
    async json() {
      return payload;
    },
    clone() {
      return mockJsonResponse(status, payload, headers);
    },
  };
}

function parseStoreOnlyZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;

  for (let index = bytes.byteLength - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  assert.notEqual(endOffset, -1, "end-of-central-directory record");

  const entryCount = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
    const crc = view.getUint32(centralOffset + 16, true);
    const size = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const nameStart = centralOffset + 46;
    const name = new TextDecoder().decode(
      bytes.subarray(nameStart, nameStart + nameLength),
    );

    assert.equal(view.getUint32(localOffset, true), 0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart =
      localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataStart, dataStart + size);
    assert.equal(crc32(data), crc);

    entries.set(name, data);
    centralOffset +=
      46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("CRC32 matches the standard check vector", () => {
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(crc32(bytes), 0xcbf43926);
});

test("flat archive paths are sanitized and collision-resistant", () => {
  assert.equal(sanitizeSegment(" CON "), "_CON");
  assert.equal(sanitizeSegment("bad/name:*?"), "bad_name_");
  assert.equal(
    createArchivePath(
      { id: "111", name: "Same/Server" },
      { id: "222", name: "party:time" },
    ),
    "emojis/Same_Server--111--party_time--222.webp",
  );
  assert.equal(
    createArchivePath(
      { id: null, name: "Unknown Server" },
      { id: "333", name: "wave" },
    ),
    "emojis/Unknown Server--wave--333.webp",
  );
});

test("store discovery accepts named stores and rejects structural impostors", () => {
  const impostor = {
    getGuilds() {},
    getGuild() {},
    getGuildCount() {},
  };
  assert.equal(
    findStoreInCache(
      { 1: { exports: impostor } },
      "GuildStore",
      ["getGuilds", "getGuild", "getGuildCount"],
    ),
    null,
  );

  const guildStore = {
    getGuilds() {},
    getGuild() {},
    getGuildCount() {},
  };
  Object.defineProperty(guildStore, "constructor", {
    value: { displayName: "GuildStore" },
  });
  assert.equal(
    findStoreInCache(
      { 1: { exports: { default: guildStore } } },
      "GuildStore",
      ["getGuilds", "getGuild", "getGuildCount"],
    ),
    guildStore,
  );
});

test("inventory includes all custom emoji metadata and sorts guilds", () => {
  const guildStore = {
    getGuilds() {
      return {
        "2": { id: "2", name: "Zulu" },
        "1": { id: "1", name: "Alpha" },
      };
    },
  };
  const emojiStore = {
    getGuildEmoji(guildId) {
      if (guildId === "1") {
        return [
          {
            id: "10",
            name: "dance",
            animated: true,
            available: false,
            managed: true,
            roles: ["99"],
          },
        ];
      }
      return [];
    },
  };

  const inventory = collectEmojiInventory(guildStore, emojiStore);
  assert.deepEqual(
    inventory.guilds.map((guild) => guild.name),
    ["Alpha", "Zulu"],
  );
  assert.equal(inventory.emojis.length, 1);
  assert.equal(inventory.emojis[0].available, false);
  assert.equal(inventory.emojis[0].managed, true);
  assert.deepEqual(inventory.emojis[0].roles, ["99"]);
  assert.equal(
    inventory.emojis[0].cdnUrl,
    "https://cdn.discordapp.com/emojis/10.webp?animated=true",
  );
});

test("user API inventory is sequential, paced, and keeps the token out of results", async () => {
  const token = "test.user.token";
  const requests = [];
  const sleepDurations = [];
  let activeEmojiRequests = 0;
  let maximumActiveEmojiRequests = 0;

  const fetchImpl = async (path, options) => {
    requests.push({ path, options });
    if (path === "/api/v10/users/@me/guilds?limit=200") {
      return mockJsonResponse(200, [
        { id: "2", name: "Zulu" },
        { id: "1", name: "Alpha" },
      ]);
    }

    activeEmojiRequests += 1;
    maximumActiveEmojiRequests = Math.max(
      maximumActiveEmojiRequests,
      activeEmojiRequests,
    );
    await Promise.resolve();
    activeEmojiRequests -= 1;

    if (path === "/api/v10/guilds/1/emojis") {
      return mockJsonResponse(200, [
        {
          id: "10",
          name: "dance",
          animated: true,
          available: true,
          managed: false,
          roles: ["99"],
        },
      ]);
    }
    if (path === "/api/v10/guilds/2/emojis") {
      return mockJsonResponse(403, { message: "Missing Access" });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const inventory = await collectEmojiInventoryFromUserApi({
    fetchImpl,
    token,
    maxAttempts: 2,
    sleep: async (milliseconds) => {
      sleepDurations.push(milliseconds);
    },
    logger: { info() {} },
  });

  assert.deepEqual(
    requests.map((request) => request.path),
    [
      "/api/v10/users/@me/guilds?limit=200",
      "/api/v10/guilds/1/emojis",
      "/api/v10/guilds/2/emojis",
    ],
  );
  assert.equal(maximumActiveEmojiRequests, 1);
  assert.deepEqual(sleepDurations, [250]);
  for (const request of requests) {
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.mode, "same-origin");
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.headers.Authorization, token);
  }

  assert.equal(inventory.source, "discord-user-rest-api");
  assert.deepEqual(
    inventory.guilds.map((guild) => guild.name),
    ["Alpha", "Zulu"],
  );
  assert.equal(inventory.emojis.length, 1);
  assert.equal(
    inventory.emojis[0].archivePath,
    "emojis/Alpha--1--dance--10.webp",
  );
  assert.match(inventory.guilds[1].collectionError, /HTTP 403/);
  assert.equal(JSON.stringify(inventory).includes(token), false);
});

test("user API requests honor Retry-After before retrying", async () => {
  const sleepDurations = [];
  let attempts = 0;
  const result = await fetchDiscordApiJson("/api/v10/test", {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return mockJsonResponse(429, { retry_after: 9 }, {
          "retry-after": "0.25",
        });
      }
      return mockJsonResponse(200, { ok: true });
    },
    token: "test.user.token",
    maxAttempts: 2,
    sleep: async (milliseconds) => {
      sleepDurations.push(milliseconds);
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(sleepDurations, [250]);
});

test("streaming writer creates a valid store-only ZIP", async () => {
  const writable = new MemoryWritable();
  const writer = new StreamingZipWriter(writable);
  const timestamp = new Date("2026-07-28T12:00:00.000Z");
  const asset = makeWebP(1);

  await writer.addFile("emojis/example.webp", asset, timestamp);
  await writer.addText("manifest.json", '{"ok":true}\n', timestamp);
  const result = await writer.finalize();

  assert.equal(writable.closed, true);
  assert.equal(result.entries, 2);
  assert.equal(result.usedZip64, false);
  const entries = parseStoreOnlyZip(writable.bytes());
  assert.deepEqual(entries.get("emojis/example.webp"), asset);
  assert.equal(
    new TextDecoder().decode(entries.get("manifest.json")),
    '{"ok":true}\n',
  );
});

test("ZIP64 records encode large offsets and entry counts", () => {
  const nameBytes = new TextEncoder().encode("emojis/large.webp");
  const centralRecord = buildCentralDirectoryRecord({
    nameBytes,
    crc: 1,
    size: 1n,
    time: 0,
    date: 0,
    localHeaderOffset: 0x1_0000_0000n,
  });
  const centralView = new DataView(centralRecord.buffer);
  assert.equal(centralView.getUint32(42, true), 0xffffffff);
  const extraOffset = 46 + nameBytes.byteLength;
  assert.equal(centralView.getUint16(extraOffset, true), 0x0001);
  assert.equal(centralView.getUint16(extraOffset + 2, true), 8);
  assert.equal(getUint64(centralView, extraOffset + 4), 0x1_0000_0000n);

  const endRecords = buildEndRecords({
    entryCount: 65_536n,
    centralSize: 100n,
    centralOffset: 0x1_0000_0000n,
    zip64RecordOffset: 0x1_0000_0064n,
  });
  assert.equal(endRecords.length, 3);
  assert.equal(new DataView(endRecords[0].buffer).getUint32(0, true), 0x06064b50);
  assert.equal(new DataView(endRecords[1].buffer).getUint32(0, true), 0x07064b50);
  const classicView = new DataView(endRecords[2].buffer);
  assert.equal(classicView.getUint16(10, true), 0xffff);
  assert.equal(classicView.getUint32(16, true), 0xffffffff);
});

test("export retries transient failures and records permanent failures", async () => {
  const inventory = {
    guilds: [
      {
        id: "1",
        name: "Server",
        emojiCount: 3,
        collectionError: null,
      },
    ],
    emojis: [
      {
        guildId: "1",
        guildName: "Server",
        id: "10",
        name: "animated",
        animated: true,
        available: true,
        managed: false,
        roles: [],
        archivePath: "emojis/Server--1--animated--10.webp",
        cdnUrl: getEmojiCdnUrl({ id: "10", animated: true }),
      },
      {
        guildId: "1",
        guildName: "Server",
        id: "11",
        name: "retry",
        animated: false,
        available: true,
        managed: false,
        roles: [],
        archivePath: "emojis/Server--1--retry--11.webp",
        cdnUrl: getEmojiCdnUrl({ id: "11", animated: false }),
      },
      {
        guildId: "1",
        guildName: "Server",
        id: "12",
        name: "missing",
        animated: false,
        available: false,
        managed: false,
        roles: [],
        archivePath: "emojis/Server--1--missing--12.webp",
        cdnUrl: getEmojiCdnUrl({ id: "12", animated: false }),
      },
    ],
  };
  const requests = [];
  const attempts = new Map();
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const id = url.match(/emojis\/(\d+)/)[1];
    attempts.set(id, (attempts.get(id) || 0) + 1);

    if (id === "11" && attempts.get(id) === 1) {
      return mockResponse(503, [], {});
    }
    if (id === "12") {
      return mockResponse(404, [], {});
    }
    return mockResponse(200, makeWebP(Number(id)), {
      "content-type": "image/webp",
    });
  };
  const writable = new MemoryWritable();
  const writer = new StreamingZipWriter(writable);
  const logger = { info() {}, warn() {} };

  const result = await exportInventoryToZip({
    inventory,
    zipWriter: writer,
    fetchImpl,
    exportedAt: new Date("2026-07-28T12:00:00.000Z"),
    sourceUrl: "https://discord.com/channels/@me",
    concurrency: 2,
    maxAttempts: 2,
    sleep: async () => {},
    logger,
  });

  assert.equal(attempts.get("10"), 1);
  assert.equal(attempts.get("11"), 2);
  assert.equal(attempts.get("12"), 1);
  assert.equal(
    requests.find((request) => request.url.includes("/10.webp")).url,
    "https://cdn.discordapp.com/emojis/10.webp?animated=true",
  );
  for (const request of requests) {
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.headers, undefined);
  }

  assert.equal(result.manifest.counts.downloaded, 2);
  assert.equal(result.manifest.counts.failed, 1);
  assert.match(
    result.manifest.emojis.find((emoji) => emoji.id === "12").error,
    /HTTP 404/,
  );

  const entries = parseStoreOnlyZip(writable.bytes());
  assert.equal(entries.has("emojis/Server--1--animated--10.webp"), true);
  assert.equal(entries.has("emojis/Server--1--retry--11.webp"), true);
  assert.equal(entries.has("emojis/Server--1--missing--12.webp"), false);
  const archivedManifest = JSON.parse(
    new TextDecoder().decode(entries.get("manifest.json")),
  );
  assert.equal(archivedManifest.counts.failed, 1);
});
