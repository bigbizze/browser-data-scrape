const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");

function loadChatGptExporter() {
  const code = fs.readFileSync(path.join(extensionRoot, "exporters", "chatgpt.js"), "utf8");
  function TestURL(value, base) {
    return new URL(value, base);
  }
  TestURL.createObjectURL = () => "blob:test";
  TestURL.revokeObjectURL = () => {};

  const sandbox = {
    window: { __chatGptBackendExportInProgress: true },
    location: {
      href: "https://chatgpt.com/c/00000000-0000-0000-0000-000000000000",
      origin: "https://chatgpt.com",
      pathname: "/c/00000000-0000-0000-0000-000000000000"
    },
    document: {
      title: "Harness",
      body: { appendChild() {} },
      createElement() {
        return {
          click() {},
          remove() {}
        };
      }
    },
    console: {log() {}, warn() {}, error() {}, table() {}},
    Blob,
    crypto: require("node:crypto").webcrypto,
    TextEncoder,
    URL: TestURL,
    setTimeout,
    fetch: async () => {
      throw new Error("fetch not available in harness");
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(extensionRoot, "exporters/bundle-docs.js"), "utf8"), sandbox);
  vm.runInContext(code, sandbox, { filename: "chatgpt.js" });
  return sandbox;
}

function loadClaudeExporter() {
  const code = fs.readFileSync(path.join(extensionRoot, "exporters", "claude.js"), "utf8");
  function TestURL(value, base) {
    return new URL(value, base);
  }
  TestURL.createObjectURL = () => "blob:test";
  TestURL.revokeObjectURL = () => {};

  const sandbox = {
    window: { __claudeConversationExportInProgress: true },
    location: {
      href: "https://claude.ai/chat/ecc3bc40-8803-488d-a23f-1dbc81a51eb5",
      origin: "https://claude.ai",
      pathname: "/chat/ecc3bc40-8803-488d-a23f-1dbc81a51eb5"
    },
    document: {
      title: "Harness",
      body: { appendChild() {} },
      createElement() {
        return {
          click() {},
          remove() {}
        };
      }
    },
    console: {log() {}, warn() {}, error() {}, table() {}},
    Blob,
    crypto: require("node:crypto").webcrypto,
    TextEncoder,
    URL: TestURL,
    setTimeout,
    fetch: async () => {
      throw new Error("fetch not available in harness");
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(extensionRoot, "exporters/bundle-docs.js"), "utf8"), sandbox);
  vm.runInContext(code, sandbox, { filename: "claude.js" });
  return sandbox;
}

