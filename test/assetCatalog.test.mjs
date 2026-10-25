import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listAssets } from "../dist/assetCatalog.js";
import { encodePng, decodePng } from "../dist/png.js";
import { Project } from "../dist/project.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const png = (width, height, fill = 0) =>
  encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(fill) });
const ogg = () => Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 1)]);

async function tempProject(data = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-catalog-"));
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.writeFile(path.join(dir, "Game.rpgproject"), "RPGMV 1.6.2");
  await fs.writeFile(path.join(dir, "data", "System.json"), JSON.stringify({ gameTitle: "T", ...data.system }));
  for (const [name, value] of Object.entries(data.files ?? {})) {
    await fs.writeFile(path.join(dir, "data", name), JSON.stringify(value));
  }
  return dir;
}

const put = async (dir, rel, bytes) => {
  const file = path.join(dir, ...rel.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
};

async function withProject(data, fn) {
  const dir = await tempProject(data);
  const project = new Project();
  await project.setRoot(dir);
  try {
    await fn({ dir, project });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const folderOf = (res, folder) => res.folders.find((f) => f.folder === folder);
const actors = [null, { id: 1, characterName: "Hero", faceName: "", battlerName: "" }];

test("listAssets reports size, dimensions and usage for a character sheet used by an actor", async () => {
  await withProject({ files: { "Actors.json": actors } }, async ({ dir, project }) => {
    const bytes = png(144, 192);
    await put(dir, "img/characters/Hero.png", bytes);
    const res = await listAssets(project, { folder: "img/characters", includeUsage: true, limit: 200 });
    assert.equal(res.folders.length, 1);
    const f = res.folders[0];
    assert.equal(f.folder, "img/characters");
    assert.equal(f.total, 1);
    assert.deepEqual(f.files[0], {
      name: "Hero",
      ext: "png",
      bytes: bytes.length,
      width: 144,
      height: 192,
      usedBy: ["Actor 1"],
      unused: false,
      warnings: [],
    });
    assert.equal(res.truncated, 0);
  });
});

test("marks an unreferenced picture as unused and a referenced one with its source", async () => {
  const cmd231 = { code: 231, indent: 0, parameters: [1, "Used", 0, 0, 0, 0, 100, 100, 255, 0] };
  const ce = [null, { id: 1, name: "c", list: [cmd231, { code: 0, indent: 0, parameters: [] }] }];
  await withProject({ files: { "CommonEvents.json": ce } }, async ({ dir, project }) => {
    await put(dir, "img/pictures/Used.png", png(2, 2));
    await put(dir, "img/pictures/Spare.png", png(2, 2));
    const res = await listAssets(project, { folder: "img/pictures", includeUsage: true, limit: 200 });
    const [spare, used] = res.folders[0].files;
    assert.equal(spare.name, "Spare");
    assert.equal(spare.unused, true);
    assert.equal(spare.usedBy, undefined);
    assert.equal(used.name, "Used");
    assert.equal(used.unused, false);
    assert.deepEqual(used.usedBy, ["CommonEvent 1"]);
  });
});

test("usedBy lists at most 3 sources and usage matching is case-sensitive", async () => {
  const actorsMany = [null, ...[1, 2, 3, 4, 5].map((id) => ({ id, characterName: "Hero", faceName: "", battlerName: "" }))];
  await withProject({ files: { "Actors.json": actorsMany } }, async ({ dir, project }) => {
    await put(dir, "img/characters/Hero.png", png(12, 8));
    await put(dir, "img/characters/hero2.png", png(12, 8));
    const res = await listAssets(project, { folder: "img/characters", includeUsage: true, limit: 200 });
    const byName = Object.fromEntries(res.folders[0].files.map((e) => [e.name, e]));
    assert.equal(byName.Hero.usedBy.length, 3);
    assert.equal(byName.hero2.unused, true);
  });
});

test("does not set unused for img/system or img/animations", async () => {
  await withProject({}, async ({ dir, project }) => {
    await put(dir, "img/system/Window.png", png(2, 2));
    await put(dir, "img/animations/Hit.png", png(192, 2));
    const res = await listAssets(project, { includeUsage: true, limit: 200 });
    for (const folder of ["img/system", "img/animations"]) {
      const e = folderOf(res, folder).files[0];
      assert.equal(e.unused, undefined, folder);
      assert.equal(e.usedBy, undefined, folder);
    }
  });
});

test("img/enemies is covered in front view and img/sv_enemies in side view only", async () => {
  await withProject({ system: { optSideView: true } }, async ({ dir, project }) => {
    await put(dir, "img/enemies/Slime.png", png(2, 2));
    await put(dir, "img/sv_enemies/Slime.png", png(2, 2));
    const res = await listAssets(project, { includeUsage: true, limit: 200 });
    assert.equal(folderOf(res, "img/enemies").files[0].unused, undefined);
    assert.equal(folderOf(res, "img/sv_enemies").files[0].unused, true);
  });
});

test("limit caps files per folder and reports truncated", async () => {
  await withProject({}, async ({ dir, project }) => {
    for (const n of ["C", "A", "E", "B", "D"]) await put(dir, `img/pictures/${n}.png`, png(1, 1));
    await put(dir, "img/faces/F1.png", png(144, 144));
    const res = await listAssets(project, { includeUsage: false, limit: 2 });
    const pics = folderOf(res, "img/pictures");
    assert.equal(pics.total, 5);
    assert.deepEqual(pics.files.map((f) => f.name), ["A", "B"]);
    assert.equal(folderOf(res, "img/faces").total, 1);
    assert.equal(res.truncated, 3);
  });
});

test("ignores sub-directories and files with foreign extensions", async () => {
  await withProject({}, async ({ dir, project }) => {
    await put(dir, "img/pictures/Real.png", png(1, 1));
    await put(dir, "img/pictures/notes.txt", "hi");
    await put(dir, "img/pictures/Sound.ogg", ogg());
    await put(dir, "img/pictures/Enc.rpgmvp", "x");
    await put(dir, "img/pictures/Sub.png/inner.png", png(1, 1)); // a directory named Sub.png
    await put(dir, "audio/bgm/Theme.ogg", ogg());
    await put(dir, "audio/bgm/Pic.png", png(1, 1));
    const pics = folderOf(await listAssets(project, { folder: "img/pictures", includeUsage: false, limit: 50 }), "img/pictures");
    assert.deepEqual(pics.files.map((f) => f.name), ["Real"]);
    assert.equal(pics.total, 1);
    const bgm = folderOf(await listAssets(project, { folder: "audio/bgm", includeUsage: false, limit: 50 }), "audio/bgm");
    assert.deepEqual(bgm.files.map((f) => `${f.name}.${f.ext}`), ["Theme.ogg"]);
  });
});

test("reads only a header: a 40 MB fake .ogg lists quickly and its bytes are right", async () => {
  await withProject({}, async ({ dir, project }) => {
    const size = 40 * 1024 * 1024;
    const file = path.join(dir, "audio", "bgm", "Big.ogg");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const fh = await fs.open(file, "w");
    await fh.write(Buffer.from("OggS"), 0, 4, 0);
    await fh.truncate(size);
    await fh.close();
    const started = Date.now();
    const res = await listAssets(project, { folder: "audio/bgm", includeUsage: false, limit: 10 });
    assert.ok(Date.now() - started < 2000);
    const e = res.folders[0].files[0];
    assert.equal(e.bytes, size);
    assert.equal(e.ext, "ogg");
    assert.deepEqual(e.warnings, []);
    assert.equal(e.width, undefined);
  });
});

test("flags a header that does not match the extension without failing the listing", async () => {
  await withProject({}, async ({ dir, project }) => {
    await put(dir, "img/pictures/Fake.png", "this is text, not a picture");
    await put(dir, "audio/se/Fake.ogg", png(1, 1));
    const pic = (await listAssets(project, { folder: "img/pictures", includeUsage: false, limit: 5 })).folders[0].files[0];
    assert.equal(pic.width, undefined);
    assert.equal(pic.warnings.length, 1);
    assert.match(pic.warnings[0], /header/i);
    assert.ok(!pic.warnings[0].includes("this is text"));
    const se = (await listAssets(project, { folder: "audio/se", includeUsage: false, limit: 5 })).folders[0].files[0];
    assert.equal(se.warnings.length, 1);
    assert.match(se.warnings[0], /header/i);
  });
});

test("carries the layout warnings of a character sheet that does not fit", async () => {
  await withProject({}, async ({ dir, project }) => {
    await put(dir, "img/characters/Crowd.png", png(100, 100));
    const e = (await listAssets(project, { folder: "img/characters", includeUsage: false, limit: 5 })).folders[0].files[0];
    assert.equal(e.warnings.length, 1);
    assert.match(e.warnings[0], /12/);
  });
});

test("a missing folder yields an empty entry, not an error", async () => {
  await withProject({}, async ({ project }) => {
    const res = await listAssets(project, { folder: "img/parallaxes", includeUsage: true, limit: 10 });
    assert.deepEqual(res, { folders: [{ folder: "img/parallaxes", total: 0, files: [] }], truncated: 0 });
    const all = await listAssets(project, { includeUsage: true, limit: 10 });
    assert.equal(all.folders.length, 18);
  });
});

test("includeUsage false omits usedBy/unused", async () => {
  await withProject({ files: { "Actors.json": actors } }, async ({ dir, project }) => {
    await put(dir, "img/characters/Hero.png", png(12, 8));
    const e = (await listAssets(project, { folder: "img/characters", includeUsage: false, limit: 10 })).folders[0].files[0];
    assert.equal("usedBy" in e, false);
    assert.equal("unused" in e, false);
  });
});

test("a broken data file does not fail the listing; usage is left out and reported", async () => {
  await withProject({}, async ({ dir, project }) => {
    await fs.writeFile(path.join(dir, "data", "Actors.json"), "{ not json");
    await put(dir, "img/pictures/A.png", png(1, 1));
    const res = await listAssets(project, { folder: "img/pictures", includeUsage: true, limit: 10 });
    assert.equal(res.folders[0].files[0].name, "A");
    assert.equal("unused" in res.folders[0].files[0], false);
    assert.equal(typeof res.usageError, "string");
    assert.ok(!res.usageError.includes("not json"));
  });
});

// ---- tool level ----
async function withServer(fn, { setProject = true } = {}) {
  const dir = await tempProject({ files: { "Actors.json": actors } });
  const client = new Client({ name: "catalog-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" }));
  const raw = async (name, args) => {
    try {
      return await client.callTool({ name, arguments: args });
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
    }
  };
  try {
    if (setProject) assert.equal((await raw("set_project", { path: dir })).isError ?? false, false);
    await fn({ dir, raw });
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("list_assets and preview_asset answer 'No project selected' before set_project", async () => {
  await withServer(
    async ({ raw }) => {
      for (const [name, args] of [
        ["list_assets", {}],
        ["preview_asset", { folder: "img/pictures", name: "A" }],
      ]) {
        const r = await raw(name, args);
        assert.equal(r.isError, true, name);
        assert.match(r.content[0].text, /No project selected/, name);
      }
    },
    { setProject: false }
  );
});

test("list_assets tool lists a folder, caps via limit and rejects an unknown folder", async () => {
  await withServer(async ({ dir, raw }) => {
    await put(dir, "img/characters/Hero.png", png(144, 192));
    await put(dir, "img/characters/Other.png", png(12, 8));
    const r = await raw("list_assets", { folder: "img/characters", limit: 1 });
    assert.equal(r.isError ?? false, false);
    const json = JSON.parse(r.content[0].text);
    assert.equal(json.folders[0].files[0].name, "Hero");
    assert.deepEqual(json.folders[0].files[0].usedBy, ["Actor 1"]);
    assert.equal(json.truncated, 1);
    assert.equal((await raw("list_assets", { folder: "img/nope" })).isError, true);
    assert.equal((await raw("list_assets", { limit: 0 })).isError, true);
    assert.equal((await raw("list_assets", { limit: 1001 })).isError, true);
  });
});

test("preview_asset returns a text block and an image block no larger than maxSize", async () => {
  await withServer(async ({ dir, raw }) => {
    await put(dir, "img/characters/Hero.png", png(576, 384, 200));
    const r = await raw("preview_asset", { folder: "img/characters", name: "Hero", maxSize: 128 });
    assert.equal(r.isError ?? false, false);
    const text = r.content.find((c) => c.type === "text").text;
    const img = r.content.find((c) => c.type === "image");
    assert.match(text, /576x384 px/);
    assert.match(text, /8 characters/);
    assert.equal(img.mimeType, "image/png");
    const bmp = decodePng(Buffer.from(img.data, "base64"));
    assert.equal(bmp.width, 128);
    assert.equal(bmp.height, 85);
    // default maxSize 512: a small image stays as it is
    await put(dir, "img/faces/Face.png", png(144, 144));
    const f = await raw("preview_asset", { folder: "img/faces", name: "Face" });
    const fb = decodePng(Buffer.from(f.content.find((c) => c.type === "image").data, "base64"));
    assert.equal(fb.width, 144);
    assert.match(f.content[0].text, /face/i);
  });
});

test("preview_asset refuses bad input clearly", async () => {
  await withServer(async ({ dir, raw }) => {
    await put(dir, "img/pictures/Text.png", "just words, not a png");
    await put(dir, "img/pictures/Real.png", png(2, 2));
    await put(dir, "audio/bgm/Song.ogg", ogg());
    await put(dir, "img/pictures/Secret1.png", png(2, 2));
    const fake = await raw("preview_asset", { folder: "img/pictures", name: "Text" });
    assert.equal(fake.isError, true);
    assert.ok(!fake.content[0].text.includes("just words"));
    for (const name of ["..", "../data/System", "a/b", "Real.png", ""]) {
      const r = await raw("preview_asset", { folder: "img/pictures", name });
      assert.equal(r.isError, true, name);
    }
    const missing = await raw("preview_asset", { folder: "img/pictures", name: "Nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Nope/);
    assert.ok(!missing.content[0].text.includes("Secret1"));
    assert.ok(!missing.content[0].text.includes("Real"));
    assert.equal((await raw("preview_asset", { folder: "audio/bgm", name: "Song" })).isError, true);
    assert.equal((await raw("preview_asset", { folder: "img/pictures", name: "Real", maxSize: 31 })).isError, true);
    assert.equal((await raw("preview_asset", { folder: "img/pictures", name: "Real", maxSize: 1025 })).isError, true);
  });
});

test("preview_asset reports an interlaced PNG and an oversized file as errors", async () => {
  await withServer(async ({ dir, raw }) => {
    const interlaced = Buffer.from(png(2, 2));
    interlaced[28] = 1; // IHDR interlace byte (the decoder does not check the CRC)
    await put(dir, "img/pictures/Inter.png", interlaced);
    const r = await raw("preview_asset", { folder: "img/pictures", name: "Inter" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /nterlaced/);

    const head = png(1, 1);
    const fh = await fs.open(path.join(dir, "img", "pictures", "Huge.png"), "w");
    await fh.write(head, 0, head.length, 0);
    await fh.truncate(32 * 1024 * 1024 + 1);
    await fh.close();
    const h = await raw("preview_asset", { folder: "img/pictures", name: "Huge" });
    assert.equal(h.isError, true);
    assert.match(h.content[0].text, /32 MiB/);
  });
});

// ---- fix round 1 ----
test("an unreadable folder is reported on its own entry and does not fail the other folders", async () => {
  await withProject({}, async ({ dir, project }) => {
    await put(dir, "img/pictures/A.png", png(1, 1));
    await put(dir, "img/faces/F.png", png(144, 144));
    const original = fs.readdir;
    fs.readdir = async (p, ...rest) => {
      if (String(p).endsWith(path.join("img", "faces"))) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(p, ...rest);
    };
    let res;
    try {
      res = await listAssets(project, { includeUsage: false, limit: 10 });
    } finally {
      fs.readdir = original;
    }
    assert.equal(res.folders.length, 18);
    const faces = folderOf(res, "img/faces");
    assert.deepEqual([faces.total, faces.files.length], [0, 0]);
    assert.match(faces.error, /EACCES/);
    assert.equal(folderOf(res, "img/pictures").files[0].name, "A");
    assert.equal("error" in folderOf(res, "img/pictures"), false);
    assert.equal("error" in folderOf(res, "img/titles1"), false); // a missing folder is just empty
  });
});

test("an interlaced PNG gets a warning in the listing", async () => {
  await withProject({}, async ({ dir, project }) => {
    const b = Buffer.from(png(2, 2));
    b[28] = 1;
    await put(dir, "img/pictures/Inter.png", b);
    const e = (await listAssets(project, { folder: "img/pictures", includeUsage: false, limit: 5 })).folders[0].files[0];
    assert.equal(e.width, 2);
    assert.ok(e.warnings.some((w) => /nterlaced/.test(w) && /preview_asset/.test(w)));
  });
});

test("a !$ character sheet is listed with the single-character layout", async () => {
  await withProject({}, async ({ dir, project }) => {
    await put(dir, "img/characters/!$Chest.png", png(99, 128));
    const e = (await listAssets(project, { folder: "img/characters", includeUsage: false, limit: 5 })).folders[0].files[0];
    assert.deepEqual(e.warnings, []);
  });
});

test("preview_asset says '!$' sheets hold one character", async () => {
  await withServer(async ({ dir, raw }) => {
    await put(dir, "img/characters/!$Chest.png", png(99, 128));
    const r = await raw("preview_asset", { folder: "img/characters", name: "!$Chest" });
    assert.equal(r.isError ?? false, false);
    assert.match(r.content[0].text, /one character/);
    assert.match(r.content[0].text, /33x32 px/);
  });
});

test("preview_asset refuses a header claiming more than 16 million pixels before decoding", async () => {
  await withServer(async ({ dir, raw }) => {
    const fake = Buffer.from(png(1, 1));
    fake.writeUInt32BE(5000, 16);
    fake.writeUInt32BE(5000, 20);
    await put(dir, "img/pictures/Wide.png", fake);
    const r = await raw("preview_asset", { folder: "img/pictures", name: "Wide" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /too large to preview \(5000x5000\)/);
  });
});

test("preview_asset on a PNG whose IDAT inflates far past its header fails fast", async () => {
  await withServer(async ({ dir, raw }) => {
    const base = Buffer.from(png(1, 1));
    // replace the IDAT of a valid 1x1 PNG: keep signature + IHDR (33 bytes), add a 64 MB-inflating IDAT
    const idat = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(idat.length, 0);
    head.write("IDAT", 4, "ascii");
    const bomb = Buffer.concat([base.subarray(0, 33), head, idat, Buffer.alloc(4), Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0])]);
    await put(dir, "img/pictures/Bomb.png", bomb);
    const started = Date.now();
    const r = await raw("preview_asset", { folder: "img/pictures", name: "Bomb" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /larger than its header allows/);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  });
});

// A PNG whose first IHDR says 2x2 and whose second says 6000x6000 (invalid per the PNG spec).
function doubleHeaderPng() {
  const chunkOf = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    return out;
  };
  const ihdr = (w, h) => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(w, 0);
    b.writeUInt32BE(h, 4);
    b[8] = 8;
    b[9] = 6;
    return b;
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunkOf("IHDR", ihdr(2, 2)),
    chunkOf("IHDR", ihdr(6000, 6000)),
    chunkOf("IDAT", Buffer.alloc(8)),
    chunkOf("IEND", Buffer.alloc(0)),
  ]);
}

test("list_assets does not report a PNG with a second IHDR as a clean 2x2, and preview_asset refuses it", async () => {
  await withProject({}, async ({ dir, project }) => {
    await put(dir, "img/pictures/Twice.png", doubleHeaderPng());
    const res = await listAssets(project, { folder: "img/pictures", includeUsage: false, limit: 200 });
    const entry = res.folders[0].files[0];
    assert.equal(entry.width, undefined);
    assert.ok(entry.warnings.some((w) => /Unreadable PNG header/.test(w)), JSON.stringify(entry));
  });
  await withServer(async ({ dir, raw }) => {
    await put(dir, "img/pictures/Twice.png", doubleHeaderPng());
    const started = Date.now();
    const r = await raw("preview_asset", { folder: "img/pictures", name: "Twice" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /second image header/);
    assert.ok(Date.now() - started < 5000);
  });
});
