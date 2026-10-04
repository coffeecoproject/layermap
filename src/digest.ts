import { createHash } from "node:crypto";

const normalize = (value: unknown, seen: Set<object>): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON values must contain finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical JSON values must not contain cycles.");
    seen.add(value);
    const normalized = value.map((entry) => normalize(entry, seen));
    seen.delete(value);
    return normalized;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Canonical JSON values must not contain cycles.");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON values must be plain JSON-compatible objects.");
    }
    seen.add(value);
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) {
        throw new TypeError("Canonical JSON values must not contain undefined fields.");
      }
      normalized[key] = normalize(entry, seen);
    }
    seen.delete(value);
    return normalized;
  }
  throw new TypeError(`Canonical JSON values cannot contain ${typeof value}.`);
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalize(value, new Set<object>()));

export const digestValue = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
