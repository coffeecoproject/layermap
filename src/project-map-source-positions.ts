import { computeLineStarts, type Node, type SourceFile, skipTrivia } from "typescript/unstable/ast";
import type { MapAnchor } from "./project-map-types";
import { MAP_WORKSPACE } from "./project-map-virtual-files";

export class MapSourcePositions {
  private readonly lines = new Map<string, number[]>();
  constructor(private readonly files: Readonly<Record<string, string>>) {}

  anchor(node: Node, file: SourceFile): MapAnchor {
    const relative = file.fileName.slice(MAP_WORKSPACE.length);
    const text = this.files[relative];
    if (text === undefined) throw new Error("PROJECT_MAP_LOCATION_OUTSIDE_INPUT");
    return this.span(relative, node === file ? 0 : skipTrivia(text, node.pos), node.end);
  }

  span(relative: string, start: number, end: number): MapAnchor {
    const text = this.files[relative];
    if (text === undefined) throw new Error("PROJECT_MAP_LOCATION_OUTSIDE_INPUT");
    const lines = this.lines.get(relative) ?? computeLineStarts(text);
    this.lines.set(relative, lines);
    const lineAt = (offset: number) => {
      let low = 0;
      let high = lines.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((lines[middle] ?? 0) <= offset) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    // Use admitted text: the native API's decoded SourceFile.text drops a leading BOM.
    return {
      path: relative,
      start,
      end,
      startLine: lineAt(start),
      endLine: lineAt(Math.max(start, end - 1)),
    };
  }
}
