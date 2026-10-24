import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project } from "../project.js";
import { safe, textResult } from "../util.js";

const EDITOR_NOTE = "The RPG Maker editor must stay closed while the server edits the project.";

export function registerChangesetTools(server: McpServer, project: Project): void {
  server.registerTool(
    "begin_changeset",
    {
      title: "Begin changeset",
      description:
        "Start a transactional batch of edits. While a changeset is open, every edit tool stages its result in memory: nothing is written to disk until commit_changeset, and all reads (get_map, get_record, list_plugins, ...) reflect the staged edits. " +
        "Commit writes every staged file in one step (all or nothing) and can be rolled back later with undo_changeset; discard_changeset drops the staged edits. Only one changeset can be open at a time; restore_backup is refused while one is open and set_project discards it. Playtests read from disk, so they only see committed edits. " +
        EDITOR_NOTE,
      inputSchema: {
        label: z.string().min(1).describe("Short description of the batch, e.g. 'Add the blacksmith to Town'"),
      },
    },
    safe(async ({ label }) => {
      project.beginChangeset(label);
      return textResult({
        open: label,
        note: "Edits are now staged in memory and reads reflect them; nothing is on disk until commit_changeset.",
      });
    })
  );

  server.registerTool(
    "commit_changeset",
    {
      title: "Commit changeset",
      description:
        "Write every file staged by the open changeset to disk as one unit and return a per-file summary (created/modified, event/tile/record counts). Staged .json files are validated first: if any is invalid, nothing is written and the changeset stays open. " +
        "Pre-images are journaled under .mcp-backups/changesets/<id>/ so undo_changeset can roll the commit back; a commit interrupted by a crash is rolled back automatically the next time the project is opened. Other edits are refused while the commit runs. Until this is called, nothing of the changeset is on disk and reads reflect the staged edits. " +
        EDITOR_NOTE,
      inputSchema: {},
    },
    safe(async () => textResult(await project.commitChangeset()))
  );

  server.registerTool(
    "discard_changeset",
    {
      title: "Discard changeset",
      description:
        "Drop every edit staged by the open changeset. Nothing on disk changes (nothing of the changeset was on disk yet), and reads go back to the files on disk. " +
        EDITOR_NOTE,
      inputSchema: {},
    },
    safe(async () => {
      project.discardChangeset();
      return textResult("Changeset discarded; nothing was written.");
    })
  );

  server.registerTool(
    "undo_changeset",
    {
      title: "Undo last changeset",
      description:
        "Roll back the most recently committed changeset from its journal: modified files are restored byte-for-byte, files it created are deleted. Call repeatedly to step back through earlier commits. " +
        "Edits made to those files after the commit are overwritten too. Refused while a changeset is open (while one is open, reads reflect its staged edits and nothing is on disk until commit). " +
        EDITOR_NOTE,
      inputSchema: {},
    },
    safe(async () => textResult({ undone: await project.undoLastChangeset() }))
  );
}
