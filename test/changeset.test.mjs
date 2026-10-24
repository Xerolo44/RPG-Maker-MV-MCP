import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Project, ProjectError } from "../dist/project.js";
import { summarizeChange } from "../dist/changeset.js";

const MAP_ORIGINAL = '{"width":2,"height":1,"data":[0,0],"events":[null]}';
const ACTORS_ORIGINAL = '[\n null ,\n{"id":1,"name":"Harold"}\n]';

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-changeset-"));
  await fs.mkdir(path.join(dir, "data"));
  // Deliberately not in the server's own serialization, so byte-for-byte restores are checked.
  await fs.writeFile(path.join(dir, "data", "Map001.json"), MAP_ORIGINAL, "utf8");
  await fs.writeFile(path.join(dir, "data", "Actors.json"), ACTORS_ORIGINAL, "utf8");
  const project = new Project();
  await project.setRoot(dir);
  return { dir, project };
}

async function withProject(fn) {
  const ctx = await tempProject();
  try {
    await fn(ctx);
  } finally {
    await fs.rm(ctx.dir, { recursive: true, force: true });
  }
}

const exists = (file) => fs.access(file).then(() => true, () => false);
const read = (file) => fs.readFile(file, "utf8");
const changesetDirs = async (dir) => {
  try {
    return await fs.readdir(path.join(dir, ".mcp-backups", "changesets"));
  } catch {
    return [];
  }
};

test("summarizeChange counts added, removed and changed events on a map", () => {
  const ev = (id, name) => ({ id, name, x: 0, y: 0, pages: [] });
  const before = { data: [1, 2, 3, 4], events: [null, ev(1, "A"), ev(2, "B"), ev(3, "C")] };
  const after = { data: [1, 9, 9, 4], events: [null, ev(1, "A"), null, ev(3, "C2"), ev(4, "D"), ev(5, "E")] };
  assert.equal(summarizeChange("data/Map001.json", before, after), "events +2 −1 ~1, tiles changed: 2");
});

test("summarizeChange lists changed ids in a database array", () => {
  const rec = (id, name) => ({ id, name });
  const before = [null, rec(1, "a"), rec(2, "b"), rec(3, "c"), rec(4, "d"), rec(5, "e"), rec(6, "f"), rec(7, "g"), rec(8, "h"), rec(9, "i")];
  const after = [...before];
  after[4] = rec(4, "D");
  after[7] = rec(7, "G");
  after[9] = rec(9, "I");
  after[10] = rec(10, "new");
  assert.equal(summarizeChange("data/Items.json", before, after), "records +1 −0 ~3 (ids 4, 7, 9)");
});

test("summarizeChange falls back to created / changed", () => {
  assert.equal(summarizeChange("data/System.json", { a: 1 }, { a: 2 }), "changed");
  assert.equal(summarizeChange("js/plugins/New.js", null, "code"), "created");
  assert.equal(summarizeChange("data/Map002.json", null, { data: [], events: [null] }), "created");
});

test("staged writes do not touch disk until commit", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("stage test");
    assert.equal(project.changesetActive, true);
    await project.writeJson(project.mapFile(1), { width: 2, height: 1, data: [5, 5], events: [null] });
    await project.writeText(path.join(dir, "js", "plugins", "New.js"), "// new\n");
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
    assert.equal(await exists(path.join(dir, "js", "plugins", "New.js")), false);
    assert.equal(await exists(path.join(dir, ".mcp-backups")), false, "no session backup before commit");
  });
});

test("reads see staged content", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("read test");
    await project.writeJson(project.mapFile(1), { width: 2, height: 1, data: [5, 5], events: [null] });
    const plugin = path.join(dir, "js", "plugins", "New.js");
    await project.writeText(plugin, "// staged\n");
    assert.deepEqual((await project.readJson(project.mapFile(1))).data, [5, 5]);
    assert.equal(await project.readText(plugin), "// staged\n");
    // relative / unnormalized paths hit the same staged entry
    assert.equal(await project.readText(path.join(dir, "js", ".", "plugins", "New.js")), "// staged\n");
    assert.equal(await project.exists(plugin), true);
    assert.equal(await project.readText(project.dataFile("Actors.json")), ACTORS_ORIGINAL);
  });
});

