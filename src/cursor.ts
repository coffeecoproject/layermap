import { createHmac, timingSafeEqual } from "node:crypto";
import { ProjectEvidenceError } from "./core";

// Continuation cursors go to models, which copy them back verbatim, so they stay short: the
// position as a few integers and a truncated HMAC under the store's secret that binds them to
// the query they continue (operation and scope digest). A cursor from another query, project
// version or store fails the check.
const MAC_BYTES = 12;
const POSITION = /^(?:0|[1-9]\d{0,14})$/u;

const mac = (secret: Buffer, binding: string, body: string) =>
  createHmac("sha256", secret)
    .update(`layermap-cursor-v3\n${binding}\n${body}`)
    .digest()
    .subarray(0, MAC_BYTES);

export function encodeQueryCursor(
  secret: Buffer,
  binding: string,
  positions: readonly number[],
): string {
  const body = positions.join(".");
  return `${body}.${mac(secret, binding, body).toString("base64url")}`;
}

/** The positions a cursor carries, or PROJECT_CONTINUATION_INVALID. */
export function decodeQueryCursor(
  secret: Buffer,
  binding: string,
  encoded: string,
  count: number,
): number[] {
  const parts = encoded.split(".");
  const signature = parts.pop() ?? "";
  const actual = Buffer.from(signature, "base64url");
  const expected = mac(secret, binding, parts.join("."));
  if (
    parts.length !== count ||
    !parts.every((part) => POSITION.test(part)) ||
    actual.toString("base64url") !== signature ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    throw new ProjectEvidenceError("PROJECT_CONTINUATION_INVALID", false);
  return parts.map(Number);
}
