import { ProjectEvidenceError } from "./core";
import type { MapAnalysis, MapAnchor, MapWorkerInput } from "./project-map-types";

export function validateMapAnalysis(
  analysis: MapAnalysis,
  input: Omit<MapWorkerInput, "compilerPath">,
): void {
  const invalid = () => {
    throw new ProjectEvidenceError("PROJECT_MAP_PROTOCOL_INVALID", false);
  };
  if (analysis.contexts.length !== 1 || analysis.contexts[0]?.ref !== input.contextRef) invalid();
  const context = analysis.contexts[0];
  if (
    context?.inputFiles.some((file) => !Object.hasOwn(input.files, file)) ||
    context?.configurationFiles.some((file) => !context.inputFiles.includes(file))
  )
    invalid();
  const inventory = new Set(input.inventory);
  for (const required of analysis.requiredFiles)
    if (!inventory.has(required) || Object.hasOwn(input.files, required)) invalid();
  const location = (anchor: MapAnchor) => {
    const content = input.files[anchor.path];
    if (
      content === undefined ||
      anchor.start < 0 ||
      anchor.end < anchor.start ||
      anchor.end > content.length ||
      anchor.endLine < anchor.startLine
    )
      invalid();
  };
  const ids = new Set<string>();
  const objects = new Map(analysis.objects.map((object) => [object.id, object]));
  for (const object of analysis.objects) {
    if (object.contextRef !== input.contextRef || ids.has(object.id)) invalid();
    ids.add(object.id);
    location(object.anchor);
    if (
      !context?.inputFiles.includes(object.anchor.path) ||
      (object.symbolStart !== undefined &&
        (object.symbolStart < object.anchor.start || object.symbolStart >= object.anchor.end))
    )
      invalid();
  }
  for (const edge of analysis.relations) {
    if (
      !ids.has(edge.from) ||
      (edge.to && !ids.has(edge.to)) ||
      (edge.to === undefined) !== (edge.basis === "UNRESOLVED") ||
      (edge.unresolvedReason !== undefined) !== (edge.basis === "UNRESOLVED")
    )
      invalid();
    location(edge.anchor);
    if (edge.kind === "CALLS" || edge.kind === "WRITES") {
      const owner = objects.get(edge.from);
      if (
        !owner?.execution ||
        owner.anchor.path !== edge.anchor.path ||
        owner.anchor.start > edge.anchor.start ||
        owner.anchor.end < edge.anchor.end
      )
        invalid();
    }
  }
  for (const note of analysis.notes) {
    if (!ids.has(note.entityRef)) invalid();
    location(note.anchor);
  }
  for (const file of analysis.parsedFiles) if (!Object.hasOwn(input.files, file)) invalid();
}