function loadPopup() {
  const code = fs.readFileSync(path.join(extensionRoot, "popup.js"), "utf8");
  const statusEl = {
    textContent: "",
    dataset: {}
  };
  const buttonArea = {
    replaceChildren() {},
    appendChild() {},
    querySelectorAll: () => []
  };
  const sandbox = {
    console: {log() {}, warn() {}, error() {}, table() {}},
    URL,
    document: {
      getElementById(id) {
        if (id === "status") return statusEl;
        if (id === "buttonArea") return buttonArea;
        return null;
      },
      createElement() {
        return {
          dataset: {},
          addEventListener() {}
        };
      }
    },
    chrome: {
      tabs: {
        query: async () => []
      },
      scripting: {
        executeScript: async () => []
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "popup.js" });
  return sandbox;
}

function message(id, role = "user", text = id, extra = {}) {
  return {
    id,
    author: { role },
    content: { content_type: "text", parts: [text] },
    create_time: 1,
    metadata: {
      model_slug: role === "assistant" ? "gpt-test" : undefined,
      ...(extra.metadata || {})
    },
    recipient: "all",
    ...extra
  };
}

function node(id, parent, children, msg = message(id)) {
  return { id, parent, children, message: msg };
}

function claudeMessage(uuid, sender = "human", extra = {}) {
  return {
    uuid,
    sender,
    parent_message_uuid: extra.parent_message_uuid || null,
    content: extra.content || [{ type: "text", text: uuid }],
    created_at: "2026-01-01T00:00:00.000Z",
    ...extra
  };
}

function exportTree(mapping) {
  const sandbox = loadChatGptExporter();
  return sandbox.buildChatGptAllBranchesExport({
    conversation_id: "conv",
    title: "Harness",
    mapping
  }, "conv");
}

function flattenMessages(branchNode) {
  return branchNode.messages.concat(...branchNode.branches.flatMap(flattenMessages));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("ChatGPT all-branches export keeps common messages above fork branches", () => {
  const out = exportTree({
    root: { id: "root", parent: null, children: ["u1"], message: null },
    u1: node("u1", "root", ["a1"], message("u1", "user")),
    a1: node("a1", "u1", ["u2", "u3"], message("a1", "assistant")),
    u2: node("u2", "a1", [], message("u2", "user")),
    u3: node("u3", "a1", [], message("u3", "user"))
  });

  assert.deepEqual(plain(out.messages.map((item) => item.id)), ["u1", "a1"]);
  assert.equal(out.branches.length, 2);
  assert.deepEqual(plain(out.totalCounts), {
    messages: 4,
    user: 3,
    assistant: 1,
    files: 0,
    branchPoints: 1,
    leafBranches: 2
  });
});

test("ChatGPT current-branch export uses the backend current node without inspecting the DOM", async () => {
  const sandbox = loadChatGptExporter();
  let inspectedRenderedDom = false;
  sandbox.collectRenderedChatGptMessageIds = async () => {
    inspectedRenderedDom = true;
    return { reachedBottom: true, messageIds: ["u2", "a2"] };
  };

  const out = await sandbox.buildChatGptCurrentBranchExport({
    conversation_id: "conv",
    title: "Harness",
    current_node: "a1",
    mapping: {
      root: { id: "root", parent: null, children: ["u1"], message: null },
      u1: node("u1", "root", ["a1", "u2"], message("u1", "user")),
      a1: node("a1", "u1", [], message("a1", "assistant")),
      u2: node("u2", "u1", ["a2"], message("u2", "user")),
      a2: node("a2", "u2", [], message("a2", "assistant"))
    }
  }, "conv");

  assert.equal(out.exportMode, "current-branch");
  assert.equal(out.branchSource, "backend-current-node");
  assert.equal(inspectedRenderedDom, false);
  assert.deepEqual(plain(out.messages.map((item) => item.id)), ["u1", "a1"]);
  assert.deepEqual(plain(out.counts), {
    messages: 2,
    user: 1,
    assistant: 1,
    files: 0
  });
});

test("ChatGPT all-branches export handles nested forks", () => {
  const out = exportTree({
    root: { id: "root", parent: null, children: ["u1"], message: null },
    u1: node("u1", "root", ["a1"], message("u1", "user")),
    a1: node("a1", "u1", ["u2", "u3"], message("a1", "assistant")),
    u2: node("u2", "a1", ["a2"], message("u2", "user")),
    a2: node("a2", "u2", [], message("a2", "assistant")),
    u3: node("u3", "a1", ["a3"], message("u3", "user")),
    a3: node("a3", "u3", ["u4", "u5"], message("a3", "assistant")),
    u4: node("u4", "a3", [], message("u4", "user")),
    u5: node("u5", "a3", [], message("u5", "user"))
  });

  assert.equal(out.branches.length, 2);
  assert.equal(out.branches[1].branches.length, 2);
  assert.deepEqual(plain(out.totalCounts), {
    messages: 8,
    user: 5,
    assistant: 3,
    files: 0,
    branchPoints: 2,
    leafBranches: 3
  });
});

test("ChatGPT all-branches export recovers missing-parent and cyclic components", () => {
  const missingParent = exportTree({
    root: { id: "root", parent: null, children: ["u1"], message: null },
    u1: node("u1", "root", [], message("u1", "user")),
    orphan: node("orphan", "missing", [], message("orphan", "assistant"))
  });
  assert.equal(missingParent.branches.some((branch) => branch.recovery === "missing-parent"), true);
  assert.equal(flattenMessages(missingParent).some((item) => item.id === "orphan"), true);
  assert.equal(missingParent.warnings.some((warning) => warning.includes("Missing parent missing")), true);

  const cycle = exportTree({
    a: node("a", "c", ["b"], message("a", "user")),
    b: node("b", "a", ["c"], message("b", "assistant")),
    c: node("c", "b", ["a"], message("c", "user"))
  });
  assert.equal(flattenMessages(cycle).length, 3);
  assert.equal(cycle.warnings.some((warning) => warning.includes("Cycle detected")), true);
});

test("ChatGPT all-branches export merges stale empty children from parent links", () => {
  const out = exportTree({
    root: { id: "root", parent: null, children: ["u1"], message: null },
    u1: node("u1", "root", [], message("u1", "user")),
    a1: node("a1", "u1", [], message("a1", "assistant")),
    a2: node("a2", "u1", [], message("a2", "assistant"))
  });

  assert.deepEqual(plain(out.messages.map((item) => item.id)), ["u1"]);
  assert.equal(out.branches.length, 2);
  assert.deepEqual(plain(out.totalCounts), {
    messages: 3,
    user: 1,
    assistant: 2,
    files: 0,
    branchPoints: 1,
    leafBranches: 2
  });
});

test("ChatGPT all-branches export ignores stale explicit children with mismatched parents", () => {
  const out = exportTree({
    root: { id: "root", parent: null, children: ["u1", "a2"], message: null },
    u1: node("u1", "root", ["a1"], message("u1", "user")),
    a1: node("a1", "u1", [], message("a1", "assistant")),
    a2: node("a2", "other", [], message("a2", "assistant"))
  });

  assert.deepEqual(plain(out.messages.map((item) => item.id)), ["u1", "a1"]);
  assert.equal(out.branches.some((branch) => branch.recovery === "missing-parent"), true);
  assert.equal(out.totalCounts.messages, 3);
  assert.equal(out.warnings.some((warning) => warning.includes("referenced by node root has parent other")), true);
});

test("ChatGPT popup branch stats use parent links to repair stale children", () => {
  const popup = loadPopup();
  const stats = popup.getChatGptBranchStats({
    root: { id: "root", parent: null, children: ["u1"] },
    u1: { id: "u1", parent: "root", children: [] },
    a1: { id: "a1", parent: "u1", children: [] },
    a2: { id: "a2", parent: "u1", children: [] }
  });

  assert.deepEqual(plain(stats), {
    branchPoints: 1,
    branchedChildren: 2
  });
});

test("ChatGPT popup branch stats ignore stale explicit children with mismatched parents", () => {
  const popup = loadPopup();
  const stats = popup.getChatGptBranchStats({
    root: { id: "root", parent: null, children: ["u1", "a2"] },
    u1: { id: "u1", parent: "root", children: ["a1"] },
    a1: { id: "a1", parent: "u1", children: [] },
    a2: { id: "a2", parent: "other", children: [] }
  });

  assert.deepEqual(plain(stats), {
    branchPoints: 0,
    branchedChildren: 0
  });
});

test("serialized ChatGPT popup probe is self-contained for page injection", async () => {
  const popup = loadPopup();
  const mapping = {
    root: { id: "root", parent: null, children: ["u1"] },
    u1: { id: "u1", parent: "root", children: [] },
    a1: { id: "a1", parent: "u1", children: [] },
    a2: { id: "a2", parent: "u1", children: [] }
  };
  const pageSandbox = {
    location: {
      origin: "https://chatgpt.com",
      pathname: "/c/00000000-0000-0000-0000-000000000000"
    },
    fetch: async (url) => {
      if (url === "/api/auth/session") {
        return {
          ok: true,
          json: async () => ({ accessToken: "token" })
        };
      }

      if (url === "https://chatgpt.com/backend-api/conversation/00000000-0000-0000-0000-000000000000") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "" },
          json: async () => ({ mapping })
        };
      }

      if (url === "https://chatgpt.com/backend-api/conversations/00000000-0000-0000-0000-000000000000/files?limit=200") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "" },
          json: async () => ({
            items: [
              { id: "lib1", file_id: "file_1", file_name: "one.txt", file_size_bytes: 1 },
              { id: "lib2", file_id: "file_1", file_name: "one-duplicate.txt", file_size_bytes: 1 },
              { id: "lib3", file_id: "file_2", file_name: "two.txt", file_size_bytes: 2 }
            ]
          })
        };
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }
  };

  vm.createContext(pageSandbox);
  const result = await vm.runInContext(`(${popup.probeChatGptBranchesInPage.toString()})()`, pageSandbox);

  assert.deepEqual(plain(result), {
    ok: true,
    hasBranches: true,
    branchPoints: 1,
    branchedChildren: 2,
    hasFiles: true,
    fileCount: 2,
    fileProbeWarning: null
  });
});

test("ChatGPT conversation file collector handles backend file list and metadata dedupe", () => {
  const chatgpt = loadChatGptExporter();
  const files = chatgpt.collectChatGptConversationFiles({
    items: [
      {
        id: "lib-a",
        file_id: "file_a",
        file_name: "notes.md",
        mime_type: "text/markdown",
        file_size_bytes: 12
      },
      {
        id: "lib-a-dupe",
        file_id: "file_a",
        file_name: "notes-copy.md",
        mime_type: "text/markdown",
        file_size_bytes: 12
      },
      {
        id: "lib-b",
        file_name: "report.json",
        mime_type: "application/json",
        file_size_bytes: 20
      }
    ]
  }, "conv-id");

  assert.deepEqual(plain(files.map((file) => file.downloadName)), ["notes.md", "report.json"]);
  assert.equal(
    files[0].url,
    "https://chatgpt.com/backend-api/files/download/file_a?inline=true&download_intent=false&check_context_scopes_for_conversation_id=conv-id"
  );
  assert.equal(
    files[1].url,
    "https://chatgpt.com/backend-api/files/download/lib-b?inline=true&download_intent=false&check_context_scopes_for_conversation_id=conv-id"
  );
});

