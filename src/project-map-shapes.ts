import type { MapAnchor, MapObject } from "./project-map-types";
import type { MapViewGraph } from "./project-map-view-graph";

// The map keeps calls and each declaration's reads of module state, not who reads a field or names
// a type: a repository would hold tens of thousands of those rows, so they are found on demand. A
// change check cannot read that absence as "nothing uses it", so it asks for the declarations whose
// uses the map leaves out, and follows the code using them as it follows callers.

const KINDS = new Set<MapObject["kind"]>(["PROPERTY", "TYPE", "INTERFACE", "ENUM"]);
// Each read compiles the context the declaration is in, which on a large repository takes seconds.
const LIMIT = Object.freeze({ shapes: 60, milliseconds: 20_000 });

/** A field or type: other code uses it without a relation the map keeps. A callable has its calls. */
export const mapIsShape = (object: Pick<MapObject, "kind" | "execution">) =>
  KINDS.has(object.kind) && object.execution !== "CLOSURE";

export type MapShapeUse = Readonly<{ owner: string; anchor: MapAnchor; write: boolean }>;

/** One declaration's uses, by the object around each; complete is false when more were left out. */
export type MapShapeReader = (
  ref: string,
) => Promise<Readonly<{ uses: readonly MapShapeUse[]; complete: boolean }> | undefined>;

export type MapShapeUses = Readonly<{
  /** Each field or type read, with each of its uses in the declarations outside it. */
  uses: ReadonlyMap<string, readonly MapShapeUse[]>;
  /** Those whose uses could not all be read, or that the limit left out. */
  unread: ReadonlySet<string>;
}>;

export const MAP_NO_SHAPE_USES: MapShapeUses = Object.freeze({
  uses: new Map<string, readonly MapShapeUse[]>(),
  unread: new Set<string>(),
});

/**
 * The uses of the fields and types among the given declarations and, as a type's use may be a field
 * of another type, of the fields and types that use them, up to a limit of declarations and time.
 * Without following, of the given declarations alone.
 */
export async function mapShapeUses(
  graph: MapViewGraph,
  starts: readonly string[],
  read: MapShapeReader,
  follow = true,
): Promise<MapShapeUses> {
  const uses = new Map<string, MapShapeUse[]>();
  const unread = new Set<string>();
  const pending = starts.filter((ref) => mapIsShape(graph.object(ref)));
  const seen = new Set(pending);
  let budget = LIMIT.shapes;
  const deadline = Date.now() + LIMIT.milliseconds;
  for (let ref = pending.shift(); ref !== undefined; ref = pending.shift()) {
    if (budget-- <= 0 || Date.now() > deadline) {
      unread.add(ref);
      continue;
    }
    const found = await read(ref);
    if (!found?.complete) unread.add(ref);
    const outside: MapShapeUse[] = [];
    for (const use of found?.uses ?? []) {
      const owner = graph.owner(use.owner);
      if (owner === ref) continue;
      outside.push({ ...use, owner });
      if (follow && mapIsShape(graph.object(owner)) && !seen.has(owner)) {
        seen.add(owner);
        pending.push(owner);
      }
    }
    uses.set(ref, outside);
  }
  return { uses, unread };
}
