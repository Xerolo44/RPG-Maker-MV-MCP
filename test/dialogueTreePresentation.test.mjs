import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cmd, terminated, validateCommandList } from "../dist/commandList.js";
import { compileDialogue, dialogueNodeSchema, resolveTarget } from "../dist/dialogueTree.js";
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
const rc = (code, ...parameters) => ({ code, parameters, indent: null });

// ------------------------------------------------------- defaults, one per node

test("wait and fade compile to 230 / 221 / 222", () => {
  assert.deepEqual(compiled({ wait: 30 }), [cmd(230, 0, 30)]);
  assert.deepEqual(compiled({ fade: "out" }), [cmd(221, 0)]);
  assert.deepEqual(compiled({ fade: "in" }), [cmd(222, 0)]);
});

test("tint, flash and shake apply their defaults", () => {
  assert.deepEqual(compiled({ tint: { r: -68, g: -68, b: 0, gray: 68 } }), [cmd(223, 0, [-68, -68, 0, 68], 60, true)]);
  assert.deepEqual(compiled({ flash: { r: 255, g: 255, b: 255, intensity: 170 } }), [cmd(224, 0, [255, 255, 255, 170], 60, true)]);
  assert.deepEqual(compiled({ shake: {} }), [cmd(225, 0, 5, 5, 30, true)]);
});

test("weather defaults to power 5, 60 frames and no wait", () => {
  assert.deepEqual(compiled({ weather: { type: "rain" } }), [cmd(236, 0, "rain", 5, 60, false)]);
  assert.deepEqual(compiled({ weather: { type: "none" } }), [cmd(236, 0, "none", 5, 60, false)]);
});

test("playAudio defaults and the four kinds", () => {
  const sound = (name) => ({ name, volume: 90, pitch: 100, pan: 0 });
  assert.deepEqual(compiled({ playAudio: { kind: "bgm", name: "Theme1" } }), [cmd(241, 0, sound("Theme1"))]);
  assert.deepEqual(compiled({ playAudio: { kind: "bgs", name: "Rain" } }), [cmd(245, 0, sound("Rain"))]);
  assert.deepEqual(compiled({ playAudio: { kind: "me", name: "Victory1" } }), [cmd(249, 0, sound("Victory1"))]);
  assert.deepEqual(compiled({ playAudio: { kind: "se", name: "Cursor1" } }), [cmd(250, 0, sound("Cursor1"))]);
});

test('playAudio name "" is allowed (stops the channel) for every kind', () => {
  for (const [kind, code] of [["bgm", 241], ["bgs", 245], ["me", 249], ["se", 250]]) {
    assert.deepEqual(compiled({ playAudio: { kind, name: "" } }), [cmd(code, 0, { name: "", volume: 90, pitch: 100, pan: 0 })]);
  }
});

test("fadeAudio maps bgm to 242 and bgs to 246", () => {
  assert.deepEqual(compiled({ fadeAudio: { kind: "bgm", seconds: 3 } }), [cmd(242, 0, 3)]);
  assert.deepEqual(compiled({ fadeAudio: { kind: "bgs", seconds: 10 } }), [cmd(246, 0, 10)]);
});

test("showPicture defaults and erasePicture", () => {
  assert.deepEqual(compiled({ showPicture: { id: 1, name: "Face", x: 10, y: 20 } }), [
    cmd(231, 0, 1, "Face", 0, 0, 10, 20, 100, 100, 255, 0),
  ]);
  assert.deepEqual(compiled({ erasePicture: 1 }), [cmd(235, 0, 1)]);
});

test("animation and balloon default to wait and resolve player / this / event id", () => {
  assert.deepEqual(compiled({ animation: { target: "player", animationId: 5 } }), [cmd(212, 0, -1, 5, true)]);
  assert.deepEqual(compiled({ animation: { target: "this", animationId: 5 } }), [cmd(212, 0, 0, 5, true)]);
  assert.deepEqual(compiled({ animation: { target: 7, animationId: 5 } }), [cmd(212, 0, 7, 5, true)]);
  assert.deepEqual(compiled({ balloon: { target: "player", balloonId: 1 } }), [cmd(213, 0, -1, 1, true)]);
  assert.deepEqual(compiled({ balloon: { target: "this", balloonId: 10 } }), [cmd(213, 0, 0, 10, true)]);
  assert.deepEqual(compiled({ balloon: { target: 7, balloonId: 3 } }), [cmd(213, 0, 7, 3, true)]);
});

