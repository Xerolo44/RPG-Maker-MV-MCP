// Scans a project's data files for asset references (images, audio) and checks them against
// the files on disk. Pure logic: the tool wrapper lives in tools/analysisTools.ts.
import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "./project.js";

export interface AssetRef {
  /** Folder relative to the project root, e.g. `img/characters`, `audio/bgm`. */
  folder: string;
  name: string;
  /** Candidate extensions; any one existing satisfies the reference. */
  ext: string[];
  /** Where it was referenced, e.g. `Map003 event 5`. */
  source: string;
}

export interface AssetAudit {
  missing: { path: string; referencedBy: string[] }[];
  caseMismatch: { referenced: string; actual: string; referencedBy: string[] }[];
  unused: string[];
  checkedFolders: string[];
}

const IMG = [".png"];
const AUDIO = [".ogg", ".m4a"];
const MAX_SOURCES = 10;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Folders that are scanned for a project (enemies use sv_enemies only in side-view mode). */
function scannedFolders(sideView: boolean): string[] {
  return [
    "img/characters",
    "img/faces",
    "img/sv_actors",
    sideView ? "img/sv_enemies" : "img/enemies",
    "img/tilesets",
    "img/parallaxes",
    "img/battlebacks1",
    "img/battlebacks2",
    "img/pictures",
    "img/titles1",
    "img/titles2",
    "audio/bgm",
    "audio/bgs",
    "audio/me",
    "audio/se",
  ];
}

const AUDIO_FOLDER: Record<string, string> = {
  241: "audio/bgm",
  245: "audio/bgs",
  249: "audio/me",
  250: "audio/se",
};

/** Reads a data file through the project (so staged changes count); a missing file yields null. */
async function readData(project: Project, name: string): Promise<unknown | null> {
  const file = project.dataFile(name);
  if (!(await project.exists(file))) return null;
  return project.readJson(file);
}

async function mapIds(project: Project): Promise<number[]> {
  const ids = new Set<number>();
  const infos = await readData(project, "MapInfos.json");
  for (const info of asArray(infos)) {
    if (isObj(info) && typeof info.id === "number") ids.add(info.id);
  }
  try {
    for (const f of await fs.readdir(project.dataFile(""))) {
      const m = /^Map(\d+)\.json$/i.exec(f);
      if (m) ids.add(Number(m[1]));
    }
  } catch {
    // no data folder: only MapInfos ids (if any) are used
  }
  return [...ids].filter((id) => id > 0).sort((a, b) => a - b);
}

export async function collectAssetRefs(project: Project): Promise<AssetRef[]> {
  void project.root; // throws the standard "No project selected" error before anything else
  const refs: AssetRef[] = [];
  const add = (folder: string, ext: string[], name: unknown, source: string): void => {
    const n = str(name);
    if (n !== "") refs.push({ folder, name: n, ext, source });
  };
  const addAudio = (folder: string, audio: unknown, source: string): void => {
    if (isObj(audio)) add(folder, AUDIO, audio.name, source);
  };

  const scanList = (list: unknown, source: string): void => {
    for (const c of asArray(list)) {
      if (!isObj(c)) continue;
      const p = asArray(c.parameters);
      switch (c.code) {
        case 101:
          add("img/faces", IMG, p[0], source);
          break;
        case 231:
          add("img/pictures", IMG, p[1], source);
          break;
        case 241:
        case 245:
        case 249:
        case 250:
          addAudio(AUDIO_FOLDER[c.code as number], p[0], source);
          break;
        case 322:
          add("img/characters", IMG, p[1], source);
          add("img/faces", IMG, p[3], source);
          add("img/sv_actors", IMG, p[5], source);
          break;
      }
    }
  };

  const system = await readData(project, "System.json");
  const sys: Obj = isObj(system) ? system : {};
  const sideView = sys.optSideView === true;

  for (const a of asArray(await readData(project, "Actors.json"))) {
    if (!isObj(a)) continue;
    const source = `Actor ${a.id}`;
    add("img/characters", IMG, a.characterName, source);
    add("img/faces", IMG, a.faceName, source);
    add("img/sv_actors", IMG, a.battlerName, source);
  }
  for (const e of asArray(await readData(project, "Enemies.json"))) {
    if (!isObj(e)) continue;
    add(sideView ? "img/sv_enemies" : "img/enemies", IMG, e.battlerName, `Enemy ${e.id}`);
  }
  for (const t of asArray(await readData(project, "Tilesets.json"))) {
    if (!isObj(t)) continue;
    for (const n of asArray(t.tilesetNames)) add("img/tilesets", IMG, n, `Tileset ${t.id}`);
  }
  for (const ce of asArray(await readData(project, "CommonEvents.json"))) {
    if (isObj(ce)) scanList(ce.list, `CommonEvent ${ce.id}`);
  }
  for (const troop of asArray(await readData(project, "Troops.json"))) {
    if (!isObj(troop)) continue;
    for (const page of asArray(troop.pages)) {
      if (isObj(page)) scanList(page.list, `Troop ${troop.id}`);
    }
  }

  for (const id of await mapIds(project)) {
    const source = `Map${String(id).padStart(3, "0")}`;
    const map = await readData(project, `Map${String(id).padStart(3, "0")}.json`);
    if (!isObj(map)) continue;
    add("img/parallaxes", IMG, map.parallaxName, source);
    addAudio("audio/bgm", map.bgm, source);
    addAudio("audio/bgs", map.bgs, source);
    add("img/battlebacks1", IMG, map.battleback1Name, source);
    add("img/battlebacks2", IMG, map.battleback2Name, source);
    for (const ev of asArray(map.events)) {
      if (!isObj(ev)) continue;
      const evSource = `${source} event ${ev.id}`;
      for (const page of asArray(ev.pages)) {
        if (!isObj(page)) continue;
        if (isObj(page.image)) add("img/characters", IMG, page.image.characterName, evSource);
        scanList(page.list, evSource);
      }
    }
  }

  if (system !== null) {
    add("img/titles1", IMG, sys.title1Name, "System");
    add("img/titles2", IMG, sys.title2Name, "System");
    add("img/battlebacks1", IMG, sys.battleback1Name, "System");
    add("img/battlebacks2", IMG, sys.battleback2Name, "System");
    addAudio("audio/bgm", sys.titleBgm, "System");
    addAudio("audio/bgm", sys.battleBgm, "System");
    addAudio("audio/me", sys.victoryMe, "System");
    addAudio("audio/me", sys.defeatMe, "System");
    addAudio("audio/me", sys.gameoverMe, "System");
    for (const vehicle of ["boat", "ship", "airship"]) {
      const v = sys[vehicle];
      if (isObj(v)) addAudio("audio/bgm", v.bgm, "System");
    }
    for (const s of asArray(sys.sounds)) addAudio("audio/se", s, "System");
  }
  return refs;
}

