import { z } from "zod";
import { ProjectEvidenceError } from "./core";
import { digestValue } from "./digest";
import { MapOutputCollector } from "./project-map-output";
import { mapQueryPathMatches } from "./project-map-query-selection";
import {
  MapReferenceKindSchema,
  type MapReferencePage,
  type MapReferenceRequest,
} from "./project-map-reference-types";
import { MapSourcePositions } from "./project-map-source-positions";
import {
  type MapAnalysis,
  MapExecutionKindSchema,
  type MapObject,
  MapObjectKindSchema,
  MapRelationKindSchema,
  MapRelationSchema,
  type MapWorkerInput,
} from "./project-map-types";

// Facts an analysis program reports (Go's go-map, the Python worker): objects numbered locally,
// spans as offsets into the admitted text. Programs that count in UTF-8 bytes (go-map) have their
// offsets converted; programs running on JavaScript strings already count UTF-16 code units.
export type MapFactsOffsets = "UTF8_BYTES" | "UTF16";

const span = {
  path: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
};
const id = z.number().int().positive();
export const MapFactsSchema = z
  .object({
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          object: id.optional(),
          excluded: z
            .enum([
              "SYNTAX_ERROR",
              "BUILD_CONSTRAINT_EXCLUDED",
              "PACKAGE_NAME_MISMATCH",
              "IGNORED_DIRECTORY",
            ])
            .optional(),
          // Facts the file has, but incomplete: a type it declares is another file's too.
          issue: z.enum(["DUPLICATE_TYPE"]).optional(),
        })
        .strict(),
    ),
    objects: z.array(
      z
        .object({
          id,
          kind: MapObjectKindSchema,
          name: z.string(),
          ...span,
          nameStart: z.number().int().min(-1),
          parent: id.optional(),
          exported: z.boolean(),
          execution: MapExecutionKindSchema.optional(),
        })
        .strict(),
    ),
    relations: z.array(
      z
        .object({
          kind: MapRelationKindSchema,
          from: id,
          to: id.optional(),
          ...span,
          target: z.string(),
          basis: MapRelationSchema.shape.basis,
          reason: MapRelationSchema.shape.unresolvedReason,
          argument: MapRelationSchema.shape.argument,
          route: MapRelationSchema.shape.route,
        })
        .strict(),
    ),
    notes: z.array(
      z.object({ object: id, kind: z.literal("SOURCE_DOCUMENTATION"), ...span }).strict(),
    ),
    typeErrors: z.number().int().nonnegative(),
    // An incremental build: the files it analyzed, whose facts alone are its own.
    focus: z.array(z.string().min(1)).optional(),
    // What the analyzer keeps for the next build of the context.
    state: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type MapFacts = z.infer<typeof MapFactsSchema>;
export const MapReferenceFactsSchema = z
  .object({
    references: z.array(z.object({ ...span, kind: MapReferenceKindSchema }).strict()),
  })
  .strict();
export type MapReferenceFacts = z.infer<typeof MapReferenceFactsSchema>;

const invalid = (): never => {
  throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
};

// Byte offsets become UTF-16 offsets of the admitted text.
function utf16Offsets(text: string): (byte: number) => number {
  const bytes = Buffer.byteLength(text);
  if (bytes === text.length) return (byte) => byte;
  const table = new Int32Array(bytes + 1);
  let byte = 0;
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    for (let k = 0; k < size; k++) table[byte + k] = index;
    byte += size;
    index += code >= 0x10000 ? 2 : 1;
  }
  table[bytes] = text.length;
  return (offset) => table[offset] ?? invalid();
}

/** Converts a program's offsets in the given files to UTF-16 offsets of their text. */
function offsetConverter(files: Readonly<Record<string, string>>, offsets: MapFactsOffsets) {
  const converters = new Map<string, (offset: number) => number>();
  return (path: string, offset: number) => {
    let convert = converters.get(path);
    if (!convert) {
      const text = files[path];
      if (text === undefined) return invalid();
      convert =
        offsets === "UTF16"
          ? (value) => (value <= text.length ? value : invalid())
          : utf16Offsets(text);
      converters.set(path, convert);
    }
    return convert(offset);
  };
}