test("resolveTarget maps player / this / ids and refuses anything else", () => {
  assert.equal(resolveTarget("player"), -1);
  assert.equal(resolveTarget("this"), 0);
  assert.equal(resolveTarget(12), 12);
  for (const bad of [0, -1, 1.5, "npc", NaN, null, undefined]) assert.throws(() => resolveTarget(bad), /target/);
});

// ----------------------------------------------------- every optional field set

test("every optional field set", () => {
  assert.deepEqual(compiled({ tint: { r: 255, g: -255, b: 12, gray: 255, frames: 600, wait: false } }), [
    cmd(223, 0, [255, -255, 12, 255], 600, false),
  ]);
  assert.deepEqual(compiled({ flash: { r: 0, g: 10, b: 20, intensity: 0, frames: 1, wait: false } }), [cmd(224, 0, [0, 10, 20, 0], 1, false)]);
  assert.deepEqual(compiled({ shake: { power: 9, speed: 1, frames: 100, wait: false } }), [cmd(225, 0, 9, 1, 100, false)]);
  assert.deepEqual(compiled({ weather: { type: "storm", power: 9, frames: 600, wait: true } }), [cmd(236, 0, "storm", 9, 600, true)]);
  assert.deepEqual(compiled({ playAudio: { kind: "se", name: "Bell", volume: 0, pitch: 150, pan: -100 } }), [
    cmd(250, 0, { name: "Bell", volume: 0, pitch: 150, pan: -100 }),
  ]);
  assert.deepEqual(
    compiled({ showPicture: { id: 100, name: "Sky", origin: "center", x: -5, y: 300, scaleX: 50, scaleY: 200, opacity: 0, blend: "screen" } }),
    [cmd(231, 0, 100, "Sky", 1, 0, -5, 300, 50, 200, 0, 3)],
  );
  assert.deepEqual(compiled({ animation: { target: 3, animationId: 9, wait: false } }), [cmd(212, 0, 3, 9, false)]);
  assert.deepEqual(compiled({ balloon: { target: "this", balloonId: 4, wait: false } }), [cmd(213, 0, 0, 4, false)]);
});

test("showPicture blend maps normal/add/multiply/screen to 0-3 and origin to 0/1", () => {
  const blend = (b) => compiled({ showPicture: { id: 2, name: "P", x: 0, y: 0, blend: b } })[0].parameters[9];
  assert.deepEqual(["normal", "add", "multiply", "screen"].map(blend), [0, 1, 2, 3]);
  const origin = (o) => compiled({ showPicture: { id: 2, name: "P", x: 0, y: 0, origin: o } })[0].parameters[2];
  assert.deepEqual(["upperLeft", "center"].map(origin), [0, 1]);
});

test("weather accepts all four types", () => {
  for (const type of ["none", "rain", "storm", "snow"]) assert.equal(compiled({ weather: { type } })[0].parameters[0], type);
});

// --------------------------------------------------------------- move routes

test("moveRoute compiles to a 205 with a route object and one 505 per step; the terminator is only in list", () => {
  const list = compiled({ moveRoute: { target: "player", steps: ["down", "left", { wait: 20 }] } });
  const steps = [rc(1), rc(2), rc(15, 20)];
  assert.deepEqual(list, [
    cmd(205, 0, -1, { list: [...steps, { code: 0, parameters: [] }], repeat: false, skippable: false, wait: true }),
    cmd(505, 0, steps[0]),
    cmd(505, 0, steps[1]),
    cmd(505, 0, steps[2]),
  ]);
  assert.equal(list.length, 4); // no 505 for the terminator
  assert.ok(!list.some((c) => c.code === 0));
});