test("commit writes all files and returns a summary", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("add chest");
    const map = await project.readJson(project.mapFile(1));
    map.events.push({ id: 1, name: "Chest", x: 0, y: 0, pages: [] });
    map.data[1] = 7;
    await project.writeJson(project.mapFile(1), map);
    const plugin = path.join(dir, "js", "plugins", "New.js");
    await project.writeText(plugin, "// new\n");
    const summary = await project.commitChangeset();

    assert.equal(project.changesetActive, false);
    assert.equal(summary.label, "add chest");
    assert.match(summary.id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/);
    assert.deepEqual(
      summary.files.map((f) => [f.path, f.change, f.summary]).sort(),
      [
        ["data/Map001.json", "modified", "events +1 −0 ~0, tiles changed: 1"],
        ["js/plugins/New.js", "created", "created"],
      ]
    );
    // MV editor serialization: objects compact on one line
    assert.equal(await read(project.mapFile(1)), JSON.stringify(map));
    assert.equal(await read(plugin), "// new\n");

    // journal: manifest + pre-image of the modified file only
    const journal = path.join(dir, ".mcp-backups", "changesets", summary.id);
    const manifest = JSON.parse(await read(path.join(journal, "manifest.json")));
    assert.equal(manifest.id, summary.id);
    assert.equal(manifest.label, "add chest");
    assert.deepEqual(
      manifest.files.sort((a, b) => a.path.localeCompare(b.path)),
      [{ path: "data/Map001.json", existed: true }, { path: "js/plugins/New.js", existed: false }]
    );
    assert.equal(await read(path.join(journal, "files", "data", "Map001.json")), MAP_ORIGINAL);
    // session backup taken at commit time
    const sessions = (await project.listBackupSessions()).map((s) => s.files);
    assert.ok(sessions.some((files) => files.includes("data/Map001.json")));
    // no temp files left behind
    assert.deepEqual((await fs.readdir(path.join(dir, "data"))).filter((f) => f.endsWith(".mcp-tmp")), []);
    assert.deepEqual(await project.externalChanges(), []);
  });
});

test("undo restores modified files byte-for-byte and deletes created ones", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("edit");
    await project.writeJson(project.mapFile(1), { width: 2, height: 1, data: [5, 5], events: [null] });
    await project.writeJson(project.dataFile("Actors.json"), [null, { id: 1, name: "Changed" }]);
    const plugin = path.join(dir, "js", "plugins", "New.js");
    await project.writeText(plugin, "// new\n");
    const committed = await project.commitChangeset();

    const undone = await project.undoLastChangeset();
    assert.equal(undone.id, committed.id);
    assert.equal(undone.label, "edit");
    assert.deepEqual(
      undone.files.map((f) => [f.path, f.change]).sort(),
      [["data/Actors.json", "restored"], ["data/Map001.json", "restored"], ["js/plugins/New.js", "removed"]]
    );
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
    assert.equal(await read(project.dataFile("Actors.json")), ACTORS_ORIGINAL);
    assert.equal(await exists(plugin), false);
    assert.deepEqual(await changesetDirs(dir), [], "journal entry is consumed");
    assert.deepEqual(await project.externalChanges(), []);
  });
});

