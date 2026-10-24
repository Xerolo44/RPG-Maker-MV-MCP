import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveStaticPath, startStaticServer } from "../dist/playtest/staticServer.js";

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "static-server-"));
  try {
    await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// Raw request so the path reaches the server untouched (fetch would normalise some of these).
function request(url, rawPath, method = "GET") {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(root, fn) {
  const { server, url } = await startStaticServer(root, 0);
  try {
    await fn(url);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

test("resolves /index.html inside root", () => {
  const root = path.resolve("games", "mv");
  assert.equal(resolveStaticPath(root, "/index.html"), path.join(root, "index.html"));
  assert.equal(resolveStaticPath(root, "/data/System.json"), path.join(root, "data", "System.json"));
});

test("maps / to index.html", () => {
  const root = path.resolve("games", "mv");
  assert.equal(resolveStaticPath(root, "/"), path.join(root, "index.html"));
});

test("rejects /../secret", () => {
  const root = path.resolve("games", "mv");
  assert.equal(resolveStaticPath(root, "/../secret"), null);
});

test("rejects encoded traversal /%2e%2e/secret and /..%2fsecret", () => {
  const root = path.resolve("games", "mv");
  assert.equal(resolveStaticPath(root, "/%2e%2e/secret"), null);
  assert.equal(resolveStaticPath(root, "/..%2fsecret"), null);
});

test("rejects a sibling directory sharing the root prefix", async () => {
  await withTmp(async (tmp) => {
    const root = path.join(tmp, "mv");
    await fs.mkdir(root);
    await fs.mkdir(path.join(tmp, "mv-secret"));
    await fs.writeFile(path.join(tmp, "mv-secret", "a.txt"), "secret");
    assert.equal(resolveStaticPath(root, "/../mv-secret/a.txt"), null);
  });
});

test("rejects NUL bytes and malformed escapes in the path", () => {
  const root = path.resolve("games", "mv");
  assert.equal(resolveStaticPath(root, "/a%00b.txt"), null);
  assert.equal(resolveStaticPath(root, "/%E0%A4%A"), null);
});

test("serves a file with the right content type over HTTP on port 0", async () => {
  await withTmp(async (root) => {
    await fs.writeFile(path.join(root, "index.html"), "<p>hi</p>");
    await fs.mkdir(path.join(root, "data"));
    await fs.writeFile(path.join(root, "data", "System.json"), '{"a":1}');
    await withServer(root, async (url) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.notEqual(new URL(url).port, "0");
      const json = await request(url, "/data/System.json?x=1");
      assert.equal(json.status, 200);
      assert.equal(json.headers["content-type"], "application/json");
      assert.equal(json.body, '{"a":1}');
      const index = await request(url, "/");
      assert.equal(index.status, 200);
      assert.equal(index.headers["content-type"], "text/html");
      assert.equal(index.body, "<p>hi</p>");
      const head = await request(url, "/index.html", "HEAD");
      assert.equal(head.status, 200);
      assert.equal(head.body, "");
    });
  });
});

test("404 for a missing file", async () => {
  await withTmp(async (root) => {
    await withServer(root, async (url) => {
      assert.equal((await request(url, "/nope.png")).status, 404);
    });
  });
});

test("403 for traversal over HTTP, including a sibling sharing the root prefix", async () => {
  await withTmp(async (tmp) => {
    const root = path.join(tmp, "mv");
    await fs.mkdir(root);
    await fs.mkdir(path.join(tmp, "mv-secret"));
    await fs.writeFile(path.join(tmp, "mv-secret", "a.txt"), "secret");
    await withServer(root, async (url) => {
      for (const p of ["/../mv-secret/a.txt", "/%2e%2e/mv-secret/a.txt", "/..%2fmv-secret/a.txt", "/a%00.txt"]) {
        const res = await request(url, p);
        assert.equal(res.status, 403, p);
        assert.ok(!res.body.includes("secret"), p);
      }
    });
  });
});

test("malformed percent-escape answers 400 and the server keeps working", async () => {
  await withTmp(async (root) => {
    await fs.writeFile(path.join(root, "index.html"), "ok");
    await withServer(root, async (url) => {
      assert.equal((await request(url, "/%E0%A4%A")).status, 400);
      assert.equal((await request(url, "/index.html")).status, 200);
    });
  });
});

test("directory request answers 404", async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, "data"));
    await withServer(root, async (url) => {
      assert.equal((await request(url, "/data")).status, 404);
      assert.equal((await request(url, "/data/")).status, 404);
    });
  });
});

test("methods other than GET and HEAD answer 405", async () => {
  await withTmp(async (root) => {
    await fs.writeFile(path.join(root, "index.html"), "ok");
    await withServer(root, async (url) => {
      const res = await request(url, "/index.html", "POST");
      assert.equal(res.status, 405);
      assert.equal(res.headers.allow, "GET, HEAD");
    });
  });
});
