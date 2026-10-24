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
/** File written into a journal entry after its last rename: the commit fully landed. */
const COMMIT_MARKER = "committed";
/** Refusal of Project.writeBinary (and of tools that check first) while a changeset is open. */
export const BINARY_IN_CHANGESET =
  "Importing binary files is not supported while a changeset is open. Commit or discard the changeset first.";

const toPosix = (p: string): string => p.replace(/\\/g, "/");

const fileExists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  );

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
  /** Set while commitChangeset / undoLastChangeset run; writes and changeset calls are refused. */
  private busy: "commit" | "undo" | null = null;
  private recovered: string[] = [];
  private recoveryFailures: string[] = [];
  private recoveryNotes: string[] = [];
  /**
   * Journal id of a commit that is only partly rolled back (a failed commit whose own
   * rollback failed, or a crash recovery that failed): project files are in a mixed state,
   * so every edit is refused until undo_changeset (or a later setRoot) finishes the job.
   */
  private unfinishedRollback: string | null = null;

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
    this.assertIdle("set_project");
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
    await this.recoverInterruptedCommits();
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
    this.assertIdle("writing project files");
    this.assertRolledBack("writing project files");
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

  /**
   * Write a binary project file (an imported image or sound): session backup, mkdir -p, write,
   * recordWrite. Binary content cannot be staged, so this is refused while a changeset is open.
   * The path must lie inside the project folder.
   */
  async writeBinary(filePath: string, data: Buffer): Promise<void> {
    this.assertIdle("writing project files");
    this.assertRolledBack("writing project files");
    if (this.changeset) throw new ProjectError(BINARY_IN_CHANGESET);
    const abs = path.resolve(filePath);
    const rel = path.relative(this.root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ProjectError(`${abs} is outside the project folder.`);
    }
    await this.backup(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
    await this.recordWrite(abs);
  }

  /** True if the open changeset holds staged (not yet committed) content for this file. */
  isStaged(filePath: string): boolean {
    return this.changeset?.staged.has(path.resolve(filePath)) ?? false;
  }

  get changesetActive(): boolean {
    return this.changeset !== null;
  }

  /** Ids of interrupted commits that the last setRoot rolled back from their journal. */
  get recoveredChangesets(): string[] {
    return [...this.recovered];
  }

  /** Interrupted commits the last setRoot could not (or would not) roll back; their journal entries were kept. */
  get recoveryErrors(): string[] {
    return [...this.recoveryFailures];
  }

  /** Everything the last setRoot's journal recovery did, as lines for the user (errors prefixed WARNING). */
  get recoveryReport(): string[] {
    return [...this.recoveryNotes, ...this.recoveryFailures.map((e) => `WARNING: ${e}`)];
  }

  private assertRolledBack(action: string): void {
    if (this.unfinishedRollback) {
      throw new ProjectError(
        `Changeset ${this.unfinishedRollback} was only partly rolled back, so some project files are in a mixed state; ${action} is refused until it is finished. ` +
          `Call undo_changeset to restore every file of that commit from its journal. If undo_changeset keeps failing, close whatever holds the files (e.g. the RPG Maker editor) and retry; ` +
          `as a last resort recover the files with list_backups / restore_backup, delete .mcp-backups/changesets/${this.unfinishedRollback} and call set_project again.`
      );
    }
  }

  /**
   * Throw while a commit or undo is running: it spans many awaits, and a write (or a new
   * changeset) arriving in that window would be staged into a map that is about to be dropped,
   * or written under files the undo is about to overwrite.
   */
  private assertIdle(action: string): void {
    if (this.busy) {
      throw new ProjectError(
        `A changeset ${this.busy} is in progress; ${action} has to wait until it finishes. Try again in a moment.`
      );
    }
  }

  /** Start staging writes in memory. Throws if a changeset is already open. */
  beginChangeset(label: string): void {
    this.root; // throws if no project is selected
    this.assertIdle("begin_changeset");
    this.assertRolledBack("begin_changeset");
    if (this.changeset) {
      throw new ProjectError(
        `A changeset ("${this.changeset.label}") is already open. Commit it with commit_changeset or drop it with discard_changeset before starting another.`
      );
    }
    this.changeset = { label, staged: new Map() };
  }

  /** Drop every staged write. Nothing on disk changes. */
  discardChangeset(): void {
    this.root; // throws if no project is selected
    this.assertIdle("discard_changeset");
    if (!this.changeset) throw new ProjectError("No changeset is open. Start one with begin_changeset.");
    this.changeset = null;
  }

  /**
   * Write every staged file to disk as one unit: (1) validate staged .json, (2) journal
   * pre-images + manifest, session backups, (3) write <file>.mcp-tmp, (4) rename each over
   * its target, then write the journal's `committed` marker. A failed rename restores the
   * files already replaced and removes the temps; a commit killed before the marker is
   * rolled back by the next setRoot.
   */
  async commitChangeset(): Promise<ChangesetSummary> {
    this.root; // throws if no project is selected
    this.assertIdle("commit_changeset");
    this.assertRolledBack("commit_changeset");
    const cs = this.changeset;
    if (!cs) throw new ProjectError("No changeset is open. Start one with begin_changeset.");
    this.busy = "commit";
    try {
      return await this.runCommit(cs);
    } finally {
      this.busy = null;
    }
  }

  private async runCommit(cs: { label: string; staged: Map<string, string> }): Promise<ChangesetSummary> {
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
      // temp + rename: a manifest.json that exists is always complete
      await fs.mkdir(journal, { recursive: true });
      const manifestFile = path.join(journal, "manifest.json");
      await fs.writeFile(manifestFile + TEMP_SUFFIX, JSON.stringify(manifest, null, 2), "utf8");
      await fs.rename(manifestFile + TEMP_SUFFIX, manifestFile);
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

    // (4) renames, then the marker that says the commit fully landed
    let done = 0;
    try {
      for (const e of entries) {
        await fs.rename(e.abs + TEMP_SUFFIX, e.abs);
        done++;
      }
      await fs.writeFile(path.join(journal, COMMIT_MARKER), new Date().toISOString(), "utf8");
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
      const what = `Commit failed while ${done < entries.length ? `replacing ${entries[done].rel}` : "finishing the journal"}: ${(err as Error).message}.`;
      if (rollbackOk) {
        await fs.rm(journal, { recursive: true, force: true }).catch(() => {});
        throw new ProjectError(
          `${what} Files already replaced were restored, so nothing changed on disk; the changeset is still open.`
        );
      }
      // Mixed state on disk: close the changeset (its staged edits are partly on disk and
      // can no longer be committed safely) and refuse every edit until the rollback is finished.
      this.changeset = null;
      this.unfinishedRollback = id;
      throw new ProjectError(
        `${what} Restoring the files already replaced failed too, so the project is in a mixed state. ` +
          `The changeset was closed (its staged edits are lost). Call undo_changeset now to restore every file of this commit from journal ${id}; other edits are refused until then.`
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
    this.root; // throws if no project is selected
    this.assertIdle("undo_changeset");
    if (this.changeset) {
      throw new ProjectError(
        `A changeset ("${this.changeset.label}") is open. Commit or discard it before undo_changeset.`
      );
    }
    this.busy = "undo";
    try {
      const ids = await this.listChangesetIds();
      const id = ids[ids.length - 1];
      if (!id) throw new ProjectError("No committed changeset to undo.");
      const manifest = await this.readManifest(id);
      const { files } = await this.rollBack(id, manifest);
      this.unfinishedRollback = null;
      return { id, label: manifest.label, files };
    } finally {
      this.busy = null;
    }
  }

  private async readManifest(id: string): Promise<ChangesetManifest> {
    const file = path.join(this.changesetRoot, id, "manifest.json");
    try {
      const manifest = JSON.parse(await fs.readFile(file, "utf8")) as ChangesetManifest;
      if (!Array.isArray(manifest.files)) throw new Error("no file list");
      return manifest;
    } catch (err) {
      throw new ProjectError(`Changeset journal ${file} is unreadable: ${(err as Error).message}`);
    }
  }

  /**
   * Put every file of a journal entry back to its pre-image (deleting files that did not
   * exist), then drop the entry. All pre-images are loaded before anything is touched, so a
   * damaged journal restores nothing; a write failure part-way keeps the entry, and running
   * the roll-back again finishes it. Each file's current version goes to the session backup
   * first. `changed` counts the files whose content actually differed from the pre-image.
   */
  private async rollBack(
    id: string,
    manifest: ChangesetManifest
  ): Promise<{ files: ChangesetSummary["files"]; changed: number }> {
    const journal = path.join(this.changesetRoot, id);
    const plan: { rel: string; target: string; bytes: Buffer | null }[] = [];
    for (const f of manifest.files) {
      const target = this.resolveInProject(f.path);
      let bytes: Buffer | null = null;
      if (f.existed) {
        try {
          bytes = await fs.readFile(path.join(journal, "files", f.path));
        } catch {
          throw new ProjectError(
            `Changeset journal ${id} is missing its copy of ${f.path}, so nothing was restored. The journal is in ${journal}.`
          );
        }
      }
      plan.push({ rel: f.path, target, bytes });
    }

    const files: ChangesetSummary["files"] = [];
    let changed = 0;
    for (const { rel, target, bytes } of plan) {
      try {
        const isJson = target.toLowerCase().endsWith(".json");
        const currentBytes = await fs.readFile(target).catch(() => null);
        const current = currentBytes?.toString("utf8") ?? null;
        if (bytes ? !currentBytes || !currentBytes.equals(bytes) : currentBytes !== null) changed++;
        await this.backup(target);
        await fs.rm(target + TEMP_SUFFIX, { force: true });
        if (bytes) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target + TEMP_SUFFIX, bytes);
          await fs.rename(target + TEMP_SUFFIX, target);
          await this.recordWrite(target);
          files.push({
            path: rel,
            change: "restored",
            summary: summarizeChange(rel, parseOrRaw(current, isJson), parseOrRaw(bytes.toString("utf8"), isJson)),
          });
        } else {
          await fs.rm(target, { force: true });
          this.forgetWrite(target);
          files.push({ path: rel, change: "removed", summary: "removed (it did not exist before the changeset)" });
        }
      } catch (err) {
        if (err instanceof ProjectError) throw err;
        throw new ProjectError(
          `Rolling back changeset ${id} failed at ${rel}: ${(err as Error).message}. Files before it were already restored and the journal entry was kept: close whatever holds the file (e.g. the RPG Maker editor) and call undo_changeset again to finish.`
        );
      }
    }
    await fs.rm(journal, { recursive: true, force: true });
    return { files, changed };
  }

  /** Changeset ids (journal folders with a manifest), oldest first. */
  private async listChangesetIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.changesetRoot);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const e of entries.sort()) {
      if (await fileExists(path.join(this.changesetRoot, e, "manifest.json"))) ids.push(e);
    }
    return ids;
  }

  private async newChangesetId(): Promise<string> {
    const base = new Date().toISOString().replace(/[:.]/g, "-");
    let id = base;
    for (let n = 1; await fileExists(path.join(this.changesetRoot, id)); n++) id = `${base}-${n}`;
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
   * Repair the journal after a crash (run by setRoot before anything else touches files):
   * - a folder without manifest.json, or whose manifest is unreadable and has no marker, died
   *   before any project file was touched (the manifest is written atomically before the
   *   first rename), so it is deleted;
   * - an entry with a manifest but no `committed` marker that is newer than every committed
   *   entry is a torn commit: it is rolled back from its pre-images, newest first, after the
   *   files found on disk are saved to the session backup;
   * - an unmarked entry older than a committed one is NOT applied (that would revert newer
   *   work); it is reported in recoveryErrors and kept for the user to inspect.
   * Committed entries are left alone. If a roll-back fails, edits are refused until
   * undo_changeset finishes it.
   */
  private async recoverInterruptedCommits(): Promise<void> {
    this.recovered = [];
    this.recoveryFailures = [];
    this.recoveryNotes = [];
    this.unfinishedRollback = null;
    let entries: string[];
    try {
      entries = await fs.readdir(this.changesetRoot);
    } catch {
      return;
    }
    const marked: string[] = [];
    const unmarked: string[] = [];
    for (const id of entries.sort()) {
      const journal = path.join(this.changesetRoot, id);
      if (!(await fileExists(path.join(journal, "manifest.json")))) {
        await fs.rm(journal, { recursive: true, force: true }).catch(() => {});
      } else if (await fileExists(path.join(journal, COMMIT_MARKER))) {
        marked.push(id);
      } else {
        unmarked.push(id);
      }
    }
    const newestMarked = marked[marked.length - 1];
    for (const id of unmarked.reverse()) {
      const journal = path.join(this.changesetRoot, id);
      let manifest: ChangesetManifest;
      try {
        manifest = await this.readManifest(id);
      } catch {
        await fs.rm(journal, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (newestMarked !== undefined && id < newestMarked) {
        this.recoveryFailures.push(
          `Interrupted changeset ${id} ("${manifest.label}") is older than the committed changeset ${newestMarked}, so it was NOT rolled back (that would revert newer work). ` +
            `Its pre-images are in ${journal}; compare them with the current files, restore anything you need by hand, then delete that folder.`
        );
        continue;
      }
      try {
        const { changed } = await this.rollBack(id, manifest);
        this.recovered.push(id);
        this.recoveryNotes.push(
          changed === 0
            ? `Discarded interrupted changeset ${id} ("${manifest.label}"): it was cut off before commit, and no project files had changed.`
            : `Rolled back interrupted changeset ${id} ("${manifest.label}"): restored ${changed} file(s) to their state before it. Its edits are not on disk; redo them if they are still wanted. The versions found on disk were saved to the session backup first (see list_backups).`
        );
      } catch (err) {
        this.unfinishedRollback = id;
        this.recoveryFailures.push(
          `Could not roll back the interrupted changeset ${id}: ${(err as Error).message} Edits are refused until undo_changeset finishes the roll-back.`
        );
        break; // older entries must not be applied over a half-restored newer one
      }
    }
  }

  /**
   * Delete *.mcp-tmp files a crashed commit may have left: in data/, js/, js/plugins/ and
   * the folders of every file in the newest journal entry.
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
        const manifest = await this.readManifest(last);
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
