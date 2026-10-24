import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cmd, terminated, validateCommandList } from "../dist/commandList.js";
import { compileDialogue, dialogueNodeSchema } from "../dist/dialogueTree.js";
import { buildTemplate, shopCommands } from "../dist/eventTemplates.js";
import { EVENT_COMMAND_REFERENCE } from "../dist/reference.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const valid = (tree) => {
  const list = compileDialogue(tree);
  assert.deepEqual(validateCommandList(terminated(list)), []);
  return list;
};
const compiled = (node) => valid([node]);
const accepted = (node) => {
  const r = dialogueNodeSchema.safeParse(node);
  assert.ok(r.success, JSON.stringify(node) + (r.success ? "" : JSON.stringify(r.error.issues)));
};
/** Both the schema and the compiler must refuse the node; returns the schema's message text. */
const rejected = (node, pattern) => {
  const r = dialogueNodeSchema.safeParse(node);
  assert.equal(r.success, false, `schema accepted ${JSON.stringify(node)}`);
  const text = JSON.stringify(r.error.issues);
  if (pattern) assert.match(text, pattern, JSON.stringify(node));
  assert.throws(() => compileDialogue([{ say: "before" }, node]), pattern ?? /./, `compiler accepted ${JSON.stringify(node)}`);
  return text;
};
const shape = (list) => list.map((c) => [c.code, c.indent]);

// ---------------------------------------------------------------- simple nodes

test("gold compiles to 125 with a sign-dependent operation and an absolute amount", () => {
  assert.deepEqual(compiled({ gold: 500 }), [cmd(125, 0, 0, 0, 500)]);
  assert.deepEqual(compiled({ gold: -250 }), [cmd(125, 0, 1, 0, 250)]);
  assert.deepEqual(compiled({ gold: 99999999 }), [cmd(125, 0, 0, 0, 99999999)]);
  assert.deepEqual(compiled({ gold: -99999999 }), [cmd(125, 0, 1, 0, 99999999)]);
});

test("item, weapon and armor compile to 126 / 127 / 128 (includeEquip false) with + or - counts", () => {
  assert.deepEqual(compiled({ item: { kind: "item", id: 3, count: 2 } }), [cmd(126, 0, 3, 0, 0, 2)]);
  assert.deepEqual(compiled({ item: { kind: "item", id: 3, count: -2 } }), [cmd(126, 0, 3, 1, 0, 2)]);
  assert.deepEqual(compiled({ item: { kind: "weapon", id: 4, count: 1 } }), [cmd(127, 0, 4, 0, 0, 1, false)]);
  assert.deepEqual(compiled({ item: { kind: "weapon", id: 4, count: -1 } }), [cmd(127, 0, 4, 1, 0, 1, false)]);
  assert.deepEqual(compiled({ item: { kind: "armor", id: 5, count: 3 } }), [cmd(128, 0, 5, 0, 0, 3, false)]);
  assert.deepEqual(compiled({ item: { kind: "armor", id: 5, count: -3 } }), [cmd(128, 0, 5, 1, 0, 3, false)]);
});

test("party add / remove / initialize compile to 129", () => {
  assert.deepEqual(compiled({ party: { actorId: 2, action: "add" } }), [cmd(129, 0, 2, 0, 0)]);
  assert.deepEqual(compiled({ party: { actorId: 2, action: "add", initialize: true } }), [cmd(129, 0, 2, 0, 1)]);
  assert.deepEqual(compiled({ party: { actorId: 2, action: "remove" } }), [cmd(129, 0, 2, 1, 0)]);
});

test("learnSkill and forget compile to 318; recoverAll to 314; nameInput to 303", () => {
  assert.deepEqual(compiled({ learnSkill: { actorId: 1, skillId: 9 } }), [cmd(318, 0, 0, 1, 0, 9)]);
  assert.deepEqual(compiled({ learnSkill: { actorId: 1, skillId: 9, forget: true } }), [cmd(318, 0, 0, 1, 1, 9)]);
  assert.deepEqual(compiled({ learnSkill: { actorId: 1, skillId: 9, forget: false } }), [cmd(318, 0, 0, 1, 0, 9)]);
  assert.deepEqual(compiled({ recoverAll: true }), [cmd(314, 0, 0, 0)]);
  assert.deepEqual(compiled({ nameInput: { actorId: 4, maxChars: 8 } }), [cmd(303, 0, 4, 8)]);
});

