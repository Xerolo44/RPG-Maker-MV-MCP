import assert from "node:assert/strict";
import test from "node:test";
import { profileProblems, suggestTileProfile, tileProfileSchema } from "../dist/tileProfile.js";

const BLOCKED = 0x0f;
const kindId = (kind) => 2048 + kind * 48;

// Synthetic tileset: A2, A4, A5 and B have images; A1, A3 and C-E are empty.
// `blocked` ids get flag 0x0f; `flagged` sets other flag values as [id, flag] pairs.
function makeTileset({ names = {}, blocked = [], flagged = [] } = {}) {
  const flags = new Array(8192).fill(0);
  for (const id of blocked) flags[id] = BLOCKED;
  for (const [id, flag] of flagged) flags[id] = flag;
  const tilesetNames = ["", "T_A2", "", "T_A4", "T_A5", "T_B", "", "", ""];
  const index = { A1: 0, A2: 1, A3: 2, A4: 3, A5: 4, B: 5, C: 6, D: 7, E: 8 };
  for (const [sheet, name] of Object.entries(names)) tilesetNames[index[sheet]] = name;
  return { id: 1, name: "Synthetic", mode: 0, note: "", flags, tilesetNames };
}

// Wall kind 89 with its wall top 81, both blocking.
const WALL_89 = [kindId(81), kindId(89)];

test("suggests the first passable A2 kind as floor", () => {
  const { profile } = suggestTileProfile(makeTileset({ blocked: [kindId(16), ...WALL_89] }));
  assert.deepEqual(profile.floor, { sheet: "A2", kind: 17 });
});

test("skips a partly blocked A2 kind as floor", () => {
  const { profile } = suggestTileProfile(makeTileset({ blocked: WALL_89, flagged: [[kindId(16), 0x01]] }));
  assert.deepEqual(profile.floor, { sheet: "A2", kind: 17 });
});

test("suggests an impassable A4 wall-table kind as wall", () => {
  // Kind 80 is impassable but drawn with the floor rule (a wall top); 88 uses the wall rule but is passable.
  const { profile } = suggestTileProfile(makeTileset({ blocked: [kindId(80), ...WALL_89] }));
  assert.deepEqual(profile.wall, { sheet: "A4", kind: 89 });
  assert.deepEqual(profile.wallTop, { sheet: "A4", kind: 81 });
});

test("skips a star-flagged A4 wall kind", () => {
  const { profile } = suggestTileProfile(
    makeTileset({ blocked: [kindId(82), kindId(90)], flagged: [[kindId(89), 0x1f]] })
  );
  assert.deepEqual(profile.wall, { sheet: "A4", kind: 90 });
});

test("pairs every A4 wall-side kind with the wall-top kind drawn above it", () => {
  // A4 rows of 8 kinds alternate wall tops (80-87, 96-103, 112-119) and wall sides (88-95, 104-111, 120-127).
  for (const row of [88, 104, 120]) {
    for (let kind = row; kind < row + 8; kind++) {
      const { profile } = suggestTileProfile(makeTileset({ blocked: [kindId(kind - 8), kindId(kind)] }));
      assert.deepEqual(profile.wall, { sheet: "A4", kind });
      assert.deepEqual(profile.wallTop, { sheet: "A4", kind: kind - 8 });
    }
  }
});

test("omits wallTop with a note when the paired top kind does not block", () => {
  const { profile, notes } = suggestTileProfile(makeTileset({ blocked: [kindId(89)] }));
  assert.deepEqual(profile.wall, { sheet: "A4", kind: 89 });
  assert.equal(profile.wallTop, undefined);
  const line = notes.find((n) => n.startsWith("wallTop:")) ?? "";
  assert.match(line, /not set/);
  assert.match(line, /A4 kind 81/);
  assert.match(line, /does not block/);
});

test("falls back to A5 when A2 has no image", () => {
  const { profile, notes } = suggestTileProfile(makeTileset({ names: { A2: "" }, blocked: [1536, ...WALL_89] }));
  assert.deepEqual(profile.floor, { sheet: "A5", index: 1 });
  assert.ok(notes.some((n) => n.startsWith("floor:") && n.includes("A2 has no image")), notes.join("\n"));
});

test("falls back to a blocking A5 tile for wall and leaves wallTop unset", () => {
  const { profile, notes } = suggestTileProfile(makeTileset({ names: { A4: "" }, blocked: [1536 + 3, 5] }));
  assert.deepEqual(profile.wall, { sheet: "A5", index: 3 });
  assert.equal(profile.wallTop, undefined);
  assert.ok(notes.some((n) => n.startsWith("wallTop:") && n.includes("not set")), notes.join("\n"));
});