test("undo can be repeated back through two commits", async () => {
  await withProject(async ({ project }) => {
    const actors = project.dataFile("Actors.json");
    project.beginChangeset("first");
    await project.writeJson(actors, [null, { id: 1, name: "One" }]);
    await project.commitChangeset();
    const afterFirst = await read(actors);
    project.beginChangeset("second");
    await project.writeJson(actors, [null, { id: 1, name: "Two" }]);
    await project.commitChangeset();

    assert.equal((await project.undoLastChangeset()).label, "second");
    assert.equal(await read(actors), afterFirst);
    assert.equal((await project.undoLastChangeset()).label, "first");
    assert.equal(await read(actors), ACTORS_ORIGINAL);
    await assert.rejects(project.undoLastChangeset(), (err) => err instanceof ProjectError && /No committed changeset/.test(err.message));
  });
});

test("discard leaves disk unchanged and clears staging", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("throwaway");
    await project.writeJson(project.mapFile(1), { data: [9], events: [null] });
    project.discardChangeset();
    assert.equal(project.changesetActive, false);
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
    assert.equal(await project.readText(project.mapFile(1)), MAP_ORIGINAL);
    assert.deepEqual(await changesetDirs(dir), []);
    assert.throws(() => project.discardChangeset(), (err) => err instanceof ProjectError && /No changeset is open/.test(err.message));
  });
});

test("begin twice throws", async () => {
  await withProject(async ({ project }) => {
    project.beginChangeset("one");
    await project.writeJson(project.mapFile(1), { data: [1], events: [null] });
    assert.throws(() => project.beginChangeset("two"), (err) => err instanceof ProjectError && /already open/.test(err.message));
    // the first changeset and its staged edit survive
    assert.equal(project.changesetActive, true);
    assert.deepEqual((await project.readJson(project.mapFile(1))).data, [1]);
  });
});

test("commit with nothing active throws", async () => {
  await withProject(async ({ dir, project }) => {
    await assert.rejects(project.commitChangeset(), (err) => err instanceof ProjectError && /No changeset is open/.test(err.message));
    assert.equal(project.changesetActive, false);
    assert.deepEqual(await changesetDirs(dir), []);
  });
});

test("undo while a changeset is open throws and changes nothing", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("one");
    await project.writeJson(project.dataFile("Actors.json"), [null]);
    await project.commitChangeset();
    project.beginChangeset("two");
    await assert.rejects(project.undoLastChangeset(), (err) => err instanceof ProjectError && /open/.test(err.message));
    assert.equal(project.changesetActive, true);
    assert.equal((await changesetDirs(dir)).length, 1);
  });
});

test("commit with invalid staged JSON writes nothing", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("broken");
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    await project.writeText(project.dataFile("Actors.json"), "{");
    await assert.rejects(project.commitChangeset(), (err) => err instanceof ProjectError && /Actors\.json/.test(err.message));
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
    assert.equal(await read(project.dataFile("Actors.json")), ACTORS_ORIGINAL);
    assert.deepEqual(await changesetDirs(dir), []);
    assert.equal(await exists(path.join(dir, ".mcp-backups")), false);
    // still open so the edit can be fixed or discarded
    assert.equal(project.changesetActive, true);
  });
});

test("a failed rename rolls back the files already renamed", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("half");
    await project.writeJson(project.dataFile("Actors.json"), [null, { id: 1, name: "New" }]);
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    await project.writeText(path.join(dir, "js", "plugins", "New.js"), "// new\n");
    const realRename = fs.rename;
    let calls = 0;
    fs.rename = async (from, to) => {
      if (++calls === 3) throw new Error("simulated rename failure");
      return realRename(from, to);
    };
    try {
      await assert.rejects(project.commitChangeset(), /simulated rename failure/);
    } finally {
      fs.rename = realRename;
    }
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
    assert.equal(await read(project.dataFile("Actors.json")), ACTORS_ORIGINAL);
    assert.equal(await exists(path.join(dir, "js", "plugins", "New.js")), false);
    for (const sub of ["data", path.join("js", "plugins")]) {
      const left = (await fs.readdir(path.join(dir, sub))).filter((f) => f.endsWith(".mcp-tmp"));
      assert.deepEqual(left, [], `no temps in ${sub}`);
    }
    assert.deepEqual(await changesetDirs(dir), [], "failed commit leaves no journal entry");
    assert.equal(project.changesetActive, true);
  });
});

