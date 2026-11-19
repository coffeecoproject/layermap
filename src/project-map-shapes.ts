import type { MapAnchor, MapObject } from "./project-map-types";
import type { MapViewGraph } from "./project-map-view-graph";

// The map keeps calls and each declaration's reads of module state, not who reads a field or names
// a type: a repository would hold tens of thousands of those rows, so they are found on demand. A
// change check cannot read that absence as "nothing uses it", so it reads them as its trace reaches
// each field or type, and follows the code using them as it follows callers.

const KINDS = new Set<MapObject["kind"]>(["PROPERTY", "TYPE", "INTERFACE", "ENUM"]);
// A guard, not a working limit: real changes take a few compiles of a few seconds. The trace's own
// limits keep how many declarations it reaches.
const READ_MS = 20_000;

/** A field or type: other code uses it without a relation the map keeps. A callable has its calls. */
export const mapIsShape = (object: Pick<MapObject, "kind" | "execution">) =>
  KINDS.has(object.kind) && object.execution !== "CLOSURE";

const TYPE_KINDS = new Set<MapObject["kind"]>(["TYPE", "INTERFACE"]);

/**
 * A declaration for the compiler alone: a type or interface, or a member of one that holds no code
 * (an interface member, a property of a type literal). Nothing runs it, so no test can run it; the
 * type checker judges it. A member with code of its own (a default method, a constant's value) runs.
 */
export function mapTypeOnly(graph: MapViewGraph, ref: string): boolean {
  for (let at: string | undefined = ref; at !== undefined; at = graph.parent(at)) {
    const object = graph.object(at);
    if (TYPE_KINDS.has(object.kind)) return true;
    if (object.execution || (object.kind !== "PROPERTY" && object.kind !== "METHOD")) return false;
  }
  return false;
}

export type MapShapeUse = Readonly<{ owner: string; anchor: MapAnchor; write: boolean }>;

/** Each declaration's uses, by the object around each; complete is false when some were left out. */
export type MapShapeReader = (
  refs: readonly string[],
  until: number,
) => Promise<ReadonlyMap<string, Readonly<{ uses: readonly MapShapeUse[]; complete: boolean }>>>;

/** When one check stops reading, across the versions it reads. */
export const mapShapeDeadline = () => Date.now() + READ_MS;

/** The uses read so far in one version, each field or type read once. */
export class MapShapeUses {
  /** Each field or type read, with each of its uses in the declarations outside it. */
  readonly uses = new Map<string, readonly MapShapeUse[]>();
  /** Those whose uses could not all be read, or that the deadline left out. */
  readonly unread = new Set<string>();

  constructor(
    private readonly graph: MapViewGraph,
    private readonly reader: MapShapeReader,
    private readonly until: number,
  ) {}

  async read(refs: readonly string[]) {
    const wanted = [...new Set(refs)].filter(
      (ref) => mapIsShape(this.graph.object(ref)) && !this.uses.has(ref) && !this.unread.has(ref),
    );
    if (!wanted.length) return;
    const found =
      Date.now() > this.until
        ? new Map<string, undefined>()
        : await this.reader(wanted, this.until);
    for (const ref of wanted) {
      const read = found.get(ref);
      if (!read?.complete) this.unread.add(ref);
      if (!read) continue;
      const outside: MapShapeUse[] = [];
      for (const use of read.uses) {
        const owner = this.graph.owner(use.owner);
        if (owner !== ref) outside.push({ ...use, owner });
      }
      this.uses.set(ref, outside);
    }
  }
}
