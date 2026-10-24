import fs from "node:fs/promises";
import path from "node:path";
import { summarizeChange, type ChangesetManifest, type ChangesetSummary } from "./changeset.js";

export type { ChangesetSummary } from "./changeset.js";

/**
 * Database types that live in data/<Name>.json as 1-indexed arrays
 * (index 0 is always null in RPG Maker MV data files).
 */
export const DATABASE_TYPES = [
  "actors",
  "classes",
  "skills",
  "items",
  "weapons",
  "armors",
  "enemies",
  "troops",
  "states",
  "animations",
  "tilesets",
  "commonEvents",
] as const;

export type DatabaseType = (typeof DATABASE_TYPES)[number];

const DATABASE_FILES: Record<DatabaseType, string> = {
  actors: "Actors.json",
  classes: "Classes.json",
  skills: "Skills.json",
  items: "Items.json",
  weapons: "Weapons.json",
  armors: "Armors.json",
  enemies: "Enemies.json",
  troops: "Troops.json",
  states: "States.json",
  animations: "Animations.json",
  tilesets: "Tilesets.json",
  commonEvents: "CommonEvents.json",
};

export class ProjectError extends Error {}

export const BACKUP_DIR_NAME = ".mcp-backups";
/** Changeset journal folder inside .mcp-backups (not a backup session). */
export const CHANGESET_DIR_NAME = "changesets";
const MAX_BACKUP_SESSIONS = 10;
/** Suffix of the temp files a changeset commit writes before renaming them into place. */
const TEMP_SUFFIX = ".mcp-tmp";

const toPosix = (p: string): string => p.replace(/\\/g, "/");

