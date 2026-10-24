import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cmd, terminated, validateCommandList } from "../dist/commandList.js";
import { compileDialogue, dialogueNodeSchema, messageCommands } from "../dist/dialogueTree.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const codes = (list) => list.map((c) => c.code);
const valid = (tree) => {
  const list = compileDialogue(tree);
  assert.deepEqual(validateCommandList(terminated(list)), []);
  return list;
};

test("messageCommands splits into boxes of 4 lines", () => {
  const list = messageCommands(["a", "b", "c", "d", "e"], "Actor1", 3, 1, 0, 2);
  assert.deepEqual(list, [
    cmd(101, 2, "Actor1", 3, 1, 0),
    cmd(401, 2, "a"),
    cmd(401, 2, "b"),
    cmd(401, 2, "c"),
    cmd(401, 2, "d"),
    cmd(101, 2, "Actor1", 3, 1, 0),
    cmd(401, 2, "e"),
  ]);
});

test("say with 5 lines makes two boxes (101,401x4,101,401)", () => {
  const list = valid([{ say: ["1", "2", "3", "4", "5"] }]);
  assert.deepEqual(codes(list), [101, 401, 401, 401, 401, 101, 401]);
  assert.deepEqual(list[0].parameters, ["", 0, 0, 2]);
});

test("say takes face, background and position; a string splits on newlines", () => {
  const list = valid([{ say: "one\ntwo", face: { name: "Actor1", index: 2 }, background: 2, position: 0 }]);
  assert.deepEqual(list, [cmd(101, 0, "Actor1", 2, 2, 0), cmd(401, 0, "one"), cmd(401, 0, "two")]);
});

test("choices with two entries and cancel disallow", () => {
  const list = valid([
    {
      choices: [
        { label: "Yes", then: [{ say: "Great" }] },
        { label: "No", then: [{ say: "Pity" }] },
      ],
      cancel: "disallow",
    },
  ]);
  assert.deepEqual(list, [
    cmd(102, 0, ["Yes", "No"], -1, 0, 2, 0),
    cmd(402, 0, 0, "Yes"),
    cmd(101, 1, "", 0, 0, 2),
    cmd(401, 1, "Great"),
    cmd(402, 0, 1, "No"),
    cmd(101, 1, "", 0, 0, 2),
    cmd(401, 1, "Pity"),
    cmd(404, 0),
  ]);
});

test("cancel omitted defaults to disallow; a number is the cancel choice index", () => {
  const ch = [{ label: "A" }, { label: "B" }];
  assert.equal(valid([{ choices: ch }])[0].parameters[1], -1);
  const list = valid([{ choices: ch, cancel: 1 }]);
  assert.equal(list[0].parameters[1], 1);
  assert.ok(!codes(list).includes(403));
});

test('cancel "branch" adds a 403 branch before the closing 404', () => {
  const list = valid([{ choices: [{ label: "A" }, { label: "B" }], cancel: "branch" }]);
  assert.deepEqual(list, [
    cmd(102, 0, ["A", "B"], -2, 0, 2, 0),
    cmd(402, 0, 0, "A"),
    cmd(402, 0, 1, "B"),
    cmd(403, 0),
    cmd(404, 0),
  ]);
});

test("if/else nests bodies one indent deeper and closes with 412", () => {
  const list = valid([{ if: { switch: 3 }, then: [{ setSwitch: { id: 4, value: true } }], else: [{ say: "no" }] }]);
  assert.deepEqual(list, [
    cmd(111, 0, 0, 3, 0),
    cmd(121, 1, 4, 4, 0),
    cmd(411, 0),
    cmd(101, 1, "", 0, 0, 2),
    cmd(401, 1, "no"),
    cmd(412, 0),
  ]);
});

test("if without else emits no 411", () => {
  const list = valid([{ if: { switch: 3, is: false }, then: [{ say: "x" }] }]);
  assert.deepEqual(codes(list), [111, 101, 401, 412]);
  assert.deepEqual(list[0].parameters, [0, 3, 1]);
});

test("a choice body containing an if keeps indent = parent + 2", () => {
  const list = valid([
    { choices: [{ label: "Go", then: [{ if: { gold: 100 }, then: [{ say: "rich" }] }] }] },
  ]);
  assert.deepEqual(
    list.map((c) => [c.code, c.indent]),
    [[102, 0], [402, 0], [111, 1], [101, 2], [401, 2], [412, 1], [404, 0]],
  );
});