test("ChatGPT file download uses files endpoint and zips returned bodies", async () => {
  const chatgpt = loadChatGptExporter();
  const requested = [];

  chatgpt.fetch = async (url) => {
    requested.push(String(url));

    if (url === "/api/auth/session") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({ accessToken: "token" })
      };
    }

    if (String(url).includes("/backend-api/conversations/00000000-0000-0000-0000-000000000000/files?limit=200")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({
          items: [
            { id: "lib-a", file_id: "file_a", file_name: "a.txt", file_size_bytes: 5 },
            { id: "lib-b", file_id: "file_b", file_name: "b.txt", file_size_bytes: 4 }
          ]
        })
      };
    }

    if (String(url).includes("/backend-api/files/download/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        blob: async () => new Blob([String(url).includes("file_a") ? "alpha" : "beta"], { type: "text/plain" })
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const out = await chatgpt.downloadChatGptConversationFiles("00000000-0000-0000-0000-000000000000");

  assert.equal(out.exportMode, "download-files-all");
  assert.equal(out.counts.files, 2);
  assert.equal(out.counts.downloaded, 2);
  assert.equal(requested.filter((url) => url.includes("/backend-api/files/download/")).length, 2);
  assert.equal(
    requested.some((url) => url.includes("check_context_scopes_for_conversation_id=00000000-0000-0000-0000-000000000000")),
    true
  );
});

test("ChatGPT file download follows JSON descriptors and stores attachment bytes", async () => {
  const chatgpt = loadChatGptExporter();
  const calls = [];
  const zipBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const pastedText = "Phases 0-2 are complete. Phase 3 has not started.";
  const cases = [
    {
      file: {
        id: "file_zip",
        name: "query-spec.zip",
        downloadName: "query-spec.zip",
        url: "https://chatgpt.com/backend-api/files/download/file_zip"
      },
      contentUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_zip&sig=signed",
      bytes: zipBytes
    },
    {
      file: {
        id: "file_text",
        name: "Pasted text (3)(20260814-170409).txt",
        downloadName: "Pasted text (3)(20260814-170409).txt",
        url: "https://chatgpt.com/backend-api/files/download/file_text"
      },
      contentUrl: "https://files.openaiusercontent.com/file_text?sig=signed",
      bytes: pastedText
    }
  ];

  chatgpt.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, init });

    const descriptorCase = cases.find((item) => item.file.url === requestUrl);
    if (descriptorCase) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => name.toLowerCase() === "content-type" ? "application/json" : ""
        },
        json: async () => ({
          status: "success",
          download_url: descriptorCase.contentUrl,
          file_name: descriptorCase.file.name,
          file_size_bytes: typeof descriptorCase.bytes === "string"
            ? Buffer.byteLength(descriptorCase.bytes)
            : descriptorCase.bytes.length
        })
      };
    }

    const contentCase = cases.find((item) => item.contentUrl === requestUrl);
    if (contentCase) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => name.toLowerCase() === "content-disposition"
            ? 'attachment; filename="server-name.bin"'
            : ""
        },
        blob: async () => new Blob([contentCase.bytes])
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const entries = [];
  for (const item of cases) {
    entries.push(await chatgpt.fetchChatGptDownloadEntry(
      item.file,
      "token",
      chatgpt.createChatGptRateLimitGate()
    ));
  }

  assert.deepEqual(entries.map((entry) => entry.name), cases.map((item) => item.file.downloadName));
  assert.deepEqual(
    Buffer.concat(entries[0].parts.map((part) => Buffer.from(part))),
    Buffer.from(zipBytes)
  );
  assert.equal(
    Buffer.concat(entries[1].parts.map((part) => Buffer.from(part))).toString("utf8"),
    pastedText
  );

  const descriptorCalls = calls.filter((call) => call.url.includes("/backend-api/files/download/"));
  assert.equal(descriptorCalls.length, 2);
  assert.equal(descriptorCalls.every((call) => call.init.headers.Authorization === "Bearer token"), true);

  const sameOriginContentCall = calls.find((call) => call.url === cases[0].contentUrl);
  assert.equal(sameOriginContentCall.init.credentials, "include");
  assert.equal(sameOriginContentCall.init.headers.Authorization, "Bearer token");

  const crossOriginContentCall = calls.find((call) => call.url === cases[1].contentUrl);
  assert.equal(crossOriginContentCall.init.credentials, "omit");
  assert.equal(crossOriginContentCall.init.headers.Authorization, undefined);
});

test("ChatGPT file download rejects byte-count mismatches", async () => {
  const chatgpt = loadChatGptExporter();
  chatgpt.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "" },
    blob: async () => new Blob(["bad"])
  });

  await assert.rejects(
    chatgpt.fetchChatGptDownloadEntry({
      id: "file_bad",
      name: "bad.zip",
      downloadName: "bad.zip",
      size: 4,
      url: "https://chatgpt.com/backend-api/files/download/file_bad"
    }, "token", chatgpt.createChatGptRateLimitGate()),
    /expected 4 bytes but received 3 bytes/
  );
});

test("ChatGPT file downloader limits concurrent downloads to ten", async () => {
  const chatgpt = loadChatGptExporter();
  const pending = [];
  let active = 0;
  let maxActive = 0;
  let completed = 0;

  chatgpt.setTimeout = (callback) => {
    callback();
    return 0;
  };

  chatgpt.fetch = async (url) => {
    if (url === "/api/auth/session") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({ accessToken: "token" })
      };
    }

    if (String(url).includes("/backend-api/conversations/conv/files?limit=200")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({
          items: Array.from({ length: 12 }, (_, index) => ({
            id: `lib-${index}`,
            file_id: `file_${index}`,
            file_name: `file-${index}.txt`
          }))
        })
      };
    }

    active++;
    maxActive = Math.max(maxActive, active);

    return new Promise((resolve) => {
      pending.push(() => {
        active--;
        completed++;
        resolve({
          ok: true,
          status: 200,
          headers: { get: () => "" },
          blob: async () => new Blob([String(url)], { type: "text/plain" })
        });
      });
    });
  };

  const downloadPromise = chatgpt.downloadChatGptConversationFiles("conv");

  while (pending.length < 10) await Promise.resolve();
  assert.equal(maxActive, 10);

  while (completed < 12) {
    while (!pending.length) await new Promise(setImmediate);
    pending.shift()();
    await Promise.resolve();
  }

  const out = await downloadPromise;
  assert.equal(out.counts.files, 12);
  assert.equal(out.counts.downloaded, 12);
  assert.equal(maxActive, 10);
});

test("ChatGPT file downloader pauses all workers during shared 429 backoff", async () => {
  const chatgpt = loadChatGptExporter();
  const pending = [];
  const timers = [];
  const requested = [];

  chatgpt.setTimeout = (callback, delay) => {
    if (delay === 150) {
      callback();
      return 0;
    }
    timers.push({ callback, delay });
    return 0;
  };

  chatgpt.fetch = async (url) => {
    requested.push(String(url));

    if (url === "/api/auth/session") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({ accessToken: "token" })
      };
    }

    if (String(url).includes("/backend-api/conversations/conv/files?limit=200")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({
          items: Array.from({ length: 12 }, (_, index) => ({
            id: `lib-${index}`,
            file_id: `file_${index}`,
            file_name: `file-${index}.txt`
          }))
        })
      };
    }

    return new Promise((resolve) => {
      pending.push({ url: String(url), resolve });
    });
  };

  const downloadPromise = chatgpt.downloadChatGptConversationFiles("conv");

  while (pending.length < 10) await Promise.resolve();
  assert.equal(requested.filter((url) => url.includes("/backend-api/files/download/")).length, 10);

  pending.shift().resolve({
    ok: false,
    status: 429,
    headers: { get: () => "" }
  });
  await Promise.resolve();
  await Promise.resolve();

  while (!timers.length) await Promise.resolve();
  assert.equal(timers[0].delay, 3000);

  while (pending.length) {
    pending.shift().resolve({
      ok: true,
      status: 200,
      headers: { get: () => "" },
      blob: async () => new Blob(["ok"], { type: "text/plain" })
    });
    await Promise.resolve();
  }

  assert.equal(requested.filter((url) => url.includes("/backend-api/files/download/")).length, 10);

  timers.shift().callback();
  while (pending.length < 3) await new Promise(setImmediate);
  assert.equal(requested.filter((url) => url.includes("/backend-api/files/download/")).length, 13);

  while (pending.length) {
    pending.shift().resolve({
      ok: true,
      status: 200,
      headers: { get: () => "" },
      blob: async () => new Blob(["ok"], { type: "text/plain" })
    });
    await Promise.resolve();
  }

  const out = await downloadPromise;
  assert.equal(out.counts.files, 12);
  assert.equal(out.counts.downloaded, 12);
});