test("plugin command compiles to 356", () => {
  assert.deepEqual(compiled({ plugin: "ShowQuest 12 fast" }), [cmd(356, 0, "ShowQuest 12 fast")]);
});

test("scene maps menu / save / gameOver / title to 351-354", () => {
  assert.deepEqual(compiled({ scene: "menu" }), [cmd(351, 0)]);
  assert.deepEqual(compiled({ scene: "save" }), [cmd(352, 0)]);
  assert.deepEqual(compiled({ scene: "gameOver" }), [cmd(353, 0)]);
  assert.deepEqual(compiled({ scene: "title" }), [cmd(354, 0)]);
});

test("comment: single line is 108, further lines (array or newlines) are 408", () => {
  assert.deepEqual(compiled({ comment: "note" }), [cmd(108, 0, "note")]);
  assert.deepEqual(compiled({ comment: ["one", "two", "three"] }), [cmd(108, 0, "one"), cmd(408, 0, "two"), cmd(408, 0, "three")]);
  assert.deepEqual(compiled({ comment: "one\r\ntwo\nthree" }), [cmd(108, 0, "one"), cmd(408, 0, "two"), cmd(408, 0, "three")]);
  assert.deepEqual(compiled({ comment: ["a\nb", "c"] }), [cmd(108, 0, "a"), cmd(408, 0, "b"), cmd(408, 0, "c")]);
});

test("label, jump, exit and callCommon compile to 118 / 119 / 115 / 117", () => {
  assert.deepEqual(compiled({ label: "start" }), [cmd(118, 0, "start")]);
  assert.deepEqual(compiled({ jump: "start" }), [cmd(119, 0, "start")]);
  assert.deepEqual(compiled({ exit: true }), [cmd(115, 0)]);
  assert.deepEqual(compiled({ callCommon: 7 }), [cmd(117, 0, 7)]);
});

test("game-flow leaf nodes are indented inside a choice body", () => {
  const list = valid([
    { choices: [{ label: "Buy", then: [{ gold: -10 }, { item: { kind: "item", id: 1, count: 1 } }, { comment: ["a", "b"] }] }] },
  ]);
  assert.deepEqual(shape(list), [[102, 0], [402, 0], [125, 1], [126, 1], [108, 1], [408, 1], [404, 0]]);
});

// ------------------------------------------------------------------------ shop

test("shop equals the 0.4 shop template's commands for the same goods", () => {
  const goods = [
    { type: "item", id: 1 },
    { type: "weapon", id: 2, price: 300 },
    { type: "armor", id: 3, price: 0 },
  ];
  for (const purchaseOnly of [false, true]) {
    const template = buildTemplate({ template: "shop", goods, purchaseOnly }).pages[0].list.filter((c) => c.code !== 0);
    assert.deepEqual(compiled({ shop: { goods, purchaseOnly } }), template);
    assert.deepEqual(shopCommands(goods, purchaseOnly, 0), template);
  }
  assert.deepEqual(compiled({ shop: { goods } }), [
    cmd(302, 0, 0, 1, 0, 0, false),
    cmd(605, 0, 1, 2, 1, 300),
    cmd(605, 0, 2, 3, 1, 0),
  ]);
});

test("shopCommands takes the indent and leaves the template output identical", () => {
  assert.deepEqual(shopCommands([{ type: "item", id: 1 }, { type: "armor", id: 2, price: 5 }], false, 2), [
    cmd(302, 2, 0, 1, 0, 0, false),
    cmd(605, 2, 2, 2, 1, 5),
  ]);
  assert.deepEqual(shape(valid([{ choices: [{ label: "Shop", then: [{ shop: { goods: [{ type: "item", id: 1 }, { type: "item", id: 2 }] } }] }] }])), [
    [102, 0], [402, 0], [302, 1], [605, 1], [404, 0],
  ]);
});