test("condition parameter layouts", () => {
  const params = (condition) => compileDialogue([{ if: condition }])[0].parameters;
  assert.deepEqual(params({ switch: 5 }), [0, 5, 0]);
  assert.deepEqual(params({ variable: 2, op: "eq", value: 7 }), [1, 2, 0, 7, 0]);
  assert.deepEqual(params({ variable: 2, op: "gte", value: 7 }), [1, 2, 0, 7, 1]);
  assert.deepEqual(params({ variable: 2, op: "lte", value: 7 }), [1, 2, 0, 7, 2]);
  assert.deepEqual(params({ variable: 2, op: "gt", value: 7 }), [1, 2, 0, 7, 3]);
  assert.deepEqual(params({ variable: 2, op: "lt", value: 7 }), [1, 2, 0, 7, 4]);
  assert.deepEqual(params({ variable: 2, op: "ne", value: 7 }), [1, 2, 0, 7, 5]);
  assert.deepEqual(params({ selfSwitch: "B" }), [2, "B", 0]);
  assert.deepEqual(params({ selfSwitch: "C", is: false }), [2, "C", 1]);
  assert.deepEqual(params({ gold: 300 }), [7, 300, 0]);
  assert.deepEqual(params({ item: 9 }), [8, 9]);
});

test("setSwitch off uses value 1", () => {
  assert.deepEqual(compileDialogue([{ setSwitch: { id: 7, value: false } }]), [cmd(121, 0, 7, 7, 1)]);
  assert.deepEqual(compileDialogue([{ setSwitch: { id: 7, value: true } }]), [cmd(121, 0, 7, 7, 0)]);
});

test("setVariable maps set/add/sub to 0/1/2 with a constant operand", () => {
  assert.deepEqual(compileDialogue([{ setVariable: { id: 2, op: "set", value: 5 } }]), [cmd(122, 0, 2, 2, 0, 0, 5)]);
  assert.deepEqual(compileDialogue([{ setVariable: { id: 2, op: "add", value: 5 } }]), [cmd(122, 0, 2, 2, 1, 0, 5)]);
  assert.deepEqual(compileDialogue([{ setVariable: { id: 2, op: "sub", value: 5 } }]), [cmd(122, 0, 2, 2, 2, 0, 5)]);
});

test("setSelfSwitch uses the letter and 0 on / 1 off", () => {
  assert.deepEqual(compileDialogue([{ setSelfSwitch: { ch: "A", value: true } }]), [cmd(123, 0, "A", 0)]);
  assert.deepEqual(compileDialogue([{ setSelfSwitch: { ch: "D", value: false } }]), [cmd(123, 0, "D", 1)]);
});

test("transfer defaults direction 0 and fade 0", () => {
  assert.deepEqual(compileDialogue([{ transfer: { mapId: 3, x: 4, y: 5 } }]), [cmd(201, 0, 0, 3, 4, 5, 0, 0)]);
  assert.deepEqual(compileDialogue([{ transfer: { mapId: 3, x: 4, y: 5, direction: 8, fade: 2 } }]), [
    cmd(201, 0, 0, 3, 4, 5, 8, 2),
  ]);
});

test("raw commands are shifted by the current indent", () => {
  const list = valid([
    {
      choices: [
        { label: "Go", then: [{ raw: [cmd(111, 0, 0, 1, 0), cmd(230, 1, 30), cmd(412, 0)] }] },
      ],
    },
  ]);
  assert.deepEqual(
    list.map((c) => [c.code, c.indent]),
    [[102, 0], [402, 0], [111, 1], [230, 2], [412, 1], [404, 0]],
  );
});

test("control codes pass through unchanged", () => {
  const text = "\\C[2]Hello\\C[0] \\N[1], you have \\V[3]\\G!\\|\\.\\^";
  const list = valid([{ say: [text] }, { choices: [{ label: "\\C[3]Yes" }] }]);
  assert.equal(list[1].parameters[0], text);
  assert.deepEqual(list[2].parameters[0], ["\\C[3]Yes"]);
  assert.equal(list[3].parameters[1], "\\C[3]Yes");
});

