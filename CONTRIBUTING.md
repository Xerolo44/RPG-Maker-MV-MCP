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
├── index.ts                 server entry point (stdio/HTTPS transport, --project and --tools flags)
├── project.ts               project root handling, MV-style JSON/text I/O, automatic backups,
│                            changeset staging/commit/undo, external-change tracking
├── changeset.ts             changeset types and per-file change summaries (pure)
├── profiles.ts              tool groups and --tools / RPGMV_TOOLS parsing (pure)
├── editorStatus.ts          detects a running RPG Maker MV editor process
├── commandList.ts           event command list building and validation (pure)
├── passability.ts           map passability following MV's checkPassage rule (pure)
├── lint.ts                  static checks for event command lists (lint_events)
├── assets.ts                asset reference scan against the files on disk (audit_assets)
├── assetFormats.ts          asset folders, name and source-path rules, magic-byte type checks (pure)
├── assetCatalog.ts          file listing with usage for list_assets (reads through Project)
├── eventSim.ts              dry-run interpreter for event command lists (simulate_event, pure)
├── dialogueTree.ts          dialogue tree to event commands compiler (build_dialogue_tree, pure)
├── shopCommands.ts          302/605 shop command builder shared by dialogueTree and eventTemplates (leaf module)
├── eventIndex.ts            project-wide event page and reference index (reads through Project)
├── usages.ts                find_usages queries and warnings over the index
├── progression.ts           analyze_progression fixpoint and map graph over the index (pure)
├── eventTemplates.ts        chest/door/inn/shop/save point/NPC templates (create_event_from_template, pure)
├── mapDiff.ts               tile and event diff between two map files (render_diff, pure)
├── stamps.ts                capture/place map stamps stored in .mcp-stamps/
├── tileProfile.ts           tile profiles and their suggestion from tileset data (pure)
├── gen/                     procedural map generators (pure): layout.ts shared types and helpers,
│                            dungeon.ts, cave.ts, materialize.ts (layout to paint operations)
├── playtest/
│   └── staticServer.ts      static file server for browser playtests (safe path resolution)
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
    ├── assetTools.ts        import_asset, list_assets, preview_asset
    ├── authoringTools.ts    build_dialogue_tree, create_event_from_template
    ├── generationTools.ts   generate_map, capture_stamp, place_stamp, list_stamps
    ├── tileTools.ts         tilesets and paint_tiles / render_map
    ├── renderTools.ts       render_map_image, render_diff
    ├── connectTools.ts      connect_maps, list_map_connections
    ├── balanceTools.ts      bulk edits, curves, balance_report, simulate_battle
    ├── localizationTools.ts export_texts, import_texts
    ├── pluginTools.ts       js/plugins.js management and plugin source files
    ├── playtestTools.ts     NW.js / browser playtesting
    ├── maintenanceTools.ts  backups, editor_status and project validation
    ├── changesetTools.ts    begin/commit/discard/undo_changeset
    ├── analysisTools.ts     audit_assets, lint_events, simulate_event, find_usages
    └── progressionTools.ts  analyze_progression (registered from analysisTools.ts)
skills/                      bundled SKILL.md workflow guides (shipped in the npm package)
scripts/
├── smoke.mjs                end-to-end smoke test
└── run-unit.mjs             runs every test/*.test.mjs with node --test (Node 18 has no --test globs)
test/                        unit tests (node:test, *.test.mjs) importing the compiled ../dist/ modules;
                             run `npm run build` before `npm run test:unit`
└── helpers/
    └── fixtureProject.mjs   builds a throwaway MV-shaped project on disk from plain objects (not a test)
```

## Guidelines

- **Every project write goes through `Project`.** Use `project.writeJson()` for data files
  and `project.writeText()` for anything else (plugins.js, plugin sources, exported files).
  They take the session backup, keep editor_status's external-change tracking accurate and,
  while a changeset is open, stage the edit instead of writing it. Binary files (imported
  images and sounds) go through `project.writeBinary()`: same backup and tracking, but binary
  content cannot be staged, so it is refused while a changeset is open (a tool should check
  `project.changesetActive` before reading its source, as `import_asset` does). Never write
  project files with `fs` directly (and do not just call `project.backup()` before an `fs`
  write): that bypasses an open changeset. Likewise read with `project.readJson()` /
  `readText()` and check existence with `project.exists()`, so staged content is respected.
- **Match the MV editor's file format.** Data arrays are 1-indexed with `null` at
  index 0; array files are written one element per line; ids must equal array
  positions. `project.writeJson()` handles the formatting.
- **Tools should fail with helpful messages.** Wrap handlers in `safe()` and throw
  `ProjectError` with a message that tells the client what to do instead.
- **Add smoke coverage** in `scripts/smoke.mjs` for every new tool, and unit tests in
  `test/*.test.mjs` for logic that can be tested without a project.
- **Preview before bulk writes.** Tools that change many records default to `dryRun: true`.
- **Skill files** are part of the product: when you change a tool's behaviour, update the
  matching `skills/*/SKILL.md`.
- Keep tool descriptions written for an AI client: state parameter semantics and
  RPG Maker quirks (scopes, command codes, chance values) in the description.

## Releasing

Releases are automatic. To ship a new version, include these in a PR to `main`:

1. Bump `version` in `package.json`, both `version` fields in `server.json`, and keep the server
   version in `src/index.ts` and the two `version` fields at the top of `package-lock.json` in step.
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
