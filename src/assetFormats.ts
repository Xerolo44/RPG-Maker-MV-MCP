// Pure checks for importing assets: folder set, name rules, magic-byte type detection and
// advisory size/dimension warnings. Works on a file's first bytes only; nothing is decoded
// and nothing here touches the disk.
import path from "node:path";
import { pngInfo } from "./png.js";
import { ProjectError } from "./project.js";

export const ASSET_FOLDERS = [
  "img/animations",
  "img/battlebacks1",
  "img/battlebacks2",
  "img/characters",
  "img/enemies",
  "img/faces",
  "img/parallaxes",
  "img/pictures",
  "img/sv_actors",
  "img/sv_enemies",
  "img/system",
  "img/tilesets",
  "img/titles1",
  "img/titles2",
  "audio/bgm",
  "audio/bgs",
  "audio/me",
  "audio/se",
] as const;

export type AssetFolder = (typeof ASSET_FOLDERS)[number];

export function isAssetFolder(v: string): v is AssetFolder {
  return (ASSET_FOLDERS as readonly string[]).includes(v);
}

export function isImageFolder(f: AssetFolder): boolean {
  return f.startsWith("img/");
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;

/** Largest file `folder` accepts, in bytes (32 MiB for images, 128 MiB for audio). */
export function assetSizeCap(folder: AssetFolder): number {
  return isImageFolder(folder) ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
}

const MAX_SOURCE_PATH = 4096;

/**
 * String-level checks on a caller-named source file path, run before any file access. Accepts
 * only an absolute local path: on Windows `X:\…` (or `X:/…`), elsewhere `/…`. Refuses on every
 * platform UNC (`\\server\share`, `//server/share`) and device (`\\.\`, `\\?\`) prefixes,
 * control characters and absurd lengths; on Windows also drive-relative (`C:x`) and root-relative
 * (`\x`) paths, alternate data streams (`file:stream`) and reserved device file names (`NUL`,
 * `con.png`). Returns the normalised path or throws `ProjectError`.
 */
export function checkSourcePath(source: string, platform: string = process.platform): string {
  if (typeof source !== "string" || source.length === 0) throw new ProjectError("source must be a non-empty file path.");
  if (source.length > MAX_SOURCE_PATH) throw new ProjectError(`source is longer than ${MAX_SOURCE_PATH} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(source)) throw new ProjectError("source contains control characters.");
  if (/^[\\/]{2}[.?][\\/]/.test(source)) {
    throw new ProjectError("Device paths (\\\\.\\… or \\\\?\\…) are not accepted as source; name a regular file on a local drive.");
  }
  if (/^[\\/]{2}/.test(source)) {
    throw new ProjectError("UNC network paths (\\\\server\\share\\…) are not accepted as source; copy the file to a local drive first.");
  }
  const relative = () =>
    new ProjectError(`source must be an absolute local file path (${platform === "win32" ? "like C:\\art\\Hero.png" : "like /home/me/art/Hero.png"}).`);
  if (platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(source)) throw relative();
    if (source.indexOf(":", 2) !== -1) throw new ProjectError("source must not name an alternate data stream (a ':' after the drive letter).");
    const normalised = path.win32.normalize(source);
    const base = path.win32.basename(normalised).split(".")[0].replace(/[ .]+$/, "");
    if (RESERVED_NAME.test(base)) throw new ProjectError("source names a reserved Windows device (CON, NUL, COM1, …), not a file.");
    return normalised;
  }
  if (!path.posix.isAbsolute(source)) throw relative();
  return path.posix.normalize(source);
}

const NAME_PATTERN = /^[A-Za-z0-9!$][A-Za-z0-9 _!$()-]{0,63}$/;
// Windows device names (also reserved with an extension, and the console aliases).
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$)$/i;

/** Returns `name` when it is a safe asset base name (no extension), otherwise throws `ProjectError`. */
export function validateAssetName(name: string): string {
  if (typeof name !== "string") throw new ProjectError("Asset name must be a string.");
  if (!NAME_PATTERN.test(name) || name.endsWith(" ")) {
    throw new ProjectError(
      `Invalid asset name ${JSON.stringify(name)}: use 1-64 characters from A-Z a-z 0-9 space _ ! $ ( ) -, ` +
        "starting with a letter, digit, ! or $, with no trailing space, no extension and no path separators.",
    );
  }
  if (RESERVED_NAME.test(name)) {
    throw new ProjectError(`Invalid asset name ${JSON.stringify(name)}: reserved Windows device name.`);
  }
  return name;
}

export type AssetType = "png" | "ogg" | "m4a";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Sniffs the type from magic bytes only (never from an extension); null when unknown. */
export function detectAssetType(head: Buffer): AssetType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (head.length >= 4 && head.toString("latin1", 0, 4) === "OggS") return "ogg";
  if (head.length >= 8 && head.toString("latin1", 4, 8) === "ftyp") return "m4a";
  return null;
}

export interface AssetInfo {
  type: AssetType;
  bytes: number;
  width?: number;
  height?: number;
  warnings: string[];
}

function dimensionWarnings(folder: AssetFolder, name: string, width: number, height: number): string[] {
  const size = `${width}x${height}`;
  switch (folder) {
    case "img/characters": {
      const [w, h] = name.startsWith("$") ? [3, 4] : [12, 8];
      return width % w === 0 && height % h === 0
        ? []
        : [`Character sheet is ${size}; expected width a multiple of ${w} and height a multiple of ${h} (${name.startsWith("$") ? "single-character '$' sheet" : "8-character sheet"}).`];
    }
    case "img/faces":
      return width % 144 === 0 && height % 144 === 0
        ? []
        : [`Face sheet is ${size}; expected multiples of 144 in both directions (recommended 576x288).`];
    case "img/sv_actors":
      return width % 9 === 0 && height % 6 === 0
        ? []
        : [`Side-view actor sheet is ${size}; expected width a multiple of 9 and height a multiple of 6.`];
    case "img/tilesets":
      return width === 768 || width === 384
        ? []
        : [`Tileset image is ${size}; the width should be 768 (or 384 for half-resolution sheets).`];
    case "img/animations":
      return width % 192 === 0 ? [] : [`Animation sheet is ${size}; expected width a multiple of 192.`];
    case "img/titles1":
    case "img/titles2":
    case "img/battlebacks1":
    case "img/battlebacks2":
      return width < 816 || height < 624
        ? [`Image is ${size}, smaller than the 816x624 game screen; it will not cover the screen.`]
        : [];
    default:
      return [];
  }
}

/**
 * Checks a candidate file against a folder from its first bytes and total size. `head` must hold
 * at least the first 64 bytes (or the whole file); nothing past `head` is read. Throws
 * `ProjectError` when the type does not fit the folder, the file is over the size cap or the
 * PNG header is unreadable. Warnings are advisory only.
 */
export function inspectAsset(folder: AssetFolder, name: string, head: Buffer, totalBytes: number): AssetInfo {
  validateAssetName(name);
  const image = isImageFolder(folder);
  if (!Number.isFinite(totalBytes) || totalBytes < 0) throw new ProjectError("Invalid file size.");
  const cap = assetSizeCap(folder);
  if (totalBytes > cap) {
    throw new ProjectError(
      `File is ${totalBytes} bytes; ${folder} accepts at most ${cap / (1024 * 1024)} MiB.`,
    );
  }
  const type = detectAssetType(head);
  const fits = image ? type === "png" : type === "ogg" || type === "m4a";
  if (!type || !fits) {
    throw new ProjectError(
      `${folder} accepts ${image ? "files with a PNG header" : "files whose header is Ogg (OggS) or ISO-BMFF/M4A (ftyp)"} (only the header is checked), but this file's header is ${type ? type.toUpperCase() : "not a recognised PNG, Ogg or M4A header"}.`,
    );
  }
  if (type !== "png") return { type, bytes: totalBytes, warnings: [] };
  let dims: { width: number; height: number };
  try {
    dims = pngInfo(head);
  } catch (e) {
    throw new ProjectError(`Unreadable PNG header: ${(e as Error).message}`);
  }
  return {
    type,
    bytes: totalBytes,
    width: dims.width,
    height: dims.height,
    warnings: dimensionWarnings(folder, name, dims.width, dims.height),
  };
}