/** A UTF-16 offset of the text as the program counts it. */
export const mapFactsOffset = (text: string, offset: number, offsets: MapFactsOffsets) =>
  offsets === "UTF16" ? offset : Buffer.byteLength(text.slice(0, offset));

export type MapFactsContext = Readonly<{
  language: string;
  offsets: MapFactsOffsets;
  configPath?: string;
  optionsDigest: string;
  gaps: MapAnalysis["gaps"];
  // Code for the count of type-check issues the program reported, if any.
  typeIssues: string;
  // Note attached to every interface declaration.
  contract: string;
}>;

/** A program's facts as map units: identities, anchors, containment and notes. */
export function mapFactsAnalysis(
  facts: MapFacts,
  input: Omit<MapWorkerInput, "compilerPath">,
  context: MapFactsContext,
): MapAnalysis {
  const output: MapAnalysis = {
    contexts: [
      {
        ref: input.contextRef,
        ...(context.configPath ? { configPath: context.configPath } : {}),
        optionsDigest: context.optionsDigest,
        mode: context.configPath ? "CONFIGURED" : "INFERRED",
        inputFiles: Object.keys(input.files).sort(),
        configurationFiles: context.configPath ? [context.configPath] : [],
      },
    ],
    objects: [],
    relations: [],
    notes: [],
    gaps: [
      ...context.gaps,
      ...(facts.typeErrors ? [{ code: context.typeIssues, count: facts.typeErrors }] : []),
    ],
    parsedFiles: [],
    requiredFiles: [],
  };
  const collect = new MapOutputCollector(output);
  const positions = new MapSourcePositions(input.files);
  const offset = offsetConverter(input.files, context.offsets);
  const anchor = (path: string, start: number, end: number) =>
    positions.span(path, offset(path, start), offset(path, end));
  // Facts with one span and kind are one object. An object is identified by its file, kind, name
  // and place among the objects around it (its parent and the same-named objects before it
  // there), so an edit elsewhere leaves it, and every relation that names it, unchanged.
  const located = new Map<
    number,
    Readonly<{ fact: MapFacts["objects"][number]; location: MapObject["anchor"] }>
  >();
  const canonical = new Map<number, number>();
  const bySpan = new Map<string, number>();
  for (const fact of facts.objects) {
    const location = anchor(fact.path, fact.start, fact.end);
    const span = `${location.path}\0${location.start}\0${location.end}\0${fact.kind}`;
    const first = bySpan.get(span) ?? fact.id;
    bySpan.set(span, first);
    canonical.set(fact.id, first);
    if (first === fact.id) located.set(fact.id, { fact, location });
  }
  const parentOf = (id: number) => {
    const parent = located.get(id)?.fact.parent;
    return parent === undefined ? 0 : (canonical.get(parent) ?? invalid());
  };
  const siblings = new Map<string, number[]>();
  for (const [id, { fact }] of located) {
    const group = `${parentOf(id)}\0${fact.name}`;
    const members = siblings.get(group) ?? [];
    members.push(id);
    siblings.set(group, members);
  }
  const position = (id: number) => located.get(id)?.location ?? invalid();
  const ordinals = new Map<number, number>();
  for (const group of siblings.values()) {
    group.sort(
      (left, right) =>
        position(left).start - position(right).start || position(left).end - position(right).end,
    );
    for (const [ordinal, id] of group.entries()) ordinals.set(id, ordinal);
  }
  const identities = new Map<number, string>();
  // A parent chain that returns to an object it started from is malformed output.
  const visiting = new Set<number>();
  const identity = (id: number): string => {
    const known = identities.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return invalid();
    visiting.add(id);
    const fact = located.get(id)?.fact ?? invalid();
    const parent = parentOf(id);
    const value = digestValue({
      parent: parent ? identity(parent) : "",
      name: fact.name,
      ordinal: ordinals.get(id) ?? invalid(),
    });
    identities.set(id, value);
    visiting.delete(id);
    return value;
  };
  const ids = new Map<number, MapObject>();
  const seen = new Set<string>();
  for (const fact of facts.objects) {
    const location = anchor(fact.path, fact.start, fact.end);
    const object: MapObject = {
      id: digestValue({
        path: location.path,
        kind: fact.kind,
        identity: identity(canonical.get(fact.id) ?? invalid()),
      }),
      contextRef: input.contextRef,
      name: fact.name,
      kind: fact.kind,
      anchor: location,
      exported: fact.exported,
      ...(fact.execution ? { execution: fact.execution } : {}),
      contextRole: "DEFAULT",
      ...(fact.nameStart >= 0 ? { symbolStart: offset(fact.path, fact.nameStart) } : {}),
      ...(fact.kind === "FILE" ? { language: context.language, parsing: "PARSED" as const } : {}),
    };
    ids.set(fact.id, object);
    if (seen.has(object.id)) continue;
    seen.add(object.id);
    collect.object(object);
  }
  const object = (fact: number) => ids.get(fact) ?? invalid();
  for (const fact of facts.objects) {
    if (fact.parent === undefined) continue;
    const child = object(fact.id);
    collect.relation({
      from: object(fact.parent).id,
      to: child.id,
      kind: "CONTAINS",
      anchor: child.anchor,
      target: child.name,
      basis: "SYNTAX_DECLARED",
    });
    if (child.kind === "INTERFACE")
      collect.note({
        entityRef: child.id,
        kind: "CONTRACT_DECLARATION",
        text: context.contract,
        anchor: child.anchor,
        truncated: false,
      });
  }
  for (const fact of facts.relations) {
    const from = object(fact.from);
    const location = anchor(fact.path, fact.start, fact.end);
    collect.relation({
      from: from.id,
      ...(fact.to !== undefined ? { to: object(fact.to).id } : {}),
      kind: fact.kind,
      anchor: location,
      target: fact.target,
      basis: fact.basis,
      ...(fact.reason ? { unresolvedReason: fact.reason } : {}),
      ...(fact.argument ? { argument: fact.argument } : {}),
      ...(fact.route ? { route: fact.route } : {}),
    });
    if (fact.kind === "WRITES")
      collect.note({
        entityRef: from.id,
        kind: "STATE_WRITE",
        text: `Contains an assignment to ${fact.target}. A write site is not necessarily the owner of the business rule.`,
        anchor: location,
        truncated: false,
      });
  }
  for (const fact of facts.notes) {
    const location = anchor(fact.path, fact.start, fact.end);
    collect.note({
      entityRef: object(fact.object).id,
      kind: fact.kind,
      text: (input.files[fact.path] ?? "").slice(location.start, location.end),
      anchor: location,
      truncated: false,
    });
  }
  for (const file of facts.files) {
    if (file.object !== undefined) output.parsedFiles.push(file.path);
    if (file.excluded) output.gaps.push({ code: file.excluded, path: file.path });
    if (file.issue) output.gaps.push({ code: file.issue, path: file.path });
  }
  return output;
}