test("externalChanges stays empty after commit and undo", async () => {
  await withProject(async ({ project }) => {
    // files tracked from an earlier plain write
    await project.writeJson(project.dataFile("Actors.json"), [null, { id: 1, name: "Plain" }]);
    project.beginChangeset("tracked");
    await project.writeJson(project.dataFile("Actors.json"), [null, { id: 1, name: "Staged" }]);
    await project.writeJson(project.dataFile("Items.json"), [null]);
    assert.deepEqual(await project.externalChanges(), []);
    await project.commitChangeset();
    assert.deepEqual(await project.externalChanges(), []);
    await project.undoLastChangeset();
    assert.deepEqual(await project.externalChanges(), []);
  });
});

test("setRoot removes leftover *.mcp-tmp files", async () => {
  await withProject(async ({ dir, project }) => {
    const tmp = path.join(dir, "data", "Map001.json.mcp-tmp");
    await fs.writeFile(tmp, "partial", "utf8");
    await fs.mkdir(path.join(dir, "js", "plugins"), { recursive: true });
    const pluginTmp = path.join(dir, "js", "plugins", "X.js.mcp-tmp");
    await fs.writeFile(pluginTmp, "partial", "utf8");
    await project.setRoot(dir);
    assert.equal(await exists(tmp), false);
    assert.equal(await exists(pluginTmp), false);
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
  });
});

test("setRoot rolls back a commit interrupted between renames", async () => {
  await withProject(async ({ dir, project }) => {
    const actors = project.dataFile("Actors.json");
    const plugin = path.join(dir, "js", "plugins", "New.js");
    project.beginChangeset("torn");
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    await project.writeJson(actors, [null, { id: 1, name: "New" }]);
    await project.writeText(plugin, "// new\n");
    const { id } = await project.commitChangeset();
    const journal = path.join(dir, ".mcp-backups", "changesets", id);
    assert.equal(await exists(path.join(journal, "committed")), true, "commit marker written");

    // Simulate a kill during step 4: Map001 and New.js were renamed, Actors still waits as a temp.
    await fs.rm(path.join(journal, "committed"));
    const newActors = await read(actors);
    await fs.writeFile(actors, ACTORS_ORIGINAL, "utf8");
    await fs.writeFile(actors + ".mcp-tmp", newActors, "utf8");

    const fresh = new Project();
    await fresh.setRoot(dir);
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
    assert.equal(await read(actors), ACTORS_ORIGINAL);
    assert.equal(await exists(actors + ".mcp-tmp"), false);
    assert.equal(await exists(plugin), false);
    assert.deepEqual(await changesetDirs(dir), [], "journal entry dropped");
    assert.deepEqual(fresh.recoveredChangesets, [id]);
    await assert.rejects(fresh.undoLastChangeset(), /No committed changeset/);
  });
});

test("setRoot keeps a fully committed changeset", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("done");
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    await project.commitChangeset();
    const committed = await read(project.mapFile(1));
    const fresh = new Project();
    await fresh.setRoot(dir);
    assert.equal(await read(project.mapFile(1)), committed);
    assert.equal((await changesetDirs(dir)).length, 1);
    assert.deepEqual(fresh.recoveredChangesets, []);
    assert.equal((await fresh.undoLastChangeset()).label, "done");
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
  });
});

test("setRoot removes a crashed journal folder that has no manifest", async () => {
  await withProject(async ({ dir, project }) => {
    const crashed = path.join(dir, ".mcp-backups", "changesets", "2026-01-01T00-00-00-000Z");
    await fs.mkdir(path.join(crashed, "files", "data"), { recursive: true });
    await fs.writeFile(path.join(crashed, "files", "data", "Map001.json"), MAP_ORIGINAL, "utf8");
    await project.setRoot(dir);
    assert.deepEqual(await changesetDirs(dir), []);
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
  });
});