test("moveRoute maps every step to its route command code", () => {
  const strings = {
    down: 1, left: 2, right: 3, up: 4,
    turnDown: 16, turnLeft: 17, turnRight: 18, turnUp: 19,
    walkAnimOn: 31, walkAnimOff: 32, stepAnimOn: 33, stepAnimOff: 34,
    dirFixOn: 35, dirFixOff: 36, throughOn: 37, throughOff: 38, transparentOn: 39, transparentOff: 40,
  };
  const steps = [
    ...Object.keys(strings),
    { jump: { x: -2, y: 3 } },
    { wait: 15 },
    { switchOn: 4 },
    { switchOff: 5 },
    { speed: 6 },
    { frequency: 1 },
  ];
  const expected = [
    ...Object.values(strings).map((code) => rc(code)),
    rc(14, -2, 3),
    rc(15, 15),
    rc(27, 4),
    rc(28, 5),
    rc(29, 6),
    rc(30, 1),
  ];
  const list = compiled({ moveRoute: { target: 2, steps } });
  assert.deepEqual(list[0].parameters[0], 2);
  assert.deepEqual(list[0].parameters[1].list, [...expected, { code: 0, parameters: [] }]);
  assert.deepEqual(list.slice(1), expected.map((e) => cmd(505, 0, e)));
});

test("moveRoute options and target resolution", () => {
  const list = compiled({ moveRoute: { target: "this", steps: ["up"], repeat: true, skippable: true, wait: false } });
  assert.deepEqual(list[0], cmd(205, 0, 0, { list: [rc(4), { code: 0, parameters: [] }], repeat: true, skippable: true, wait: false }));
});

/** Every object/array reachable from `value`; fails if the same one is reachable twice (aliasing). */
const assertNoSharedObjects = (value, label) => {
  const seen = new Set();
  const walk = (v) => {
    if (v === null || typeof v !== "object") return;
    assert.ok(!seen.has(v), `${label}: the same object is referenced twice: ${JSON.stringify(v)}`);
    seen.add(v);
    for (const child of Object.values(v)) walk(child);
  };
  walk(value);
  return seen.size;
};

test("moveRoute route commands are independent objects (list rows are not aliased to the 505 rows)", () => {
  const list = compiled({ moveRoute: { target: "this", steps: ["up"] } });
  assert.notStrictEqual(list[0].parameters[1].list[0], list[1].parameters[0]);
  assert.notStrictEqual(list[0].parameters[1].list[0].parameters, list[1].parameters[0].parameters);
});

test("moveRoute output shares no objects: repeated identical steps and two identical moveRoute nodes", () => {
  const route = { moveRoute: { target: "this", steps: ["down", "down", { wait: 5 }, { wait: 5 }, { jump: { x: 1, y: 1 } }, { jump: { x: 1, y: 1 } }] } };
  const single = compiled(route);
  assert.ok(assertNoSharedObjects(single, "one route") > 20);
  const twice = valid([route, structuredClone(route)]);
  assertNoSharedObjects(twice, "two distinct nodes");
  // the SAME node object listed twice must not alias either
  const same = valid([route, route]);
  assertNoSharedObjects(same, "one node object used twice");
  assert.deepEqual(same.slice(0, single.length), single);
  assert.deepEqual(same.slice(single.length), single);

  // mutating one output object must not change any other
  const snapshot = JSON.stringify(same);
  const firstRow = same[1].parameters[0];
  firstRow.code = 99;
  firstRow.parameters.push("x");
  same[0].parameters[1].list[1].code = 98;
  same[0].parameters[1].list[2].parameters[0] = 77;
  same[single.length].parameters[1].repeat = true;
  const after = JSON.parse(JSON.stringify(same));
  const expected = JSON.parse(snapshot);
  expected[1].parameters[0].code = 99;
  expected[1].parameters[0].parameters.push("x");
  expected[0].parameters[1].list[1].code = 98;
  expected[0].parameters[1].list[2].parameters[0] = 77;
  expected[single.length].parameters[1].repeat = true;
  assert.deepEqual(after, expected);
  // and the compiler's input is untouched
  assert.deepEqual(route.moveRoute.steps, ["down", "down", { wait: 5 }, { wait: 5 }, { jump: { x: 1, y: 1 } }, { jump: { x: 1, y: 1 } }]);
  // a later compile is unaffected by the mutations
  assert.deepEqual(compiled(route), single);
});