test("Claude downloadable file collector handles current file shapes", () => {
  const claude = loadClaudeExporter();
  const files = claude.collectClaudeDownloadableFiles({
    uuid: "conv",
    chat_messages: [
      claudeMessage("u1", "human", {
        attachments: [{
          id: "att1",
          file_name: "notes.md",
          extracted_content: "# Notes"
        }]
      }),
      claudeMessage("a1", "assistant", {
        parent_message_uuid: "u1",
        files: [{
          file_uuid: "blob-file",
          file_name: "diagram.png",
          file_kind: "image",
          preview_url: "/resized-preview",
          mime_type: "image/png"
        }],
        files_v2: [{
          file_uuid: "path-file",
          file_name: "app.js",
          path: "src/app.js",
          mime_type: "text/javascript"
        }],
        generated_files: [{
          id: "generated-file",
          filename: "report.csv",
          download_url: "/api/generated/report.csv",
          mime_type: "text/csv"
        }],
        content: [{
          type: "tool_use",
          name: "create_file",
          id: "artifact-tool",
          input: {
            filename: "result.py",
            content: "print(1)"
          }
        }]
      })
    ]
  }, "conv", "org");

  assert.deepEqual(plain(files.map((file) => file.source)), [
    "attachment",
    "files",
    "files_v2",
    "generated_files",
    "artifact-create-file"
  ]);
  assert.equal(files[0].downloadName, "notes.md.txt");
  assert.equal(files[1].url, "https://claude.ai/api/organizations/org/files/blob-file/contents");
  assert.equal(files[2].url, "https://claude.ai/api/organizations/org/conversations/conv/wiggle/download-file?path=src%2Fapp.js");
  assert.equal(files[3].url, "https://claude.ai/api/generated/report.csv");
  assert.equal(files[4].downloadName, "result.py");
  assert.equal(files[4].content, "print(1)");
});

test("Claude downloadable file collector dedupes repeated branch files", () => {
  const claude = loadClaudeExporter();
  const files = claude.collectClaudeDownloadableFiles({
    uuid: "conv",
    chat_messages: [
      claudeMessage("u1", "human", {
        files_v2: [{
          file_uuid: "same-file",
          file_name: "input.txt",
          path: "input.txt"
        }]
      }),
      claudeMessage("u2", "human", {
        parent_message_uuid: "u1",
        files_v2: [{
          file_uuid: "same-file",
          file_name: "input.txt",
          path: "input.txt"
        }]
      }),
      claudeMessage("u3", "human", {
        parent_message_uuid: "u1",
        attachments: [{
          id: "same-extracted",
          file_name: "brief.pdf",
          extracted_content: "Brief text"
        }]
      }),
      claudeMessage("u4", "human", {
        parent_message_uuid: "u1",
        attachments: [{
          id: "same-extracted",
          file_name: "brief.pdf",
          extracted_content: "Brief text"
        }]
      })
    ]
  }, "conv", "org");

  assert.deepEqual(plain(files.map((file) => file.id)), ["same-file", "same-extracted"]);
  assert.deepEqual(plain(files.map((file) => file.downloadName)), ["input.txt", "brief.pdf.txt"]);
});

test("Claude workspace file collector includes wiggle list files with preserved ZIP paths", () => {
  const claude = loadClaudeExporter();
  const files = claude.collectClaudeDownloadableFiles({
    uuid: "conv",
    chat_messages: []
  }, "conv", "org");

  claude.addClaudeWiggleFiles(files, {
    files: [
      "/mnt/user-data/uploads/graph-admit-plan.md",
      "/mnt/user-data/outputs/adjudication-tree/INDEX.md"
    ],
    files_metadata: [
      {
        path: "/mnt/user-data/uploads/graph-admit-plan.md",
        size: 123,
        content_type: "text/markdown",
        custom_metadata: { filename: "graph-admit-plan.md" }
      },
      {
        path: "/mnt/user-data/outputs/adjudication-tree/INDEX.md",
        size: 456,
        content_type: "text/plain",
        custom_metadata: { filename: "INDEX.md" }
      }
    ]
  }, "conv", "org");

  assert.deepEqual(plain(files.map((file) => file.source)), ["wiggle-list-files", "wiggle-list-files"]);
  assert.deepEqual(plain(files.map((file) => file.zipPath)), [
    "uploads/graph-admit-plan.md",
    "outputs/adjudication-tree/INDEX.md"
  ]);
  assert.equal(
    files[0].url,
    "https://claude.ai/api/organizations/org/conversations/conv/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Fuploads%2Fgraph-admit-plan.md"
  );
});

test("Claude fetch retry uses bounded exponential backoff for 429 responses", async () => {
  const claude = loadClaudeExporter();
  const delays = [];
  let attempts = 0;

  claude.setTimeout = (callback, delay) => {
    delays.push(delay);
    callback();
    return 0;
  };
  claude.fetch = async () => {
    attempts++;
    return attempts < 3
      ? {
        ok: false,
        status: 429,
        headers: { get: () => "" }
      }
      : {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({ ok: true })
      };
  };

  const response = await claude.fetchClaudeWithRetry("https://claude.ai/rate-limited", {}, { label: "File" });

  assert.equal(response.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [3000, 6000]);
  assert.equal(claude.getClaudeRetryDelayMs({ headers: { get: () => "1" } }, 0), 3000);
  assert.equal(claude.getClaudeRetryDelayMs({ headers: { get: () => "60" } }, 0), 20000);
});

test("Claude file download does not byte-dedupe distinct metadata records", async () => {
  const claude = loadClaudeExporter();
  const requested = [];

  claude.fetch = async (url) => {
    requested.push(url);

    if (String(url).includes("/wiggle/list-files")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({ success: true, files: [], files_metadata: [] })
      };
    }

    return {
      ok: true,
      status: 200,
      headers: { get: () => "" },
      blob: async () => new Blob(["same bytes"], { type: "text/plain" })
    };
  };

  const out = await claude.downloadClaudeConversationFiles({
    uuid: "conv",
    name: "Dedup",
    chat_messages: [
      claudeMessage("a1", "assistant", {
        generated_files: [
          { id: "one", filename: "one.txt", download_url: "/download/one.txt" },
          { id: "two", filename: "two.txt", download_url: "/download/two.txt" }
        ]
      })
    ]
  }, "conv", "org");

  assert.equal(out.counts.files, 2);
  assert.equal(out.counts.downloaded, 2);
  assert.equal(out.counts.duplicates, undefined);
  assert.equal(out.duplicates, undefined);
  assert.equal(requested.filter((url) => String(url).includes("/download/")).length, 2);
});

