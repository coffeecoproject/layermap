import { transformSync } from "esbuild";
import type { Hunk, Lines } from "./project-map-change-types";

// A change to a TypeScript file's types alone (annotations, type arguments, inline types, what only
// the compiler reads), to its comments or to its layout leaves the code that runs as it was: the
// runtimes tests run in erase the types the same way, so no test runs that code differently. The
// change check erases the types from both versions of a changed file and compares what is left,
// hunk by hunk, to tell the lines whose code changed from the rest.
//
// Erasing is the type-checker-free erasure every TypeScript runtime does, with two exceptions it
// cannot see: decorator metadata, where types become values, and compiler plugins that generate
// code from types. A file with decorators is not judged. Wherever the erased versions do not line up
// with the diff, or a file does not erase, the file is not judged either, and its changed lines all
// count as code, as before.

const LOADERS: Readonly<Record<string, "ts" | "tsx">> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
};
// esbuild lowers decorators into calls of these helpers when told the target lacks decorators.
const DECORATED = /\b__decorat(?:orStart|eClass|eParam)\b/u;
// Past this many line pairs, a hunk's erased code is not lined up; its lines count as code.
const PAIRS = 4_000_000;

/** Whether the change check erases a file's types to tell the lines whose code changed. */
export const mapErasable = (path: string) =>
  !path.endsWith(".d.ts") && LOADERS[path.slice(path.lastIndexOf("."))] !== undefined;

/** An erased file: each line of the code left, trimmed, and the source lines it came from. */
type Erased = Readonly<{ lines: readonly string[]; from: readonly (readonly [number, number])[] }>;

function erase(text: string, path: string): Erased | undefined {
  const loader = LOADERS[path.slice(path.lastIndexOf("."))];
  if (!loader) return undefined;
  let code: string;
  let map: string;
  try {
    ({ code, map } = transformSync(text, {
      loader,
      sourcefile: path,
      target: "esnext",
      // Lowered, so a decorator shows in the helpers it needs.
      supported: { decorators: false },
      jsx: "preserve",
      legalComments: "none",
      sourcemap: "external",
      logLevel: "silent",
      // Fields declared without a value are fields at run time under the standard semantics, and an
      // import is kept as written: whichever the project's settings, a change to either is code.
      tsconfigRaw: {
        compilerOptions: { useDefineForClassFields: true, verbatimModuleSyntax: true },
      },
    }));
  } catch {
    return undefined;
  }
  if (DECORATED.test(code)) return undefined;
  const lines = code.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const from = sourceLines(map, lines.length);
  if (!from) return undefined;
  return { lines: lines.map((line) => line.trim()), from };
}

const VLQ = new Map(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]),
);

/**
 * The 1-based source lines each generated line came from, from a source map's mappings. A line
 * holding no token of its own place (the inside of a template string, a comment esbuild keeps)
 * lies between the lines of the tokens around it.
 */
function sourceLines(map: string, count: number): [number, number][] | undefined {
  let mappings: string;
  try {
    mappings = String(JSON.parse(map).mappings);
  } catch {
    return undefined;
  }
  const seen: (number[] | undefined)[] = [];
  let source = 0;
  const groups = mappings.split(";");
  for (const [generated, group] of groups.entries()) {
    for (const segment of group ? group.split(",") : []) {
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = VLQ.get(char);
        if (digit === undefined) return undefined;
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      if (fields.length < 4) continue;
      source += fields[2] as number;
      // A token at the place of the one before it (a comment esbuild keeps, a line of a template
      // string) does not say where its own line was.
      if (fields[2] === 0 && fields[3] === 0) continue;
      const lines = seen[generated] ?? [];
      lines.push(source + 1);
      seen[generated] = lines;
    }
  }
  // The lines of the nearest mapped tokens before and after each generated line.
  const last: (number | undefined)[] = [];
  const next: (number | undefined)[] = [];
  for (let line = 0, at: number | undefined; line < count; line++) {
    last[line] = at;
    const own = seen[line];
    if (own?.length) at = Math.max(...own);
  }
  for (let line = count - 1, at: number | undefined; line >= 0; line--) {
    next[line] = at;
    const own = seen[line];
    if (own?.length) at = Math.min(...own);
  }
  const from: [number, number][] = [];
  for (let line = 0; line < count; line++) {
    const own = seen[line];
    if (own?.length) from.push([Math.min(...own), Math.max(...own)]);
    else if (last[line] === undefined && next[line] === undefined) return undefined;
    else from.push([last[line] ?? 1, next[line] ?? Number.MAX_SAFE_INTEGER]);
  }
  return from;
}

