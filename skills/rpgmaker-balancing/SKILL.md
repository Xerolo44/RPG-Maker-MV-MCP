---
name: rpgmaker-balancing
description: Balancing an RPG Maker MV game with data - parameter curves, enemy scaling, bulk edits with dry-run diffs, balance reports and battle simulation. Use when tuning difficulty, stats, damage or rewards.
---

# Balancing with numbers, not guesses

## Principles
- Decide the **target experience** first, then measure it: hits-to-kill for normal enemies (2-4), for bosses (10-25), and how many enemy hits a party member survives (3-6).
- Change one lever at a time (class curves, enemy stats, skill formulas, gear) and re-measure.
- Formulas and traits are described in `rpgmaker://reference/damage-formulas` and `rpgmaker://reference/trait-codes`.

## Tools
1. **`balance_report`** - class stat curves, damage vs enemy HP (hits to kill) and enemy threat vs your classes. Start here; read the `warnings`.
2. **`simulate_battle {troopId, party}`** - Monte-Carlo run of a troop against a party (win rate, turns, survivors, who does the damage). Use it for bosses and for spot-checking dungeon progression. It uses the real damage formulas, variance, crits, hit/evasion and turn order; skills with states or special effects are approximated as plain damage.
3. **`generate_param_curve`** - writes a class stat curve from a start and end value with a shape (`linear`, `ease-in`, `ease-out`, `ease-in-out`, `exponential`, `logistic`). Dry run by default, shows sample levels.
4. **`generate_enemy_scaling`** - spreads stats along a curve over an ordered list of enemies (weakest to strongest) for smooth difficulty progression, including `exp` and `gold`.
5. **`bulk_update_records`** - "all weapons +10% attack": `changes: [{field: "params.atk", op: "percent", value: 10}]`. Filter with `ids` or `where`. **Dry run is the default**; show the diff, then repeat with `dryRun: false`.

## Workflow
1. `balance_report` -> note the outliers.
2. Fix the cause: a class curve that falls behind (`generate_param_curve`), an enemy tier out of line (`generate_enemy_scaling`), a skill that is too strong (`update_record` on its `damage.formula`).
3. Preview bulk changes with `bulk_update_records` before applying.
4. `simulate_battle` the key fights; aim for the win rate and turn count you decided on.
5. Repeat until the report has no warnings you do not accept. Tell the user which numbers you changed and why.

## Handy ratios
- Damage with the stock formula `a.atk*4 - b.def*2` is roughly 2x the attacker's ATK when DEF is similar - so keep enemy HP around (desired hits) x (2 x party ATK).
- Rewards: gold and EXP should grow along the same curve as enemy HP, or players will out-level or under-earn.
- Gear: each tier should add 10-25% to the relevant stat, not flat huge jumps.
- EXP curve: `expParams` is `[base, extra, accelA, accelB]` per class; lower base = faster levelling.

## Limits to mention
Reports ignore elemental affinities beyond the skill's own element, state effects, items, AI conditions beyond ratings, and equipment other than what the actor starts with. They are guides, not a replacement for a playtest.