test("Claude file downloader limits concurrent downloads to ten", async () => {
  const claude = loadClaudeExporter();
  const pending = [];
  let active = 0;
  let maxActive = 0;
  let completed = 0;

  claude.setTimeout = (callback) => {
    callback();
    return 0;
  };

  claude.fetch = async (url) => {
    if (String(url).includes("/wiggle/list-files")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({ success: true, files: [], files_metadata: [] })
      };
    }

    active++;
    maxActive = Math.max(maxActive, active);

    return new Promise((resolve) => {
      pending.push(() => {
        active--;
        completed++;
        resolve({
          ok: true,
          status: 200,
          headers: { get: () => "" },
          blob: async () => new Blob([String(url)], { type: "text/plain" })
        });
      });
    });
  };

  const downloadPromise = claude.downloadClaudeConversationFiles({
    uuid: "conv",
    name: "Parallel",
    chat_messages: [
      claudeMessage("a1", "assistant", {
          generated_files: Array.from({ length: 12 }, (_, index) => ({
          id: `file-${index}`,
          filename: `file-${index}.txt`,
          download_url: `/download/file-${index}.txt`
        }))
      })
    ]
  }, "conv", "org");

  while (pending.length < 10) await Promise.resolve();
  assert.equal(maxActive, 10);

  while (completed < 12) {
    while (!pending.length) await new Promise(setImmediate);
    const next = pending.shift();
    next();
    await Promise.resolve();
  }

  const out = await downloadPromise;
  assert.equal(out.counts.files, 12);
  assert.equal(out.counts.downloaded, 12);
  assert.equal(maxActive, 10);
});

test("Claude file downloader pauses all workers during shared 429 backoff", async () => {
  const claude = loadClaudeExporter();
  const pending = [];
  const timers = [];
  const requested = [];

  claude.setTimeout = (callback, delay) => {
    if (delay === 150) {
      callback();
      return 0;
    }
    timers.push({ callback, delay });
    return 0;
  };

  claude.fetch = async (url) => {
    requested.push(String(url));

    if (String(url).includes("/wiggle/list-files")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({ success: true, files: [], files_metadata: [] })
      };
    }

    return new Promise((resolve) => {
      pending.push({ url: String(url), resolve });
    });
  };

  const downloadPromise = claude.downloadClaudeConversationFiles({
    uuid: "conv",
    name: "Backoff",
    chat_messages: [
      claudeMessage("a1", "assistant", {
        generated_files: Array.from({ length: 12 }, (_, index) => ({
          id: `file-${index}`,
          filename: `file-${index}.txt`,
          download_url: `/download/file-${index}.txt`
        }))
      })
    ]
  }, "conv", "org");

  while (pending.length < 10) await Promise.resolve();
  assert.equal(requested.filter((url) => url.includes("/download/")).length, 10);

  pending.shift().resolve({
    ok: false,
    status: 429,
    headers: { get: () => "" }
  });
  await Promise.resolve();
  await Promise.resolve();

  while (!timers.length) await Promise.resolve();
  assert.equal(timers[0].delay, 3000);

  while (pending.length) {
    pending.shift().resolve({
      ok: true,
      status: 200,
      headers: { get: () => "" },
      blob: async () => new Blob(["ok"], { type: "text/plain" })
    });
    await Promise.resolve();
  }

  assert.equal(requested.filter((url) => url.includes("/download/")).length, 10);

  timers.shift().callback();
  while (pending.length < 3) await new Promise(setImmediate);
  assert.equal(requested.filter((url) => url.includes("/download/")).length, 13);

  while (pending.length) {
    pending.shift().resolve({
      ok: true,
      status: 200,
      headers: { get: () => "" },
      blob: async () => new Blob(["ok"], { type: "text/plain" })
    });
    await Promise.resolve();
  }

  const out = await downloadPromise;
  assert.equal(out.counts.files, 12);
  assert.equal(out.counts.downloaded, 12);
});

test("Claude ZIP writer stores byte-part entries in one archive", async () => {
  const claude = loadClaudeExporter();
  const encoder = new TextEncoder();
  const zip = await claude.createZipBlob([
    {
      name: "first.txt",
      parts: [encoder.encode("alpha")],
      size: 5,
      crc: claude.crc32(encoder.encode("alpha")),
      lastModified: new Date("2026-01-01T00:00:00Z")
    },
    {
      name: "outputs/report/second.json",
      parts: [encoder.encode('{"ok":true}')],
      size: 11,
      crc: claude.crc32(encoder.encode('{"ok":true}')),
      lastModified: new Date("2026-01-01T00:00:00Z")
    }
  ]);

  const bytes = new Uint8Array(await zip.arrayBuffer());
  const text = new TextDecoder().decode(bytes);

  assert.equal(zip.type, "application/zip");
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.match(text, /first\.txt/);
  assert.match(text, /outputs\/report\/second\.json/);
  assert.match(text, /alpha/);
  assert.match(text, /\{"ok":true\}/);
});

test("Claude recorded artifact source follows ancestry and applies literal edits", () => {
  const claude = loadClaudeExporter();
  const tool = (name, input, id = name) => ({ type: "tool_use", name, input, id });
  const root = claudeMessage("root", "assistant", { content: [
    tool("Write", { file_path: "/tmp/demo.html", content: "<p>old</p>" })
  ] });
  const branch = claudeMessage("branch", "assistant", { parent_message_uuid: "root", content: [
    tool("Edit", { file_path: "/tmp/demo.html", old_string: "old", new_string: "$& new" }),
    tool("Artifact", { file_path: "/tmp/demo.html" })
  ] });
  const sibling = claudeMessage("sibling", "assistant", { parent_message_uuid: "root", content: [
    tool("Artifact", { file_path: "/tmp/demo.html" })
  ] });
  const files = claude.collectClaudeDownloadableFiles({ chat_messages: [branch, sibling, root] }, "conv", "org");
  assert.deepEqual(plain(files.map(file => file.content)), ["<p>$& new</p>", "<p>old</p>"]);
  assert.deepEqual(plain(files.map(file => file.zipPath)), ["recorded-source/demo.html", "recorded-source/demo (2).html"]);
});

test("Claude recorded source excludes failed writes and ambiguous edits", () => {
  const claude = loadClaudeExporter();
  const files = claude.getClaudeWrittenArtifactFiles([claudeMessage("m", "assistant", { content: [
    { type: "tool_use", id: "w", name: "Write", input: { file_path: "/a", content: "wrong" } },
    { type: "tool_result", tool_use_id: "w", is_error: true },
    { type: "tool_use", name: "Artifact", input: { file_path: "/a" } },
    { type: "tool_use", name: "Write", input: { file_path: "/b", content: "xx" } },
    { type: "tool_use", name: "Edit", input: { file_path: "/b", old_string: "x", new_string: "y" } },
    { type: "tool_use", name: "Artifact", input: { file_path: "/b" } }
  ] })]);
  assert.equal(files.length, 0);
});