test("undo with a missing pre-image restores nothing", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("two files");
    await project.writeJson(project.dataFile("Actors.json"), [null, { id: 1, name: "New" }]);
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    const { id } = await project.commitChangeset();
    const actorsAfter = await read(project.dataFile("Actors.json"));
    const mapAfter = await read(project.mapFile(1));
    await fs.rm(path.join(dir, ".mcp-backups", "changesets", id, "files", "data", "Map001.json"));
    await assert.rejects(
      project.undoLastChangeset(),
      (err) => err instanceof ProjectError && /Map001\.json/.test(err.message) && /nothing was restored/i.test(err.message)
    );
    assert.equal(await read(project.dataFile("Actors.json")), actorsAfter);
    assert.equal(await read(project.mapFile(1)), mapAfter);
    assert.deepEqual(await changesetDirs(dir), [id]);
  });
});

test("writes and changeset calls are refused while a commit or undo is running", async () => {
  await withProject(async ({ project }) => {
    project.beginChangeset("busy");
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    const committing = project.commitChangeset();
    const busy = (err) => err instanceof ProjectError && /in progress/.test(err.message);
    await assert.rejects(project.writeJson(project.dataFile("Actors.json"), [null]), busy);
    await assert.rejects(project.writeText(project.dataFile("Items.json"), "[null]"), busy);
    assert.throws(() => project.beginChangeset("other"), busy);
    assert.throws(() => project.discardChangeset(), busy);
    await assert.rejects(project.commitChangeset(), busy);
    await committing;
    assert.equal(await read(project.dataFile("Actors.json")), ACTORS_ORIGINAL, "refused write never landed");

    const undoing = project.undoLastChangeset();
    await assert.rejects(project.writeJson(project.dataFile("Actors.json"), [null]), busy);
    await assert.rejects(project.undoLastChangeset(), busy);
    await undoing;
    assert.equal(await read(project.mapFile(1)), MAP_ORIGINAL);
    // once finished, writes work again
    await project.writeJson(project.dataFile("Items.json"), [null]);
  });
});

test("setRoot discards an open changeset", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("lost");
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    await project.setRoot(dir);
    assert.equal(project.changesetActive, false);
    assert.equal(await project.readText(project.mapFile(1)), MAP_ORIGINAL);
  });
});

test("the changesets journal is not treated as a backup session", async () => {
  await withProject(async ({ dir, project }) => {
    project.beginChangeset("journal");
    await project.writeJson(project.mapFile(1), { data: [3], events: [null] });
    await project.commitChangeset();
    const sessions = await project.listBackupSessions();
    assert.ok(sessions.length >= 1);
    assert.ok(sessions.every((s) => s.session !== "changesets"));

    // pruning never deletes the journal, even with many old sessions around
    for (let i = 0; i < 12; i++) {
      const old = path.join(dir, ".mcp-backups", `2000-01-01T00-00-${String(i).padStart(2, "0")}`, "data");
      await fs.mkdir(old, { recursive: true });
      await fs.writeFile(path.join(old, "Items.json"), "[null]");
    }
    await project.writeJson(project.dataFile("Actors.json"), [null]); // first backup of Actors -> prune
    assert.equal((await changesetDirs(dir)).length, 1);
    const after = await project.listBackupSessions();
    assert.equal(after.length, 10, "ten real sessions kept");
  });
});

test("writeText outside a changeset backs up, writes and records", async () => {
  await withProject(async ({ dir, project }) => {
    const plugin = path.join(dir, "js", "plugins.js");
    await fs.mkdir(path.dirname(plugin), { recursive: true });
    await fs.writeFile(plugin, "old", "utf8");
    await project.writeText(plugin, "new");
    assert.equal(await read(plugin), "new");
    const sessions = await project.listBackupSessions();
    assert.ok(sessions[0].files.includes("js/plugins.js"));
    assert.deepEqual(await project.externalChanges(), []);
  });
});
