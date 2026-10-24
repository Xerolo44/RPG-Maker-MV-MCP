// Stat-curve shapes for class parameter tables and enemy scaling.

export const PARAM_NAMES = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"] as const;
export type ParamName = (typeof PARAM_NAMES)[number];

export const CURVE_SHAPES = ["linear", "ease-in", "ease-out", "ease-in-out", "exponential", "logistic"] as const;
export type CurveShape = (typeof CURVE_SHAPES)[number];

export function paramIndex(param: string | number): number {
  if (typeof param === "number") {
    if (!Number.isInteger(param) || param < 0 || param > 7) throw new Error(`Parameter index ${param} must be 0-7.`);
    return param;
  }
  const i = PARAM_NAMES.indexOf(param.toLowerCase() as ParamName);
  if (i < 0) throw new Error(`Unknown parameter "${param}". Use ${PARAM_NAMES.join(", ")} (or 0-7).`);
  return i;
}

/**
 * Value of a curve at position t (0 = first point, 1 = last point).
 * `exponent` is the power for the ease shapes (default 2) and the steepness for logistic (default 8).
 */
export function curveValue(shape: CurveShape, start: number, end: number, t: number, exponent?: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (shape) {
    case "linear":
      return start + (end - start) * x;
    case "ease-in":
      return start + (end - start) * Math.pow(x, exponent ?? 2);
    case "ease-out":
      return start + (end - start) * (1 - Math.pow(1 - x, exponent ?? 2));
    case "ease-in-out": {
      const p = exponent ?? 2;
      const f = x < 0.5 ? 0.5 * Math.pow(2 * x, p) : 1 - 0.5 * Math.pow(2 * (1 - x), p);
      return start + (end - start) * f;
    }
    case "exponential":
      if (start <= 0 || end <= 0) {
        throw new Error("The exponential shape needs start and end above 0 (it grows by a constant factor); use ease-in instead.");
      }
      return start * Math.pow(end / start, x);
    case "logistic": {
      const k = exponent ?? 8;
      const f = (v: number): number => 1 / (1 + Math.exp(-k * (v - 0.5)));
      return start + (end - start) * ((f(x) - f(0)) / (f(1) - f(0)));
    }
  }
}
