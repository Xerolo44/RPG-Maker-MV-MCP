import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assetSizeCap, checkSourcePath } from "../dist/assetFormats.js";
import { encodePng } from "../dist/png.js";
import { Project, ProjectError } from "../dist/project.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const png = (width, height, fill = 0) =>
  encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(fill) });
const ogg = () => Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 1)]);
const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(52, 2)]);

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-import-"));
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.writeFile(path.join(dir, "Game.rpgproject"), "RPGMV 1.6.2");
  await fs.writeFile(path.join(dir, "data", "System.json"), JSON.stringify({ gameTitle: "T" }));
  return dir;
}

async function withServer(fn, { setProject = true } = {}) {
  const dir = await tempProject();
  const src = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-import-src-"));
  const client = new Client({ name: "import-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" }));
  const call = async (name, args) => {
    let res;
    try {
      res = await client.callTool({ name, arguments: args });
    } catch (err) {
      return { isError: true, text: String(err?.message ?? err), json: null };
    }
    const text = res.content?.[0]?.text ?? "";
    return { isError: !!res.isError, text, json: !res.isError && /^[{[]/.test(text) ? JSON.parse(text) : null };
  };
  const source = async (name, bytes) => {
    const file = path.join(src, name);
    await fs.writeFile(file, bytes);
    return file;
  };
  const imgDir = path.join(dir, "img");
  const listImg = async () => {
    const out = [];
    const walk = async (d) => {
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(dir, full).replace(/\\/g, "/"));
      }
    };
    await walk(imgDir);
    await walk(path.join(dir, "audio"));
    return out.sort();
  };
  try {
    if (setProject) assert.equal((await call("set_project", { path: dir })).isError, false);
    await fn({ dir, src, call, source, listImg, at: (rel) => path.join(dir, ...rel.split("/")) });
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

// ---- checkSourcePath (pure, platform passed in so the Windows rules are tested on every OS) ----

test("checkSourcePath accepts plain absolute local paths", () => {
  assert.equal(checkSourcePath("C:\\Users\\me\\Hero.png", "win32"), "C:\\Users\\me\\Hero.png");
  assert.equal(checkSourcePath("D:/art/Hero.png", "win32"), "D:\\art\\Hero.png");
  assert.equal(checkSourcePath("/home/me/Hero.png", "linux"), "/home/me/Hero.png");
  assert.equal(checkSourcePath("/home/me/../me/Hero.png", "darwin"), "/home/me/Hero.png");
});

test("checkSourcePath rejects UNC and device prefixes on every platform before touching the disk", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    for (const p of ["\\\\server\\share\\x.png", "//server/share/x.png", "\\/server/x.png"]) {
      assert.throws(() => checkSourcePath(p, platform), (e) => e instanceof ProjectError && /UNC/.test(e.message), `${platform} ${p}`);
    }
    for (const p of ["\\\\.\\COM1", "\\\\?\\C:\\x.png", "//./COM1", "//?/C:/x.png", "\\\\.\\PhysicalDrive0"]) {
      assert.throws(() => checkSourcePath(p, platform), (e) => e instanceof ProjectError && /[Dd]evice/.test(e.message), `${platform} ${p}`);
    }
  }
});

test("checkSourcePath rejects relative, drive-relative, stream, reserved, control-char and absurd paths", () => {
  const bad = {
    win32: ["x.png", "sub\\x.png", ".\\x.png", "..\\x.png", "\\x.png", "/x.png", "C:x.png", "C:\\a\\x.png:secret",
      "C:\\a\\NUL", "C:\\a\\con.png", "C:\\a\\COM1.txt.png", "C:\\a\\lpt9 .png", "", "C:\\a\\x\0.png", "C:\\a\\x\n.png",
      "C:\\" + "a".repeat(5000)],
    linux: ["x.png", "sub/x.png", "./x.png", "", "/a/x\0.png", "/a/x\r.png", "/" + "a".repeat(5000)],
  };
  for (const [platform, paths] of Object.entries(bad)) {
    for (const p of paths) {
      assert.throws(() => checkSourcePath(p, platform), ProjectError, `${platform} ${JSON.stringify(p.slice(0, 40))}`);
    }
  }
  assert.throws(() => checkSourcePath(42, "linux"), ProjectError);
});

