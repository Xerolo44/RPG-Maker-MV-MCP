import { type Stats, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAssets } from "../assetCatalog.js";
import {
  ASSET_FOLDERS,
  type AssetFolder,
  type AssetType,
  assetSizeCap,
  checkSourcePath,
  inspectAsset,
  isImageFolder,
  isSingleCharacterSheet,
  validateAssetName,
} from "../assetFormats.js";
import { PngError, decodePng, encodePng, pngInfo, scaleDownNearest } from "../png.js";
import { BINARY_IN_CHANGESET, Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";

/**
 * Read a caller-named source file after the string checks: lstat must show a regular file (not a
 * symbolic link, directory or device), non-empty and within the folder's size cap, all before a
 * single byte is read. The file is then opened with O_NOFOLLOW and O_NONBLOCK where the OS has
 * them (so a FIFO swapped in after the lstat cannot hang the open) and the handle's fstat must
 * match the lstat (regular file, same dev/ino/size), so a file swapped in between is refused.
 * After the read a second fstat must show the same size and mtime, so a file that grew or was
 * rewritten during the read is refused too. Exported for tests.
 */
export async function readSource(source: string, folder: AssetFolder): Promise<Buffer> {
  let st: Stats;
  try {
    st = await fs.lstat(source);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ProjectError(
      code === "ENOENT" || code === "ENOTDIR" ? `Source file not found: ${source}` : `Cannot read source file ${source} (${code ?? "error"}).`
    );
  }
  if (st.isSymbolicLink()) throw new ProjectError(`Source ${source} is a symbolic link; name the real file instead.`);
  if (!st.isFile()) throw new ProjectError(`Source ${source} is not a regular file (it is a directory or a device).`);
  if (st.size === 0) throw new ProjectError(`Source ${source} is empty.`);
  const cap = assetSizeCap(folder);
  if (st.size > cap) {
    throw new ProjectError(`Source ${source} is ${st.size} bytes; ${folder} accepts at most ${cap / (1024 * 1024)} MiB.`);
  }
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new ProjectError(`Cannot open source file ${source} (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  try {
    const now = await fh.stat();
    if (!now.isFile() || now.dev !== st.dev || now.ino !== st.ino || now.size !== st.size) {
      throw new ProjectError(`Source ${source} changed while it was being read; nothing was imported.`);
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const after = await fh.stat();
    if (off !== buf.length || after.size !== now.size || after.mtimeMs !== now.mtimeMs) {
      throw new ProjectError(`Source ${source} changed while it was being read; nothing was imported.`);
    }
    return buf;
  } finally {
    await fh.close();
  }
}

/** Reads a project image file whole after checking, on the open handle, that it is a regular file within `cap`. */
async function readImageFile(file: string, label: string, cap: number): Promise<Buffer> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new ProjectError(`Cannot open ${label} (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ProjectError(`${label} is not a regular file.`);
    if (st.size === 0) throw new ProjectError(`${label} is empty.`);
    if (st.size > cap) throw new ProjectError(`${label} is ${st.size} bytes; previews accept at most ${cap / (1024 * 1024)} MiB.`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

/** Entries of a destination folder; a folder that does not exist yet is empty. */
async function listFolder(dir: string): Promise<{ name: string; isFile: boolean }[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isFile: e.isFile() }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ProjectError(`Cannot list ${dir} (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** preview_asset refuses images with more pixels than this (decoding takes ~4 bytes per pixel plus working copies). */
const MAX_PREVIEW_PIXELS = 16_000_000;

const IMAGE_FOLDERS = ASSET_FOLDERS.filter(isImageFolder) as unknown as [AssetFolder, ...AssetFolder[]];

/** Describes the frame layout a sheet in `folder` is expected to have, from its name and size. */
function layoutNote(folder: AssetFolder, name: string, width: number, height: number): string {
  if (folder === "img/characters") {
    const single = isSingleCharacterSheet(name);
    const [cols, rows] = single ? [3, 4] : [12, 8];
    const frame =
      width % cols === 0 && height % rows === 0
        ? ` Each frame is ${width / cols}x${height / rows} px.`
        : " The size does not divide evenly into frames.";
    const noOffset = /^[!$]*!/.test(name) ? " A '!' in the prefix means no vertical offset when drawn on a map." : "";
    const kind = single
      ? "Character sheet with one character: 3 columns of walk frames by 4 rows (down, left, right, up)."
      : "Character sheet with 8 characters (4 across, 2 down), each 3 columns of walk frames by 4 rows (down, left, right, up).";
    return kind + frame + noOffset;
  }
  if (folder === "img/faces") {
    return width % 144 === 0 && height % 144 === 0
      ? `Face sheet: a grid of ${width / 144} across by ${height / 144} down, 144x144 px per face; face index = row * ${width / 144} + column (0-based).`
      : "Face sheet; faces are 144x144 px but this size does not divide evenly.";
  }
  return "";
}

export function registerAssetTools(server: McpServer, project: Project): void {
  server.registerTool(
    "import_asset",
    {
      title: "Import asset",
      description:
        "Copy an image or sound file from this computer into the project: <project>/<folder>/<name>.<ext>. " +
        "source must be an absolute local path to a regular file (no relative paths, network/UNC shares, devices or symbolic links). " +
        "The type is read from the file's header, never its extension: img/* folders take files with a PNG header (max 32 MiB; only the signature + IHDR is checked, not the whole image), audio/* folders take files whose header is Ogg (OggS) or ISO-BMFF/M4A (ftyp) (max 128 MiB; only the header is checked, not the codec or the full file); the extension (.png, .ogg, .m4a) is chosen from the detected header. " +
        "name defaults to the source file name without its extension and must be 1-64 characters from A-Z a-z 0-9 space _ ! $ ( ) - (no dots, no path); a '$' prefix on a character sheet means one character per sheet, '!' means no offset. " +
        "An existing file with the same name (letter case ignored) is only replaced with overwrite: true; the old file goes to the session backup (list_backups / restore_backup). " +
        "Nothing is converted or resized; warnings flag sheet sizes that do not fit the folder's layout, and for audio a missing sibling format (MV's web build needs both .ogg and .m4a). " +
        "Refused while a changeset is open (binary files cannot be staged): commit or discard it first.",
      inputSchema: {
        source: z.string().describe("Absolute path of the file to import, e.g. C:\\art\\Hero.png or /home/me/art/Hero.png"),
        folder: z.enum(ASSET_FOLDERS).describe("Destination asset folder, e.g. img/characters or audio/bgm"),
        name: z.string().optional().describe("File name without extension; defaults to the source's base name"),
        overwrite: z.boolean().default(false).describe("Replace an existing file with this name"),
      },
    },
    safe(async ({ source, folder, name, overwrite }) => {
      const root = project.root;
      const src = checkSourcePath(source);
      const assetName = validateAssetName(name ?? path.basename(src, path.extname(src)));
      if (project.changesetActive) throw new ProjectError(BINARY_IN_CHANGESET);

      const bytes = await readSource(src, folder);
      const info = inspectAsset(folder, assetName, bytes, bytes.length);
      const ext: AssetType = info.type;
      const wanted = `${assetName}.${ext}`;
      const dir = path.join(root, ...folder.split("/"));
      const entries = await listFolder(dir);
      const existing = entries.find((e) => e.name === wanted) ?? entries.find((e) => sameName(e.name, wanted));
      const warnings = [...info.warnings];
      if (existing) {
        const where = `${folder}/${existing.name}`;
        if (!existing.isFile) throw new ProjectError(`${where} exists but is not a regular file; it is never replaced.`);
        if (!overwrite) {
          throw new ProjectError(`${where} already exists. Pass overwrite: true to replace it (the old file is kept in the session backup), or pick another name.`);
        }
        if (existing.name !== wanted) {
          warnings.push(`Replaced ${existing.name}, whose name differs from "${wanted}" only in letter case; the existing file name was kept.`);
        }
      }
      const fileName = existing?.name ?? wanted;
      await project.writeBinary(path.join(dir, fileName), bytes);

      if (ext !== "png") {
        const other = ext === "ogg" ? "m4a" : "ogg";
        if (!entries.some((e) => sameName(e.name, `${assetName}.${other}`))) {
          warnings.push(`No ${assetName}.${other} in ${folder}: MV's web build needs both .ogg and .m4a versions of each sound; import the other format too if you deploy to the browser or mobile.`);
        }
      }

      const imported: { path: string; type: AssetType; bytes: number; width?: number; height?: number } = {
        path: `${folder}/${fileName}`,
        type: info.type,
        bytes: info.bytes,
      };
      if (info.width !== undefined) imported.width = info.width;
      if (info.height !== undefined) imported.height = info.height;
      return textResult({ imported, replaced: existing !== undefined, warnings });
    })
  );

  server.registerTool(
    "list_assets",
    {
      title: "List assets",
      description:
        "List the image and sound files in the project's asset folders (img/* and audio/*, 18 folders; all of them or one `folder`). " +
        "Each file shows its name (without extension), ext, size in bytes and, for images, the pixel size read from the PNG header, plus warnings (a header that does not match the extension, or a sheet size that does not fit the folder). " +
        "Only the first 64 bytes of each file are read, so a sound's type is judged from its header alone, not the codec or the whole file. Sub-directories and files with other extensions (.rpgmvp, .txt, ...) are skipped. " +
        "With includeUsage (default true), files in the folders the reference scan covers (all except img/system and img/animations) get usedBy (at most 3 places, e.g. 'Actor 1', 'Map003 event 5') and unused (true when nothing in the database, maps, common events or troops references the name). Names are matched case-sensitively, so a reference that differs only in letter case shows the file as unused: run audit_assets to find case mismatches and missing files. " +
        "A plugin or script that loads a file by name is not seen, so check before deleting. " +
        "Files with names outside the import rule (dots, non-ASCII) are listed too, but preview_asset cannot open them. " +
        "Interlaced PNGs are flagged in warnings. A folder that cannot be read gets an `error` on its entry instead of failing the listing. " +
        "Files are sorted by name; each folder shows at most `limit` files and `truncated` counts the rest.",
      inputSchema: {
        folder: z.enum(ASSET_FOLDERS).optional().describe("Only this folder, e.g. img/characters; omit for all folders"),
        includeUsage: z.boolean().default(true).describe("Add usedBy/unused (scans the project's data files)"),
        limit: z.number().int().min(1).max(1000).default(200).describe("Maximum files listed per folder"),
      },
    },
    safe(async ({ folder, includeUsage, limit }) => textResult(await listAssets(project, { folder, includeUsage, limit })))
  );

  server.registerTool(
    "preview_asset",
    {
      title: "Preview asset",
      description:
        "Show a PNG from an img/* folder as an image so you can see it, with its pixel size, file size and, for img/characters and img/faces, the sheet layout implied by the name and size. " +
        "name is the file name without .png and must match an existing file exactly (see list_assets). " +
        "The image is scaled down (nearest neighbour, aspect kept) to at most maxSize pixels on its longer edge; smaller images are shown as they are. " +
        "Files over 32 MiB or 16 million pixels, interlaced PNGs and files that are not valid PNGs are refused. Only names that pass the asset name rule (1-64 characters from A-Z a-z 0-9 space _ ! $ ( ) -) can be opened, even though list_assets may show files with other names. Audio cannot be previewed.",
      inputSchema: {
        folder: z.enum(IMAGE_FOLDERS).describe("Image folder, e.g. img/characters"),
        name: z.string().describe("File name without extension, e.g. Actor1"),
        maxSize: z.number().int().min(32).max(1024).default(512).describe("Longest edge of the returned image in pixels"),
      },
    },
    safe(async ({ folder, name, maxSize }) => {
      const root = project.root;
      validateAssetName(name);
      const dir = path.join(root, ...folder.split("/"));
      const wanted = `${name}.png`;
      const entries = await listFolder(dir);
      const found = entries.find((e) => e.name === wanted);
      if (!found || !found.isFile) {
        const lookalike = entries.find((e) => e.isFile && sameName(e.name, wanted));
        throw new ProjectError(
          `No file ${folder}/${wanted}.` +
            (lookalike ? ` A file whose name differs only in letter case exists (${lookalike.name}); names must match exactly.` : " Use list_assets to see the files.")
        );
      }
      const label = `${folder}/${wanted}`;
      const bytes = await readImageFile(path.join(dir, wanted), label, assetSizeCap(folder));
      // The header is read first: a huge claimed size is refused before anything is inflated.
      let bitmap;
      try {
        const { width, height } = pngInfo(bytes);
        if (width * height > MAX_PREVIEW_PIXELS) {
          throw new ProjectError(`Cannot preview ${label}: image is too large to preview (${width}x${height}); the limit is ${MAX_PREVIEW_PIXELS / 1_000_000} million pixels.`);
        }
        bitmap = decodePng(bytes);
      } catch (err) {
        if (err instanceof ProjectError) throw err;
        throw new ProjectError(`Cannot preview ${label}: ${err instanceof PngError ? err.message : "the image data is corrupt."}`);
      }
      const shown = scaleDownNearest(bitmap, maxSize);
      const scaled = shown === bitmap ? "" : `; shown at ${shown.width}x${shown.height} px`;
      const layout = layoutNote(folder, name, bitmap.width, bitmap.height);
      const text = `${folder}/${wanted}: ${bitmap.width}x${bitmap.height} px, ${bytes.length} bytes${scaled}.${layout ? ` ${layout}` : ""}`;
      return {
        content: [
          { type: "text", text },
          { type: "image", data: encodePng(shown).toString("base64"), mimeType: "image/png" },
        ],
      };
    })
  );
}
