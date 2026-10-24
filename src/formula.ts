// Safe evaluator for RPG Maker damage formulas. The formulas come from project files, so they
// are checked against a whitelist (numbers, operators and a fixed set of identifiers) before
// being compiled - no strings, assignments, calls on arbitrary objects or global access.

const ALLOWED_IDENTIFIERS = new Set([
  "a", "b", "v", "Math",
  // battler properties
  "hp", "mp", "tp", "mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk", "level",
  "hit", "eva", "cri", "cev", "mev", "mrf", "cnt", "hrg", "mrg", "trg",
  "tgr", "grd", "rec", "pha", "mcr", "tcr", "pdr", "mdr", "fdr", "exr",
  // battler methods
  "isStateAffected", "isActor", "isEnemy", "isDead", "isAlive", "isDying",
  // Math members
  "max", "min", "floor", "ceil", "round", "abs", "pow", "sqrt", "random", "PI", "log", "exp", "sign", "trunc",
  // literals
  "true", "false", "null", "undefined", "Infinity", "NaN",
]);

const TOKEN = /\s+|\d+\.?\d*(?:e[+-]?\d+)?|[A-Za-z_$][\w$]*|===|!==|==|!=|<=|>=|&&|\|\||\*\*|[()[\]?:,.+\-*/%<>!]/gy;

export class FormulaError extends Error {}

/** Throws a FormulaError when the formula uses anything outside the whitelist. */
export function assertSafeFormula(formula: string): void {
  if (formula.length > 500) throw new FormulaError("formula is too long");
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < formula.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(formula);
    if (!m) throw new FormulaError(`unsupported character "${formula[pos]}" at position ${pos}`);
    const token = m[0];
    if (/^[A-Za-z_$]/.test(token) && !ALLOWED_IDENTIFIERS.has(token)) {
      throw new FormulaError(`identifier "${token}" is not allowed`);
    }
    pos += token.length;
  }
}

export interface FormulaContext {
  a: object;
  b: object;
  v: number[];
  math: Pick<Math, "max" | "min" | "floor" | "ceil" | "round" | "abs" | "pow" | "sqrt" | "random" | "PI" | "log" | "exp" | "sign" | "trunc">;
}

type Compiled = (a: object, b: object, v: number[], Math: FormulaContext["math"]) => unknown;
const cache = new Map<string, Compiled | FormulaError>();

function compile(formula: string): Compiled | FormulaError {
  let entry = cache.get(formula);
  if (entry) return entry;
  try {
    assertSafeFormula(formula);
    entry = new Function("a", "b", "v", "Math", `"use strict"; return (${formula});`) as Compiled;
  } catch (err) {
    entry = err instanceof FormulaError ? err : new FormulaError(err instanceof Error ? err.message : String(err));
  }
  cache.set(formula, entry);
  return entry;
}

/** Why a formula cannot be evaluated, or null when it is fine. */
export function formulaProblem(formula: string): string | null {
  const c = compile(formula);
  return c instanceof FormulaError ? c.message : null;
}

/** Evaluate like the engine does: errors and NaN count as 0, negative results are clamped to 0. */
export function evalFormula(formula: string, ctx: FormulaContext): number {
  const c = compile(formula);
  if (c instanceof FormulaError) return 0;
  try {
    const value = Number(c(ctx.a, ctx.b, ctx.v, ctx.math));
    return Number.isNaN(value) ? 0 : Math.max(value, 0);
  } catch {
    return 0;
  }
}
