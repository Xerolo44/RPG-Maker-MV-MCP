---
name: rpgmaker-localization
description: Translating an RPG Maker MV game by exporting every text to CSV/JSON and importing it back, preserving control codes. Use when localizing a game or reviewing all of its text.
---

# Localization workflow

## Tools
- **`export_texts {format: "csv" | "json", scope?, file?}`** writes every translatable string to a file inside the project (default `localization/texts.csv`) and reports counts per category. Rows are `key, context, original, translation`.
- **`import_texts {file, dryRun?}`** applies the `translation` column. **Dry run is the default**: it reports what would change, which keys are unknown and which originals no longer match the project. Apply with `dryRun: false`.

## What is exported
Database names, descriptions, nicknames, profiles and battle messages; System terms and type names; the game title and currency; map display names; and event text - dialogue boxes (one row per message box, lines joined by newlines), choice labels, scrolling text, and the actor name/nickname/profile commands - in maps, common events and troop battle events.

## Steps
1. `export_texts` (optionally with `scope`, e.g. `["maps"]`).
2. Translate the `translation` column row by row. Leave a cell empty to keep the original. For big games work in batches by reading the file in chunks.
3. `import_texts` with `dryRun: true`, review the report, then apply.
4. `validate_project`, then `playtest_start` and read a few scenes.

## Rules for translators
- **Keep control codes exactly:** `\C[n]` colour, `\V[n]` variable, `\N[n]` actor name, `\G` currency, `\I[n]` icon, `\{` `\}` size, `\.` `\|` `\!` `\^` pauses, `\$` gold window, `\>` `\<` instant text. Moving them is fine, deleting or altering them is not. (The exported files contain them as written in the game, e.g. `\C[2]Hero\C[0]`.)
- Keep **line length** in mind: a message box shows 4 lines and roughly 40-50 characters per line at the default font. A translation with more than 4 lines is split into extra message boxes on import (no text is lost, but check the pacing).
- Do not translate `key` or `context`. If `original` differs from the project, the text changed after export - re-export or review before importing that row.
- Names used by code (plugin parameters, note tags `<...>`) are not exported on purpose.
- CJK languages need a font that supports them (set in `fonts/` and `gamefont.css`).
