import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_FOLDERS,
  detectAssetType,
  inspectAsset,
  isAssetFolder,
  isImageFolder,
  validateAssetName,
} from "../dist/assetFormats.js";
import { encodePng } from "../dist/png.js";
import { ProjectError } from "../dist/project.js";

const png = (width, height) => encodePng({ width, height, data: new Uint8Array(width * height * 4) });
const ogg = () => Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);
const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(52)]);
const MiB = 1024 * 1024;

test("folder list is exact and the helpers agree with it", () => {
  assert.equal(ASSET_FOLDERS.length, 18);
  assert.equal(ASSET_FOLDERS[0], "img/animations");
  assert.equal(ASSET_FOLDERS[13], "img/titles2");
  assert.equal(ASSET_FOLDERS[14], "audio/bgm");
  assert.equal(ASSET_FOLDERS[17], "audio/se");
  assert.ok(isAssetFolder("img/faces"));
  assert.ok(!isAssetFolder("img/other"));
  assert.ok(!isAssetFolder("../img/faces"));
  assert.ok(!isAssetFolder("img/faces/"));
  assert.ok(isImageFolder("img/system"));
  assert.ok(!isImageFolder("audio/se"));
});

test("validateAssetName accepts normal MV names", () => {
  for (const n of ["Hero", "$Boss", "!Door", "Actor 1", "a_b-c(1)", "0", "x".repeat(64)]) {
    assert.equal(validateAssetName(n), n);
  }
});

test("validateAssetName rejects hostile and malformed names", () => {
  const bad = [
    "", " x", "x ", ".", "..", "a/b", "a\\b", "a.png", "x.", "C:x", "../x", "..\\x",
    "nul", "NUL", "CON", "con", "prn", "aux", "COM1", "com9", "lpt1", "lpt9", "Nul", "CONIN$", "conout$",
    "x".repeat(65), "a\0b", "\0", "ｈero", "Ｈero", "hérö", "a\nb", "a\n", "a\tb", "-x", "_x", "(x",
  ];
  for (const n of bad) assert.throws(() => validateAssetName(n), ProjectError, JSON.stringify(n));
  for (const v of [undefined, null, 5, {}, [], ["a"], true]) {
    assert.throws(() => validateAssetName(v), ProjectError);
  }
});

test("detectAssetType recognises PNG, OggS and an ftyp box", () => {
  assert.equal(detectAssetType(png(1, 1)), "png");
  assert.equal(detectAssetType(ogg()), "ogg");
  assert.equal(detectAssetType(m4a()), "m4a");
  assert.equal(detectAssetType(Buffer.from("OggS")), "ogg");
});

test("detectAssetType returns null for text, an empty buffer and a 3-byte buffer", () => {
  assert.equal(detectAssetType(Buffer.from("hello world, definitely not a PNG")), null);
  assert.equal(detectAssetType(Buffer.alloc(0)), null);
  assert.equal(detectAssetType(Buffer.from([0x4f, 0x67, 0x67])), null);
  assert.equal(detectAssetType(Buffer.from([137, 80, 78, 71])), null);
  assert.equal(detectAssetType(Buffer.from("....ftyp").subarray(0, 7)), null);
});

test("inspectAsset: characters sheets", () => {
  const big = inspectAsset("img/characters", "$Big", png(144, 192), 500);
  assert.deepEqual(big, { type: "png", bytes: 500, width: 144, height: 192, warnings: [] });
  const crowd = inspectAsset("img/characters", "Crowd", png(100, 100), 500);
  assert.equal(crowd.warnings.length, 1);
  assert.match(crowd.warnings[0], /12/);
  assert.match(crowd.warnings[0], /8/);
  const bigBad = inspectAsset("img/characters", "$Big", png(100, 100), 500);
  assert.equal(bigBad.warnings.length, 1);
  assert.match(bigBad.warnings[0], /3/);
  assert.match(bigBad.warnings[0], /4/);
  assert.deepEqual(inspectAsset("img/characters", "Hero", png(144, 192), 1).warnings, []);
});