test("schema accepts a well-formed tree and fills raw defaults", () => {
  const parsed = dialogueNodeSchema.safeParse({ raw: [{ code: 230, parameters: [30] }] });
  assert.ok(parsed.success);
  assert.equal(parsed.data.raw[0].indent, 0);
  assert.ok(
    dialogueNodeSchema.safeParse({ choices: [{ label: "A", then: [{ if: { item: 1 }, then: [{ say: "x" }] }] }] }).success,
  );
});

test("schema rejects empty choices, too many choices, empty labels, empty say and bad cancel", () => {
  const msg = (node) => {
    const r = dialogueNodeSchema.safeParse(node);
    assert.equal(r.success, false, JSON.stringify(node));
    return JSON.stringify(r.error.issues);
  };
  assert.match(msg({ choices: [] }), /at least 1 entry/);
  assert.match(msg({ choices: Array.from({ length: 7 }, (_, i) => ({ label: `c${i}` })) }), /at most 6/);
  assert.match(msg({ choices: [{ label: "" }] }), /label must not be empty/);
  assert.match(msg({ say: "" }), /say must not be empty/);
  assert.match(msg({ say: [] }), /at least one line/);
  assert.match(msg({ say: ["ok", ""] }), /lines must not be empty/);
  msg({ choices: [{ label: "A" }], cancel: 6 });
  msg({ say: "x", typo: 1 });
});

test("schema rejects depth 9 with a clear message and accepts depth 8", () => {
  const nest = (levels) => {
    let node = { say: "leaf" };
    for (let i = 1; i < levels; i++) node = { if: { switch: 1 }, then: [node] };
    return node;
  };
  assert.ok(dialogueNodeSchema.safeParse(nest(8)).success);
  const bad = dialogueNodeSchema.safeParse(nest(9));
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error.issues), /nested 9 levels deep.*maximum is 8/);
});

test("compileDialogue throws instead of producing a malformed list", () => {
  assert.throws(() => compileDialogue([{ choices: [] }]), /1-6 entries/);
  assert.throws(() => compileDialogue([{ choices: [{ label: "" }] }]), /non-empty label/);
  assert.throws(() => compileDialogue([{ choices: [{ label: "A" }], cancel: 3 }]), /not a valid choice index/);
  assert.throws(() => compileDialogue([{ say: "" }]), /some text/);
  let node = { say: "leaf" };
  for (let i = 1; i < 9; i++) node = { if: { switch: 1 }, then: [node] };
  assert.throws(() => compileDialogue([node]), /maximum is 8/);
});

test("presentation nodes compile inside choice and if bodies and keep the block structure valid", () => {
  const list = valid([
    {
      choices: [
        { label: "Go", then: [{ if: { switch: 1 }, then: [{ fade: "out" }, { wait: 10 }], else: [{ moveRoute: { target: "this", steps: ["up"] } }] }] },
      ],
    },
  ]);
  assert.deepEqual(
    list.map((c) => [c.code, c.indent]),
    [[102, 0], [402, 0], [111, 1], [221, 2], [230, 2], [411, 1], [205, 2], [505, 2], [412, 1], [404, 0]],
  );
});

test("every compiled tree passes validateCommandList(terminated(...))", () => {
  valid([
    { say: ["a", "b", "c", "d", "e"], face: { name: "Actor1", index: 0 } },
    {
      choices: [
        {
          label: "Ask",
          then: [
            { if: { variable: 1, op: "gte", value: 3 }, then: [{ say: "ok" }], else: [{ say: "no" }] },
            { setVariable: { id: 1, op: "add", value: 1 } },
          ],
        },
        { label: "Leave", then: [{ transfer: { mapId: 2, x: 1, y: 1 } }] },
      ],
      cancel: "branch",
    },
    { setSelfSwitch: { ch: "A", value: true } },
  ]);
  assert.deepEqual(compileDialogue([]), []);
});

// ------------------------------------------------------------- tool

