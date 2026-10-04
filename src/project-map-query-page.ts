import { ProjectEvidenceError } from "./core";
import { canonicalJson } from "./digest";
import { PROJECT_MAP_LIMITS } from "./project-map-types";

// Supplied by a trusted consumer, never by model tool arguments.
export type MapQueryOutputBudget = Readonly<{ maxBytes: number; envelopeBytes: number }>;

export function mapQueryPage<Result>(
  count: number,
  materialize: (count: number) => Result,
  navigation: (result: Result) => unknown,
  budget?: MapQueryOutputBudget,
): Result {
  const maxBytes = budget?.maxBytes ?? PROJECT_MAP_LIMITS.queryBytes;
  const envelopeBytes = budget?.envelopeBytes ?? 0;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(envelopeBytes) ||
    envelopeBytes < 0
  )
    throw new ProjectEvidenceError("PROJECT_READ_INPUT_INVALID", false);
  const fits = (result: Result) =>
    Buffer.byteLength(canonicalJson(navigation(result))) + envelopeBytes <= maxBytes;
  // Completion can remove a cursor, so measure the complete page before the monotone
  // partial prefixes. Budget clipping must retain at least one result when any exist.
  const complete = materialize(count);
  if (fits(complete)) return complete;
  let lower = 1;
  let upper = count - 1;
  let selected: Result | undefined;
  while (lower <= upper) {
    const length = lower + Math.floor((upper - lower) / 2);
    const result = materialize(length);
    if (fits(result)) {
      selected = result;
      lower = length + 1;
    } else {
      upper = length - 1;
    }
  }
  if (selected !== undefined) return selected;
  throw new ProjectEvidenceError("PROJECT_MAP_ITEM_LIMIT", false);
}