test("Claude published artifact export fetches source bytes and preserves supporting files", async () => {
  const claude = loadClaudeExporter();
  const uuid = "11111111-1111-1111-1111-111111111111";
  claude.DOMParser = class {
    parseFromString() { return { documentElement: { dataset: { frameUuid: uuid, frameUchost: `${uuid}.frame.claudeusercontent.com` } } }; }
  };
  const calls = [];
  claude.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/artifact/demo")) return new Response("shell");
    if (String(url).includes("/api/frame/")) {
      assert.equal(init.headers["x-frame-cp"], "go");
      return Response.json({ ver: "v1", assetToken: "signed-test", files: [
        { path: "index.html", contentType: "text/html" }, { path: "styles/main.css", contentType: "text/css" }
      ] });
    }
    assert.equal(init.credentials, "omit");
    assert.match(String(url), /\/_src\//);
    return new Response(String(url).includes("main.css") ? "p { color:red }" : "<!doctype html><p>Actual source</p>");
  };
  const files = [];
  await claude.addClaudePublishedArtifactFiles(files, { chat_messages: [{ content: [
    { type: "tool_result", content: [{ text: "Published at https://claude.ai/artifact/demo (Version 1)" }] },
    { text: "https://claude.ai/artifact/demo" }
  ] }] }, "org");
  assert.equal(files.length, 2);
  assert.equal(files[1].zipPath, `artifacts/${uuid}/v1/styles/main.css`);
  const entry = await claude.fetchClaudeDownloadEntry(files[0]);
  assert.equal(Buffer.concat(entry.parts.map(Buffer.from)).toString(), "<!doctype html><p>Actual source</p>");
  assert.equal(calls.filter(call => call.url.includes("/artifact/demo")).length, 1);
});

test("Claude ZIP preserves unique names despite identical response filenames and records missing artifacts", async () => {
  const claude = loadClaudeExporter();
  claude.setTimeout = callback => { callback(); return 0; };
  let downloaded;
  claude.downloadBlob = blob => { downloaded = blob; };
  claude.fetch = async () => new Response("real content", { headers: { "content-disposition": 'attachment; filename="same.html"' } });
  const files = [
    { name: "same.html", url: "/one" }, { name: "same.html", url: "/two" },
    { name: "same (2).html", url: "/three" },
    { name: "README.md", url: "/readme" },
    { name: "missing", error: "Artifact unavailable" }
  ];
  claude.applyUniqueDownloadNames(files);
  const out = await claude.downloadClaudeFilesToZip(files, "test.zip");
  assert.equal(out.results.filter(result => result.ok).length, 4);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  const names = [];
  for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    const length = bytes.readUInt16LE(offset + 26);
    const extra = bytes.readUInt16LE(offset + 28);
    const size = bytes.readUInt32LE(offset + 18);
    names.push(bytes.subarray(offset + 30, offset + 30 + length).toString());
    offset += 30 + length + extra + size;
  }
  assert.deepEqual(names, ["README.md", "same.html", "same (2).html", "same (2) (2).html", "README (2).md", "export-manifest.json", "export-failures.json"]);
  assert.match(bytes.toString(), /Artifact unavailable/);
});