test("shop needs 1-40 goods with valid types, ids and prices", () => {
  accepted({ shop: { goods: Array(40).fill({ type: "item", id: 1 }) } });
  rejected({ shop: { goods: [] } }, /at least 1/);
  rejected({ shop: { goods: Array(41).fill({ type: "item", id: 1 }) } }, /at most 40/);
  rejected({ shop: { goods: [{ type: "potion", id: 1 }] } }, /./);
  rejected({ shop: { goods: [{ type: "item", id: 0 }] } }, /greater than or equal to 1/);
  rejected({ shop: { goods: [{ type: "item", id: 1, price: -1 }] } }, /greater than or equal to 0/);
  rejected({ shop: { goods: [{ type: "item", id: 1, typo: 1 }] } }, /Unrecognized key/);
  rejected({ shop: { goods: [{ type: "item", id: 1 }], purchaseOnly: "yes" } }, /./);
  rejected({ shop: {} }, /./);
});

// ---------------------------------------------------------------------- battle

test("battle with all three branches", () => {
  const list = compiled({
    battle: {
      troopId: 3,
      canEscape: true,
      canLose: true,
      onWin: [{ say: "Won" }],
      onEscape: [{ say: "Ran" }],
      onLose: [{ say: "Lost" }],
    },
  });
  assert.deepEqual(list, [
    cmd(301, 0, 0, 3, true, true),
    cmd(601, 0),
    cmd(101, 1, "", 0, 0, 2),
    cmd(401, 1, "Won"),
    cmd(602, 0),
    cmd(101, 1, "", 0, 0, 2),
    cmd(401, 1, "Ran"),
    cmd(603, 0),
    cmd(101, 1, "", 0, 0, 2),
    cmd(401, 1, "Lost"),
    cmd(604, 0),
  ]);
});

test("battle with only onWin; branch order is always win, escape, lose", () => {
  assert.deepEqual(compiled({ battle: { troopId: 1, onWin: [{ setSwitch: { id: 2, value: true } }] } }), [
    cmd(301, 0, 0, 1, false, false),
    cmd(601, 0),
    cmd(121, 1, 2, 2, 0),
    cmd(604, 0),
  ]);
  const list = compiled({ battle: { troopId: 1, canEscape: true, canLose: true, onLose: [{ exit: true }], onEscape: [{ wait: 5 }] } });
  assert.deepEqual(shape(list), [[301, 0], [602, 0], [230, 1], [603, 0], [115, 1], [604, 0]]);
});

test("battle without branches is 301 then 604; empty branch arrays emit nothing", () => {
  assert.deepEqual(compiled({ battle: { troopId: 5 } }), [cmd(301, 0, 0, 5, false, false), cmd(604, 0)]);
  assert.deepEqual(compiled({ battle: { troopId: 5, canEscape: true, canLose: true } }), [cmd(301, 0, 0, 5, true, true), cmd(604, 0)]);
  assert.deepEqual(compiled({ battle: { troopId: 5, onWin: [] } }), [cmd(301, 0, 0, 5, false, false), cmd(604, 0)]);
});

