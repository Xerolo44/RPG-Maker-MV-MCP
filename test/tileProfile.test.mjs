import assert from "node:assert/strict";
import test from "node:test";
import { profileProblems, suggestTileProfile, tileProfileSchema } from "../dist/tileProfile.js";

const BLOCKED = 0x0f;
const kindId = (kind) => 2048 + kind * 48;

// Synthetic tileset: A2, A4, A5 and B have images; A1, A3 and C-E are empty.
function makeTileset({ names = {}, blocked = [] } = {}) {
  const flags = new Array(8192).fill(0);
  for (const id of blocked) flags[id] = BLOCKED;
  const tilesetNames = ["", "T_A2", "", "T_A4", "T_A5", "T_B", "", "", ""];
  const index = { A1: 0, A2: 1, A3: 2, A4: 3, A5: 4, B: 5, C: 6, D: 7, E: 8 };
  for (const [sheet, name] of Object.entries(names)) tilesetNames[index[sheet]] = name;
  return { id: 1, name: "Synthetic", mode: 0, note: "", flags, tilesetNames };
}

test("suggests the first passable A2 kind as floor", () => {
  const { profile } = suggestTileProfile(makeTileset({ blocked: [kindId(16), kindId(89)] }));
  assert.deepEqual(profile.floor, { sheet: "A2", kind: 17 });
});

test("suggests an impassable A4 wall-table kind as wall", () => {
  // Kind 80 is impassable but drawn with the floor rule (a wall top); 88 uses the wall rule but is passable.
  const { profile } = suggestTileProfile(makeTileset({ blocked: [kindId(80), kindId(89)] }));
  assert.deepEqual(profile.wall, { sheet: "A4", kind: 89 });
  assert.deepEqual(profile.wallTop, { sheet: "A4", kind: 81 });
});

test("pairs every A4 wall-side kind with the wall-top kind drawn above it", () => {
  // A4 rows of 8 kinds alternate wall tops (80-87, 96-103, 112-119) and wall sides (88-95, 104-111, 120-127).
  for (const row of [88, 104, 120]) {
    for (let kind = row; kind < row + 8; kind++) {
      const { profile } = suggestTileProfile(makeTileset({ blocked: [kindId(kind)] }));
      assert.deepEqual(profile.wall, { sheet: "A4", kind });
      assert.deepEqual(profile.wallTop, { sheet: "A4", kind: kind - 8 });
    }
  }
});

test("falls back to A5 when A2 has no image", () => {
  const { profile, notes } = suggestTileProfile(
    makeTileset({ names: { A2: "" }, blocked: [1536, kindId(89)] })
  );
  assert.deepEqual(profile.floor, { sheet: "A5", index: 1 });
  assert.ok(notes.some((n) => n.startsWith("floor:") && n.includes("A2 has no image")), notes.join("\n"));
});

test("falls back to an impassable A5/B tile for wall and leaves wallTop unset", () => {
  const { profile, notes } = suggestTileProfile(
    makeTileset({ names: { A4: "" }, blocked: [1536 + 3, 5] })
  );
  assert.deepEqual(profile.wall, { sheet: "A5", index: 3 });
  assert.equal(profile.wallTop, undefined);
  assert.ok(notes.some((n) => n.startsWith("wallTop:") && n.includes("not set")), notes.join("\n"));
});

test("throws when no floor tile can be found", () => {
  assert.throws(
    () => suggestTileProfile(makeTileset({ names: { A2: "", A5: "" }, blocked: [kindId(89)] })),
    /floor/
  );
});

test("notes explain each pick", () => {
  const { notes } = suggestTileProfile(makeTileset({ blocked: [kindId(16), kindId(89)] }));
  const line = (role) => notes.find((n) => n.startsWith(`${role}:`)) ?? "";
  assert.match(line("floor"), /A2 kind 17/);
  assert.match(line("floor"), /passable/);
  assert.match(line("wall"), /A4 kind 89/);
  assert.match(line("wall"), /impassable/);
  assert.match(line("wallTop"), /A4 kind 81/);
  assert.match(line("decor"), /not suggested/);
  assert.ok(!notes.some((n) => /RTP/.test(n)));
});

test("a suggested profile has no problems", () => {
  const tileset = makeTileset({ blocked: [kindId(89)] });
  assert.deepEqual(profileProblems(suggestTileProfile(tileset).profile, tileset), []);
});

test("profileProblems flags a passable wall", () => {
  const problems = profileProblems(
    { floor: { sheet: "A2", kind: 16 }, wall: { sheet: "A4", kind: 88 } },
    makeTileset()
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /wall/);
  assert.match(problems[0], /passable/);
});

test("profileProblems flags an impassable floor", () => {
  const problems = profileProblems(
    { floor: { sheet: "A2", kind: 16 }, wall: { sheet: "A4", kind: 89 } },
    makeTileset({ blocked: [kindId(16), kindId(89)] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /floor/);
  assert.match(problems[0], /impassable/);
});

test("profileProblems flags a sheet without an image", () => {
  const problems = profileProblems(
    {
      floor: { sheet: "A2", kind: 16 },
      wall: { sheet: "A4", kind: 89 },
      decor: [{ tile: { sheet: "C", index: 4 }, weight: 1 }],
    },
    makeTileset({ blocked: [kindId(89)] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /decor/);
  assert.match(problems[0], /sheet C/);
  assert.match(problems[0], /no image/);
});

test("profileProblems reports a tile spec that does not resolve", () => {
  const problems = profileProblems(
    { floor: { sheet: "A2", kind: 3 }, wall: { sheet: "A4", kind: 89 } },
    makeTileset({ blocked: [kindId(89)] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /floor/);
  assert.match(problems[0], /valid kinds/);
});

test("tileProfileSchema rejects a profile missing floor", () => {
  assert.equal(tileProfileSchema.safeParse({ wall: { sheet: "A4", kind: 89 } }).success, false);
  assert.equal(
    tileProfileSchema.safeParse({ floor: { sheet: "A2", kind: 16 }, wall: { sheet: "A4", kind: 89 } }).success,
    true
  );
});

test("tileProfileSchema requires positive decor weights", () => {
  const base = { floor: { sheet: "A2", kind: 16 }, wall: 1600 };
  assert.equal(tileProfileSchema.safeParse({ ...base, decor: [{ tile: { sheet: "B", index: 3 }, weight: 0 }] }).success, false);
  assert.equal(tileProfileSchema.safeParse({ ...base, decor: [{ tile: { sheet: "B", index: 3 }, weight: 2 }] }).success, true);
});
