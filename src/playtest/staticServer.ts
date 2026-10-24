import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

/**
 * Maps a request path (still percent-encoded, query already stripped) to a file under `root`.
 * Returns null when the request is forbidden: malformed escapes, NUL bytes, or anything that
 * resolves outside `root`.
 *
 * The containment check uses `path.relative` rather than `filePath.startsWith(root)`. A plain
 * prefix test accepts sibling directories that merely share the root's prefix (root `/games/mv`
 * also "contains" `/games/mv-secret/a.txt`). `path.relative(root, filePath)` is only inside
 * `root` when it neither starts with `..` nor is absolute (a different drive on Windows yields
 * an absolute result).
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const resolvedRoot = path.resolve(root);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.join(resolvedRoot, relativePath);
  const rel = path.relative(resolvedRoot, filePath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return filePath;
}

function isMalformedEscape(urlPath: string): boolean {
  try {
    decodeURIComponent(urlPath);
    return false;
  } catch {
    return true;
  }
}

export function startStaticServer(
  root: string,
  port: number,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    const urlPath = (req.url ?? "/").split("?")[0];
    if (isMalformedEscape(urlPath)) {
      res.writeHead(400).end("Bad request");
      return;
    }
    const filePath = resolveStaticPath(root, urlPath);
    if (filePath === null) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    // A directory makes readFile fail with EISDIR, which is answered as 404 like any other miss.
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(req.method === "HEAD" ? undefined : content);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: boundPort } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${boundPort}` });
    });
  });
}
