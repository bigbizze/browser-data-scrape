const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");

function loadChatGptExporter() {
  const code = fs.readFileSync(path.join(extensionRoot, "exporters", "chatgpt.js"), "utf8");
  const sandbox = {
    window: { __chatGptBackendExportInProgress: true },
    location: {
      href: "https://chatgpt.com/c/00000000-0000-0000-0000-000000000000",
      origin: "https://chatgpt.com",
      pathname: "/c/00000000-0000-0000-0000-000000000000"
    },
    document: { title: "Harness" },
    console,
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => {}
    },
    setTimeout,
    fetch: async () => {
      throw new Error("fetch not available in harness");
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "chatgpt.js" });
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
          json: async () => ({ mapping })
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
    branchedChildren: 2
  });
});