test("assetSizeCap is 32 MiB for images and 128 MiB for audio", () => {
  assert.equal(assetSizeCap("img/pictures"), 32 * 1024 * 1024);
  assert.equal(assetSizeCap("audio/se"), 128 * 1024 * 1024);
});

// ---- Project.writeBinary ----

test("Project.writeBinary writes bytes, keeps a backup of the old file and refuses inside a changeset", async () => {
  const dir = await tempProject();
  try {
    const project = new Project();
    await project.setRoot(dir);
    const file = path.join(dir, "img", "pictures", "A.png");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from([1, 2, 3]));
    await project.writeBinary(file, Buffer.from([4, 5, 6, 7]));
    assert.deepEqual([...(await fs.readFile(file))], [4, 5, 6, 7]);
    const backup = path.join(project.sessionBackupDir, "img", "pictures", "A.png");
    assert.deepEqual([...(await fs.readFile(backup))], [1, 2, 3]);
    assert.deepEqual(await project.externalChanges(), []);

    await assert.rejects(project.writeBinary(path.join(dir, "..", "outside.png"), Buffer.from([1])), ProjectError);

    project.beginChangeset("x");
    await assert.rejects(
      project.writeBinary(file, Buffer.from([9])),
      (e) => e instanceof ProjectError &&
        e.message === "Importing binary files is not supported while a changeset is open. Commit or discard the changeset first.",
    );
    assert.deepEqual([...(await fs.readFile(file))], [4, 5, 6, 7]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- import_asset tool ----

test("imports a PNG byte for byte, the name defaults to the source basename", async () => {
  await withServer(async ({ call, source, at }) => {
    const bytes = png(144, 192, 7);
    const file = await source("$Hero.png", bytes);
    const r = await call("import_asset", { source: file, folder: "img/characters" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json, {
      imported: { path: "img/characters/$Hero.png", type: "png", bytes: bytes.length, width: 144, height: 192 },
      replaced: false,
      warnings: [],
    });
    assert.ok((await fs.readFile(at("img/characters/$Hero.png"))).equals(bytes));
  });
});

test("an explicit name wins and dimension warnings are passed through", async () => {
  await withServer(async ({ call, source, at, listImg }) => {
    const file = await source("whatever.png", png(100, 100));
    const r = await call("import_asset", { source: file, folder: "img/characters", name: "Crowd" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.imported.path, "img/characters/Crowd.png");
    assert.equal(r.json.warnings.length, 1);
    assert.match(r.json.warnings[0], /12/);
    assert.deepEqual(await listImg(), ["img/characters/Crowd.png"]);
    await fs.access(at("img/characters/Crowd.png"));
  });
});

test("a source whose extension lies is typed by its content", async () => {
  await withServer(async ({ call, source }) => {
    const file = await source("Picture.dat", png(4, 4));
    const r = await call("import_asset", { source: file, folder: "img/pictures" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.imported.path, "img/pictures/Picture.png");
  });
});

test("a duplicate needs overwrite; overwrite replaces, reports replaced and keeps a session backup", async () => {
  await withServer(async ({ dir, call, source, at }) => {
    const old = png(4, 4, 1);
    await fs.mkdir(at("img/pictures"), { recursive: true });
    await fs.writeFile(at("img/pictures/Sky.png"), old);
    const fresh = await source("Sky.png", png(4, 4, 200));

    const refused = await call("import_asset", { source: fresh, folder: "img/pictures" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /overwrite/);
    assert.ok((await fs.readFile(at("img/pictures/Sky.png"))).equals(old));

    const r = await call("import_asset", { source: fresh, folder: "img/pictures", overwrite: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.replaced, true);
    assert.ok((await fs.readFile(at("img/pictures/Sky.png"))).equals(await fs.readFile(fresh)));

    const sessions = await fs.readdir(path.join(dir, ".mcp-backups"));
    assert.equal(sessions.length, 1);
    const backup = path.join(dir, ".mcp-backups", sessions[0], "img", "pictures", "Sky.png");
    assert.ok((await fs.readFile(backup)).equals(old));
  });
});

test("a name that differs only by letter case counts as existing; overwrite replaces the existing file", async () => {
  await withServer(async ({ call, source, at, listImg }) => {
    await fs.mkdir(at("img/characters"), { recursive: true });
    const old = png(12, 8, 1);
    await fs.writeFile(at("img/characters/Hero.png"), old);
    const file = await source("hero.png", png(12, 8, 9));

    const refused = await call("import_asset", { source: file, folder: "img/characters" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Hero\.png/);
    assert.match(refused.text, /overwrite/);
    assert.ok((await fs.readFile(at("img/characters/Hero.png"))).equals(old));

    const r = await call("import_asset", { source: file, folder: "img/characters", overwrite: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.replaced, true);
    assert.equal(r.json.imported.path, "img/characters/Hero.png");
    assert.ok(r.json.warnings.some((w) => /letter case/.test(w)));
    assert.deepEqual(await listImg(), ["img/characters/Hero.png"]);
    assert.ok((await fs.readFile(at("img/characters/Hero.png"))).equals(await fs.readFile(file)));
  });
});

test("an existing destination that is not a regular file is never replaced", async () => {
  await withServer(async ({ call, source, at }) => {
    await fs.mkdir(at("img/pictures/Sky.png"), { recursive: true });
    const file = await source("Sky.png", png(4, 4));
    const r = await call("import_asset", { source: file, folder: "img/pictures", overwrite: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /not a regular file/);
    assert.ok((await fs.stat(at("img/pictures/Sky.png"))).isDirectory());
  });
});

test("content that does not fit the folder is refused and nothing is written", async () => {
  await withServer(async ({ call, source, listImg }) => {
    const text = await source("Fake.png", "this is only text, not an image at all, but long enough.");
    const r1 = await call("import_asset", { source: text, folder: "img/pictures" });
    assert.equal(r1.isError, true);
    assert.match(r1.text, /PNG/);
    assert.ok(!r1.text.includes("this is only text"), "error must not echo file contents");

    const r2 = await call("import_asset", { source: await source("Face.ogg", ogg()), folder: "img/faces" });
    assert.equal(r2.isError, true);
    const r3 = await call("import_asset", { source: await source("Song.png", png(4, 4)), folder: "audio/bgm" });
    assert.equal(r3.isError, true);
    assert.deepEqual(await listImg(), []);
  });
});

test("hostile or unusable source paths are refused with nothing written", async () => {
  await withServer(async ({ src, call, source, listImg }) => {
    const empty = await source("Empty.png", Buffer.alloc(0));
    const cases = [
      ["Hero.png", /absolute/],
      [path.join("sub", "Hero.png"), /absolute/],
      [src, /not a regular file/],
      [empty, /empty/],
      [path.join(src, "Missing.png"), /not found/],
      ["\\\\server\\share\\x.png", /UNC/],
      ["\\\\.\\COM1", /[Dd]evice/],
      ["\\\\?\\C:\\x.png", /[Dd]evice/],
    ];
    for (const [p, re] of cases) {
      const r = await call("import_asset", { source: p, folder: "img/pictures", name: "Pic" });
      assert.equal(r.isError, true, p);
      assert.match(r.text, re, p);
    }
    assert.deepEqual(await listImg(), []);
  });
});

test("a symlinked source is refused", async (t) => {
  await withServer(async ({ src, call, source, listImg }) => {
    const real = await source("Real.png", png(4, 4));
    const link = path.join(src, "Link.png");
    try {
      await fs.symlink(real, link, "file");
    } catch (err) {
      t.skip(`cannot create symlinks here (${err.code})`);
      return;
    }
    const r = await call("import_asset", { source: link, folder: "img/pictures" });
    assert.equal(r.isError, true);
    assert.match(r.text, /symbolic link/);
    assert.deepEqual(await listImg(), []);
  });
});

test("a source above the size cap is refused from its size alone", async () => {
  await withServer(async ({ src, call, listImg }) => {
    const big = path.join(src, "Big.png");
    const fh = await fs.open(big, "w");
    await fh.truncate(32 * 1024 * 1024 + 1);
    await fh.close();
    const r = await call("import_asset", { source: big, folder: "img/pictures" });
    assert.equal(r.isError, true);
    assert.match(r.text, /MiB/);
    assert.deepEqual(await listImg(), []);
  });
});

test("bad names are refused: ../x, CON, a.png, and a basename that is not a valid name", async () => {
  await withServer(async ({ call, source, listImg }) => {
    const file = await source("Pic.png", png(4, 4));
    for (const name of ["../x", "CON", "a.png", "", "x/y"]) {
      const r = await call("import_asset", { source: file, folder: "img/pictures", name });
      assert.equal(r.isError, true, name);
      assert.match(r.text, /Invalid asset name/, name);
    }
    const dotted = await source("my.hero.png", png(4, 4));
    const r = await call("import_asset", { source: dotted, folder: "img/pictures" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Invalid asset name/);
    assert.deepEqual(await listImg(), []);
  });
});

test("an unknown folder is rejected by the schema", async () => {
  await withServer(async ({ call, source, listImg }) => {
    const file = await source("Pic.png", png(4, 4));
    for (const folder of ["img/evil", "../img/pictures", "img/pictures/", "data"]) {
      const r = await call("import_asset", { source: file, folder });
      assert.equal(r.isError, true, folder);
    }
    assert.deepEqual(await listImg(), []);
  });
});

test("inside an open changeset the import is refused before the source is touched", async () => {
  await withServer(async ({ src, call, source, listImg }) => {
    const file = await source("Pic.png", png(4, 4));
    assert.equal((await call("begin_changeset", { label: "import" })).isError, false);
    const r = await call("import_asset", { source: file, folder: "img/pictures" });
    assert.equal(r.isError, true);
    assert.match(r.text, /changeset is open/);
    // a missing source gives the same answer: the changeset check runs before any file access
    const missing = await call("import_asset", { source: path.join(src, "Nope.png"), folder: "img/pictures" });
    assert.match(missing.text, /changeset is open/);
    assert.deepEqual(await listImg(), []);
    assert.equal((await call("discard_changeset", {})).isError, false);
    const ok = await call("import_asset", { source: file, folder: "img/pictures" });
    assert.equal(ok.isError, false, ok.text);
  });
});

test("audio imports warn when the sibling format is missing, and the other format is not a duplicate", async () => {
  await withServer(async ({ call, source, at }) => {
    const r1 = await call("import_asset", { source: await source("Theme.ogg", ogg()), folder: "audio/bgm" });
    assert.equal(r1.isError, false, r1.text);
    assert.deepEqual(r1.json.imported, { path: "audio/bgm/Theme.ogg", type: "ogg", bytes: 64 });
    assert.equal(r1.json.warnings.length, 1);
    assert.match(r1.json.warnings[0], /Theme\.m4a/);
    assert.match(r1.json.warnings[0], /MV's web build needs both/);

    const r2 = await call("import_asset", { source: await source("Theme.m4a", m4a()), folder: "audio/bgm" });
    assert.equal(r2.isError, false, r2.text);
    assert.equal(r2.json.imported.path, "audio/bgm/Theme.m4a");
    assert.equal(r2.json.replaced, false);
    assert.deepEqual(r2.json.warnings, []);
    await fs.access(at("audio/bgm/Theme.ogg"));
  });
});

test("no project selected", async () => {
  await withServer(
    async ({ call, source }) => {
      const r = await call("import_asset", { source: await source("Pic.png", png(4, 4)), folder: "img/pictures" });
      assert.equal(r.isError, true);
      assert.match(r.text, /No project selected/);
    },
    { setProject: false },
  );
});
