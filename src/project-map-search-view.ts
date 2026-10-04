import { z } from "zod";
import type { CodeIndexStore } from "./code-index-store";
import { type MapQueryOutputBudget, mapQueryPage } from "./project-map-query-page";
import type { mapSearchRows } from "./project-map-search";
import { MapObjectKindSchema, type MapSearchResult } from "./project-map-types";
import { MapViewGraph, mapDeclarationLabel, mapIsModule } from "./project-map-view-graph";

export const MAP_SEARCH_FORMAT = "PROJECT_MAP_SEARCH_V1";
export const MapSearchViewPageSchema = z
  .object({
    format: z.literal(MAP_SEARCH_FORMAT),
    text: z.string(),
    nextOffset: z.number().int().positive().optional(),
    pageExhausted: z.boolean(),
  })
  .strict();
export type MapSearchViewPage = z.infer<typeof MapSearchViewPageSchema>;

const FIELDS = { NAME: "name", PATH: "path", DOCUMENTATION: "doc" } as const;

export function mapSearchView(
  store: CodeIndexStore,
  version: string,
  query: MapSearchResult["query"],
  rows: ReturnType<typeof mapSearchRows>,
  offset: number,
  maxResults: number,
  budget: MapQueryOutputBudget | undefined,
): MapSearchViewPage {
  const graph = new MapViewGraph(store, version);
  const results = rows.slice(0, maxResults).map(({ object, ranking }) => ({
    path: object.anchor.path,
    text: `${
      mapIsModule(object)
        ? `(file) ${object.anchor.endLine}L`
        : `${graph.qualifiedName(object.id)} ${mapDeclarationLabel(object)}`
    } [${ranking.matchedFields.map((field) => FIELDS[field]).join(",")}]`,
  }));
  const filters = [
    ...(query.path === "." ? [] : [`path ${query.path}`]),
    ...(query.kinds.length < MapObjectKindSchema.options.length
      ? [`kinds ${query.kinds.join(",")}`]
      : []),
  ];
  const materialize = (count: number): MapSearchViewPage => {
    const more = rows.length > count;
    const lines: string[] = [];
    let current: { path: string; items: string[] } | undefined;
    // Adjacent hits share a file line; relevance order is preserved across files.
    for (const result of results.slice(0, count)) {
      if (current?.path !== result.path) {
        if (current) lines.push(`${current.path}: ${current.items.join(", ")}`);
        current = { path: result.path, items: [] };
      }
      current.items.push(result.text);
    }
    if (current) lines.push(`${current.path}: ${current.items.join(", ")}`);
    return {
      format: MAP_SEARCH_FORMAT,
      text: [
        `PROJECT MAP · SEARCH ${JSON.stringify(query.text)} ${query.matchMode}${
          filters.length ? ` · ${filters.join(" · ")}` : ""
        } · ${
          count ? `results ${offset + 1}-${offset + count}` : "no matching declarations or files"
        }${more ? ` · continue with offset ${offset + count}` : ""}`,
        "Ranked by relevance; kinds f function, c class, m method, p property, v variable, t type, i interface, e enum, followed by 1-based source lines and the matched fields.",
        ...lines,
      ].join("\n"),
      ...(more ? { nextOffset: offset + count } : {}),
      pageExhausted: !more,
    };
  };
  if (!results.length) return materialize(0);
  return mapQueryPage(results.length, materialize, (page) => page, budget);
}
