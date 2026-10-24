import { execFile } from "node:child_process";

// UNVERIFIED: "RPGMV.exe" is the expected image name of the RPG Maker MV editor on
// Windows, but it has not been confirmed on a machine with the editor open. Check with
// `tasklist` while the editor is running and record the observed name here; if it
// differs, change IMAGE_NAME.
const IMAGE_NAME = "RPGMV.exe";

/**
 * Whether the RPG Maker MV editor process is running.
 * Returns null when this cannot be determined (non-Windows platform or tasklist failed).
 */
export async function editorProcessRunning(): Promise<boolean | null> {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", `IMAGENAME eq ${IMAGE_NAME}`, "/NH"],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.toLowerCase().includes(IMAGE_NAME.toLowerCase()));
      }
    );
  });
}