async function withServer(fn) {
  const client = new Client({ name: "dialogue-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, RPGMV_TOOLS: "" },
      stderr: "ignore",
    }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function withProjectServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-dialogue-"));
  await fs.mkdir(path.join(dir, "data"));
  const page = { list: [{ code: 0, indent: 0, parameters: [] }] };
  const map = { width: 2, height: 2, data: [], events: [null, { id: 1, name: "NPC", x: 0, y: 0, pages: [page] }] };
  const mapFile = path.join(dir, "data", "Map001.json");
  await fs.writeFile(mapFile, JSON.stringify(map), "utf8");
  try {
    await withServer(async (client) => {
      const set = await client.callTool({ name: "set_project", arguments: { path: dir } });
      assert.ok(!set.isError, set.content[0].text);
      await fn(client, { dir, mapFile });
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const tool = async (client, args) => {
  const res = await client.callTool({ name: "build_dialogue_tree", arguments: args });
  return { res, body: res.isError ? null : JSON.parse(res.content[0].text) };
};

test("build_dialogue_tree before set_project returns the No project selected error", async () => {
  await withServer(async (client) => {
    const res = await client.callTool({ name: "build_dialogue_tree", arguments: { tree: [{ say: "hi" }] } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No project selected/);
  });
});

test("build_dialogue_tree without a target is a dry run that never touches disk", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const before = await fs.readFile(mapFile, "utf8");
    const { body } = await tool(client, { tree: [{ say: "hi" }] });
    assert.equal(body.commands, 2);
    assert.deepEqual(body.problems, []);
    assert.equal(body.inserted, undefined);
    assert.deepEqual(body.preview, [cmd(101, 0, "", 0, 0, 2), cmd(401, 0, "hi")]);

    const dry = await tool(client, { tree: [{ say: "hi" }], mapId: 1, eventId: 1, dryRun: true });
    assert.equal(dry.body.inserted, undefined);
    assert.equal(dry.body.preview.length, 2);

    assert.equal(await fs.readFile(mapFile, "utf8"), before);
    assert.deepEqual((await fs.readdir(path.dirname(mapFile))).sort(), ["Map001.json"]);
  });
});

test("build_dialogue_tree inserts into an event page and preserves the terminator", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const { body } = await tool(client, {
      tree: [{ choices: [{ label: "Yes", then: [{ say: "Great" }] }, { label: "No" }] }],
      mapId: 1,
      eventId: 1,
    });
    assert.equal(body.commands, 6);
    assert.equal(body.inserted.inserted, 6);
    assert.deepEqual(body.problems, []);
    const map = JSON.parse(await fs.readFile(mapFile, "utf8"));
    const list = map.events[1].pages[0].list;
    assert.deepEqual(codes(list), [102, 402, 101, 401, 402, 404, 0]);
    assert.deepEqual(validateCommandList(list), []);
  });
});

test("build_dialogue_tree index: top-level positions work, positions inside a block are refused", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const base = [
      cmd(111, 0, 0, 5, 0),
      cmd(101, 1, "", 0, 0, 2),
      cmd(401, 1, "inside"),
      cmd(412, 0),
      cmd(0, 0),
    ];
    const reset = async () => {
      const map = JSON.parse(await fs.readFile(mapFile, "utf8"));
      map.events[1].pages[0].list = structuredClone(base);
      await fs.writeFile(mapFile, JSON.stringify(map), "utf8");
      return JSON.stringify(map);
    };
    const listOf = async () => JSON.parse(await fs.readFile(mapFile, "utf8")).events[1].pages[0].list;

    // top level: before the 111 (index 0) and at the terminator (index 4)
    await reset();
    for (const [index, expectAt] of [[0, 0], [4, 4]]) {
      await reset();
      const { res, body } = await tool(client, { tree: [{ say: "new" }], mapId: 1, eventId: 1, index });
      assert.ok(!res.isError, res.content[0].text);
      assert.equal(body.inserted.at, expectAt);
      const list = await listOf();
      assert.deepEqual(validateCommandList(list), []);
      const at = list.findIndex((c) => c.code === 401 && c.parameters[0] === "new");
      assert.equal(list[at].indent, 0);
      assert.equal(list[at - 1].indent, 0);
    }

    // inside the body (index 1, 2) and before the closer 412 (index 3): refused, file untouched
    for (const index of [1, 2, 3]) {
      const before = await reset();
      const { res } = await tool(client, { tree: [{ say: "new" }], mapId: 1, eventId: 1, index });
      assert.equal(res.isError, true, `index ${index}`);
      assert.match(res.content[0].text, /inside a block|nested/, `index ${index}`);
      assert.equal(await fs.readFile(mapFile, "utf8"), before);
    }
  });
});

