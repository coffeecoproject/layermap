import type { API } from "typescript/unstable/async";
import type { MapParserTrace } from "./project-map-failure";
import type { MapWorkerTiming } from "./project-map-timing";

// Opt-in diagnostics only. RPC sums can overlap; Node CPU excludes the compiler process.
export class MapWorkerTimingCollector {
  private phase: MapParserTrace["phase"] = "INITIALIZE";
  private readonly started = performance.now();
  private lastWall = this.started;
  private lastCpu = process.cpuUsage();
  private observationMs = 0;
  private readonly wallMs: MapWorkerTiming["wallMs"] = {};
  private readonly nodeCpuMs: MapWorkerTiming["nodeCpuMs"] = {};
  readonly trace: MapParserTrace;

  constructor() {
    const owner = this;
    this.trace = {
      get phase() {
        return owner.phase;
      },
      set phase(value) {
        owner.flush();
        owner.phase = value;
      },
    };
  }

  private flush() {
    const now = performance.now();
    const cpu = process.cpuUsage();
    this.wallMs[this.phase] = (this.wallMs[this.phase] ?? 0) + now - this.lastWall;
    this.nodeCpuMs[this.phase] =
      (this.nodeCpuMs[this.phase] ?? 0) +
      (cpu.user + cpu.system - this.lastCpu.user - this.lastCpu.system) / 1000;
    this.lastWall = now;
    this.lastCpu = cpu;
  }

  async checkpoint(api: API, point: MapWorkerTiming["point"]) {
    this.flush();
    const start = performance.now();
    const timing = await api.getTimingInfo();
    this.observationMs += performance.now() - start;
    this.lastWall = performance.now();
    this.lastCpu = process.cpuUsage();
    process.send?.({
      timing: {
        point,
        elapsedMs: performance.now() - this.started,
        observationMs: this.observationMs,
        wallMs: this.wallMs,
        nodeCpuMs: this.nodeCpuMs,
        nodeRssBytes: process.memoryUsage().rss,
        compiler: timing.totals,
      } satisfies MapWorkerTiming,
    });
  }
}
