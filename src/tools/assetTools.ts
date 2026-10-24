import { type Stats, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_FOLDERS,
  type AssetFolder,
  type AssetType,
  assetSizeCap,
  checkSourcePath,
  inspectAsset,
  validateAssetName,
} from "../assetFormats.js";
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
}
