import { z } from "zod";
import { digestValue } from "./digest";
import {
  MapAnchorSchema,
  MapExecutionKindSchema,
  MapNoteSchema,
  MapObjectKindSchema,
  MapRelationSchema,
} from "./project-map-types";

export const MapTextObjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    kind: MapObjectKindSchema,
    anchor: MapAnchorSchema,
    execution: MapExecutionKindSchema.optional(),
  })
  .strict();

export const MapTextGraphSchema = z
  .object({
    targetRef: z.string().optional(),
    objects: z.array(MapTextObjectSchema),
    relations: z.array(z.object({ relation: MapRelationSchema }).strict()),
    notes: z.array(MapNoteSchema),
    traversal: z
      .object({
        semantics: z.literal("STATIC_RELATIONSHIPS"),
        frontier: z.array(
          z
            .object({
              entityRef: z.string(),
              direction: z.enum(["INCOMING", "OUTGOING", "BOTH"]),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

type TextGraph = z.infer<typeof MapTextGraphSchema>;
type TextObject = z.infer<typeof MapTextObjectSchema>;
type Anchor = TextObject["anchor"];

const header = [
  "CODE_MAP_TEXT_V1",
  "F=file; N=name,kind,location,execution; R=from → to,kind,location,basis,target,unresolved reason; D=source note; T=entry; B=unexpanded boundary.",
  "Location F:line-line@start-end uses UTF-16 offsets (end exclusive). N/F labels are local to this response; use the file path and start offset for a source locator. '-' means absent.",
];
const objectId = ({ anchor, kind }: Pick<TextObject, "anchor" | "kind">) =>
  digestValue({ path: anchor.path, start: anchor.start, end: anchor.end, kind });
const failed = (): never => {
  throw new Error("PROJECT_MAP_TEXT_INVALID");
};
const string = (value: string | undefined): string => {
  if (value === undefined) return failed();
  return z.string().parse(JSON.parse(value));
};

// The exceptional ID preserves inventory objects and previously persisted noncanonical
// identities. Normal compiler objects and relationships reconstruct their existing IDs.
const identity = (id: string, reconstructed: string) =>
  id === reconstructed ? [] : [JSON.stringify(id)];

export function encodeMapText(graph: TextGraph): string {
  const files = new Map<string, string>();
  const file = (path: string) => {
    let ref = files.get(path);
    if (!ref) {
      ref = `F${files.size + 1}`;
      files.set(path, ref);
    }
    return ref;
  };
  const at = (anchor: Anchor) =>
    `${file(anchor.path)}:${anchor.startLine}-${anchor.endLine}@${anchor.start}-${anchor.end}`;
  const nodes = new Map(graph.objects.map((object, index) => [object.id, `N${index + 1}`]));
  const node = (id: string) => nodes.get(id) ?? failed();
  const rows = graph.objects.map((object) =>
    [
      node(object.id),
      JSON.stringify(object.name),
      object.kind,
      at(object.anchor),
      object.execution ?? "-",
      ...identity(object.id, objectId(object)),
    ].join("\t"),
  );
  for (const { relation } of graph.relations) {
    const { id, ...semantic } = relation;
    rows.push(
      [
        "R",
        `${node(relation.from)} → ${relation.to === undefined ? "-" : node(relation.to)}`,
        relation.kind,
        at(relation.anchor),
        relation.basis,
        JSON.stringify(relation.target),
        relation.unresolvedReason ?? "-",
        ...identity(id, digestValue(semantic)),
      ].join("\t"),
    );
  }
  for (const note of graph.notes)
    rows.push(
      [
        "D",
        node(note.entityRef),
        note.kind,
        at(note.anchor),
        note.truncated ? "TRUNCATED" : "COMPLETE",
        JSON.stringify(note.text),
      ].join("\t"),
    );
  if (graph.targetRef !== undefined) rows.push(`T\t${node(graph.targetRef)}`);
  for (const frontier of graph.traversal.frontier)
    rows.push(`B\t${node(frontier.entityRef)}\t${frontier.direction}`);
  return [
    ...header,
    ...[...files].map(([path, ref]) => `${ref}\t${JSON.stringify(path)}`),
    ...rows,
  ].join("\n");
}

export function decodeMapText(text: string): TextGraph {
  const lines = text.split("\n");
  if (!header.every((line, index) => lines[index] === line)) return failed();
  const files = new Map<string, string>();
  const nodes = new Map<string, TextObject>();
  const ids = new Set<string>();
  const graph: TextGraph = {
    objects: [],
    relations: [],
    notes: [],
    traversal: { semantics: "STATIC_RELATIONSHIPS", frontier: [] },
  };
  const node = (ref: string | undefined) => (ref && nodes.get(ref)?.id) || failed();
  const at = (value: string | undefined): Anchor => {
    const match = /^(F[1-9]\d*):(\d+)-(\d+)@(\d+)-(\d+)$/u.exec(value ?? "");
    if (!match) return failed();
    const path = files.get(match[1] ?? "");
    if (path === undefined) return failed();
    return MapAnchorSchema.parse({
      path,
      startLine: Number(match[2]),
      endLine: Number(match[3]),
      start: Number(match[4]),
      end: Number(match[5]),
    });
  };
  for (const line of lines.slice(header.length)) {
    const fields = line.split("\t");
    const tag = fields[0] ?? "";
    if (/^F[1-9]\d*$/u.test(tag)) {
      if (fields.length !== 2 || files.has(tag)) return failed();
      files.set(tag, string(fields[1]));
    } else if (/^N[1-9]\d*$/u.test(tag)) {
      if ((fields.length !== 5 && fields.length !== 6) || nodes.has(tag)) return failed();
      const anchor = at(fields[3]);
      const kind = MapObjectKindSchema.parse(fields[2]);
      const object = MapTextObjectSchema.parse({
        id: fields[5] === undefined ? objectId({ anchor, kind }) : string(fields[5]),
        name: string(fields[1]),
        kind,
        anchor,
        ...(fields[4] === "-" ? {} : { execution: MapExecutionKindSchema.parse(fields[4]) }),
      });
      if (ids.has(object.id)) return failed();
      ids.add(object.id);
      nodes.set(tag, object);
      graph.objects.push(object);
    } else if (tag === "R") {
      if (fields.length !== 7 && fields.length !== 8) return failed();
      const endpoints = /^(N[1-9]\d*) → (N[1-9]\d*|-)$/u.exec(fields[1] ?? "");
      if (!endpoints) return failed();
      const semantic = MapRelationSchema.omit({ id: true }).parse({
        from: node(endpoints[1]),
        ...(endpoints[2] === "-" ? {} : { to: node(endpoints[2]) }),
        kind: fields[2],
        anchor: at(fields[3]),
        basis: fields[4],
        target: string(fields[5]),
        ...(fields[6] === "-" ? {} : { unresolvedReason: fields[6] }),
      });
      graph.relations.push({
        relation: {
          ...semantic,
          id: fields[7] === undefined ? digestValue(semantic) : string(fields[7]),
        },
      });
    } else if (tag === "D") {
      if (fields.length !== 6 || !["TRUNCATED", "COMPLETE"].includes(fields[4] ?? ""))
        return failed();
      graph.notes.push(
        MapNoteSchema.parse({
          entityRef: node(fields[1]),
          kind: fields[2],
          anchor: at(fields[3]),
          truncated: fields[4] === "TRUNCATED",
          text: string(fields[5]),
        }),
      );
    } else if (tag === "T") {
      if (fields.length !== 2 || graph.targetRef !== undefined) return failed();
      graph.targetRef = node(fields[1]);
    } else if (tag === "B") {
      if (fields.length !== 3) return failed();
      graph.traversal.frontier.push({
        entityRef: node(fields[1]),
        direction: z.enum(["INCOMING", "OUTGOING", "BOTH"]).parse(fields[2]),
      });
    } else return failed();
  }
  return graph;
}