test("falls back to a blocking B tile for wall, skipping star-flagged ones", () => {
  const { profile } = suggestTileProfile(makeTileset({ names: { A4: "" }, blocked: [5], flagged: [[2, 0x1f]] }));
  assert.deepEqual(profile.wall, { sheet: "B", index: 5 });
});

test("throws when no floor tile can be found", () => {
  assert.throws(
    () => suggestTileProfile(makeTileset({ names: { A2: "", A5: "" }, blocked: WALL_89 })),
    /floor/
  );
});

test("throws when no wall tile can be found", () => {
  assert.throws(() => suggestTileProfile(makeTileset()), /wall/);
});

test("notes explain each pick", () => {
  const { notes } = suggestTileProfile(makeTileset({ blocked: [kindId(16), ...WALL_89] }));
  const line = (role) => notes.find((n) => n.startsWith(`${role}:`)) ?? "";
  assert.match(line("floor"), /A2 kind 17/);
  assert.match(line("floor"), /walkable/);
  assert.match(line("wall"), /A4 kind 89/);
  assert.match(line("wall"), /blocks movement/);
  assert.match(line("wallTop"), /A4 kind 81/);
  assert.match(line("decor"), /not suggested/);
  assert.ok(!notes.some((n) => /RTP/.test(n)));
});

test("a suggested profile has no problems", () => {
  const tileset = makeTileset({ blocked: WALL_89 });
  assert.deepEqual(profileProblems(suggestTileProfile(tileset).profile, tileset), []);
});

const A2_16 = { sheet: "A2", kind: 16 };
const A4_89 = { sheet: "A4", kind: 89 };

test("profileProblems flags a passable wall", () => {
  const problems = profileProblems({ floor: A2_16, wall: { sheet: "A4", kind: 88 } }, makeTileset());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^wall:/);
  assert.match(problems[0], /does not block/);
});

test("profileProblems judges passability like passableGrid", () => {
  // floor 0x01 is not walkable; a star floor 0x10 is fine; a partly blocked wall 0x0e is fine; a star wall 0x1f is not.
  const notWalkable = profileProblems(
    { floor: A2_16, wall: A4_89 },
    makeTileset({ blocked: [kindId(89)], flagged: [[kindId(16), 0x01]] })
  );
  assert.equal(notWalkable.length, 1);
  assert.match(notWalkable[0], /^floor:.*not walkable/);

  assert.deepEqual(
    profileProblems({ floor: A2_16, wall: A4_89 }, makeTileset({ flagged: [[kindId(16), 0x10], [kindId(89), 0x0e]] })),
    []
  );

  const starWall = profileProblems({ floor: A2_16, wall: A4_89 }, makeTileset({ flagged: [[kindId(89), 0x1f]] }));
  assert.equal(starWall.length, 1);
  assert.match(starWall[0], /^wall:.*does not block/);
});

test("profileProblems flags a wallTop that does not block", () => {
  const problems = profileProblems(
    { floor: A2_16, wall: A4_89, wallTop: { sheet: "A4", kind: 81 } },
    makeTileset({ blocked: [kindId(89)] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^wallTop:.*does not block/);
});

test("profileProblems flags a sheet without an image", () => {
  const problems = profileProblems(
    { floor: A2_16, wall: A4_89, decor: [{ tile: { sheet: "C", index: 4 }, weight: 1 }] },
    makeTileset({ blocked: [kindId(89)] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /decor/);
  assert.match(problems[0], /sheet C/);
  assert.match(problems[0], /no image/);
});

test("profileProblems reports a tile spec that does not resolve", () => {
  const problems = profileProblems({ floor: { sheet: "A2", kind: 3 }, wall: A4_89 }, makeTileset({ blocked: [kindId(89)] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /floor/);
  assert.match(problems[0], /valid kinds/);
});

test("tileProfileSchema rejects a profile missing floor", () => {
  assert.equal(tileProfileSchema.safeParse({ wall: A4_89 }).success, false);
  assert.equal(tileProfileSchema.safeParse({ floor: A2_16, wall: A4_89 }).success, true);
});

test("tileProfileSchema requires positive decor weights", () => {
  const base = { floor: A2_16, wall: 1600 };
  assert.equal(tileProfileSchema.safeParse({ ...base, decor: [{ tile: { sheet: "B", index: 3 }, weight: 0 }] }).success, false);
  assert.equal(tileProfileSchema.safeParse({ ...base, decor: [{ tile: { sheet: "B", index: 3 }, weight: 2 }] }).success, true);
});