test("a moveRoute nested in a choice body is indented with its 505 rows", () => {
  const list = valid([
    { choices: [{ label: "Go", then: [{ moveRoute: { target: "player", steps: ["up", { jump: { x: 0, y: -1 } }] } }] }] },
  ]);
  assert.deepEqual(
    list.map((c) => [c.code, c.indent]),
    [[102, 0], [402, 0], [205, 1], [505, 1], [505, 1], [0, 1], [404, 0]],
  );
  assert.deepEqual(list[3].parameters, [rc(4)]);
});

test("a full cutscene passes validateCommandList and mixes with 0.4 nodes", () => {
  const list = valid([
    { fade: "out" },
    { wait: 30 },
    { showPicture: { id: 1, name: "Bg", x: 0, y: 0 } },
    { playAudio: { kind: "bgm", name: "Theme1" } },
    { moveRoute: { target: "this", steps: ["down", "down"] } },
    { say: "Hello" },
    { fade: "in" },
  ]);
  assert.deepEqual(
    list.map((c) => c.code),
    [221, 230, 231, 241, 205, 505, 505, 101, 401, 222],
  );
});

// ---------------------------------------------------------------- rejections

test("moveRoute with 0 or 101 steps is rejected, 1 and 100 are fine", () => {
  rejected({ moveRoute: { target: "this", steps: [] } }, /at least 1 step/);
  rejected({ moveRoute: { target: "this", steps: Array(101).fill("down") } }, /at most 100 steps/);
  accepted({ moveRoute: { target: "this", steps: ["down"] } });
  accepted({ moveRoute: { target: "this", steps: Array(100).fill("down") } });
  assert.equal(compileDialogue([{ moveRoute: { target: "this", steps: Array(100).fill("down") } }]).length, 101);
});

test("moveRoute rejects an unknown step name with a message that lists the vocabulary", () => {
  const text = rejected({ moveRoute: { target: "this", steps: ["down", "dance"] } }, /Invalid move route step/);
  assert.match(text, /turnDown/);
  rejected({ moveRoute: { target: "this", steps: [{ fly: 1 }] } }, /Invalid move route step/);
  rejected({ moveRoute: { target: "this", steps: [{ jump: { x: 1, y: 1 }, wait: 2 }] } }, /Unrecognized key/);
  rejected({ moveRoute: { target: "this", steps: [42] } }, /Invalid move route step/);
});

test("moveRoute rejects non-integer jump coordinates, speed 7 and other out-of-range step values", () => {
  rejected({ moveRoute: { target: "this", steps: [{ jump: { x: 1.5, y: 0 } }] } }, /integer/i);
  rejected({ moveRoute: { target: "this", steps: [{ jump: { x: 0, y: "1" } }] } }, /./);
  rejected({ moveRoute: { target: "this", steps: [{ jump: { x: 0 } }] } }, /./);
  rejected({ moveRoute: { target: "this", steps: [{ speed: 7 }] } }, /less than or equal to 6/);
  rejected({ moveRoute: { target: "this", steps: [{ speed: 0 }] } }, /greater than or equal to 1/);
  rejected({ moveRoute: { target: "this", steps: [{ frequency: 6 }] } }, /less than or equal to 5/);
  rejected({ moveRoute: { target: "this", steps: [{ wait: 0 }] } }, /greater than or equal to 1/);
  rejected({ moveRoute: { target: "this", steps: [{ switchOn: 0 }] } }, /greater than or equal to 1/);
  accepted({ moveRoute: { target: "this", steps: [{ speed: 6 }, { speed: 1 }, { frequency: 5 }, { jump: { x: -3, y: 0 } }] } });
});

test("a rejected moveRoute produces no partial output, even when the invalid node comes after valid siblings", () => {
  const tree = [{ wait: 5 }, { say: "before" }, { moveRoute: { target: "this", steps: ["down", { speed: 7 }] } }, { say: "after" }];
  // a valid wait is followed by an invalid moveRoute: compile throws and returns nothing at all
  let result;
  assert.throws(() => {
    result = compileDialogue(tree);
  }, /speed/);
  assert.equal(result, undefined);
  // the same tree without the bad node is fine, so the earlier siblings were valid on their own
  assert.deepEqual(
    compileDialogue([tree[0], tree[1], tree[3]]).map((c) => c.code),
    [230, 101, 401, 101, 401],
  );
  // a failing node nested in a choice body (after a valid sibling there) fails the whole tree too
  let nested;
  assert.throws(() => {
    nested = compileDialogue([{ choices: [{ label: "Go", then: [{ wait: 5 }, { moveRoute: { target: "this", steps: [] } }] }] }]);
  }, /at least 1 step/);
  assert.equal(nested, undefined);
});

