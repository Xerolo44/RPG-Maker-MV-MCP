import fs from "node:fs/promises";
import path from "node:path";

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
const MAX_BACKUP_SESSIONS = 10;

export class Project {
  private rootDir: string | null = null;
  private sessionStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  private backedUp = new Set<string>();

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
  }

  get backupRoot(): string {
    return path.join(this.root, BACKUP_DIR_NAME);
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
      sessions = (await fs.readdir(this.backupRoot)).sort();
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
      sessions = (await fs.readdir(this.backupRoot)).sort().reverse();
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

  async readJson<T = unknown>(filePath: string): Promise<T> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      throw new ProjectError(`File not found: ${filePath}`);
    }
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
    await this.backup(filePath);
    let text: string;
    if (Array.isArray(value)) {
      const lines = value.map((el) => JSON.stringify(el));
      text = "[\n" + lines.join(",\n") + "\n]";
    } else {
      text = JSON.stringify(value);
    }
    await fs.writeFile(filePath, text, "utf8");
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
