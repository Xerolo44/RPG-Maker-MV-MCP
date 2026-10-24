# Contributing

Thanks for your interest in improving rpgmaker-mv-mcp!

## Getting started

```sh
npm install
npm run build
npm run test:unit   # unit tests for the pure modules
npm run smoke       # end-to-end test against a generated throwaway MV project
```

`npm test` (build + unit tests + smoke test) must pass before and after your change. The smoke
test spins up the compiled server over real stdio, generates a fake RPG Maker MV project in a
temp folder, and exercises every tool group.

## Project layout

```
src/
├── index.ts                 server entry point (stdio/HTTPS transport, --project flag)
├── project.ts               project root handling, MV-style JSON I/O, automatic backups
├── util.ts                  tool result helpers and error wrapping
├── tiles.ts                 tile-id encoding, autotile shapes, map painting (pure)
├── render.ts, png.ts        map renderer and the dependency-free PNG codec (pure)
├── formula.ts, battle.ts    safe damage-formula evaluator, stats/damage/battle simulation (pure)
├── curves.ts, bulk.ts       stat-curve shapes, field-path bulk edits (pure)
├── localization.ts          collects/applies all translatable texts, CSV (pure apart from reads)
├── reference.ts, skills.ts  reference texts, skill-file loading
├── knowledge.ts             MCP resources, prompts and install_skills
└── tools/
    ├── projectTools.ts      set_project, get_project_info
    ├── databaseTools.ts     generic database CRUD, System.json, switch/variable names
    ├── skillTools.ts        high-level skill creation helpers
    ├── searchTools.ts       search across databases and map events
    ├── mapTools.ts          maps, events, event commands, dialogue helper
    ├── tileTools.ts         tilesets and paint_tiles / render_map
    ├── renderTools.ts       render_map_image
    ├── connectTools.ts      connect_maps, list_map_connections
    ├── balanceTools.ts      bulk edits, curves, balance_report, simulate_battle
    ├── localizationTools.ts export_texts, import_texts
    ├── pluginTools.ts       js/plugins.js management and plugin source files
    ├── playtestTools.ts     NW.js / browser playtesting
    └── maintenanceTools.ts  backups and project validation
skills/                      bundled SKILL.md workflow guides (shipped in the npm package)
scripts/
├── smoke.mjs                end-to-end smoke test
└── unit.mjs                 unit tests (node:test) for the pure modules
```

## Guidelines

- **Every write goes through a backup.** Use `project.writeJson()` (which backs up
  automatically) or call `project.backup(path)` before any direct `fs` write.
- **Match the MV editor's file format.** Data arrays are 1-indexed with `null` at
  index 0; array files are written one element per line; ids must equal array
  positions. `project.writeJson()` handles the formatting.
- **Tools should fail with helpful messages.** Wrap handlers in `safe()` and throw
  `ProjectError` with a message that tells the client what to do instead.
- **Add smoke coverage** in `scripts/smoke.mjs` for every new tool, and unit tests in
  `scripts/unit.mjs` for logic that can be tested without a project.
- **Preview before bulk writes.** Tools that change many records default to `dryRun: true`.
- **Skill files** are part of the product: when you change a tool's behaviour, update the
  matching `skills/*/SKILL.md`.
- Keep tool descriptions written for an AI client: state parameter semantics and
  RPG Maker quirks (scopes, command codes, chance values) in the description.

## Releasing

Releases are automatic. To ship a new version, include these in a PR to `main`:

1. Bump `version` in `package.json`, and both `version` fields in `server.json`.
2. Add a `## [X.Y.Z] - date` section to `CHANGELOG.md` (it becomes the GitHub Release notes).

When the PR is merged, `.github/workflows/release.yml` sees a version without a GitHub Release,
runs the tests, publishes to npm (with provenance) and the MCP Registry, then tags `vX.Y.Z` and
creates the GitHub Release. Merges that don't change the version release nothing. If a run fails
part-way, re-run it: finished steps are skipped. `node scripts/release-check.mjs <file>` runs the
version consistency check locally.

One-time setup: configure npm trusted publishing for this repository and the workflow
`release.yml` (npmjs.com, package settings). No secrets are needed.

## Reporting issues

Please include: your OS, Node version, the tool call (name + arguments), the
returned error, and — if it's a data corruption issue — the relevant JSON file
from `.mcp-backups/` so the before/after can be compared.