test("a moveRoute with repeat: true defaults wait to false; repeat: false (or unset) keeps wait true", () => {
  const params = (m) => compiled({ moveRoute: { target: "this", steps: ["up"], ...m } })[0].parameters[1];
  assert.equal(params({ repeat: true }).wait, false);
  assert.equal(params({ repeat: true }).repeat, true);
  assert.equal(params({ repeat: true, wait: false }).wait, false);
  assert.equal(params({}).wait, true);
  assert.equal(params({ repeat: false }).wait, true);
  assert.equal(params({ repeat: false, wait: false }).wait, false);
  assert.equal(params({ repeat: false, wait: true }).wait, true);
});

test("an explicit repeat: true together with wait: true is rejected with a clear message", () => {
  const message = /a repeating route never finishes, so the event cannot wait for it/;
  rejected({ moveRoute: { target: "this", steps: ["up"], repeat: true, wait: true } }, message);
  accepted({ moveRoute: { target: "this", steps: ["up"], repeat: true } });
  accepted({ moveRoute: { target: "this", steps: ["up"], repeat: true, wait: false } });
  accepted({ moveRoute: { target: "this", steps: ["up"], repeat: false, wait: true } });
  assert.throws(() => compileDialogue([{ moveRoute: { target: "this", steps: ["up"], repeat: true, wait: true } }]), /Invalid moveRoute node: moveRoute\.wait: a repeating route/);
});

test("jump coordinates are capped to -1000..1000", () => {
  const jump = (x, y) => ({ moveRoute: { target: "this", steps: [{ jump: { x, y } }] } });
  accepted(jump(1000, -1000));
  accepted(jump(-1000, 1000));
  assert.deepEqual(compiled(jump(-1000, 1000))[1].parameters, [rc(14, -1000, 1000)]);
  rejected(jump(1001, 0), /less than or equal to 1000/);
  rejected(jump(0, -1001), /greater than or equal to -1000/);
  rejected(jump(-1001, 0), /greater than or equal to -1000/);
  rejected(jump(0, 1001), /less than or equal to 1000/);
  rejected(jump(Number.MAX_SAFE_INTEGER, 0), /less than or equal to 1000/);
});

test("moveRoute rejects bad targets, extra keys and non-boolean options", () => {
  rejected({ moveRoute: { target: 0, steps: ["down"] } }, /target/);
  rejected({ moveRoute: { target: "npc", steps: ["down"] } }, /target/);
  rejected({ moveRoute: { target: 1.5, steps: ["down"] } }, /target|integer/i);
  rejected({ moveRoute: { target: "this" } });
  rejected({ moveRoute: { target: "this", steps: ["down"], speed: 3 } });
  rejected({ moveRoute: { target: "this", steps: ["down"], repeat: "yes" } });
});

test("playAudio rejects names with newlines, NUL or other control characters", () => {
  for (const name of ["a\nb", "a\rb", "a\u0000b", "\t", "\u001b[0m", "x\u007f"]) {
    rejected({ playAudio: { kind: "bgm", name } }, /control characters/);
  }
  accepted({ playAudio: { kind: "bgm", name: "Dungeon 1" } });
  accepted({ playAudio: { kind: "bgm", name: "Théâtre" } });
});

test("showPicture name follows the same control-character rule and must not be empty", () => {
  rejected({ showPicture: { id: 1, name: "a\nb", x: 0, y: 0 } }, /control characters/);
  rejected({ showPicture: { id: 1, name: "a\u0000", x: 0, y: 0 } }, /control characters/);
  rejected({ showPicture: { id: 1, name: "", x: 0, y: 0 } }, /name/);
});

