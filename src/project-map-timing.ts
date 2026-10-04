import { z } from "zod";
import { MapParserDiagnosticSchema } from "./project-map-failure";

const duration = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counter = duration.int();
export const MapWorkerTimingSchema = z
  .object({
    point: z.enum([
      "OPEN_PROJECT",
      "SOURCES",
      "DECLARATIONS",
      "RELATIONS",
      "IMPLEMENTATIONS",
      "ANALYSIS",
      "DISPOSE",
      "CONFIGURE",
      "REFERENCES",
    ]),
    elapsedMs: duration,
    observationMs: duration,
    wallMs: z.partialRecord(MapParserDiagnosticSchema.shape.phase, duration),
    nodeCpuMs: z.partialRecord(MapParserDiagnosticSchema.shape.phase, duration),
    nodeRssBytes: counter,
    compiler: z
      .object({
        requestCount: counter,
        roundTripMs: duration,
        serverTimeMs: duration,
        transportOverheadMs: duration,
        bytesSent: counter,
        bytesReceived: counter,
        nodesMaterialized: counter,
        nodesFetched: counter,
        sourceFilesFetched: counter,
      })
      .strict(),
  })
  .strict();
export type MapWorkerTiming = z.infer<typeof MapWorkerTimingSchema>;
export type MapParserTiming =
  | { source: "WORKER"; measurement: MapWorkerTiming }
  | {
      source: "PARENT";
      phase: "INPUT_SERIALIZATION" | "OUTPUT_ACCOUNTING" | "RESULT_VALIDATION" | "RESULT_TO_EXIT";
      elapsedMs: number;
    };