test("build_dialogue_tree index: positions inside a multi-line command are refused, nothing is written", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const base = [
      cmd(101, 0, "", 0, 0, 2),
      cmd(401, 0, "line one"),
      cmd(401, 0, "line two"),
      cmd(302, 0, 0, 1, 0, 0, false),
      cmd(605, 0, 0, 2, 0, 0),
      cmd(0, 0),
    ];
    const reset = async () => {
      const map = JSON.parse(await fs.readFile(mapFile, "utf8"));
      map.events[1].pages[0].list = structuredClone(base);
      await fs.writeFile(mapFile, JSON.stringify(map), "utf8");
      return JSON.stringify(map);
    };
    // 1, 2 = text continuation lines (401), 4 = shop good (605)
    for (const index of [1, 2, 4]) {
      const before = await reset();
      const { res } = await tool(client, { tree: [{ say: "new" }], mapId: 1, eventId: 1, index });
      assert.equal(res.isError, true, `index ${index}`);
      assert.match(res.content[0].text, /inside a multi-line command/, `index ${index}`);
      assert.equal(await fs.readFile(mapFile, "utf8"), before, `index ${index}`);
    }
    // between whole commands still works: before the 101, before the 302, at the terminator
    for (const index of [0, 3, 5]) {
      await reset();
      const { res, body } = await tool(client, { tree: [{ say: "new" }], mapId: 1, eventId: 1, index });
      assert.ok(!res.isError, `index ${index}: ${res.content[0].text}`);
      assert.equal(body.inserted.at, index);
    }
  });
});

test("add_event_command still accepts an index on a 401 continuation line", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const map = JSON.parse(await fs.readFile(mapFile, "utf8"));
    map.events[1].pages[0].list = [cmd(101, 0, "", 0, 0, 2), cmd(401, 0, "line one"), cmd(401, 0, "line two"), cmd(0, 0)];
    await fs.writeFile(mapFile, JSON.stringify(map), "utf8");
    const res = await client.callTool({
      name: "add_event_command",
      arguments: { mapId: 1, eventId: 1, index: 1, commands: [cmd(108, 0, "note")] },
    });
    assert.ok(!res.isError, res.content[0].text);
    const list = JSON.parse(await fs.readFile(mapFile, "utf8")).events[1].pages[0].list;
    assert.deepEqual(codes(list), [101, 108, 401, 401, 0]);
  });
});

test("build_dialogue_tree omits preview for long inserted trees and reports a half-specified target", async () => {
  await withProjectServer(async (client) => {
    const tree = Array.from({ length: 21 }, (_, i) => ({ say: `line ${i}` }));
    const { body } = await tool(client, { tree, mapId: 1, eventId: 1 });
    assert.equal(body.commands, 42);
    assert.equal(body.preview, undefined);
    assert.equal(body.inserted.inserted, 42);

    const half = await tool(client, { tree: [{ say: "x" }], mapId: 1 });
    assert.equal(half.res.isError, true);
    assert.match(half.res.content[0].text, /mapId and eventId/);
  });
});

test("build_dialogue_tree rejects invalid trees and leaves the map untouched", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const before = await fs.readFile(mapFile, "utf8");
    for (const tree of [[{ choices: [] }], [{ say: "" }], [{ choices: [{ label: "" }] }]]) {
      const { res } = await tool(client, { tree, mapId: 1, eventId: 1 });
      assert.equal(res.isError, true, JSON.stringify(tree));
    }
    let deep = { say: "leaf" };
    for (let i = 1; i < 9; i++) deep = { if: { switch: 1 }, then: [deep] };
    const { res } = await tool(client, { tree: [deep], mapId: 1, eventId: 1 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /maximum is 8/);
    assert.equal(await fs.readFile(mapFile, "utf8"), before);
  });
});

test("build_dialogue_tree refuses to write a structurally invalid raw list", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const before = await fs.readFile(mapFile, "utf8");
    const { res } = await tool(client, { tree: [{ raw: [{ code: 111, indent: 0, parameters: [0, 1, 0] }] }], mapId: 1, eventId: 1 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no matching Branch End \(412\)/);
    assert.equal(await fs.readFile(mapFile, "utf8"), before);
  });
});