test("ranges from the vocabulary table are enforced", () => {
  const bad = [
    [{ wait: 0 }, /greater than or equal to 1/],
    [{ wait: 6001 }, /less than or equal to 6000/],
    [{ wait: 1.5 }, /integer/i],
    [{ fade: "sideways" }, /./],
    [{ tint: { r: 256, g: 0, b: 0, gray: 0 } }, /less than or equal to 255/],
    [{ tint: { r: -256, g: 0, b: 0, gray: 0 } }, /greater than or equal to -255/],
    [{ tint: { r: 0, g: 0, b: 0, gray: 256 } }, /less than or equal to 255/],
    [{ tint: { r: 0, g: 0, b: 0, gray: -1 } }, /greater than or equal to 0/],
    [{ tint: { r: 0, g: 0, b: 0, gray: 0, frames: 0 } }, /greater than or equal to 1/],
    [{ tint: { r: 0, g: 0, b: 0, gray: 0, frames: 601 } }, /less than or equal to 600/],
    [{ tint: { r: 0, g: 0, b: 0 } }, /./],
    [{ flash: { r: -1, g: 0, b: 0, intensity: 0 } }, /greater than or equal to 0/],
    [{ flash: { r: 0, g: 0, b: 0, intensity: 256 } }, /less than or equal to 255/],
    [{ shake: { power: 0 } }, /greater than or equal to 1/],
    [{ shake: { speed: 10 } }, /less than or equal to 9/],
    [{ shake: { frames: 0 } }, /greater than or equal to 1/],
    [{ weather: { type: "fog" } }, /./],
    [{ weather: { type: "rain", power: 10 } }, /less than or equal to 9/],
    [{ playAudio: { kind: "voice", name: "x" } }, /./],
    [{ playAudio: { kind: "bgm", name: "x", volume: 101 } }, /less than or equal to 100/],
    [{ playAudio: { kind: "bgm", name: "x", pitch: 49 } }, /greater than or equal to 50/],
    [{ playAudio: { kind: "bgm", name: "x", pan: 101 } }, /less than or equal to 100/],
    [{ playAudio: { kind: "bgm" } }, /./],
    [{ fadeAudio: { kind: "me", seconds: 3 } }, /./],
    [{ fadeAudio: { kind: "bgm", seconds: 0 } }, /greater than or equal to 1/],
    [{ fadeAudio: { kind: "bgs", seconds: 61 } }, /less than or equal to 60/],
    [{ showPicture: { id: 0, name: "P", x: 0, y: 0 } }, /greater than or equal to 1/],
    [{ showPicture: { id: 101, name: "P", x: 0, y: 0 } }, /less than or equal to 100/],
    [{ showPicture: { id: 1, name: "P", x: 0.5, y: 0 } }, /integer/i],
    [{ showPicture: { id: 1, name: "P", x: 0, y: 0, origin: "left" } }, /./],
    [{ showPicture: { id: 1, name: "P", x: 0, y: 0, blend: "burn" } }, /./],
    [{ showPicture: { id: 1, name: "P", x: 0, y: 0, opacity: 256 } }, /less than or equal to 255/],
    [{ showPicture: { id: 1, name: "P", x: 0, y: 0, scaleX: -1 } }, /greater than or equal to 0/],
    [{ erasePicture: 0 }, /greater than or equal to 1/],
    [{ erasePicture: 101 }, /less than or equal to 100/],
    [{ animation: { target: "player", animationId: 0 } }, /greater than or equal to 1/],
    [{ animation: { target: -1, animationId: 1 } }, /target/],
    [{ balloon: { target: "this", balloonId: 0 } }, /greater than or equal to 1/],
    [{ balloon: { target: "this", balloonId: 11 } }, /less than or equal to 10/],
  ];
  for (const [node, pattern] of bad) rejected(node, pattern);
});

