// Unit tests for the pure modules (PNG, formulas, CSV, curves, bulk edits, renderer, battle maths).
// Run after a build: npm run test:unit
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const dist = (name) => import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", name)).href);
const { decodePng, encodePng } = await dist("png.js");
const { evalFormula, formulaProblem } = await dist("formula.js");
const { parseCsv, toCsv, controlCodes } = await dist("localization.js");
const { curveValue, paramIndex } = await dist("curves.js");
const { applyChanges, matches, parsePath, BulkError } = await dist("bulk.js");
const { renderMapBitmap } = await dist("render.js");
const { Battler, calcDamage, makeActor, simulateBattles, mulberry32 } = await dist("battle.js");

// ---- PNG -------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngFile({ width, height, depth, colorType, raw, palette, trns }) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    ...(palette ? [chunk("PLTE", Buffer.from(palette))] : []), ...(trns ? [chunk("tRNS", Buffer.from(trns))] : []),
    chunk("IDAT", zlib.deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("png: encode then decode keeps every pixel", () => {
  const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 8, 7, 6, 1, 2, 3, 4, 5, 6, 7, 8]);
  const back = decodePng(encodePng({ width: 3, height: 2, data }));
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.data], [...data]);
});

test("png: all five row filters are undone", () => {
  const bmp = decodePng(pngFile({
    width: 3, height: 4, depth: 8, colorType: 0,
    raw: [1, 10, 5, 5, /* sub */ 2, 1, 1, 1, /* up */ 4, 0, 0, 0, /* paeth */ 3, 0, 0, 0 /* average */],
  }));
  const gray = (y) => [0, 1, 2].map((x) => bmp.data[(y * 3 + x) * 4]);
  assert.deepEqual(gray(0), [10, 15, 20]);
  assert.deepEqual(gray(1), [11, 16, 21]);
  assert.deepEqual(gray(2), [11, 16, 21]);
  assert.deepEqual(gray(3), [5, 10, 15]);
});

test("png: palette images with transparency decode to RGBA", () => {
  const bmp = decodePng(pngFile({
    width: 2, height: 1, depth: 4, colorType: 3, raw: [0, 0x01],
    palette: [10, 20, 30, 200, 100, 50], trns: [0],
  }));
  assert.deepEqual([...bmp.data], [10, 20, 30, 0, 200, 100, 50, 255]);
});

test("png: garbage is rejected", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /Not a PNG/);
});

// ---- formulas --------------------------------------------------------------

const ctx = (a = {}, b = {}) => ({ a, b, v: [0, 7], math: Math });

test("formula: evaluates engine-style expressions", () => {
  assert.equal(evalFormula("a.atk * 4 - b.def * 2", ctx({ atk: 26 }, { def: 30 })), 44);
  assert.equal(evalFormula("v[1] * 2 + Math.max(1, 3)", ctx()), 17);
  assert.equal(evalFormula("b.hp < 10 ? 100 : 5", ctx({}, { hp: 4 })), 100);
});

test("formula: negatives clamp to 0 and NaN counts as 0", () => {
  assert.equal(evalFormula("a.atk - 1000", ctx({ atk: 5 })), 0);
  assert.equal(evalFormula("b.level * 2", ctx({}, {})), 0);
});

test("formula: anything outside the whitelist is refused", () => {
  for (const bad of [
    "process.exit(1)", "a.constructor", "Math.constructor('return 1')()", "'x'", "a.hp = 1", "this",
    "a.atk; 1", "(function(){})()", "a[`atk`]", "globalThis", "require('fs')", "a.__proto__",
  ]) {
    assert.ok(formulaProblem(bad), `should refuse: ${bad}`);
    assert.equal(evalFormula(bad, ctx({ atk: 9 })), 0, `should not evaluate: ${bad}`);
  }
});

// ---- CSV -------------------------------------------------------------------

test("csv: commas, quotes and newlines survive a round trip", () => {
  const rows = [["key", "text"], ["a/1", 'He said "hi", then left\nsecond line'], ["b", ""], ["c", "plain"]];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv("﻿k,t\r\nx,y\r\n"), [["k", "t"], ["x", "y"]]);
});

test("csv: control codes are extracted for comparison", () => {
  assert.deepEqual(controlCodes("\\C[2]Hi\\C[0] \\N[1], you have \\V[3]\\G!"), ["\\C[0]", "\\C[2]", "\\G", "\\N[1]", "\\V[3]"]);
});

// ---- curves ----------------------------------------------------------------