/** A hunk's lines on one side: a range, or the point after a line when it spans none. */
type Region = Readonly<{ from: number; to: number }>;
const touches = (region: Region, [start, end]: readonly [number, number]) =>
  region.from <= region.to
    ? start <= region.to && region.from <= end
    : start <= region.to && end >= region.from;

/**
 * The lines of a changed TypeScript file in the working tree whose code changed once types are
 * erased, as the diff's lines are written (a point for code only removed); undefined where that is
 * not worked out, and every changed line counts as code.
 */
export function mapRuntimeLines(
  path: string,
  baseText: string,
  text: string,
  hunks: readonly Hunk[],
): Lines | undefined {
  const before = erase(baseText, path);
  const after = erase(text, path);
  if (!before || !after) return undefined;
  const regions = hunks.map((hunk) => ({
    base: hunk.baseCount
      ? { from: hunk.baseStart, to: hunk.baseStart + hunk.baseCount - 1 }
      : { from: hunk.baseStart + 1, to: hunk.baseStart },
    working: hunk.count
      ? { from: hunk.start, to: hunk.start + hunk.count - 1 }
      : { from: hunk.start + 1, to: hunk.start },
  }));
  // The code outside every hunk is what the diff left as it was: if it differs once erased, the
  // erased versions do not line up with the diff, and nothing here is judged.
  const outside = (erased: Erased, side: "base" | "working") =>
    erased.lines.filter(
      (_, line) =>
        !regions.some((region) => touches(region[side], erased.from[line] as [number, number])),
    );
  const kept = outside(before, "base");
  const left = outside(after, "working");
  // A comma ending a line the diff left can come or go with the item after it, in a hunk.
  const bare = (line: string | undefined) => line?.replace(/,$/u, "");
  if (kept.length !== left.length || kept.some((line, at) => bare(line) !== bare(left[at])))
    return undefined;
  const lines: [number, number][] = [];
  for (const region of regions) {
    const pick = (erased: Erased, side: Region) =>
      erased.lines.flatMap((line, at) => {
        const from = erased.from[at] as [number, number];
        return touches(side, from) ? [{ line, from }] : [];
      });
    lines.push(
      ...changedIn(pick(before, region.base), pick(after, region.working), region.working),
    );
  }
  // The versions differ once erased, yet no hunk says where: they do not line up with the diff.
  const same =
    before.lines.length === after.lines.length &&
    before.lines.every((line, at) => line === after.lines[at]);
  if (!same && !lines.length) return undefined;
  const seen = new Set<string>();
  return lines
    .sort(([a, b], [c, d]) => a - c || b - d)
    .filter((range) => !seen.has(`${range}`) && Boolean(seen.add(`${range}`)));
}

type Piece = Readonly<{ line: string; from: readonly [number, number] }>;

/**
 * The working lines of one hunk whose erased code changed: those holding code the base's side does
 * not have, and, where base code is gone, the stretch between the code kept on either side of it.
 */
function changedIn(
  base: readonly Piece[],
  working: readonly Piece[],
  region: Region,
): [number, number][] {
  if (base.length === working.length && base.every((piece, at) => piece.line === working[at]?.line))
    return [];
  const whole: [number, number] = [region.from, region.to];
  if (base.length * working.length > PAIRS) return [whole];
  // The longest common sequence of lines, as pairs of positions.
  const width = working.length + 1;
  const table = new Uint32Array((base.length + 1) * width);
  for (let i = base.length - 1; i >= 0; i--)
    for (let j = working.length - 1; j >= 0; j--)
      table[i * width + j] =
        base[i]?.line === working[j]?.line
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < base.length && j < working.length; )
    if (base[i]?.line === working[j]?.line) pairs.push([i++, j++]);
    else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) i++;
    else j++;
  const lines: [number, number][] = [];
  const clamp = (start: number, end: number) => {
    const from = Math.max(start, region.from);
    const to = Math.min(end, region.to);
    // A region that is a point keeps the point: code only removed there.
    lines.push(region.from <= region.to && from <= to ? [from, to] : whole);
  };
  const matched = new Set(pairs.map(([, j]) => j));
  for (const [j, piece] of working.entries()) if (!matched.has(j)) clamp(...piece.from);
  // Each run of base lines without a partner lies between two pairs, or a pair and the hunk's edge.
  const bounds: [number, number][] = [[-1, -1], ...pairs, [base.length, working.length]];
  for (let at = 1; at < bounds.length; at++) {
    const [i0, j0] = bounds[at - 1] as [number, number];
    const [i1, j1] = bounds[at] as [number, number];
    if (i1 - i0 <= 1) continue;
    clamp(
      j0 >= 0 ? (working[j0] as Piece).from[1] : region.from,
      j1 < working.length ? (working[j1] as Piece).from[0] : region.to,
    );
  }
  return lines;
}