/** One page of a program's references, filtered, de-duplicated and ordered by location. */
export function mapReferencesPage(
  facts: MapReferenceFacts,
  files: Readonly<Record<string, string>>,
  reference: MapReferenceRequest,
  offsets: MapFactsOffsets,
): MapReferencePage {
  const positions = new MapSourcePositions(files);
  const offset = offsetConverter(files, offsets);
  const references = new Map<string, MapReferencePage["references"][number]>();
  for (const fact of facts.references) {
    if (!mapQueryPathMatches(fact.path, reference.path ?? ".")) continue;
    if (reference.kinds && !reference.kinds.includes(fact.kind)) continue;
    const anchor = positions.span(
      fact.path,
      offset(fact.path, fact.start),
      offset(fact.path, fact.end),
    );
    references.set(`${anchor.path}:${anchor.start}:${anchor.end}`, { anchor, kind: fact.kind });
  }
  const ordered = [...references.values()].sort(
    (left, right) =>
      Buffer.compare(Buffer.from(left.anchor.path), Buffer.from(right.anchor.path)) ||
      left.anchor.start - right.anchor.start ||
      left.anchor.end - right.anchor.end,
  );
  if (reference.offset > ordered.length)
    throw new ProjectEvidenceError("PROJECT_MAP_REFERENCE_CURSOR_INVALID", false);
  const selected = ordered.slice(reference.offset, reference.offset + reference.maxResults);
  const next = reference.offset + selected.length;
  return {
    references: selected,
    ...(next < ordered.length ? { nextOffset: next } : {}),
    requiredFiles: [],
  };
}
