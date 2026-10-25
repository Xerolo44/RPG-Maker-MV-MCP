// Test helper (not a test: the runner only executes test/*.test.mjs).
// Builds a temporary MV-shaped project from plain objects and returns a Project pointed at it.
//
//   const { root, project, cleanup } = await createFixtureProject({ maps: { 1: { events: [null, event(1, [page([...])])] } } });
//   try { ... } finally { await cleanup(); }
//
// Spec (every key optional; arrays are written verbatim, so supply the leading `null` of MV arrays yourself):
//   system        object merged over { startMapId: 1, partyMembers: [1], switches: [""], variables: [""], ... }
//   maps          { [id]: object merged over { width: 17, height: 13, encounterList: [], events: [null] } }
//                 a string value is written raw (malformed JSON); `null` writes no file (an unreadable map)
//   mapInfos      array written as MapInfos.json; default: [null, {id, name:"Map<id>"}...] for every key of `maps`
//   commonEvents, troops, actors, classes, enemies, items, skills
//                 arrays for CommonEvents/Troops/Actors/Classes/Enemies/Items/Skills.json; default [null]
//   files         { "Name.json": value } extra raw files in data/ (string = written verbatim)
//
// Exports:
//   createFixtureProject(spec?) -> Promise<{ root, project, cleanup }>
//   c(code, indent, ...parameters)  an event command;  END  the list terminator
//   page(list, extra?)              a map event page (all-false conditions, trigger 0); `extra.conditions` is merged
//   event(id, pages, extra?)        a map event { id, name, x, y, pages }
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Project } from "../../dist/project.js";

export const c = (code, indent = 0, ...parameters) => ({ code, indent, parameters });
export const END = c(0, 0);

export const page = (list = [END], extra = {}) => {
  const { conditions, ...rest } = extra;
  return {
    conditions: {
      actorId: 1,
      actorValid: false,
      itemId: 1,
      itemValid: false,
      selfSwitchCh: "A",
      selfSwitchValid: false,
      switch1Id: 1,
      switch1Valid: false,
      switch2Id: 1,
      switch2Valid: false,
      variableId: 1,
      variableValid: false,
      variableValue: 0,
      ...conditions,
    },
    list,
    trigger: 0,
    ...rest,
  };
};

export const event = (id, pages = [page()], extra = {}) => ({ id, name: `EV${String(id).padStart(3, "0")}`, x: 0, y: 0, pages, ...extra });

const mapFileName = (id) => `Map${String(id).padStart(3, "0")}.json`;

export async function createFixtureProject(spec = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-fixture-"));
  const dir = path.join(root, "data");
  await fs.mkdir(dir);
  const put = (name, value) => fs.writeFile(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value), "utf8");

  const maps = spec.maps ?? { 1: {} };
  await put("System.json", {
    gameTitle: "Fixture",
    startMapId: 1,
    startX: 0,
    startY: 0,
    partyMembers: [1],
    switches: [""],
    variables: [""],
    ...(spec.system ?? {}),
  });
  await put(
    "MapInfos.json",
    spec.mapInfos ?? [null, ...Object.keys(maps).map(Number).sort((a, b) => a - b).map((id) => ({ id, name: `Map${id}`, parentId: 0, order: id }))],
  );
  for (const [id, value] of Object.entries(maps)) {
    if (value === null) continue;
    await put(mapFileName(Number(id)), typeof value === "string" ? value : { width: 17, height: 13, encounterList: [], events: [null], ...value });
  }
  const tables = {
    "CommonEvents.json": spec.commonEvents,
    "Troops.json": spec.troops,
    "Actors.json": spec.actors,
    "Classes.json": spec.classes,
    "Enemies.json": spec.enemies,
    "Items.json": spec.items,
    "Skills.json": spec.skills,
  };
  for (const [name, value] of Object.entries(tables)) await put(name, value ?? [null]);
  for (const [name, value] of Object.entries(spec.files ?? {})) await put(name, value);

  const project = new Project();
  await project.setRoot(root);
  return { root, project, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
