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
    console,
    Blob,
    TextEncoder,
    URL: TestURL,
    setTimeout,
    fetch: async () => {
      throw new Error("fetch not available in harness");
    }
  };

  vm.createContext(sandbox);
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
    console,
    Blob,
    TextEncoder,
    URL: TestURL,
    setTimeout,
    fetch: async () => {
      throw new Error("fetch not available in harness");
    }
  };

  vm.createContext(sandbox);
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
    console,
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
    while (!pending.length) await Promise.resolve();
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
  while (pending.length < 3) await Promise.resolve();
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
          file_kind: "blob",
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
    while (!pending.length) await Promise.resolve();
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
  while (pending.length < 3) await Promise.resolve();
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