test("curves: every shape starts and ends where asked", () => {
  for (const shape of ["linear", "ease-in", "ease-out", "ease-in-out", "exponential", "logistic"]) {
    assert.ok(Math.abs(curveValue(shape, 10, 500, 0) - 10) < 1e-9, `${shape} start`);
    assert.ok(Math.abs(curveValue(shape, 10, 500, 1) - 500) < 1e-9, `${shape} end`);
  }
  assert.ok(curveValue("ease-in", 0, 100, 0.5) < 50);
  assert.ok(curveValue("ease-out", 0, 100, 0.5) > 50);
  assert.throws(() => curveValue("exponential", 0, 100, 0.5), /above 0/);
  assert.equal(paramIndex("atk"), 2);
  assert.throws(() => paramIndex("nope"));
});

// ---- bulk edits ------------------------------------------------------------

test("bulk: percent on integers rounds, params alias works, clamps apply", () => {
  const rec = { id: 1, price: 105, params: [0, 0, 10, 0, 0, 0, 0, 0], name: "Sword" };
  const diffs = applyChanges(rec, [
    { field: "params.atk", op: "percent", value: 10 },
    { field: "price", op: "multiply", value: 2, max: 200 },
  ]);
  assert.equal(rec.params[2], 11);
  assert.equal(rec.price, 200);
  assert.equal(diffs.length, 2);
  assert.deepEqual(parsePath("traits[1].value"), ["traits", 1, "value"]);
});

test("bulk: bad paths and prototype pollution are refused", () => {
  assert.throws(() => parsePath("__proto__.x"), BulkError);
  assert.throws(() => applyChanges({ id: 1 }, [{ field: "missing.field", op: "add", value: 1 }]), BulkError);
  assert.throws(() => applyChanges({ name: "x" }, [{ field: "name", op: "add", value: 1 }]), BulkError);
  assert.equal({}.polluted, undefined);
});

test("bulk: conditions", () => {
  const rec = { name: "Iron Sword", price: 100, wtypeId: 2, damage: { type: 1 } };
  assert.ok(matches(rec, { field: "name", op: "contains", value: "sword" }));
  assert.ok(matches(rec, { field: "price", op: "gte", value: 100 }));
  assert.ok(matches(rec, { field: "damage.type", op: "eq", value: 1 }));
  assert.ok(!matches(rec, { field: "wtypeId", op: "ne", value: 2 }));
  assert.ok(matches(rec, { field: "name", op: "matches", value: "^iron" }));
});

// ---- renderer --------------------------------------------------------------