test("unknown keys are still rejected, at the node and inside each presentation object", () => {
  rejected({ wait: 30, typo: 1 });
  rejected({ fade: "in", wait: 30 });
  rejected({ tint: { r: 0, g: 0, b: 0, gray: 0, typo: 1 } });
  rejected({ flash: { r: 0, g: 0, b: 0, intensity: 0, typo: 1 } });
  rejected({ shake: { typo: 1 } });
  rejected({ weather: { type: "rain", typo: 1 } });
  rejected({ playAudio: { kind: "bgm", name: "x", typo: 1 } });
  rejected({ fadeAudio: { kind: "bgm", seconds: 2, typo: 1 } });
  rejected({ showPicture: { id: 1, name: "P", x: 0, y: 0, typo: 1 } });
  rejected({ animation: { target: "this", animationId: 1, typo: 1 } });
  rejected({ balloon: { target: "this", balloonId: 1, typo: 1 } });
  rejected({ moveRoute: { target: "this", steps: ["down"], typo: 1 } });
});

test("presentation nodes count towards nesting; depth 9 is still rejected and depth 8 accepted", () => {
  const nest = (levels, leaf) => {
    let node = leaf;
    for (let i = 1; i < levels; i++) node = { if: { switch: 1 }, then: [node] };
    return node;
  };
  const leaf = { moveRoute: { target: "this", steps: ["down"] } };
  accepted(nest(8, leaf));
  const bad = dialogueNodeSchema.safeParse(nest(9, leaf));
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error.issues), /nested 9 levels deep.*maximum is 8/);
  assert.throws(() => compileDialogue([nest(9, { wait: 5 })]), /maximum is 8/);
  assert.deepEqual(
    compileDialogue([nest(8, { fade: "out" })]).map((c) => c.indent),
    [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0],
  );
});

test("the event command reference documents every command the presentation nodes emit", () => {
  for (const code of [205, 212, 213, 223, 224, 225, 231, 235, 236, 242, 246, 505]) {
    assert.match(EVENT_COMMAND_REFERENCE, new RegExp(`(^|\\n|, |/| )${code}[ :/]`), `code ${code}`);
  }
  assert.match(EVENT_COMMAND_REFERENCE, /236 Set Weather Effect: \["none"\|"rain"\|"storm"\|"snow"/);
  assert.match(EVENT_COMMAND_REFERENCE, /246 Fadeout BGS: \[seconds\]/);
  assert.match(EVENT_COMMAND_REFERENCE, /\{list: \[routeCommand/);
});

// ------------------------------------------------------------------ tool

async function withProjectServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-present-"));
  await fs.mkdir(path.join(dir, "data"));
  const page = { list: [{ code: 0, indent: 0, parameters: [] }] };
  const map = { width: 2, height: 2, data: [], events: [null, { id: 1, name: "NPC", x: 0, y: 0, pages: [page] }] };
  const mapFile = path.join(dir, "data", "Map001.json");
  await fs.writeFile(mapFile, JSON.stringify(map), "utf8");
  const client = new Client({ name: "presentation-test", version: "0.0.0" });
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

test("build_dialogue_tree writes a presentation tree and rejects a bad move route without touching the map", async () => {
  await withProjectServer(async (client, { mapFile }) => {
    const before = await fs.readFile(mapFile, "utf8");
    const bad = await client.callTool({
      name: "build_dialogue_tree",
      arguments: { tree: [{ wait: 5 }, { moveRoute: { target: "this", steps: ["down", { speed: 7 }] } }], mapId: 1, eventId: 1 },
    });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /less than or equal to 6/);
    const unknown = await client.callTool({
      name: "build_dialogue_tree",
      arguments: { tree: [{ moveRoute: { target: "this", steps: ["dance"] } }], mapId: 1, eventId: 1 },
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Invalid move route step/);
    assert.equal(await fs.readFile(mapFile, "utf8"), before);

    const ok = await client.callTool({
      name: "build_dialogue_tree",
      arguments: {
        tree: [
          { fade: "out" },
          { playAudio: { kind: "bgm", name: "" } },
          { moveRoute: { target: "player", steps: ["up", "up"] } },
          { fade: "in" },
        ],
        mapId: 1,
        eventId: 1,
      },
    });
    assert.ok(!ok.isError, ok.content[0].text);
    const list = JSON.parse(await fs.readFile(mapFile, "utf8")).events[1].pages[0].list;
    assert.deepEqual(
      list.map((c) => c.code),
      [221, 241, 205, 505, 505, 222, 0],
    );
    assert.deepEqual(validateCommandList(list), []);
  });
});
