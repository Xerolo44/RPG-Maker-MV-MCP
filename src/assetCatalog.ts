// Catalogue of the asset files in a project: size, image dimensions and where each file is used.
// Only the first bytes of each file are read (never a whole image or sound), so a folder with
// thousands of files or a 100 MB soundtrack lists quickly.
import fs from "node:fs/promises";
import path from "node:path";
import { collectAssetRefs, scannedFolders, usesSideView } from "./assets.js";
import {
  ASSET_FOLDERS,
  type AssetFolder,
  assetSizeCap,
  detectAssetType,
  inspectAsset,
  isImageFolder,
  validateAssetName,
} from "./assetFormats.js";
import { pngInfo } from "./png.js";
import { type Project, ProjectError } from "./project.js";

export interface AssetEntry {
  /** File name without its extension. */
  name: string;
  /** Extension as on disk, without the dot (`png`, `ogg`, `m4a`). */
  ext: string;
  bytes: number;
  width?: number;
  height?: number;
  /** At most 3 places that reference this file (only with includeUsage, in folders the usage scan covers). */
  usedBy?: string[];
  /** Whether nothing references it; set only with includeUsage, in folders the usage scan covers. */
  unused?: boolean;
  warnings: string[];
}

export interface AssetListing {
  folders: { folder: AssetFolder; total: number; files: AssetEntry[] }[];
  /** Files left out because of `limit`, over all folders. */
  truncated: number;
  /** Set when usage could not be worked out (a data file could not be read); usedBy/unused are then left out. */
  usageError?: string;
}

const HEADER_BYTES = 64;
const MAX_USED_BY = 3;
const READ_BATCH = 16;

const familyExts = (folder: AssetFolder): string[] => (isImageFolder(folder) ? ["png"] : ["ogg", "m4a"]);

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Regular files of `folder` whose extension belongs to the folder's family, sorted by file name. */
async function candidateFiles(root: string, folder: AssetFolder): Promise<{ file: string; name: string; ext: string }[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, ...folder.split("/")), { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new ProjectError(`Cannot list ${folder} (${code ?? "error"}).`);
  }
  const exts = familyExts(folder);
  const out: { file: string; name: string; ext: string }[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const dot = e.name.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = e.name.slice(dot + 1);
    if (!exts.includes(ext.toLowerCase())) continue;
    out.push({ file: e.name, name: e.name.slice(0, dot), ext });
  }
  return out.sort((a, b) => byName(a.file, b.file));
}

/** Size and first bytes of a file; the file is never read past `HEADER_BYTES`. */
async function readHeader(file: string): Promise<{ bytes: number; head: Buffer }> {
  const fh = await fs.open(file, "r");
  try {
    const st = await fh.stat();
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    return { bytes: st.size, head: buf.subarray(0, bytesRead) };
  } finally {
    await fh.close();
  }
}

/** Everything that can be said about one file from its first bytes. Audio type comes from the header only. */
function describe(folder: AssetFolder, name: string, ext: string, head: Buffer, bytes: number): Omit<AssetEntry, "name" | "ext" | "bytes"> {
  const warnings: string[] = [];
  const type = detectAssetType(head);
  const out: { width?: number; height?: number } = {};
  if (isImageFolder(folder)) {
    if (type !== "png") {
      warnings.push("Header is not a PNG header; the file is probably not a valid image.");
    } else {
      try {
        Object.assign(out, pngInfo(head));
      } catch {
        warnings.push("Unreadable PNG header.");
      }
    }
  } else {
    const want = ext.toLowerCase();
    if (type !== want) {
      warnings.push(
        `Header looks like ${type ? type.toUpperCase() : "neither Ogg nor M4A"}, but the extension is .${want} (only the header is checked, not the codec).`
      );
    }
  }
  if (bytes > assetSizeCap(folder)) {
    warnings.push(`Larger than the ${assetSizeCap(folder) / (1024 * 1024)} MiB that import_asset accepts for ${folder}.`);
  }
  if (out.width !== undefined && bytes <= assetSizeCap(folder)) {
    try {
      validateAssetName(name);
      warnings.push(...inspectAsset(folder, name, head, bytes).warnings);
    } catch {
      // names that import_asset would not accept (e.g. non-ASCII) just get no layout warnings
    }
  }
  return { ...out, warnings };
}

async function entriesFor(root: string, folder: AssetFolder, files: { file: string; name: string; ext: string }[]): Promise<AssetEntry[]> {
  const entries: AssetEntry[] = [];
  const dir = path.join(root, ...folder.split("/"));
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const batch = await Promise.all(
      files.slice(i, i + READ_BATCH).map(async (f): Promise<AssetEntry> => {
        try {
          const { bytes, head } = await readHeader(path.join(dir, f.file));
          return { name: f.name, ext: f.ext, bytes, ...describe(folder, f.name, f.ext, head, bytes) };
        } catch (err) {
          return { name: f.name, ext: f.ext, bytes: 0, warnings: [`Could not read the file (${(err as NodeJS.ErrnoException).code ?? "error"}).`] };
        }
      })
    );
    entries.push(...batch);
  }
  return entries;
}

export async function listAssets(
  project: Project,
  opts: { folder?: AssetFolder; includeUsage: boolean; limit: number }
): Promise<AssetListing> {
  const root = project.root;
  const wanted: readonly AssetFolder[] = opts.folder ? [opts.folder] : ASSET_FOLDERS;

  // Usage: who references which file, for the folders the reference scan covers.
  let covered = new Set<string>();
  const usage = new Map<string, Set<string>>();
  let usageError: string | undefined;
  if (opts.includeUsage) {
    try {
      covered = new Set(scannedFolders(await usesSideView(project)));
      if (wanted.some((f) => covered.has(f))) {
        for (const ref of await collectAssetRefs(project)) {
          const key = `${ref.folder}/${ref.name}`;
          const set = usage.get(key) ?? new Set<string>();
          set.add(ref.source);
          usage.set(key, set);
        }
      }
    } catch {
      covered = new Set();
      usage.clear();
      usageError = "Usage could not be worked out because a project data file could not be read; the listing has no usedBy/unused. Run validate_project to find the broken file.";
    }
  }

  const folders: AssetListing["folders"] = [];
  let truncated = 0;
  for (const folder of wanted) {
    const all = await candidateFiles(root, folder);
    const shown = all.slice(0, opts.limit);
    const files = await entriesFor(root, folder, shown);
    if (covered.has(folder)) {
      for (const e of files) {
        const sources = usage.get(`${folder}/${e.name}`);
        if (sources) e.usedBy = [...sources].slice(0, MAX_USED_BY);
        e.unused = sources === undefined;
      }
    }
    truncated += all.length - shown.length;
    folders.push({ folder, total: all.length, files });
  }
  const result: AssetListing = { folders, truncated };
  if (usageError) result.usageError = usageError;
  return result;
}