function sheet(width, height, colorOf) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = colorOf(x, y);
    data.set([r, g, b, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}
const pixel = (bmp, x, y) => [...bmp.data.slice((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3)];
const baseInput = (over) => ({
  width: 1, height: 1, data: new Array(6).fill(0), flags: [], sheets: {}, tileSize: 48, grid: false, regions: false,
  tileEvents: [], sprites: [], markers: [], region: { x: 0, y: 0, width: 1, height: 1 }, ...over,
});

test("render: a normal tile is copied from its sheet position", () => {
  // A5 sheet 8x16 tiles; tile index 9 = column 1, row 1
  const a5 = sheet(384, 768, (x, y) => [Math.floor(x / 48), Math.floor(y / 48), 0]);
  const out = renderMapBitmap(baseInput({ data: [1536 + 9, 0, 0, 0, 0, 0], sheets: { A5: a5 } }));
  assert.deepEqual(pixel(out.bitmap, 10, 10), [1, 1, 0]);
});

test("render: autotile quarters follow the engine's tables", () => {
  // Every 24px quarter of the A2 sheet gets a colour that encodes its quarter coordinates.
  const a2 = sheet(768, 576, (x, y) => [Math.floor(x / 24), Math.floor(y / 24), 0]);
  const draw = (shape) => renderMapBitmap(baseInput({ data: [2816 + shape, 0, 0, 0, 0, 0], sheets: { A2: a2 } })).bitmap;
  // shape 0 (fully surrounded) of A2 kind 16 -> quarters [[2,4],[1,4],[2,3],[1,3]]
  let bmp = draw(0);
  assert.deepEqual([pixel(bmp, 2, 2), pixel(bmp, 26, 2), pixel(bmp, 2, 26), pixel(bmp, 26, 26)], [[2, 4, 0], [1, 4, 0], [2, 3, 0], [1, 3, 0]]);
  // shape 46 (isolated) -> [[0,2],[3,2],[0,5],[3,5]]
  bmp = draw(46);
  assert.deepEqual([pixel(bmp, 2, 2), pixel(bmp, 26, 2), pixel(bmp, 2, 26), pixel(bmp, 26, 26)], [[0, 2, 0], [3, 2, 0], [0, 5, 0], [3, 5, 0]]);
});

test("render: shadows darken quarters, missing sheets are reported, scaling keeps size", () => {
  const a5 = sheet(384, 768, () => [200, 200, 200]);
  const shadowed = renderMapBitmap(baseInput({ data: [1536, 0, 0, 0, 1, 0], sheets: { A5: a5 } })).bitmap;
  assert.deepEqual(pixel(shadowed, 5, 5), [100, 100, 100]);
  assert.deepEqual(pixel(shadowed, 40, 40), [200, 200, 200]);
  const missing = renderMapBitmap(baseInput({ data: [1536, 0, 0, 0, 0, 0] }));
  assert.deepEqual(missing.missingSheets, ["A5"]);
  const small = renderMapBitmap(baseInput({ data: [1536, 0, 0, 0, 0, 0], sheets: { A5: a5 }, tileSize: 16 }));
  assert.equal(small.bitmap.width, 16);
  assert.deepEqual(pixel(small.bitmap, 8, 8), [200, 200, 200]);
});

// ---- battle maths ----------------------------------------------------------

const params = (mhp, atk, def, mat = 10, mdf = 10, agi = 10) => [mhp, 50, atk, def, mat, mdf, agi, 10];
const HIT = [{ code: 22, dataId: 0, value: 1 }]; // enemies hit only with a HIT trait, like the editor's defaults
const attackSkill = { id: 1, name: "Attack", scope: 1, hitType: 1, repeats: 1, speed: 0, successRate: 100, mpCost: 0,
  damage: { type: 1, elementId: 0, formula: "a.atk * 4 - b.def * 2", variance: 20, critical: true } };

test("battle: expected damage matches the engine formula", () => {
  const a = new Battler("Hero", true, 5, params(400, 26, 10), []);
  const b = new Battler("Bat", false, undefined, params(200, 10, 30), []);
  assert.equal(calcDamage(attackSkill, a, b, null).value, 44);
  // physical damage rate (PDR, sparam 6) halves the result
  const tough = new Battler("Golem", false, undefined, params(200, 10, 30), [{ code: 23, dataId: 6, value: 0.5 }]);
  assert.equal(calcDamage(attackSkill, a, tough, null).value, 22);
});

test("battle: class curves, equipment and param traits feed the stats", () => {
  const row = new Array(100).fill(0); row[5] = 100;
  const data = {
    classes: [null, { id: 1, name: "Fighter", traits: [{ code: 21, dataId: 2, value: 1.5 }], params: [row, row, row, row, row, row, row, row] }],
    actors: [null, { id: 1, name: "Hero", classId: 1, initialLevel: 1, maxLevel: 99, equips: [1, 0], traits: [] }],
    weapons: [null, { id: 1, name: "Sword", params: [0, 0, 20, 0, 0, 0, 0, 0], traits: [] }],
    armors: [null], skills: [null, attackSkill], enemies: [null], troops: [null],
  };
  const hero = makeActor(data, { actorId: 1, level: 5 });
  assert.equal(hero.param(0), 100);
  assert.equal(hero.param(2), 180); // (100 + 20) * 1.5
});

test("battle: simulations are reproducible and respect strength", () => {
  const row = (v) => { const r = new Array(100).fill(v); return r; };
  const data = {
    classes: [null, { id: 1, name: "Fighter", traits: [{ code: 22, dataId: 0, value: 1 }], params: [row(500), row(50), row(60), row(20), row(10), row(10), row(30), row(10)] }],
    actors: [null, { id: 1, name: "Hero", classId: 1, initialLevel: 1, maxLevel: 99, equips: [0, 0], traits: [] }],
    skills: [null, attackSkill], weapons: [null], armors: [null],
    enemies: [null,
      { id: 1, name: "Rat", params: params(50, 5, 5), traits: HIT, actions: [{ skillId: 1, rating: 5, conditionType: 0 }] },
      { id: 2, name: "Dragon", params: params(90000, 400, 400, 400, 400, 80), traits: HIT, actions: [{ skillId: 1, rating: 5, conditionType: 0 }] }],
    troops: [null],
  };
  const opts = { runs: 60, maxTurns: 30, seed: 7, partyLevel: 5 };
  const easy = simulateBattles(data, [{ actorId: 1 }], [1], opts);
  assert.equal(easy.winRate, 1);
  assert.deepEqual(simulateBattles(data, [{ actorId: 1 }], [1], opts), easy);
  const hard = simulateBattles(data, [{ actorId: 1 }], [2], opts);
  assert.equal(hard.winRate, 0);
  assert.ok(hard.lossRate > 0.9);
  assert.ok(easy.sampleLog.length > 0);
  const r = mulberry32(1);
  assert.ok(r() >= 0 && r() < 1);
});