test("a battle branch containing choices containing an if has exact indents 1/2/3", () => {
  const list = valid([
    {
      battle: {
        troopId: 2,
        onWin: [
          {
            choices: [{ label: "Loot", then: [{ if: { switch: 4 }, then: [{ gold: 100 }], else: [{ gold: 10 }] }] }],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(shape(list), [
    [301, 0],
    [601, 0],
    [102, 1],
    [402, 1],
    [111, 2],
    [125, 3],
    [411, 2],
    [125, 3],
    [412, 2],
    [404, 1],
    [604, 0],
  ]);
});

test("a battle inside a battle branch and inside a choice keeps its block structure", () => {
  const list = valid([
    {
      choices: [
        {
          label: "Fight",
          then: [{ battle: { troopId: 1, canLose: true, onWin: [{ battle: { troopId: 2, onWin: [{ say: "Both" }] } }], onLose: [{ scene: "gameOver" }] } }],
        },
      ],
    },
  ]);
  assert.deepEqual(shape(list), [
    [102, 0],
    [402, 0],
    [301, 1],
    [601, 1],
    [301, 2],
    [601, 2],
    [101, 3],
    [401, 3],
    [604, 2],
    [603, 1],
    [353, 2],
    [604, 1],
    [404, 0],
  ]);
});

test("battle with onEscape but canEscape false (or onLose without canLose) is rejected", () => {
  rejected({ battle: { troopId: 1, onEscape: [{ say: "x" }] } }, /onEscape.*canEscape/);
  rejected({ battle: { troopId: 1, canEscape: false, onEscape: [{ say: "x" }] } }, /onEscape.*canEscape/);
  rejected({ battle: { troopId: 1, onLose: [{ say: "x" }] } }, /onLose.*canLose/);
  rejected({ battle: { troopId: 1, canLose: false, onLose: [{ say: "x" }] } }, /onLose.*canLose/);
  rejected({ battle: { troopId: 1, canEscape: true, onLose: [{ say: "x" }] } }, /onLose.*canLose/);
  rejected({ battle: { troopId: 1, canLose: true, onEscape: [{ say: "x" }] } }, /onEscape.*canEscape/);
  accepted({ battle: { troopId: 1, canEscape: true, canLose: true, onEscape: [{ say: "x" }], onLose: [{ say: "y" }] } });
});

test("battle validates troopId, flags, unknown keys and branch contents", () => {
  rejected({ battle: {} }, /./);
  rejected({ battle: { troopId: 0 } }, /greater than or equal to 1/);
  rejected({ battle: { troopId: 1.5 } }, /integer/i);
  rejected({ battle: { troopId: 1, canEscape: "yes" } }, /./);
  rejected({ battle: { troopId: 1, onWin: "win" } }, /./);
  rejected({ battle: { troopId: 1, typo: 1 } }, /Unrecognized key/);
  rejected({ battle: { troopId: 1, onWin: [{ nonsense: 1 }] } }, /./);
  rejected({ battle: { troopId: 1, onWin: [{ wait: 0 }] } }, /greater than or equal to 1/);
});

test("battle branch bodies count towards the nesting limit: depth 8 passes, depth 9 is rejected", () => {
  const nest = (levels, leaf) => {
    let node = leaf;
    for (let i = 1; i < levels; i++) node = { battle: { troopId: 1, onWin: [node] } };
    return node;
  };
  accepted(nest(8, { say: "deep" }));
  const bad = dialogueNodeSchema.safeParse(nest(9, { say: "deep" }));
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error.issues), /nested 9 levels deep.*maximum is 8/);
  assert.throws(() => compileDialogue([nest(9, { say: "deep" })]), /maximum is 8/);
  // mixed with choices/if: battle(1) > choices(2) > if(3) ... 9 deep
  let mixed = { say: "leaf" };
  for (let i = 0; i < 3; i++) mixed = { battle: { troopId: 1, canLose: true, onLose: [{ choices: [{ label: "a", then: [{ if: { switch: 1 }, then: [mixed] }] }] }] } };
  assert.equal(dialogueNodeSchema.safeParse(mixed).success, false); // 3 x 3 + 1 leaf = 10
  assert.throws(() => compileDialogue([mixed]), /maximum is 8/);
  const deepest = compileDialogue([nest(8, { say: "deep" })]).filter((c) => c.code === 101);
  assert.equal(deepest[0].indent, 7);
});

test("battle branches are reachable through the game-flow tree as a whole cutscene", () => {
  const list = valid([
    { fade: "out" },
    { battle: { troopId: 4, canEscape: true, onWin: [{ gold: 200 }, { item: { kind: "item", id: 1, count: 1 } }], onEscape: [{ jump: "end" }] } },
    { shop: { goods: [{ type: "item", id: 1 }], purchaseOnly: true } },
    { label: "end" },
  ]);
  assert.deepEqual(list.map((c) => c.code), [221, 301, 601, 125, 126, 602, 119, 604, 302, 118]);
});

// ------------------------------------------------------------------ rejections

test("ranges and keys of the simple game-flow nodes are enforced", () => {
  const bad = [
    [{ gold: 0 }, /gold must not be 0/],
    [{ gold: 1.5 }, /integer/i],
    [{ gold: 100000000 }, /less than or equal to 99999999/],
    [{ gold: -100000000 }, /greater than or equal to -99999999/],
    [{ item: { kind: "item", id: 1, count: 0 } }, /count must not be 0/],
    [{ item: { kind: "item", id: 1, count: 100 } }, /less than or equal to 99/],
    [{ item: { kind: "item", id: 1, count: -100 } }, /greater than or equal to -99/],
    [{ item: { kind: "key", id: 1, count: 1 } }, /./],
    [{ item: { kind: "item", id: 0, count: 1 } }, /greater than or equal to 1/],
    [{ item: { kind: "item", id: 1 } }, /./],
    [{ item: { kind: "item", id: 1, count: 1, typo: 1 } }, /Unrecognized key/],
    [{ party: { actorId: 0, action: "add" } }, /greater than or equal to 1/],
    [{ party: { actorId: 1, action: "swap" } }, /./],
    [{ party: { actorId: 1, action: "add", initialize: 1 } }, /./],
    [{ learnSkill: { actorId: 1, skillId: 0 } }, /greater than or equal to 1/],
    [{ learnSkill: { actorId: 0, skillId: 1 } }, /greater than or equal to 1/],
    [{ learnSkill: { actorId: 1, skillId: 1, forget: "no" } }, /./],
    [{ recoverAll: false }, /./],
    [{ nameInput: { actorId: 1, maxChars: 0 } }, /greater than or equal to 1/],
    [{ nameInput: { actorId: 1, maxChars: 17 } }, /less than or equal to 16/],
    [{ nameInput: { actorId: 0, maxChars: 8 } }, /greater than or equal to 1/],
    [{ plugin: "" }, /empty/],
    [{ plugin: "Cmd\nSecond" }, /control characters/],
    [{ plugin: "Cmd\u0000" }, /control characters/],
    [{ scene: "options" }, /./],
    [{ callCommon: 0 }, /greater than or equal to 1/],
    [{ callCommon: 1.5 }, /integer/i],
    [{ label: "" }, /empty/],
    [{ label: "a\nb" }, /control characters/],
    [{ jump: "" }, /empty/],
    [{ jump: "a\u0000" }, /control characters/],
    [{ exit: false }, /./],
    [{ exit: 1 }, /./],
    [{ comment: "" }, /empty/],
    [{ comment: [] }, /at least one line/],
    [{ comment: "a\u0000b" }, /control characters/],
    [{ comment: ["ok", "b\u001bc"] }, /control characters/],
  ];
  for (const [node, pattern] of bad) rejected(node, pattern);
});

test("unknown keys are rejected at the node and inside each game-flow object", () => {
  rejected({ gold: 5, typo: 1 });
  rejected({ exit: true, typo: 1 });
  rejected({ scene: "menu", typo: 1 });
  rejected({ party: { actorId: 1, action: "add", typo: 1 } });
  rejected({ learnSkill: { actorId: 1, skillId: 1, typo: 1 } });
  rejected({ nameInput: { actorId: 1, maxChars: 8, typo: 1 } });
  rejected({ shop: { goods: [{ type: "item", id: 1 }], typo: 1 } });
});

test("a failing node leaves no partial output: compileDialogue throws before returning anything", () => {
  const tree = [{ gold: 5 }, { battle: { troopId: 1, onWin: [{ say: "ok" }, { gold: 0 }] } }, { say: "after" }];
  let result;
  assert.throws(() => {
    result = compileDialogue(tree);
  }, /gold must not be 0/);
  assert.equal(result, undefined);
  // no state leaks into the next compile
  assert.deepEqual(compileDialogue([{ gold: 5 }]), [cmd(125, 0, 0, 0, 5)]);
});

// ------------------------------------------------------------------- reference

test("the event command reference documents every command the game-flow nodes emit", () => {
  for (const code of [108, 408, 115, 117, 118, 119, 125, 126, 127, 128, 129, 301, 302, 303, 314, 318, 351, 352, 353, 354, 356, 601, 602, 603, 604, 605]) {
    assert.match(EVENT_COMMAND_REFERENCE, new RegExp(`(^|\\n|, |/| )${code}[ :/,]`), `code ${code}`);
  }
  assert.match(EVENT_COMMAND_REFERENCE, /108 Comment: \["first line"\]/);
  assert.match(EVENT_COMMAND_REFERENCE, /408/);
});

// ------------------------------------------------------------------------ tool

async function withProjectServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-flow-"));
  await fs.mkdir(path.join(dir, "data"));
  const page = { list: [{ code: 0, indent: 0, parameters: [] }] };
  const map = { width: 2, height: 2, data: [], events: [null, { id: 1, name: "NPC", x: 0, y: 0, pages: [page] }] };
  const mapFile = path.join(dir, "data", "Map001.json");
  await fs.writeFile(mapFile, JSON.stringify(map), "utf8");
  const client = new Client({ name: "flow-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, RPGMV_TOOLS: "" }, stderr: "ignore" }),
  );
  try {
    const set = await client.callTool({ name: "set_project", arguments: { path: dir } });
    assert.ok(!set.isError, set.content[0].text);
    await fn(client, { mapFile });
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const tool = async (client, args) => {
  const res = await client.callTool({ name: "build_dialogue_tree", arguments: args });
  return { res, text: res.content[0].text, body: res.isError ? null : JSON.parse(res.content[0].text) };
};

test("build_dialogue_tree writes a battle + shop tree and rejects an unreachable branch without touching the map", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const before = await fs.readFile(mapFile, "utf8");
    const bad = await tool(client, {
      tree: [{ wait: 5 }, { battle: { troopId: 1, onEscape: [{ say: "never" }] } }],
      mapId: 1,
      eventId: 1,
    });
    assert.equal(bad.res.isError, true);
    assert.match(bad.text, /onEscape.*canEscape/);
    assert.equal(await fs.readFile(mapFile, "utf8"), before);

    const ok = await tool(client, {
      tree: [
        { battle: { troopId: 1, canEscape: true, onWin: [{ gold: 50 }], onEscape: [{ say: "Phew" }] } },
        { shop: { goods: [{ type: "item", id: 1 }, { type: "weapon", id: 2, price: 99 }] } },
      ],
      mapId: 1,
      eventId: 1,
    });
    assert.ok(!ok.res.isError, ok.text);
    assert.ok(ok.body.inserted);
    const list = JSON.parse(await fs.readFile(mapFile, "utf8")).events[1].pages[0].list;
    assert.deepEqual(list.map((c) => c.code), [301, 601, 125, 602, 101, 401, 604, 302, 605, 0]);
    assert.deepEqual(validateCommandList(list), []);
  });
});

test("the build_dialogue_tree description lists every node, the move-route vocabulary and the limits", async () => {
  await withProjectServer(async (client) => {
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "build_dialogue_tree").description;
    // Each node must appear in its own section: route steps also contain "{jump:" and "{wait:", so a
    // whole-description substring match would pass even if the flow/presentation node were missing.
    const at = (marker) => {
      const i = description.indexOf(marker);
      assert.ok(i >= 0, `description has no section header ${marker}`);
      return i;
    };
    const [m1, m2, m3] = [at("(1) MESSAGES AND FLOW"), at("(2) CUTSCENE"), at("(3) GAME FLOW")];
    assert.ok(m1 < m2 && m2 < m3);
    const sections = {
      messages: ["say", "choices", "if", "setSwitch", "setVariable", "setSelfSwitch", "transfer", "raw"],
      cutscene: ["wait", "fade", "tint", "flash", "shake", "weather", "playAudio", "fadeAudio", "showPicture", "erasePicture", "animation", "balloon", "moveRoute"],
      flow: ["battle", "shop", "callCommon", "label", "jump", "exit", "comment", "gold", "item", "party", "learnSkill", "recoverAll", "nameInput", "plugin", "scene"],
    };
    const bodies = { messages: description.slice(m1, m2), cutscene: description.slice(m2, m3), flow: description.slice(m3) };
    for (const [group, keys] of Object.entries(sections)) {
      for (const key of keys) assert.ok(bodies[group].includes(`{${key}:`), `${group} section does not mention {${key}: ...}`);
    }
    // The forms only the node entries use, not the route steps {jump: {x, y}} / {wait: 1-999}.
    assert.ok(bodies.cutscene.includes("{wait: 1-6000}"), "cutscene {wait: 1-6000}");
    assert.ok(bodies.flow.includes("{jump: label name}"), "flow {jump: label name}");
    assert.ok(bodies.flow.includes("{label: name}"), "flow {label: name}");
    for (const step of ["down", "turnUp", "walkAnimOn", "stepAnimOff", "dirFixOn", "throughOff", "transparentOn", "switchOn", "switchOff", "speed", "frequency"]) {
      assert.ok(description.includes(step), `route step ${step}`);
    }
    assert.match(description, /8 levels/);
    assert.match(description, /repeat: true.*wait defaults to false.*wait: true is rejected/);
    assert.match(description, /needs canEscape: true/);
    assert.match(description, /needs canLose: true/);
    const index = tools.find((t) => t.name === "build_dialogue_tree").inputSchema.properties.index.description;
    assert.match(index, /505/);
    assert.match(index, /601/);
  });
});