async function readStoredZip(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const entries = new Map();
  for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const size = bytes.readUInt32LE(offset + 18);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    assert.equal(entries.has(name), false, `Duplicate ZIP path: ${name}`);
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

for (const provider of ["chatgpt", "claude"]) {
  for (const scenario of ["files", "empty", "failed"]) {
    test(`${provider} combined export saves all branches in one ZIP with ${scenario} downloads`, async () => {
      const sandbox = provider === "chatgpt" ? loadChatGptExporter() : loadClaudeExporter();
      sandbox.setTimeout = callback => { callback(); return 0; };
      const downloads = [];
      sandbox.downloadBlob = (blob, name) => downloads.push({ blob, name });
      sandbox.downloadJson = () => assert.fail("Combined export must not download separate JSON");
      sandbox.console = { log() {}, warn() {}, error() {}, table() {} };
      sandbox.fetch = async () => scenario === "failed"
        ? new Response("unavailable", { status: 404 }) : new Response("attachment bytes");
      let result;
      if (provider === "chatgpt") {
        sandbox.getAccessToken = async () => "token";
        sandbox.fetchChatGptConversation = async () => ({ title: "Bundle", current_node: "left", mapping: {
          root: node("root", null, ["left", "right"]),
          left: node("left", "root", []), right: node("right", "root", [])
        } });
        sandbox.fetchChatGptConversationFiles = async () => ({ items: scenario === "empty" ? [] : [
          { file_id: "file1", file_name: "conversation.json" }
        ] });
        result = await sandbox.exportChatBackend(sandbox.normalizeChatGptExportMode("conversation-and-files"));
      } else {
        sandbox.getClaudeOrgIds = async () => ["org"];
        sandbox.fetchClaudeWiggleFiles = async () => ({ files: [] });
        sandbox.fetchClaudeConversation = async () => ({ name: "Bundle", chat_messages: [
          claudeMessage("root", "human"),
          claudeMessage("left", "assistant", { parent_message_uuid: "root", generated_files: scenario === "empty" ? [] : [
            { id: "file1", filename: "conversation.json", download_url: "/download/file1" }
          ] }),
          claudeMessage("right", "assistant", { parent_message_uuid: "root" })
        ] });
        result = await sandbox.exportClaudeConversation(sandbox.normalizeClaudeExportMode("conversation-and-files"));
      }
      assert.equal(downloads.length, 1);
      assert.match(downloads[0].name, /-complete\.zip$/);
      assert.equal(result.exportMode, "conversation-and-files");
      assert.equal(result.counts.messages, 3);
      assert.equal(result.counts.failed, scenario === "failed" ? 1 : 0);
      const entries = await readStoredZip(downloads[0].blob);
      const history = JSON.parse(entries.get("conversation.json").toString());
      assert.equal(history.exportMode, "all-branches");
      assert.equal(history.branches.length, 2);
      if (scenario === "files") assert.equal(entries.get("files/conversation.json").toString(), "attachment bytes");
      if (scenario === "empty") assert.equal(entries.size, provider === "claude" ? 4 : 3);
      if (scenario === "failed") assert.match(entries.get("export-failures.json").toString(), /404/);
    });
  }
}

test("Combined ZIP button stays enabled with empty or unavailable file probes", async () => {
  const popup = loadPopup();
  await Promise.resolve();
  for (const provider of ["chatgpt", "claude"]) {
    for (const probe of [{ ok: true, fileCount: 0 }, { ok: true, hasBranches: true, fileCount: 1 }, { ok: false }]) {
      let buttons;
      let selectedMode;
      popup.renderButtons = value => { buttons = value; };
      popup.chrome.scripting.executeScript = async () => [{ result: probe }];
      popup.runExport = (tab, target, mode) => { selectedMode = mode; };
      await popup[provider === "chatgpt" ? "initializeChatGptButtons" : "initializeClaudeButtons"]({ id: 1 }, { type: provider });
      const bundle = buttons.find(button => button.label === "Download history + all files (ZIP)");
      assert.ok(bundle);
      assert.equal(Boolean(bundle.disabled), false);
      bundle.onClick();
      assert.equal(selectedMode, "conversation-and-files");
    }
  }
});

test('Claude receipts preserve delivery identity, branches and repeated associations', () => {
  const c = loadClaudeExporter();
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const data = {chat_messages:[claudeMessage('root','assistant',{content:[{type:'tool_use',name:'SendUserFile',id:'send',input:{files:['/tmp/r5.md','/tmp/eval-inputs.zip']}}]}),
    claudeMessage('left','assistant',{parent_message_uuid:'root',content:[{type:'tool_result',tool_use_id:'send',content:`2 files delivered.\n/tmp/r5.md → file_uuid: ${ids[0]}\n/tmp/eval-inputs.zip → file_uuid: ${ids[1]}` }]}),
    claudeMessage('right','assistant',{parent_message_uuid:'root',content:[{type:'tool_result',tool_use_id:'send',content:`/tmp/r5.md → file_uuid: ${ids[0]}`} ]})]};
  const inventory = c.buildClaudeInventory(data,'conv','org');
  assert.equal(inventory.files.length,2);
  assert.equal(inventory.files[0].associations.length,2);
  assert.notDeepEqual(inventory.files[0].associations[0].branchPath,inventory.files[0].associations[1].branchPath);
  assert.equal(inventory.history.branches[0].messages[0].blocks[0].tool_use_id,'send');
});

test('Claude quickstart filtering is contextual and leaves real listed and explicit links', () => {
  const c=loadClaudeExporter();
  const catalogue='Quickstart. type_url: https://claude.ai/artifact/template\nFor a plain page, keep this guidance.';
  const data={chat_messages:[claudeMessage('m','assistant',{content:[
    {type:'tool_use',name:'Artifact',id:'q',input:{action:'quickstart'}},
    {type:'tool_result',tool_use_id:'q',content:[{type:'text',text:catalogue}]},
    {type:'tool_use',name:'Artifact',id:'l',input:{action:'list'}},
    {type:'tool_result',tool_use_id:'l',content:'https://claude.ai/artifact/real'},
    {type:'text',text:'https://claude.ai/artifact/template https://claude.ai/artifact/PENDING'}]})]};
  const i=c.buildClaudeInventory(data,'conv','org');
  assert.deepEqual(Array.from(i.artifacts,a=>a.slug),['real','template']);
  assert.equal(i.artifacts[0].associations[0].relationship,'listed');
  const blocks=i.history.messages[0].blocks;
  assert.match(blocks[1].content[0].text,/omitted/);
  assert.match(blocks[1].content[0].text,/keep this guidance/);
  assert.match(blocks[4].text,/artifact\/template/);
});

test('Claude known workspace route survives failed listing and hashes exact ZIP bytes', async () => {
  const c=loadClaudeExporter();let blob;
  c.downloadBlob=b=>blob=b;
  c.fetch=async url => String(url).includes('download-file') ? new Response('zip bytes') : new Response('',{status:404});
  const data={uuid:'conv',chat_messages:[claudeMessage('m','user',{files:[{file_uuid:'f',file_kind:'blob',path:'/mnt/user-data/uploads/a.zip',size_bytes:9}]})]};
  const out=await c.downloadClaudeConversationFiles(data,'conv','org',c.buildClaudeAllBranchesExport(data,'conv','org'));
  assert.equal(out.counts.downloaded,1);assert.equal(out.counts.discoveryFailures,1);
  const entries=await readStoredZip(blob), manifest=JSON.parse(entries.get('export-manifest.json'));
  const row=manifest.candidates[0];
  assert.deepEqual(row.routesAttempted.map(r=>r.route),['direct','workspace']);
  assert.equal(row.sha256,require('node:crypto').createHash('sha256').update(entries.get(row.zipPath)).digest('hex'));
  assert.equal(row.bytes,entries.get(row.zipPath).length);
});

test('Claude historical source uses matching tokens and keeps missing explicit versions', async () => {
  const c=loadClaudeExporter(), id='11111111-1111-4111-8111-111111111111';
  c.DOMParser=class {parseFromString(){return {documentElement:{dataset:{frameUuid:id,frameUchost:`${id}.frame.claudeusercontent.com`}}};}};
  const versions=Array.from({length:5},(_,i)=>`179195819${i}-6272`);
  c.fetch=async(url,init)=>{
    url=String(url);
    if(url.includes('/artifact/'))return new Response('shell');
    if(url.includes('/versions/'))return Response.json({history:versions,versions:Object.fromEntries(versions.map(v=>[v,{label:v,thumb_img_url:`https://${id}.frame.claudeusercontent.com/_f/${v}/_thumb.img?__frame_t=${v}`}]))});
    if(url.includes('/api/frame/')){assert.equal(init.headers['x-frame-cp'],'go');return Response.json({ver:versions[4],assetToken:versions[4],files:[{path:'index.html'}]});}
    if(url.includes('/_files.json'))return Response.json([{path:'index.html'}]);
    const parsed=new URL(url),version=parsed.pathname.split('/')[2];assert.equal(parsed.searchParams.get('__frame_t'),version);
    return new Response(version);
  };
  const data={chat_messages:[claudeMessage('m','assistant',{content:[{type:'text',text:'https://claude.ai/artifact/page version 1791958199-6272'}]})]};
  const inventory=c.buildClaudeInventory(data,'conv','org');await c.addClaudePublishedArtifactFiles(inventory.files,data,'org',inventory);
  assert.equal(inventory.files.length,6);
  for(const file of inventory.files.filter(f=>!f.error)){const entry=await c.fetchClaudeDownloadEntry(file);assert.equal(Buffer.concat(entry.parts.map(Buffer.from)).toString(),file.version);}
  assert.match(inventory.files.find(f=>f.version==='1791958199-6272').error,/Historical/);
});

function copyHarness({returnedId,existing=[],ambiguous=false,downloadFailure=false,deleteFailure=false,journal={}}={}) {
  const c=loadClaudeExporter();
  const original='11111111-1111-4111-8111-111111111111',copy='22222222-2222-4222-8222-222222222222';
  const events=[],stored=structuredClone(journal);
  c.chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>{events.push('journal');Object.assign(stored,structuredClone(v));}}}};
  c.fetch=async(url,init={})=>{
    url=String(url);
    if(url.endsWith('/api/account'))return Response.json({uuid:'account'});
    if(url.includes('/frames?'))return Response.json({frames:[{slug:original},...existing.map(slug=>({slug}))]});
    if(init.method==='POST'){events.push('create');return ambiguous ? new Response('not json') : Response.json({slug:returnedId || copy,version:'copy-v',owned:true,owner_account_id:'account'});}
    if(init.method==='DELETE'){events.push('delete');return new Response(null,{status:deleteFailure?403:204});}
    if(url.includes('/_src/')){events.push('download');return new Response(downloadFailure?'missing':'source',{status:downloadFailure?404:200});}
    if(url.includes(`/frame/${original}?`))return Response.json({ver:'original-v',duplicable:true});
    if(url.includes(`/frame/${copy}?`))return Response.json({ver:'copy-v',viewer:{owner:true},perm:{role:'owner'},assetToken:'test',files:[{path:'index.html',size:6}]});
    throw new Error(`Unexpected URL ${url}`);
  };
  const create=c.createZipAccumulator;
  c.createZipAccumulator=()=>{const zip=create();return {...zip,addEntry:async entry=>{if(entry.name.includes('index.html'))events.push('zip');await zip.addEntry(entry);}};};
  let blob;c.downloadBlob=b=>blob=b;
  return {c,original,copy,events,stored,getBlob:()=>blob,file:{id:original,artifactId:original,version:'original-v',copyEligible:true,name:'shared',error:'No token',associations:[]}};
}