test("inspectAsset: faces, sv_actors, tilesets, animations, titles and battlebacks", () => {
  assert.deepEqual(inspectAsset("img/faces", "Actor1", png(576, 288), 1).warnings, []);
  assert.equal(inspectAsset("img/faces", "Actor1", png(100, 100), 1).warnings.length, 1);
  assert.match(inspectAsset("img/faces", "Actor1", png(100, 100), 1).warnings[0], /144/);
  assert.deepEqual(inspectAsset("img/sv_actors", "Actor1", png(576, 384), 1).warnings, []);
  assert.equal(inspectAsset("img/sv_actors", "Actor1", png(100, 100), 1).warnings.length, 1);
  assert.deepEqual(inspectAsset("img/tilesets", "World_A1", png(768, 576), 1).warnings, []);
  assert.deepEqual(inspectAsset("img/tilesets", "World_A1", png(384, 576), 1).warnings, []);
  const ts = inspectAsset("img/tilesets", "World_A1", png(500, 576), 1);
  assert.equal(ts.warnings.length, 1);
  assert.match(ts.warnings[0], /768/);
  assert.deepEqual(inspectAsset("img/animations", "Hit", png(960, 400), 1).warnings, []);
  assert.equal(inspectAsset("img/animations", "Hit", png(1000, 400), 1).warnings.length, 1);
  for (const f of ["img/titles1", "img/titles2", "img/battlebacks1", "img/battlebacks2"]) {
    assert.deepEqual(inspectAsset(f, "Sky", png(816, 624), 1).warnings, [], f);
    assert.equal(inspectAsset(f, "Sky", png(800, 624), 1).warnings.length, 1, f);
    assert.equal(inspectAsset(f, "Sky", png(816, 600), 1).warnings.length, 1, f);
  }
  for (const f of ["img/enemies", "img/pictures", "img/parallaxes", "img/system", "img/sv_enemies"]) {
    assert.deepEqual(inspectAsset(f, "Odd", png(13, 7), 1).warnings, [], f);
  }
});

test("inspectAsset: audio folders accept ogg and m4a, with no warnings", () => {
  assert.deepEqual(inspectAsset("audio/bgm", "Theme", ogg(), 5 * MiB), { type: "ogg", bytes: 5 * MiB, warnings: [] });
  assert.deepEqual(inspectAsset("audio/se", "Hit", m4a(), 10), { type: "m4a", bytes: 10, warnings: [] });
});

test("inspectAsset refuses a type that does not fit the folder", () => {
  assert.throws(() => inspectAsset("audio/bgm", "Theme", png(1, 1), 100), ProjectError);
  assert.throws(() => inspectAsset("img/faces", "Actor1", ogg(), 100), ProjectError);
  assert.throws(() => inspectAsset("img/faces", "Actor1", m4a(), 100), ProjectError);
  assert.throws(() => inspectAsset("audio/me", "Jingle", Buffer.from("just text"), 9), ProjectError);
  assert.throws(() => inspectAsset("img/faces", "Actor1", Buffer.alloc(0), 0), ProjectError);
});

test("inspectAsset enforces the size caps (32 MiB images, 128 MiB audio)", () => {
  assert.doesNotThrow(() => inspectAsset("img/pictures", "Big", png(2, 2), 32 * MiB));
  assert.throws(() => inspectAsset("img/pictures", "Big", png(2, 2), 32 * MiB + 1), ProjectError);
  assert.doesNotThrow(() => inspectAsset("audio/bgm", "Long", ogg(), 128 * MiB));
  assert.throws(() => inspectAsset("audio/bgm", "Long", ogg(), 128 * MiB + 1), ProjectError);
  assert.throws(() => inspectAsset("audio/bgm", "Long", ogg(), -1), ProjectError);
  assert.throws(() => inspectAsset("audio/bgm", "Long", ogg(), Number.NaN), ProjectError);
});

test("inspectAsset refuses a head that is too short for a PNG header or a hostile name", () => {
  assert.throws(() => inspectAsset("img/pictures", "Cut", png(2, 2).subarray(0, 20), 100), ProjectError);
  assert.throws(() => inspectAsset("img/pictures", "Cut", png(2, 2).subarray(0, 8), 100), ProjectError);
  assert.throws(() => inspectAsset("img/pictures", "../x", png(2, 2), 100), ProjectError);
});
