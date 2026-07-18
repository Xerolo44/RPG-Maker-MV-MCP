# Contributing

Thanks for your interest in improving rpgmaker-mv-mcp!

## Getting started

```sh
npm install
npm run build
npm run smoke   # end-to-end test against a generated throwaway MV project
```

`npm run smoke` must pass before and after your change. It spins up the compiled
server over real stdio, generates a fake RPG Maker MV project in a temp folder,
and exercises every tool group.

## Project layout

```
src/
├── index.ts                 server entry point (stdio transport, --project flag)
├── project.ts               project root handling, MV-style JSON I/O, automatic backups
├── util.ts                  tool result helpers and error wrapping
└── tools/
    ├── projectTools.ts      set_project, get_project_info
    ├── databaseTools.ts     generic database CRUD, System.json, switch/variable names
    ├── skillTools.ts        high-level skill creation helpers
    ├── searchTools.ts       search across databases and map events
    ├── mapTools.ts          maps, events, event commands, dialogue helper
    ├── pluginTools.ts       js/plugins.js management and plugin source files
    ├── playtestTools.ts     NW.js / browser playtesting
    └── maintenanceTools.ts  backups and project validation
scripts/
└── smoke.mjs                end-to-end smoke test
```

## Guidelines

- **Every write goes through a backup.** Use `project.writeJson()` (which backs up
  automatically) or call `project.backup(path)` before any direct `fs` write.
- **Match the MV editor's file format.** Data arrays are 1-indexed with `null` at
  index 0; array files are written one element per line; ids must equal array
  positions. `project.writeJson()` handles the formatting.
- **Tools should fail with helpful messages.** Wrap handlers in `safe()` and throw
  `ProjectError` with a message that tells the client what to do instead.
- **Add smoke coverage** in `scripts/smoke.mjs` for every new tool.
- Keep tool descriptions written for an AI client: state parameter semantics and
  RPG Maker quirks (scopes, command codes, chance values) in the description.

## Reporting issues

Please include: your OS, Node version, the tool call (name + arguments), the
returned error, and — if it's a data corruption issue — the relevant JSON file
from `.mcp-backups/` so the before/after can be compared.
