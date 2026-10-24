import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { diffMaps } from "../dist/mapDiff.js";
import { renderMapBitmap } from "../dist/render.js";

const map = (width, height, over = {}) => ({
  width, height, data: new Array(width * height * 6).fill(0), events: [null], ...over,
});
const ev = (id, x, y, extra = {}) => ({ id, name: `E${id}`, x, y, pages: [], ...extra });

test("identical maps give an empty diff", () => {
  const a = map(3, 2, { events: [null, ev(1, 0, 0)] });
  const b = map(3, 2, { events: [null, ev(1, 0, 0)] });
  assert.deepEqual(diffMaps(a, b), {
    sizeChanged: false,
    changedCells: [],
    events: { added: [], removed: [], moved: [], edited: [] },
  });
});

test("a single changed tile on layer 2 appears once in changedCells", () => {
  const a = map(3, 2);
  const b = map(3, 2);
  b.data[(2 * 2 + 1) * 3 + 2] = 7; // layer 2, y=1, x=2
  const d = diffMaps(a, b);
  assert.deepEqual(d.changedCells, [{ x: 2, y: 1 }]);
  assert.equal(d.sizeChanged, false);
});

test("added, removed, moved and edited events are classified", () => {
  const before = map(4, 4, { events: [null, ev(1, 0, 0), ev(2, 1, 1), ev(3, 2, 2), ev(4, 3, 3), ev(5, 0, 1)] });
  const after = map(4, 4, {
    events: [null, ev(1, 0, 0), null, ev(3, 3, 2), ev(4, 3, 3, { name: "Renamed" }), ev(5, 1, 1, { name: "Both" }), ev(6, 2, 0)],
  });
  const d = diffMaps(before, after);
  assert.deepEqual(d.events.added, [6]);
  assert.deepEqual(d.events.removed, [2]);
  assert.deepEqual(d.events.moved, [3, 5]);
  assert.deepEqual(d.events.edited, [4, 5]);
});

test("different sizes set sizeChanged and compare the overlap", () => {
  const a = map(3, 3);
  const b = map(2, 2);
  b.data[(0 * 2 + 1) * 2 + 1] = 9; // layer 0, (1,1) in the 2x2 map
  const d = diffMaps(a, b);
  assert.equal(d.sizeChanged, true);
  assert.deepEqual(d.changedCells, [{ x: 1, y: 1 }]);
});

test("null event slots are ignored", () => {
  const a = map(2, 2, { events: [null, null, ev(2, 0, 0)] });
  const b = map(2, 2, { events: [null, ev(1, 1, 1), ev(2, 0, 0), null] });
  assert.deepEqual(diffMaps(a, b).events, { added: [1], removed: [], moved: [], edited: [] });
});

test("outlines draw a yellow border pixel on the outlined cell", () => {
  const yellow = [255, 220, 0];
  const base = {
    width: 3, height: 1, data: new Array(18).fill(0), flags: [], sheets: {}, tileSize: 24, grid: false,
    regions: false, passability: false, tileEvents: [], sprites: [], markers: [],
    region: { x: 0, y: 0, width: 3, height: 1 },
  };
  const px = (bmp, x, y) => [...bmp.data.slice((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3)];
  const plain = renderMapBitmap(base).bitmap;
  const out = renderMapBitmap({ ...base, outlines: [{ x: 1, y: 0, color: yellow }] }).bitmap;
  assert.deepEqual(px(out, 24, 0), yellow, "top-left corner of cell 1");
  assert.deepEqual(px(out, 24 + 23, 23), yellow, "bottom-right corner of cell 1");
  assert.deepEqual(px(out, 24 + 12, 12), px(plain, 24 + 12, 12), "cell centre untouched");
  assert.deepEqual(px(out, 5, 5), px(plain, 5, 5), "other cells untouched");
  assert.doesNotThrow(() => renderMapBitmap({ ...base, outlines: undefined }));
});

// ---- tool level -----------------------------------------------------------------------------

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function connect() {
  const client = new Client({ name: "mapdiff-test", version: "0.0.0" });
  return client
    .connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, RPGMV_TOOLS: "" }, stderr: "ignore" }))
    .then(() => client);
}

async function withClient(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mv-mcp-diff-"));
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.writeFile(path.join(dir, "Game.rpgproject"), "RPGMV 1.6.2");
  const current = map(4, 4, { tilesetId: 1 });
  current.data[(0 * 4 + 1) * 4 + 1] = 2816;
  await fs.writeFile(path.join(dir, "data", "Map001.json"), JSON.stringify(current));
  const client = await connect();
  try {
    await fn({ dir, client });
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const call = (client, args) => client.callTool({ name: "render_diff", arguments: args });
const writeBackup = async (dir, folder, mapFile) => {
  const file = path.join(dir, ".mcp-backups", ...folder, "data", "Map001.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(mapFile));
};

test("render_diff before set_project returns the No project selected error", async () => {
  const client = await connect();
  try {
    const res = await call(client, { mapId: 1 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No project selected/);
  } finally {
    await client.close();
  }
});

test("render_diff with no backup returns a non-error text result", async () => {
  await withClient(async ({ dir, client }) => {
    await client.callTool({ name: "set_project", arguments: { path: dir } });
    const res = await call(client, { mapId: 1 });
    assert.notEqual(res.isError, true);
    assert.equal(res.content.length, 1);
    assert.match(res.content[0].text, /no earlier version/);
  });
});

test("render_diff rejects path traversal in against.session and against.changeset", async () => {
  await withClient(async ({ dir, client }) => {
    await client.callTool({ name: "set_project", arguments: { path: dir } });
    const bad = [{ session: "../x" }, { session: "a/b" }, { session: "a\\b" }, { session: ".." }, { changeset: "../../x" }, { changeset: "a/b" }];
    for (const against of bad) {
      const res = await call(client, { mapId: 1, against });
      assert.equal(res.isError, true, JSON.stringify(against));
      assert.match(res.content[0].text, /plain folder name/, JSON.stringify(against));
    }
  });
});

test("render_diff against a session backup reports changes and returns a PNG", async () => {
  await withClient(async ({ dir, client }) => {
    await writeBackup(dir, ["2026-01-01T00-00-00"], map(4, 4, { tilesetId: 1 }));
    await client.callTool({ name: "set_project", arguments: { path: dir } });
    const res = await call(client, { mapId: 1 });
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /1 changed cell/);
    assert.match(res.content[0].text, /\(1,1\)/);
    const png = res.content.find((c) => c.type === "image");
    assert.equal(png.mimeType, "image/png");
    assert.ok(Buffer.from(png.data, "base64").subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])));
    // a named session that does not exist is a text result, not a crash
    const missing = await call(client, { mapId: 1, against: { session: "nope" } });
    assert.notEqual(missing.isError, true);
    assert.match(missing.content[0].text, /no earlier version|not found/i);
  });
});

test("render_diff against a changeset pre-image", async () => {
  await withClient(async ({ dir, client }) => {
    await writeBackup(dir, ["changesets", "2026-01-01T00-00-00", "files"], map(4, 4, { tilesetId: 1 }));
    // a committed journal entry survives set_project's crash recovery
    const journal = path.join(dir, ".mcp-backups", "changesets", "2026-01-01T00-00-00");
    await fs.writeFile(path.join(journal, "manifest.json"), JSON.stringify({ label: "test", files: [] }));
    await fs.writeFile(path.join(journal, "committed"), "");
    await client.callTool({ name: "set_project", arguments: { path: dir } });
    const res = await call(client, { mapId: 1, against: { changeset: "2026-01-01T00-00-00" } });
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /1 changed cell/);
  });
});