function limitSources(sources: Set<string>): string[] {
  const all = [...sources];
  if (all.length <= MAX_SOURCES) return all;
  return [...all.slice(0, MAX_SOURCES), `+${all.length - MAX_SOURCES} more`];
}

const extLabel = (ext: string[]): string => (ext.length === 1 ? ext[0] : `(${ext.join("|")})`);

export async function auditAssets(project: Project, opts: { includeUnused: boolean }): Promise<AssetAudit> {
  const root = project.root;
  const refs = await collectAssetRefs(project);
  const system = await readData(project, "System.json");
  const sideView = isObj(system) && system.optSideView === true;
  const checkedFolders = scannedFolders(sideView);

  const listings = new Map<string, string[] | null>();
  const listFolder = async (folder: string): Promise<string[] | null> => {
    if (!listings.has(folder)) {
      try {
        listings.set(folder, await fs.readdir(path.join(root, folder)));
      } catch {
        listings.set(folder, null);
      }
    }
    return listings.get(folder) ?? null;
  };

  const missing = new Map<string, Set<string>>();
  const mismatch = new Map<string, { actual: string; sources: Set<string> }>();
  /** `folder/lowercased name` of every referenced asset (extension stripped). */
  const used = new Set<string>();

  for (const ref of refs) {
    used.add(`${ref.folder}/${ref.name.toLowerCase()}`);
    const files = (await listFolder(ref.folder)) ?? [];
    const wanted = ref.ext.map((e) => ref.name + e);
    if (wanted.some((w) => files.includes(w))) continue;

    const lower = new Set(wanted.map((w) => w.toLowerCase()));
    const actual = files.find((f) => lower.has(f.toLowerCase()));
    if (actual !== undefined) {
      const referenced = `${ref.folder}/${wanted[0]}`;
      const entry = mismatch.get(`${referenced}\0${actual}`) ?? { actual: `${ref.folder}/${actual}`, sources: new Set() };
      entry.sources.add(ref.source);
      mismatch.set(`${referenced}\0${actual}`, entry);
      continue;
    }
    const key = `${ref.folder}/${ref.name}${extLabel(ref.ext)}`;
    const sources = missing.get(key) ?? new Set<string>();
    sources.add(ref.source);
    missing.set(key, sources);
  }

  const unused: string[] = [];
  if (opts.includeUnused) {
    for (const folder of checkedFolders) {
      const exts = folder.startsWith("audio/") ? AUDIO : IMG;
      for (const file of (await listFolder(folder)) ?? []) {
        const ext = path.extname(file);
        if (!exts.includes(ext.toLowerCase())) continue;
        if (!used.has(`${folder}/${file.slice(0, file.length - ext.length).toLowerCase()}`)) {
          unused.push(`${folder}/${file}`);
        }
      }
    }
  }

  return {
    missing: [...missing].map(([p, s]) => ({ path: p, referencedBy: limitSources(s) })),
    caseMismatch: [...mismatch].map(([k, v]) => ({
      referenced: k.slice(0, k.indexOf("\0")),
      actual: v.actual,
      referencedBy: limitSources(v.sources),
    })),
    unused,
    checkedFolders,
  };
}
