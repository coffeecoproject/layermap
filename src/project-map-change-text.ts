import {
  LIMITS,
  LIST,
  type MapChangeEntry,
  type MapChangeImpact,
  type MapChanges,
  type MapCompileBreaks,
  type MapReusableCode,
} from "./project-map-change-types";
import { type MapRouteClientSearch, routeClientsLine } from "./project-map-clients";
import type { MapModuleDependency, MapReuseImport } from "./project-map-dependencies";
import { strandedNameLine } from "./project-map-names";

// The test functions among the test file's declarations that reach the change, else a few of them.
function testNames(names: readonly string[], limit: number = LIST.names): string {
  if (!names.length) return "";
  const tests = names.filter((name) => /(?:^|\.)(?:test|Test|should|it_)\w*$/u.test(name));
  const shown = (tests.length ? tests : names).slice(0, limit);
  const more = (tests.length ? tests : names).length - shown.length;
  return `: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/** The check as an agent reads it: the conclusion first, then each list, then what it cannot see. */
export function mapChangesText(
  changes: MapChanges,
  impact: MapChangeImpact,
  clients: MapRouteClientSearch = { routes: [] },
  similar: readonly MapReusableCode[] = [],
  compile: MapCompileBreaks = { errors: [], missing: [], unchecked: [] },
): string {
  const files = changes.files.length;
  const direct = impact.tests.filter((test) => test.rank < 4);
  const indirect = impact.tests.filter((test) => test.rank >= 4);
  const routes = impact.entries.filter((entry) => entry.route);
  const lines = [
    `PROJECT MAP · CHANGES against ${changes.base} (${changes.commit.slice(0, 12)}) · ${files} changed file${files === 1 ? "" : "s"} · ${impact.changed.length} changed and ${impact.removed.length} removed declarations · ${routes.length} routes and ${impact.entries.length - routes.length} other entry points reached · ${direct.length} related test files${indirect.length ? ` (+${indirect.length} importing the changes indirectly)` : ""}${impact.untested ? ` · ${impact.untested.changed.length} changed declarations not reached by the given tests` : ""}`,
  ];
  if (!files) return `${lines[0]}\nNothing changed against ${changes.base}.`;
  const list = (title: string, items: readonly string[], limit: number) => {
    if (!items.length) return;
    lines.push(title, ...items.slice(0, limit).map((item) => `  ${item}`));
    if (items.length > limit) lines.push(`  +${items.length - limit} more`);
  };
  list("CHANGED", impact.changed, LIST.changed);
  list(
    "REMOVED OR RENAMED, STILL USED (code the diff did not change still calls or uses them: update it, or keep the old name)",
    impact.removed
      .filter(({ usedBy }) => usedBy.length)
      .map(
        ({ declaration, usedBy }) =>
          `${declaration} ← ${usedBy.slice(0, LIST.names).join(", ")}${usedBy.length > LIST.names ? ` (+${usedBy.length - LIST.names})` : ""}`,
      ),
    LIST.changed,
  );
  list(
    "REMOVED OR RENAMED (no reference found on a line the diff left unchanged)",
    impact.removed.filter(({ usedBy }) => !usedBy.length).map(({ declaration }) => declaration),
    LIST.changed,
  );
  list(
    "NEW COMPILE ERRORS ON LINES THE DIFF LEFT UNCHANGED (the compiler reports these now and did not before: the diff broke this code)",
    compile.errors,
    LIST.changed,
  );
  if (compile.missing.length)
    lines.push(
      `PACKAGES NOT FOUND (${compile.missing.slice(0, LIST.names).join(", ")}${compile.missing.length > LIST.names ? `, +${compile.missing.length - LIST.names} more` : ""}): are dependencies installed in this directory? Values typed by them have no type to follow, so calls through them (framework page methods among them), their uses and compile errors are not seen, and this report can miss what the change reaches.`,
    );
  if (compile.unchecked.length)
    lines.push(
      `NOT CHECKED FOR NEW COMPILE ERRORS (${compile.unchecked.slice(0, LIST.names).join(", ")}${compile.unchecked.length > LIST.names ? `, +${compile.unchecked.length - LIST.names} more` : ""}): the check ran out of time before compiling them on both sides, or the base has no such configuration, so errors the diff caused there are not listed.`,
    );
  list(
    "LEFT WITHOUT CALLERS (the diff removed or changed their last callers; nothing outside tests calls or otherwise uses them now)",
    impact.uncalled,
    LIST.changed,
  );
  if (impact.uncalled.length)
    lines.push(
      "If the change replaced them, delete them and the tests that only test them; keep them only if something the map cannot see uses them, such as another package, a framework or a dynamic call.",
    );
  // Names read or set by text, which no compiler links: a rename on one side strands the other.
  if (changes.stranded.names.length) {
    list(
      "NAMES STILL USED ELSEWHERE (environment variables and configuration keys the diff removed from a file, found by text)",
      changes.stranded.names.map(strandedNameLine),
      LIST.stranded,
    );
    lines.push(
      "These places still read or set the old name. If the diff renamed or dropped it on purpose, update them too or keep the old name working. Names built at run time are not found.",
    );
  }
  // Expectations the diff rewrote: when the request did not ask for them, the code change reached
  // a feature it was not meant to change, and the rewritten test hides that.
  if (impact.rewrittenTests.length) {
    list(
      "EXISTING TESTS CHANGED (tests that existed before this diff, whose code it changed or removed)",
      impact.rewrittenTests.map(
        (test) =>
          `${test.path}: ${test.names.slice(0, LIST.names).join(", ")}${test.names.length > LIST.names ? `, +${test.names.length - LIST.names} more` : ""}`,
      ),
      LIST.tests,
    );
    lines.push(
      "For each, decide whether the request asks for that behavior to change. If it does not, the code change probably reached a feature it was not meant to: restore the test and narrow the change.",
    );
  }
  // The changed code serves several features: a change meant for one can leak into the others.
  if (impact.areas.length > 1) {
    list(
      `SHARED BY ${impact.areas.length} AREAS (tests that call the changed code, by the code they call it through)`,
      impact.areas.map((area) => {
        const through = `${area.through.slice(0, LIST.through).join(", ")}${area.through.length > LIST.through ? ", …" : ""}`;
        const tests = area.tests
          .slice(0, LIST.areaTests)
          .map((test) => `${test.path}${testNames(test.names, LIST.areaNames)}`);
        const more = area.tests.length - tests.length;
        return `${area.area} (${through}): ${tests.join("; ")}${more > 0 ? `; +${more} more files` : ""}`;
      }),
      LIST.areas,
    );
    lines.push(
      "Each area's tests pin its current behavior. Decide which areas the request is about: a failing test of another area means the change reached a feature the request may not cover; if it does not, narrow the change, for example to code only the requested area uses, rather than rewriting that test.",
    );
  }
  // Which way the changed code now depends: the project's layers decide whether that is allowed.
  if (impact.dependencies.length) {
    const sites = (dependency: MapModuleDependency) =>
      `${dependency.sites.slice(0, LIST.sites).join(", ")}${dependency.sites.length > LIST.sites ? `, +${dependency.sites.length - LIST.sites} more` : ""}`;
    // A module the diff adds imports everything anew: its imports read best as one line.
    const fresh = new Map<string, string[]>();
    for (const dependency of impact.dependencies)
      if (dependency.added && !dependency.back)
        fresh.set(dependency.from, [...(fresh.get(dependency.from) ?? []), dependency.to]);
    list(
      "NEW MODULE DEPENDENCIES (imports between the modules of the project overview that the base did not have)",
      [
        ...impact.dependencies
          .filter((dependency) => !fresh.has(dependency.from) || dependency.back)
          .map(
            (dependency) =>
              `${dependency.from} → ${dependency.to} (${sites(dependency)})${dependency.back ? `; now a cycle, back through ${dependency.back.join(" → ")}` : ""}`,
          ),
        ...[...fresh].map(
          ([from, targets]) => `${from} (a module this diff adds) → ${targets.join(", ")}`,
        ),
      ],
      LIST.dependencies,
    );
    lines.push(
      `Decide for each whether it runs the way the project's layers do: code others build on (shared types, storage, utilities) should not import the features or interfaces built on it.${impact.dependencies.some((dependency) => dependency.back) ? " A cycle ties the modules together, so neither can change or be tested alone." : ""} If one runs the wrong way, move what both need into the lower module or pass it in, rather than import upward.`,
    );
  }
  const entry = (item: MapChangeEntry) =>
    `${item.route ? JSON.stringify(item.label) : item.label}${item.chain.length ? ` → ${item.chain.join(" → ")}` : ""}${
      item.removed
        ? ` (the diff removes it${item.site ? `; registered at ${item.site} before` : ""})`
        : item.site
          ? ` (registered at ${item.site})`
          : ""
    }`;
  list(
    "AFFECTED ENTRY POINTS (through resolved calls)",
    impact.entries.filter((e) => e.certain).map(entry),
    LIST.entries,
  );
  list(
    "POSSIBLY AFFECTED (through a call on an interface or base member, which may dispatch elsewhere, or through code that uses a changed field or type, which may not depend on what changed)",
    impact.entries.filter((e) => !e.certain).map(entry),
    LIST.entries,
  );
  // What the given tests leave out: none of them runs the code under these entry points.
  if (impact.untested) {
    const { changed, entries, throughRoutes, routes, missing, truncated } = impact.untested;
    const items = (shown: readonly string[], limit: number) => {
      lines.push(...shown.slice(0, limit).map((item) => `  ${item}`));
      if (shown.length > limit) lines.push(`  +${shown.length - limit} more`);
    };
    lines.push("NOT REACHED BY THE GIVEN TESTS");
    if (missing.length)
      lines.push(`  the map has no code for these given files: ${missing.join(", ")}`);
    if (changed.length) {
      lines.push(
        `  ${changed.length} of ${impact.changed.length} changed declarations are reached by none of the given tests; ${entries.length ? "the entry points above them, then the declarations:" : "the declarations:"}`,
      );
      items(
        entries.map((item) => `${entry(item)}${item.certain ? "" : " (possibly)"}`),
        LIST.entries,
      );
      items(changed, LIST.changed);
      // Each declaration with the tests running it, closest first.
      const runners = (
        heading: string,
        found: readonly Readonly<{ declaration: string; tests: readonly string[] }>[],
      ) => {
        if (!found.length) return;
        lines.push(`  ${found.length} of them ${heading}:`);
        items(
          found.map(
            ({ declaration, tests }) =>
              `${declaration} ← ${tests.slice(0, LIST.names).join(", ")}${tests.length > LIST.names ? `, +${tests.length - LIST.names} more` : ""}`,
          ),
          LIST.changed,
        );
      };
      runners("are run by other tests of the project, closest first", impact.untested.runByOthers);
      runners(
        "may be run by the given tests, which send a request whose path the map does not work out to a route above them",
        impact.untested.mayRun,
      );
    } else
      lines.push(
        impact.changed.length
          ? `  none: the given tests reach all ${impact.changed.length} changed declarations`
          : "  none: the diff changes no declarations outside the tests",
      );
    if (throughRoutes.length) {
      lines.push(
        `  ${throughRoutes.length} changed declarations are reached only through a route a given test requests (${routes.map((route) => JSON.stringify(route)).join(", ")}):`,
      );
      items(throughRoutes, LIST.changed);
    }
    if (truncated)
      lines.push(
        `  callers were followed ${LIMITS.depth} levels or ${LIMITS.declarations} declarations up; a given test or entry point further up is not seen`,
      );
    if (impact.changed.length)
      lines.push(
        "Reach is followed through resolved calls from the given files and the routes they request. Reached means a given test calls code that leads to it, not that the test takes that path or checks what it does; a call through dependency injection, reflection or a receiver of unknown type, or a path built at run time, may run code the map does not see.",
      );
  }
  // Requests by path, which no compiler links: a frontend, a generated client, a template.
  if (clients.routes.length) {
    list(
      "REQUESTED BY (code and templates outside the tests that request these routes' paths, found by text)",
      clients.routes.map(routeClientsLine),
      LIST.clients,
    );
    lines.push(
      "If the change alters what a route accepts or returns, or its path, these callers must change with it. Paths built at run time are not found.",
    );
  }
  // What the check did not finish comes first, and in full: it says what the rest leaves out.
  const incomplete = [
    ...impact.incomplete,
    ...(clients.unsearched
      ? [
          `the change reaches more routes than the check searches requests for; ${clients.unsearched} of them were not searched, so the code requesting them is not listed`,
        ]
      : []),
    ...(clients.failed
      ? [
          `the text search for code and templates requesting the routes the change reaches did not finish (${clients.failed}), so the callers that name their paths are not listed`,
        ]
      : []),
  ];
  list(
    "CHECK BY HAND (the map cannot see these)",
    [...incomplete, ...impact.unclear],
    incomplete.length + LIST.unclear,
  );
  if (direct.length) {
    list(
      "RELATED TESTS (closest first)",
      direct.map((test) => `${test.path}${testNames(test.names)} (${test.why})`),
      LIST.tests,
    );
    if (indirect.length)
      lines.push(
        `  +${indirect.length} more test files import the changed files through other modules; run them for a broader check`,
      );
    lines.push("If the change needs verifying, these existing tests are the ones to run.");
  } else if (indirect.length)
    lines.push(
      `RELATED TESTS: none call or import the changed code directly; ${indirect.length} test files import it through other modules, which a broader run covers.`,
    );
  lines.push(
    "Static estimate: calls through dependency injection, reflection, string dispatch, configuration and database coupling are not mapped, so an empty list does not prove the change is safe; confirm the entry points in source.",
  );
  // Code the diff adds that the project already has: reuse it, or retire the old copy. It comes
  // last, after what the change reaches and breaks: a copy is no fault, and weighing it first
  // leaves the rest of the report less looked at.
  if (similar.length) {
    const declaration = (item: { path: string; name: string; label: string }) =>
      `${item.path}: ${item.name} ${item.label}`;
    // Which copy would use the other and what that would import, which decides whether to.
    const reach = ({ user, from, to, imported, cycle, packages }: MapReuseImport) => {
      const using = user === "NEW" ? "using it" : "the existing code using the new";
      if (imported)
        return user === "NEW"
          ? "no new import"
          : `the existing code can use the new with no new import: ${from} already imports ${to}`;
      return `${using} imports ${to} from ${from} for the first time${packages ? `, in ${packages[1]}, which ${packages[0]} already imports` : ""}${cycle ? `; ${to} already reaches ${from}, so the import closes a cycle` : ""}`;
    };
    // A file that repeats much of another reads best as one line.
    const pairs = new Map<string, MapReusableCode[]>();
    for (const item of similar) {
      const key = `${item.path}\u0000${item.like.path}`;
      pairs.set(key, [...(pairs.get(key) ?? []), item]);
    }
    list(
      "EXISTING CODE LIKE THE NEW CODE (declarations the diff adds whose code reads almost the same as code the project already has; weigh them after everything above)",
      [...pairs.values()].flatMap((items) => {
        const [first] = items as [MapReusableCode];
        if (items.length < 3)
          return items.map(
            (item) =>
              `${declaration(item)} ~ ${declaration(item.like)} (${item.others ? `+${item.others} more alike; ` : ""}${reach(item.imports)})`,
          );
        const names = items
          .slice(0, LIST.similarNames)
          .map((item) => `${item.name} ~ ${item.like.name}`);
        return [
          `${first.path} repeats ${first.like.path} in ${items.length} declarations: ${names.join(", ")}${items.length > LIST.similarNames ? ", …" : ""} (${reach(first.imports)})`,
        ];
      }),
      LIST.similar,
    );
    lines.push(
      "Where it needs no new import, or only one that runs the way the project's layers do, and both copies must stay the same, keep one; code alike for another feature, layer or table is often meant to differ, so keep both. Change existing code only where it is part of the task; tell the user of the rest.",
    );
  }
  return lines.join("\n");
}
