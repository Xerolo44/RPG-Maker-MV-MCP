import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Project } from "../dist/project.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-editor-"));
  await fs.mkdir(path.join(dir, "data"));
  const project = new Project();
  await project.setRoot(dir);
  return { dir, project };
}

test("externalChanges is empty right after our own write", async () => {
  const { dir, project } = await tempProject();
  try {
    await project.writeJson(project.dataFile("Actors.json"), [null, { id: 1 }]);
    assert.deepEqual(await project.externalChanges(), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("externalChanges lists a file rewritten behind our back", async () => {
  const { dir, project } = await tempProject();
  try {
    const file = project.dataFile("Actors.json");
    await project.writeJson(file, [null, { id: 1 }]);
    await sleep(20);
    await fs.writeFile(file, '[null,{"id":1,"name":"changed by editor"}]', "utf8");
    assert.deepEqual(await project.externalChanges(), ["data/Actors.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a file deleted behind our back counts as changed", async () => {
  const { dir, project } = await tempProject();
  try {
    const file = project.dataFile("Actors.json");
    await project.writeJson(file, [null]);
    await fs.rm(file);
    assert.deepEqual(await project.externalChanges(), ["data/Actors.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rewriting through writeJson again clears the entry", async () => {
  const { dir, project } = await tempProject();
  try {
    const file = project.dataFile("Actors.json");
    await project.writeJson(file, [null, { id: 1 }]);
    await sleep(20);
    await fs.writeFile(file, '[null,{"id":1,"name":"changed by editor"}]', "utf8");
    assert.equal((await project.externalChanges()).length, 1);
    await project.writeJson(file, [null, { id: 1, name: "ours again" }]);
    assert.deepEqual(await project.externalChanges(), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("files we never wrote are not reported", async () => {
  const { dir, project } = await tempProject();
  try {
    await fs.writeFile(project.dataFile("Items.json"), "[null]", "utf8");
    await sleep(20);
    await fs.writeFile(project.dataFile("Items.json"), "[null,{}]", "utf8");
    assert.deepEqual(await project.externalChanges(), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("recordWrite accepts a file written outside writeJson", async () => {
  const { dir, project } = await tempProject();
  try {
    const file = project.dataFile("Actors.json");
    await project.writeJson(file, [null]);
    await sleep(20);
    await fs.writeFile(file, "[null,{}]", "utf8");
    assert.equal((await project.externalChanges()).length, 1);
    await project.recordWrite(file);
    assert.deepEqual(await project.externalChanges(), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("setRoot forgets earlier write signatures", async () => {
  const { dir, project } = await tempProject();
  try {
    const file = project.dataFile("Actors.json");
    await project.writeJson(file, [null]);
    await fs.rm(file);
    await project.setRoot(dir);
    assert.deepEqual(await project.externalChanges(), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reading Project.root before setRoot throws \"No project selected\"", () => {
  const project = new Project();
  assert.throws(() => project.root, /No project selected/);
});

test("editorProcessRunning returns a boolean, or null when the OS is unsupported", async () => {
  const { editorProcessRunning } = await import("../dist/editorStatus.js");
  const result = await editorProcessRunning();
  assert.ok(result === null || typeof result === "boolean");
});
