import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "selfsigned";

export interface TlsPair {
  cert: string;
  key: string;
}

/**
 * Loads a cached self-signed TLS cert/key for localhost, generating and
 * caching a fresh one (valid ~10 years) on first run. Used only to satisfy
 * clients that require https:// even for a purely local server — the
 * private key never leaves this machine and the cert is not CA-signed.
 */
export async function loadOrCreateLocalCert(): Promise<TlsPair> {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const certDir = path.join(packageRoot, ".certs");
  const certFile = path.join(certDir, "localhost.crt");
  const keyFile = path.join(certDir, "localhost.key");

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile, "utf8"), key: fs.readFileSync(keyFile, "utf8") };
  }

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);

  const pems = await generate([{ name: "commonName", value: "localhost" }], {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });

  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(certFile, pems.cert, "utf8");
  fs.writeFileSync(keyFile, pems.private, "utf8");
  return { cert: pems.cert, key: pems.private };
}
