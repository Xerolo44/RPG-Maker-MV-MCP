import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Project } from "../dist/project.js";
import { auditAssets, collectAssetRefs } from "../dist/assets.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const cmd = (code, ...parameters) => ({ code, indent: 0, parameters });
const page = (list, characterName = "") => ({ image: { characterName, characterIndex: 0 }, list });

/** Builds a temp project; `files` are touched on disk (paths relative to the project root). */
async function tempProject({ files = [], data = {}, withFolders = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mvmcp-assets-"));
  await fs.mkdir(path.join(dir, "data"));
  for (const [name, value] of Object.entries(data)) {
    await fs.writeFile(path.join(dir, "data", name), JSON.stringify(value), "utf8");
  }
  if (withFolders) {
    for (const f of files) {
      await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await fs.writeFile(path.join(dir, f), "x");
    }
  }
  const project = new Project();
  await project.setRoot(dir);
  return { dir, project };
}

async function withProject(opts, fn) {
  const ctx = await tempProject(opts);
  try {
    await fn(ctx);
  } finally {
    await fs.rm(ctx.dir, { recursive: true, force: true });
  }
}

const baseData = () => ({
  "MapInfos.json": [null, { id: 3, name: "Cave" }],
  "Map003.json": {
    width: 1,
    height: 1,
    bgm: { name: "Theme1", volume: 90, pan: 0, pitch: 100 },
    events: [
      null,
      { id: 1, name: "a", pages: [] },
      {
        id: 5,
        name: "Npc",
        pages: [page([cmd(101, "Ghost", 0, 0, 2), cmd(401, "hi"), cmd(0)], "Hero")],
      },
    ],
  },
});

const baseFiles = ["audio/bgm/Theme1.m4a", "img/characters/hero.png", "img/characters/Spare.png"];

test("reports missing face Ghost with its referencing event", async () => {
  await withProject({ files: baseFiles, data: baseData() }, async ({ project }) => {
    const audit = await auditAssets(project, { includeUnused: true });
    const ghost = audit.missing.find((m) => m.path === "img/faces/Ghost.png");
    assert.ok(ghost, JSON.stringify(audit.missing));
    assert.deepEqual(ghost.referencedBy, ["Map003 event 5"]);
  });
});

test("reports Hero as caseMismatch not missing", async () => {
  await withProject({ files: baseFiles, data: baseData() }, async ({ project }) => {
    const audit = await auditAssets(project, { includeUnused: true });
    assert.ok(!audit.missing.some((m) => m.path.includes("Hero")));
    assert.deepEqual(audit.caseMismatch, [
      { referenced: "img/characters/Hero.png", actual: "img/characters/hero.png", referencedBy: ["Map003 event 5"] },
    ]);
  });
});

test("does not report ogg when only m4a exists as missing", async () => {
  await withProject({ files: baseFiles, data: baseData() }, async ({ project }) => {
    const audit = await auditAssets(project, { includeUnused: true });
    assert.ok(!audit.missing.some((m) => m.path.includes("Theme1")));
    assert.ok(!audit.caseMismatch.some((m) => m.referenced.includes("Theme1")));
  });
});

test("lists Spare.png as unused but not referenced-by-case files", async () => {
  await withProject({ files: baseFiles, data: baseData() }, async ({ project }) => {
    const audit = await auditAssets(project, { includeUnused: true });
    assert.deepEqual(audit.unused, ["img/characters/Spare.png"]);
    assert.ok(audit.checkedFolders.includes("img/characters"));
    assert.ok(audit.checkedFolders.includes("audio/bgm"));
  });
});

test("skips unused scan when includeUnused is false", async () => {
  await withProject({ files: baseFiles, data: baseData() }, async ({ project }) => {
    const audit = await auditAssets(project, { includeUnused: false });
    assert.deepEqual(audit.unused, []);
    assert.equal(audit.missing.length, 1);
  });
});

test("tolerates a map with events [null] and a page without list", async () => {
  const data = {
    "MapInfos.json": [null, { id: 1 }, { id: 2 }],
    "Map001.json": { events: [null], bgm: null },
    "Map002.json": { events: [null, { id: 1, pages: [{ image: { characterName: "Missing" } }, null, {}] }] },
  };
  await withProject({ data }, async ({ project }) => {
    const audit = await auditAssets(project, { includeUnused: true });
    assert.deepEqual(audit.missing.map((m) => m.path), ["img/characters/Missing.png"]);
  });
});

test("treats a project without img/ and audio/ as everything missing", async () => {
  await withProject({ data: baseData(), withFolders: false }, async ({ project, dir }) => {
    const audit = await auditAssets(project, { includeUnused: true });
    assert.deepEqual(audit.missing.map((m) => m.path).sort(), [
      "audio/bgm/Theme1(.ogg|.m4a)",
      "img/characters/Hero.png",
      "img/faces/Ghost.png",
    ]);
    assert.deepEqual(audit.caseMismatch, []);
    assert.deepEqual(audit.unused, []);
    await assert.rejects(fs.access(path.join(dir, "img")));
  });
});

test("collects the documented fields and event commands", async () => {
  const data = {
    "Actors.json": [null, { id: 1, characterName: "A_c", faceName: "A_f", battlerName: "A_b" }],
    "Enemies.json": [null, { id: 1, battlerName: "Slime" }],
    "Tilesets.json": [null, { id: 1, tilesetNames: ["T_a", "", "T_b"] }],
    "System.json": {
      optSideView: true,
      title1Name: "Title1",
      title2Name: "",
      battleback1Name: "SysBb1",
      titleBgm: { name: "TitleBgm" },
      battleBgm: { name: "BattleBgm" },
      victoryMe: { name: "Win" },
      boat: { bgm: { name: "BoatBgm" } },
      sounds: [{ name: "Cursor" }, { name: "" }],
    },
    "MapInfos.json": [null, { id: 1 }],
    "Map001.json": {
      parallaxName: "Sky",
      bgs: { name: "Rain" },
      battleback1Name: "Bb1",
      battleback2Name: "Bb2",
      events: [
        null,
        {
          id: 2,
          pages: [
            {
              image: { characterName: "Npc" },
              list: [
                cmd(231, 1, "Pic"),
                cmd(241, { name: "Song" }),
                cmd(245, { name: "Wind" }),
                cmd(249, { name: "Fanfare" }),
                cmd(250, { name: "Beep" }),
                cmd(322, 1, "Chr", 0, "Fce", 0, "Btl"),
                cmd(0),
              ],
            },
          ],
        },
      ],
    },
  };
  await withProject({ data }, async ({ project }) => {
    const refs = await collectAssetRefs(project);
    const keys = refs.map((r) => `${r.folder}/${r.name}`).sort();
    assert.deepEqual(keys, [
      "audio/bgm/BattleBgm", "audio/bgm/BoatBgm", "audio/bgm/Song", "audio/bgm/TitleBgm",
      "audio/bgs/Rain", "audio/bgs/Wind",
      "audio/me/Fanfare", "audio/me/Win",
      "audio/se/Beep", "audio/se/Cursor",
      "img/battlebacks1/Bb1", "img/battlebacks1/SysBb1", "img/battlebacks2/Bb2",
      "img/characters/A_c", "img/characters/Chr", "img/characters/Npc",
      "img/faces/A_f", "img/faces/Fce",
      "img/parallaxes/Sky", "img/pictures/Pic",
      "img/sv_actors/A_b", "img/sv_actors/Btl", "img/sv_enemies/Slime",
      "img/tilesets/T_a", "img/tilesets/T_b", "img/titles1/Title1",
    ].sort());
    const audio = refs.find((r) => r.name === "Song");
    assert.deepEqual(audio.ext, [".ogg", ".m4a"]);
    assert.equal(audio.source, "Map001 event 2");
  });
});

test("scans commands 132/133/139/140/283/284/323 and ignores empty names", async () => {
  const data = {
    "CommonEvents.json": [
      null,
      {
        id: 1,
        list: [
          cmd(132, { name: "BattleSong", volume: 90, pan: 0, pitch: 100 }),
          cmd(133, { name: "WinMe" }),
          cmd(139, { name: "LoseMe" }),
          cmd(140, 1, { name: "ShipSong" }),
          cmd(283, "BackA", "BackB"),
          cmd(284, "Clouds", true, true, 0, 0),
          cmd(323, 2, "ShipSheet", 0),
          cmd(0),
        ],
      },
      {
        id: 2,
        list: [
          cmd(132, { name: "" }),
          cmd(133, {}),
          cmd(139),
          cmd(140, 0, { name: "" }),
          cmd(283, "", ""),
          cmd(284, ""),
          cmd(323, 0, "", 0),
          cmd(0),
        ],
      },
    ],
  };
  await withProject({ data }, async ({ project }) => {
    const refs = await collectAssetRefs(project);
    const keys = refs.map((r) => `${r.folder}/${r.name}`).sort();
    assert.deepEqual(keys, [
      "audio/bgm/BattleSong", "audio/bgm/ShipSong", "audio/me/LoseMe", "audio/me/WinMe",
      "img/battlebacks1/BackA", "img/battlebacks2/BackB", "img/characters/ShipSheet", "img/parallaxes/Clouds",
    ]);
    assert.deepEqual(refs.find((r) => r.name === "WinMe").ext, [".ogg", ".m4a"]);
    assert.deepEqual(refs.find((r) => r.name === "Clouds").ext, [".png"]);
    assert.equal(refs.find((r) => r.name === "ShipSheet").source, "CommonEvent 1");
  });
});

test("audit_assets reports the newly scanned commands as missing or satisfied", async () => {
  const data = {
    "CommonEvents.json": [
      null,
      { id: 1, list: [cmd(133, { name: "WinMe" }), cmd(283, "BackA", "Gone"), cmd(284, "Clouds"), cmd(0)] },
    ],
  };
  const files = ["audio/me/WinMe.ogg", "img/battlebacks1/BackA.png", "img/parallaxes/Clouds.png"];
  await withProject({ data, files }, async ({ project }) => {
    const audit = await auditAssets(project, { includeUnused: true });
    assert.deepEqual(audit.missing, [{ path: "img/battlebacks2/Gone.png", referencedBy: ["CommonEvent 1"] }]);
    assert.deepEqual(audit.unused, []);
  });
});

test("audit_assets before set_project returns the No project selected error", async () => {
  const client = new Client({ name: "assets-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, RPGMV_TOOLS: "" },
      stderr: "ignore",
    }),
  );
  try {
    const res = await client.callTool({ name: "audit_assets", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No project selected/);
  } finally {
    await client.close();
  }
});

test("audit_assets caps each list at 200 and reports truncated counts", async () => {
  const actors = [null];
  for (let i = 1; i <= 205; i++) actors.push({ id: i, faceName: `Face${i}` });
  await withProject({ data: { "Actors.json": actors } }, async ({ dir }) => {
    const client = new Client({ name: "assets-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry, "--project", dir],
        env: { ...process.env, RPGMV_TOOLS: "" },
        stderr: "ignore",
      }),
    );
    try {
      const res = await client.callTool({ name: "audit_assets", arguments: {} });
      const out = JSON.parse(res.content[0].text);
      assert.equal(out.missing.length, 200);
      assert.equal(out.truncated.missing, 5);
      assert.equal(out.truncated.caseMismatch, 0);
      assert.ok(Array.isArray(out.notScanned));
    } finally {
      await client.close();
    }
  });
});