test('Claude copy lifecycle journals, downloads, inserts ZIP then deletes; hashes match',async()=>{
  const h=copyHarness();const result=await h.c.downloadClaudeFilesToZip([h.file],'test.zip',null,[],'org');
  assert.equal(result.results[0].ok,true);assert.deepEqual(h.events,['create','journal','journal','download','zip','delete','journal']);
  const entries=await readStoredZip(h.getBlob()),manifest=JSON.parse(entries.get('export-manifest.json'));
  const row=manifest.candidates[0];assert.equal(row.temporaryCopy.cleanup,'deleted');assert.equal(row.provenance,'exported-through-copy');
  assert.equal(row.sha256,require('node:crypto').createHash('sha256').update(entries.get(row.zipPath)).digest('hex'));
  assert.equal(JSON.stringify(h.stored).includes('assetToken'),false);
});
for(const failure of ['original','existing','wrong','ambiguous']) test(`Claude refuses deletion for ${failure} creation identity`,async()=>{
  const original='11111111-1111-4111-8111-111111111111',copy='22222222-2222-4222-8222-222222222222';
  const h=copyHarness({returnedId:failure==='original'?original:failure==='wrong'?'bad':copy,existing:failure==='existing'?[copy]:[],ambiguous:failure==='ambiguous'});
  const manager=h.c.createClaudeCopyManager('org');await assert.rejects(manager.acquire(h.file));
  await assert.rejects(manager.cleanup({copyId:copy}),/receipt/);
  assert.equal(h.events.filter(e=>e==='create').length,1);assert.equal(h.events.includes('delete'),false);
});
test('Claude reused and previous-run receipts cannot authorize deletion',async()=>{
  const original='11111111-1111-4111-8111-111111111111',copy='22222222-2222-4222-8222-222222222222';
  const h=copyHarness({journal:{'claudeExportCopies:org:old':[{originalId:original,originalVersion:'original-v',copyId:copy,copyVersion:'copy-v',sourceVerified:true,cleanup:'pending'}]}});
  const manager=h.c.createClaudeCopyManager('org'),receipt=await manager.acquire(h.file);assert.equal(receipt.reused,true);
  await assert.rejects(manager.cleanup(receipt),/receipt/);assert.equal(h.events.length,0);
  const fresh=copyHarness(),first=fresh.c.createClaudeCopyManager('org'),created=await first.acquire(fresh.file);
  await assert.rejects(fresh.c.createClaudeCopyManager('org').cleanup(created),/receipt/);
  await first.cleanup(created);await assert.rejects(first.cleanup(created),/receipt/);
});
test('Claude download failure cleans only the new copy and reports cleanup failure separately',async()=>{
  const h=copyHarness({downloadFailure:true,deleteFailure:true});
  const result=await h.c.downloadClaudeFilesToZip([h.file],'test.zip',null,[],'org');
  assert.equal(result.results[0].ok,false);assert.equal(result.cleanupFailures.length,1);
  assert.equal(h.events.includes('zip'),false);assert.equal(h.events.includes('delete'),true);
  const entries=await readStoredZip(h.getBlob()),failures=JSON.parse(entries.get('export-failures.json'));
  assert.deepEqual(failures.map(f=>f.kind),['download','cleanup']);assert.match(failures[1].copyUrl,/artifact\//);
});

test('Claude copies current source after access denial, but not after a network failure', async () => {
  for (const denied of [true,false]) {
    const h=copyHarness();const fetch=h.c.fetch;
    h.c.fetch=async (url,init)=>{
      if(url==='/original-source') { if(denied)return new Response(null,{status:403});throw new TypeError('Network error'); }
      return fetch(url,init);
    };
    const file={...h.file, id:`${h.original}/original-v/index.html`, error:null, copyEligible:false,
      copyCapable:true, sourcePath:'index.html', url:'/original-source'};
    const result=await h.c.downloadClaudeFilesToZip([file],'test.zip',null,[],'org');
    assert.equal(result.results[0].ok,denied);
    assert.equal(h.events.includes('create'),denied);
    assert.equal(h.events.includes('delete'),denied);
  }
});

test('Both ZIP writers produce valid Deflate entries and retain stored fallback', async () => {
  const zlib=require('node:zlib');
  const original=Buffer.from('Unicode source: λ; repeated content.\n'.repeat(400));
  for (const load of [loadClaudeExporter,loadChatGptExporter]) {
    const c=load();c.CompressionStream=CompressionStream;c.Response=Response;
    const blob=await c.createZipBlob([{name:'source.html',parts:[original]},{name:'nested.zip',parts:[original]}]);
    const bytes=Buffer.from(await blob.arrayBuffer());let offset=0;
    for (const method of [8,0]) {
      assert.equal(bytes.readUInt32LE(offset),0x04034b50);
      assert.equal(bytes.readUInt16LE(offset+8),method);
      const packedSize=bytes.readUInt32LE(offset+18),size=bytes.readUInt32LE(offset+22);
      const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
      const packed=bytes.subarray(start,start+packedSize),actual=method===8?zlib.inflateRawSync(packed):packed;
      assert.deepEqual(actual,original);assert.equal(size,actual.length);
      assert.equal(bytes.readUInt32LE(offset+14),c.crc32(new Uint8Array(actual)));
      if(method===8)assert.ok(packedSize<size/2);
      offset=start+packedSize;
    }
    assert.equal(bytes.readUInt32LE(offset),0x02014b50);
    c.CompressionStream=class {constructor(){throw new Error('unavailable');}};
    const fallback=Buffer.from(await(await c.createZipBlob([{name:'source.html',parts:[original]}])).arrayBuffer());
    assert.equal(fallback.readUInt16LE(8),0);assert.equal(fallback.readUInt32LE(18),original.length);
  }
});

test('Claude reports partial multi-file copies and ambiguous creation without hiding cleanup risk', async () => {
  const h=copyHarness(),fetch=h.c.fetch;
  h.c.fetch=async(url,init)=>{
    if(String(url).includes('/_src/style.css')) return new Response(null,{status:404});
    const response=await fetch(url,init);
    if(String(url).includes(`/frame/${h.copy}?`) && !init?.method) {
      const metadata=await response.json();metadata.files.push({path:'style.css',size:6});return Response.json(metadata);
    }
    return response;
  };
  const result=await h.c.downloadClaudeFilesToZip([h.file],'test.zip',null,[],'org');
  assert.equal(result.results.length,2);assert.equal(result.results.filter(r=>r.ok).length,1);
  assert.equal(result.cleanupFailures.length,0);assert.equal(h.events.includes('delete'),true);
  const uncertain=copyHarness({ambiguous:true});
  const outcome=await uncertain.c.downloadClaudeFilesToZip([uncertain.file],'test.zip',null,[],'org');
  assert.equal(outcome.cleanupFailures[0].cleanup,'creation-unknown');
  assert.equal(uncertain.events.includes('delete'),false);
});