function parseOrRaw(text: string | null, isJson: boolean): unknown {
  if (text === null || !isJson) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class Project {
  private rootDir: string | null = null;
  private sessionStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  private backedUp = new Set<string>();
  /** Size/mtime of each file this server last wrote, keyed by absolute path. */
  private writeSignatures = new Map<string, { size: number; mtimeMs: number }>();
  /** Open changeset: staged file texts keyed by resolved absolute path. */
  private changeset: { label: string; staged: Map<string, string> } | null = null;

  get root(): string {
    if (!this.rootDir) {
      throw new ProjectError(
        "No project selected. Call set_project with the path to an RPG Maker MV project folder first."
      );
    }
    return this.rootDir;
  }

  get isOpen(): boolean {
    return this.rootDir !== null;
  }

  async setRoot(dir: string): Promise<void> {
    const resolved = path.resolve(dir);
    let entries: string[];
    try {
      entries = await fs.readdir(resolved);
    } catch {
      throw new ProjectError(`Cannot read directory: ${resolved}`);
    }
    const hasProjectFile = entries.some(
      (e) => e.toLowerCase().endsWith(".rpgproject") || e.toLowerCase().endsWith(".rmmzproject")
    );
    const hasDataDir = entries.some((e) => e.toLowerCase() === "data");
    if (!hasProjectFile && !hasDataDir) {
      throw new ProjectError(
        `${resolved} does not look like an RPG Maker MV/MZ project (no *.rpgproject or *.rmmzproject file and no data/ folder).`
      );
    }
    this.rootDir = resolved;
    this.backedUp.clear();
    this.writeSignatures.clear();
    this.changeset = null;
    await this.removeLeftoverTemps();
  }

  get backupRoot(): string {
    return path.join(this.root, BACKUP_DIR_NAME);
  }

  get changesetRoot(): string {
    return path.join(this.backupRoot, CHANGESET_DIR_NAME);
  }

  get sessionBackupDir(): string {
    return path.join(this.backupRoot, this.sessionStamp);
  }

  /**
   * Snapshot a project file into .mcp-backups/<session>/ before its first
   * modification this session, so every editing session can be rolled back.
   */
  async backup(filePath: string): Promise<void> {
    if (this.backedUp.has(filePath)) return;
    const rel = path.relative(this.root, filePath);
    if (rel.startsWith("..") || rel.startsWith(BACKUP_DIR_NAME)) return;
    this.backedUp.add(filePath);
    try {
      await fs.access(filePath);
    } catch {
      return; // brand-new file, nothing to snapshot
    }
    const dest = path.join(this.sessionBackupDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(filePath, dest);
    await this.pruneBackups();
  }

  private async pruneBackups(): Promise<void> {
    let sessions: string[];
    try {
      sessions = (await fs.readdir(this.backupRoot)).filter((e) => e !== CHANGESET_DIR_NAME).sort();
    } catch {
      return;
    }
    while (sessions.length > MAX_BACKUP_SESSIONS) {
      const oldest = sessions.shift()!;
      if (oldest === this.sessionStamp) continue;
      await fs.rm(path.join(this.backupRoot, oldest), { recursive: true, force: true });
    }
  }

  async listBackupSessions(): Promise<{ session: string; files: string[] }[]> {
    let sessions: string[];
    try {
      sessions = (await fs.readdir(this.backupRoot))
        .filter((e) => e !== CHANGESET_DIR_NAME)
        .sort()
        .reverse();
    } catch {
      return [];
    }
    const result: { session: string; files: string[] }[] = [];
    for (const session of sessions) {
      const dir = path.join(this.backupRoot, session);
      const files: string[] = [];
      const walk = async (d: string): Promise<void> => {
        for (const entry of await fs.readdir(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) await walk(full);
          else files.push(path.relative(dir, full).replace(/\\/g, "/"));
        }
      };
      try {
        await walk(dir);
      } catch {
        continue;
      }
      result.push({ session, files });
    }
    return result;
  }

  dataFile(name: string): string {
    return path.join(this.root, "data", name);
  }

  databaseFile(type: DatabaseType): string {
    return this.dataFile(DATABASE_FILES[type]);
  }

  mapFile(mapId: number): string {
    return this.dataFile(`Map${String(mapId).padStart(3, "0")}.json`);
  }

  /** Read a project text file; while a changeset is open, its staged content wins. */
  async readText(filePath: string): Promise<string> {
    const staged = this.changeset?.staged.get(path.resolve(filePath));
    if (staged !== undefined) return staged;
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      throw new ProjectError(`File not found: ${filePath}`);
    }
  }

  /** True if the file is staged in the open changeset or exists on disk. */
  async exists(filePath: string): Promise<boolean> {
    if (this.changeset?.staged.has(path.resolve(filePath))) return true;
    return fs.access(filePath).then(
      () => true,
      () => false
    );
  }

  async readJson<T = unknown>(filePath: string): Promise<T> {
    const raw = await this.readText(filePath);
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new ProjectError(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
    }
  }

  /**
   * Write JSON the way the MV editor does: arrays with one element per line,
   * objects as a single compact line. Keeps diffs readable and the editor happy.
   */
  async writeJson(filePath: string, value: unknown): Promise<void> {
    let text: string;
    if (Array.isArray(value)) {
      const lines = value.map((el) => JSON.stringify(el));
      text = "[\n" + lines.join(",\n") + "\n]";
    } else {
      text = JSON.stringify(value);
    }
    await this.writeText(filePath, text);
  }

  /**
   * Write a project text file (UTF-8). Outside a changeset: session backup, write,
   * recordWrite. Inside one: only staged in memory (backup deferred to commit).
   */
  async writeText(filePath: string, text: string): Promise<void> {
    if (this.changeset) {
      const abs = path.resolve(filePath);
      this.relativeInProject(abs);
      this.changeset.staged.set(abs, text);
      return;
    }
    await this.backup(filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, "utf8");
    await this.recordWrite(filePath);
  }

  get changesetActive(): boolean {
    return this.changeset !== null;
  }

  /** Start staging writes in memory. Throws if a changeset is already open. */
  beginChangeset(label: string): void {
    this.root; // throws if no project is selected
    if (this.changeset) {
      throw new ProjectError(
        `A changeset ("${this.changeset.label}") is already open. Commit it with commit_changeset or drop it with discard_changeset before starting another.`
      );
    }
    this.changeset = { label, staged: new Map() };
  }

  /** Drop every staged write. Nothing on disk changes. */
  discardChangeset(): void {
    if (!this.changeset) throw new ProjectError("No changeset is open. Start one with begin_changeset.");
    this.changeset = null;
  }

  /**
   * Write every staged file to disk as one unit: (1) validate staged .json, (2) journal
   * pre-images + manifest, session backups, (3) write <file>.mcp-tmp, (4) rename each over
   * its target. A failed rename restores the files already replaced and removes the temps.
   */
  async commitChangeset(): Promise<ChangesetSummary> {
    const cs = this.changeset;
    if (!cs) throw new ProjectError("No changeset is open. Start one with begin_changeset.");
    const entries = [...cs.staged].map(([abs, text]) => ({
      abs,
      rel: toPosix(this.relativeInProject(abs)),
      text,
      isJson: abs.toLowerCase().endsWith(".json"),
    }));

    // (1) validate
    for (const e of entries) {
      if (!e.isJson) continue;
      try {
        JSON.parse(e.text);
      } catch (err) {
        throw new ProjectError(
          `Staged ${e.rel} is not valid JSON (${(err as Error).message}). Nothing was written; the changeset is still open, so fix the file or call discard_changeset.`
        );
      }
    }

    const id = await this.newChangesetId();
    if (entries.length === 0) {
      this.changeset = null;
      return { id, label: cs.label, files: [] };
    }

    // (2) journal + session backups
    const journal = path.join(this.changesetRoot, id);
    const before = new Map<string, Buffer | null>();
    try {
      for (const e of entries) {
        let bytes: Buffer | null = null;
        try {
          bytes = await fs.readFile(e.abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        before.set(e.abs, bytes);
        if (bytes) {
          const dest = path.join(journal, "files", e.rel);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, bytes);
        }
      }
      const manifest: ChangesetManifest = {
        id,
        label: cs.label,
        files: entries.map((e) => ({ path: e.rel, existed: before.get(e.abs) !== null })),
      };
      await fs.mkdir(journal, { recursive: true });
      await fs.writeFile(path.join(journal, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      for (const e of entries) await this.backup(e.abs);
    } catch (err) {
      await fs.rm(journal, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // (3) temps
    try {
      for (const e of entries) {
        await fs.mkdir(path.dirname(e.abs), { recursive: true });
        await fs.writeFile(e.abs + TEMP_SUFFIX, e.text, "utf8");
      }
    } catch (err) {
      for (const e of entries) await fs.rm(e.abs + TEMP_SUFFIX, { force: true }).catch(() => {});
      await fs.rm(journal, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // (4) renames
    let done = 0;
    try {
      for (const e of entries) {
        await fs.rename(e.abs + TEMP_SUFFIX, e.abs);
        done++;
      }
    } catch (err) {
      let rollbackOk = true;
      for (const e of entries.slice(0, done)) {
        const bytes = before.get(e.abs) ?? null;
        try {
          if (bytes) {
            await fs.writeFile(e.abs, bytes);
            await this.recordWrite(e.abs);
          } else {
            await fs.rm(e.abs, { force: true });
            this.forgetWrite(e.abs);
          }
        } catch {
          rollbackOk = false;
        }
      }
      for (const e of entries.slice(done)) await fs.rm(e.abs + TEMP_SUFFIX, { force: true }).catch(() => {});
      if (rollbackOk) await fs.rm(journal, { recursive: true, force: true }).catch(() => {});
      throw new ProjectError(
        `Commit failed while replacing ${entries[done].rel}: ${(err as Error).message}. ` +
          (rollbackOk
            ? "Files already replaced were restored, so nothing changed on disk; the changeset is still open."
            : `Some files could not be restored; call undo_changeset to roll back to the journal ${id}.`)
      );
    }

    for (const e of entries) await this.recordWrite(e.abs);
    this.changeset = null;
    return {
      id,
      label: cs.label,
      files: entries.map((e) => {
        const prev = before.get(e.abs) ?? null;
        return {
          path: e.rel,
          change: prev ? "modified" : "created",
          summary: summarizeChange(e.rel, parseOrRaw(prev?.toString("utf8") ?? null, e.isJson), parseOrRaw(e.text, e.isJson)),
        };
      }),
    };
  }

  /**
   * Roll back the most recent committed changeset from its journal: restore pre-images
   * byte-for-byte, delete files it created, then drop the journal entry.
   */
  async undoLastChangeset(): Promise<ChangesetSummary> {
    if (this.changeset) {
      throw new ProjectError(
        `A changeset ("${this.changeset.label}") is open. Commit or discard it before undo_changeset.`
      );
    }
    const ids = await this.listChangesetIds();
    const id = ids[ids.length - 1];
    if (!id) throw new ProjectError("No committed changeset to undo.");
    const journal = path.join(this.changesetRoot, id);
    let manifest: ChangesetManifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(journal, "manifest.json"), "utf8")) as ChangesetManifest;
      if (!Array.isArray(manifest.files)) throw new Error("no file list");
    } catch (err) {
      throw new ProjectError(`Changeset journal ${journal} is unreadable: ${(err as Error).message}`);
    }

    const files: ChangesetSummary["files"] = [];
    for (const f of manifest.files) {
      const target = this.resolveInProject(f.path);
      const isJson = target.toLowerCase().endsWith(".json");
      const current = await fs.readFile(target, "utf8").catch(() => null);
      await this.backup(target);
      if (f.existed) {
        let bytes: Buffer;
        try {
          bytes = await fs.readFile(path.join(journal, "files", f.path));
        } catch {
          throw new ProjectError(`Changeset journal ${id} is missing its copy of ${f.path}; nothing more was restored.`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target + TEMP_SUFFIX, bytes);
        await fs.rename(target + TEMP_SUFFIX, target);
        await this.recordWrite(target);
        files.push({
          path: f.path,
          change: "restored",
          summary: summarizeChange(f.path, parseOrRaw(current, isJson), parseOrRaw(bytes.toString("utf8"), isJson)),
        });
      } else {
        await fs.rm(target, { force: true });
        this.forgetWrite(target);
        files.push({ path: f.path, change: "removed", summary: "removed (it did not exist before the changeset)" });
      }
    }
    await fs.rm(journal, { recursive: true, force: true });
    return { id, label: manifest.label, files };
  }

  /** Committed changeset ids (journal folders with a manifest), oldest first. */
  private async listChangesetIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.changesetRoot);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const e of entries.sort()) {
      const ok = await fs.access(path.join(this.changesetRoot, e, "manifest.json")).then(
        () => true,
        () => false
      );
      if (ok) ids.push(e);
    }
    return ids;
  }

  private async newChangesetId(): Promise<string> {
    const base = new Date().toISOString().replace(/[:.]/g, "-");
    let id = base;
    for (let n = 1; await this.exists(path.join(this.changesetRoot, id)); n++) id = `${base}-${n}`;
    return id;
  }

  /** Project-relative path of an absolute path; throws if it is outside the project. */
  private relativeInProject(abs: string): string {
    const rel = path.relative(this.root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ProjectError(`${abs} is outside the project folder and cannot be part of a changeset.`);
    }
    return rel;
  }

  private resolveInProject(rel: string): string {
    const abs = path.resolve(this.root, rel);
    this.relativeInProject(abs);
    return abs;
  }

  /**
   * Delete *.mcp-tmp files a crashed commit may have left: in data/, js/, js/plugins/ and
   * the folders of every file in the newest journal entry (the only commit that can be torn).
   */
  private async removeLeftoverTemps(): Promise<void> {
    const dirs = new Set([
      path.join(this.root, "data"),
      path.join(this.root, "js"),
      path.join(this.root, "js", "plugins"),
    ]);
    const ids = await this.listChangesetIds();
    const last = ids[ids.length - 1];
    if (last) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(this.changesetRoot, last, "manifest.json"), "utf8")
        ) as ChangesetManifest;
        for (const f of manifest.files) dirs.add(path.dirname(this.resolveInProject(f.path)));
      } catch {
        // unreadable manifest: the fixed folders are still cleaned
      }
    }
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.endsWith(TEMP_SUFFIX)) await fs.rm(path.join(dir, e), { force: true }).catch(() => {});
      }
    }
  }

  /**
   * Remember the size/mtime of a file this server just wrote, so externalChanges()
   * can later tell if something else (typically the MV editor) overwrote it.
   * Anything that writes project files without going through writeJson (restore_backup,
   * changeset commits) must call this afterwards.
   */
  async recordWrite(filePath: string): Promise<void> {
    try {
      const { size, mtimeMs } = await fs.stat(filePath);
      this.writeSignatures.set(filePath, { size, mtimeMs });
    } catch {
      this.writeSignatures.delete(filePath);
    }
  }

  /** Stop tracking a file (e.g. one the server deleted on purpose). */
  forgetWrite(filePath: string): void {
    this.writeSignatures.delete(filePath);
  }

  /**
   * Project-relative paths (forward slashes) written by this server whose size or
   * mtime on disk now differs from what we last wrote. A missing file counts as changed.
   */
  async externalChanges(): Promise<string[]> {
    const changed: string[] = [];
    for (const [filePath, sig] of this.writeSignatures) {
      try {
        const { size, mtimeMs } = await fs.stat(filePath);
        if (size === sig.size && mtimeMs === sig.mtimeMs) continue;
      } catch {
        // missing or unreadable: treat as changed
      }
      changed.push(path.relative(this.root, filePath).replace(/\\/g, "/"));
    }
    return changed.sort();
  }

  async readDatabase(type: DatabaseType): Promise<unknown[]> {
    const data = await this.readJson(this.databaseFile(type));
    if (!Array.isArray(data)) {
      throw new ProjectError(`${DATABASE_FILES[type]} is not an array.`);
    }
    return data;
  }

  async writeDatabase(type: DatabaseType, records: unknown[]): Promise<void> {
    await this.writeJson(this.databaseFile(type), records);
  }
}
