import { z } from "zod";
import { ProjectEvidenceError } from "./core";

const PhaseSchema = z.enum([
  "INITIALIZE",
  "OPEN_PROJECT",
  "SOURCE_FILES",
  "SOURCE_AST",
  "SYNTAX_DIAGNOSTICS",
  "EXPORTS",
  "TRAVERSAL",
  "RELATION_SYMBOLS",
  "RELATION_TARGETS",
  "IMPLEMENTATIONS",
  "DECLARATION_SYMBOLS",
  "DOCUMENTATION",
  "CONFIG_DIAGNOSTICS",
  "PROGRAM_DIAGNOSTICS",
  "CONTEXT",
  "DISPOSE",
  "RESULT_VALIDATION",
  "REFERENCES",
]);
export type MapParserTrace = {
  phase: z.infer<typeof PhaseSchema>;
  checkpoint?: (
    point: "SOURCES" | "DECLARATIONS" | "RELATIONS" | "IMPLEMENTATIONS",
  ) => Promise<void>;
};
export const MapParserDiagnosticSchema = z
  .object({
    phase: PhaseSchema,
    category: z.enum([
      "TYPE_ERROR",
      "RANGE_ERROR",
      "COMPILER_RPC_ERROR",
      "ERROR",
      "NON_ERROR",
      "SCHEMA",
    ]),
    rpcCode: z.number().int().safe().optional(),
    systemCode: z.enum(["ENOENT", "EPERM", "EACCES", "EPIPE", "ECONNRESET", "ENOMEM"]).optional(),
    workerFrames: z
      .array(
        z
          .object({
            line: z.number().int().positive(),
            column: z.number().int().positive(),
          })
          .strict(),
      )
      .max(8),
    validationIssues: z
      .array(
        z
          .object({
            section: z.enum([
              "contexts",
              "objects",
              "relations",
              "notes",
              "gaps",
              "parsedFiles",
              "requiredFiles",
              "ROOT",
            ]),
            code: z.enum([
              "invalid_type",
              "too_big",
              "too_small",
              "invalid_format",
              "unrecognized_keys",
              "invalid_value",
              "OTHER",
            ]),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type MapParserDiagnostic = z.infer<typeof MapParserDiagnosticSchema>;
export const MapWorkerFailureSchema = z
  .object({
    error: z.enum([
      "PROJECT_MAP_ANALYSIS_FAILED",
      // A native analyzer (go-map, java-map) refusing a request it cannot read.
      "PROJECT_MAP_PROTOCOL_INVALID",
      "PROJECT_MAP_CONTEXT_NOT_AVAILABLE",
      "PROJECT_MAP_LOCATION_OUTSIDE_INPUT",
      "PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE",
      "PROJECT_MAP_REFERENCE_CURSOR_INVALID",
    ]),
    diagnostic: MapParserDiagnosticSchema,
  })
  .strict();

// Error messages, native stderr, paths and source fragments never cross this boundary.
export function mapWorkerFailure(error: unknown, trace: MapParserTrace, workerUrl: string) {
  const rpcCode =
    error instanceof Error && "code" in error && Number.isSafeInteger(error.code)
      ? Number(error.code)
      : undefined;
  const workerFrames: MapParserDiagnostic["workerFrames"] = [];
  for (const frame of error instanceof Error ? (error.stack ?? "").split("\n").slice(1) : []) {
    const position = frame.indexOf(`${workerUrl}:`);
    if (position < 0) continue;
    const match = /^(\d+):(\d+)\)?$/u.exec(frame.slice(position + workerUrl.length + 1));
    if (match && workerFrames.length < 8)
      workerFrames.push({ line: Number(match[1]), column: Number(match[2]) });
  }
  const code = MapWorkerFailureSchema.shape.error.safeParse(
    error instanceof Error ? error.message : undefined,
  );
  const systemCode = MapParserDiagnosticSchema.shape.systemCode
    .unwrap()
    .safeParse(error instanceof Error && "code" in error ? error.code : undefined);
  return MapWorkerFailureSchema.parse({
    error: code.success ? code.data : "PROJECT_MAP_ANALYSIS_FAILED",
    diagnostic: {
      phase: trace.phase,
      category:
        error instanceof TypeError
          ? "TYPE_ERROR"
          : error instanceof RangeError
            ? "RANGE_ERROR"
            : rpcCode !== undefined
              ? "COMPILER_RPC_ERROR"
              : error instanceof Error
                ? "ERROR"
                : "NON_ERROR",
      ...(rpcCode !== undefined ? { rpcCode } : {}),
      ...(systemCode.success ? { systemCode: systemCode.data } : {}),
      workerFrames,
    },
  });
}

export class ProjectMapAnalysisError extends ProjectEvidenceError {
  readonly diagnostic: MapParserDiagnostic;
  constructor(code: string, diagnostic: MapParserDiagnostic) {
    super(code, false);
    this.diagnostic = MapParserDiagnosticSchema.parse(diagnostic);
  }
}
