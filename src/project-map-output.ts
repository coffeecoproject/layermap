import { digestValue } from "./digest";
import type { MapAnalysis, MapNote, MapObject, MapRelation } from "./project-map-types";

export class MapOutputCollector {
  constructor(private readonly output: MapAnalysis) {}

  object(value: MapObject): void {
    this.output.objects.push(value);
  }

  relation(value: Omit<MapRelation, "id">): void {
    this.output.relations.push({ ...value, id: digestValue(value) });
  }

  note(value: MapNote): void {
    this.output.notes.push(value);
  }
}
