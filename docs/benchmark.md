# LayerMap benchmark

[English](benchmark.md) · [中文](benchmark.zh-CN.md)

Does a code map help a coding agent answer "what does changing this affect?" Two experiments:

1. **Budget-limited comparison.** One model, at most 15 requests per answer, with and without
   LayerMap. With the map it found **97.9%** of the affected HTTP endpoints across six public tasks;
   without it, **58.8%**.
2. **Natural use.** Claude Code and Codex were not told about the map. With the plugin installed,
   both used it on their own in **12 of 12** runs, and again in 12 of 12 when rerun with 0.1.5.
   With no request limit:
   - accuracy was the same with or without the map (98–100%);
   - Claude Code cost **about a third less**;
   - Codex used **55% fewer** input tokens at reasoning effort max, but 14% more with its current,
     leaner defaults ([rerun](#rerun-with-015));
   - runs took 17–25% longer.

Samples are small and LayerMap's authors wrote the tasks; see [Limitations](#limitations). The
questions, truth sets and scoring rules are in [`benchmark/tasks`](benchmark/tasks).

## Tasks

Each task names a function and asks which HTTP endpoints are affected if it changes, with each
endpoint's call chain and anything left unconfirmed. Questions never mention the map. The original
questions are in Chinese; each task file also has an English translation.

| Task | Language | Project | Target | Endpoints |
|---|---|---|---|---|
| [SRCSET_PARSE](benchmark/tasks/SRCSET_PARSE.json) | Go | [Miniflux](https://github.com/miniflux/v2) v2.2.17 | `ParseSrcSetAttribute` | 29 |
| [ENTRY_QUERY](benchmark/tasks/ENTRY_QUERY.json) | Go | Miniflux v2.2.17 | `EntryQueryBuilder.GetEntries` | 36 |
| [TAX_SERVICE](benchmark/tasks/TAX_SERVICE.json) | Python | [Polar](https://github.com/polarsource/polar) `server/` @ `71bd203` | `_get_tax_service` | 21 |
| [METER_FILTER](benchmark/tasks/METER_FILTER.json) | Python | Polar `server/` @ `71bd203` | `FilterClause.matches` | 20 |
| [RETRY_DELAY_CAP](benchmark/tasks/RETRY_DELAY_CAP.json) | Java | [Conductor](https://github.com/conductor-oss/conductor) v3.32.5 | `DeciderService.applyMaxRetryDelayCap` | 20 |
| [SECRET_REF](benchmark/tasks/SECRET_REF.json) | Java | Conductor v3.32.5 | `ParametersUtils.resolveSecretRef` | 22 |
| TS-A | TypeScript | private codebase | a business-date comparison helper | 33 |
| TS-B | TypeScript | private codebase | an audit-event write helper | 22 |

Endpoints sit 1 to 12 calls above the target. Some are reached only through a template function,
an interface implemented elsewhere in the class hierarchy, or an implicit `__aexit__`.

**Truth sets** reconcile two sources endpoint by endpoint, with disagreements checked in source.
One source is an independent toolchain:

- Go: the VTA call graph from `golang.org/x/tools`.
- Python: mypy, plus FastAPI `Depends`.
- Java: bytecode from Conductor's Gradle build.

The other source is LayerMap's own index.

Two Python truth sets were revised after the first round; the task files record why:

- TAX_SERVICE: one endpoint is unreachable at runtime, so 22 became 21.
- METER_FILTER: one endpoint is reached through an implicit `__aexit__`, so 19 became 20.

**Scoring:**

- An endpoint listed as affected with an equivalent call chain scores 1.
- An endpoint listed as uncertain, or with a wrong or missing chain, scores 0.5.
- A missing endpoint scores 0.
- An endpoint outside the truth set that an answer calls definitely affected is a false positive,
  unless the grader confirms it in source.

**Grading was blind.** Each task's answers were shuffled under random letters and graded by a
Claude Opus 5.5 agent. The grader had the truth set and read-only source, and was not told which
answer came from which condition.

## Experiment 1: budget-limited comparison

**Setup.**

- **Model:** `gpt-5.5` (reasoning high) via the OpenAI Responses API, in a minimal harness.
- **Both conditions:** four read-only source tools: list files, path status, exact text search and
  read file.
- **With LayerMap:** adds the three map tools and one sentence saying `project_explore_map` shows
  callers and callees. The first request had to call the map.
- **Budget:** at most 15 requests, the last one without tools.
- **Runs:** 3 per condition and task, in random order, each sandboxed to the project's text files.
  All 48 runs completed. One source-only run timed out and scores 0.

| Task | Endpoints | With LayerMap | Source only |
|---|---|---|---|
| SRCSET_PARSE (Go) | 29 | 29 / 29 / 29 — **100%** | 23.5 / 18.5 / 24 — 75.9% |
| ENTRY_QUERY (Go) | 36 | 36 / 36 / 36 — **100%** | 35 / 36 / 35 — 98.1% |
| TAX_SERVICE (Python) | 21 | 16 / 20 / 19 — **87.3%** | 6.5 / 7.5 / 4.5 — 29.4% |
| METER_FILTER (Python) | 20 | 20 / 20 / 20 — **100%** | 1 / 1 / 1 — 5.0% |
| RETRY_DELAY_CAP (Java) | 20 | 19.5 / 20 / 19.5 — **98.3%** | 6 / 0 (timeout) / 12.5 — 30.8% |
| SECRET_REF (Java) | 22 | 21.5 / 22 / 22 — **99.2%** | 18 / 13 / 18 — 74.2% |
| **Six public tasks** | 444 | **434.5 — 97.9%** | 261 — 58.8% |
| TS-A (private) | 33 | 33 / 33 / 33 — 100% | 12.5 / 17.5 / 11 — 41.4% |
| TS-B (private) | 22 | 22 / 22 / 22 — 100% | 17 / 18.5 / 15 — 76.5% |

**False positives:**

- **With LayerMap, 4 in 18 public answers.** A Miniflux share page that skips the srcset rewrite,
  and three Polar backoffice endpoints that are connected statically but never trigger billing at
  runtime.
- **Source only, 6.** Two answers each invented a Conductor endpoint that does not exist.

**Where the gap comes from:** endpoints far from the target.

- **METER_FILTER:** every source-only answer found the function all paths converge on, but traced
  none of its callers to an endpoint within 15 requests.
- **RETRY_DELAY_CAP:** source-only answers missed most endpoints 9 or more calls away.
- **TS-A:** 7 endpoints lie beyond one depth-8 view. LayerMap answers found all 7 every time by
  continuing from the view's unexpanded declarations; source-only answers found 2 of 21.
- **ENTRY_QUERY:** endpoints are 1–3 calls away, and both conditions do well.

**Tokens:** with requests capped, LayerMap answers used more input tokens. Deep map views are long,
and the model still verified them in source.

- Six public tasks: 6.42M against 5.16M (+24%).
- Per task: 0.57× (ENTRY_QUERY) to 2.19× (RETRY_DELAY_CAP).
- Model time was about equal: 3,001 s against 3,179 s.

Here the map buys accuracy, not savings.

## Experiment 2: natural use in Claude Code and Codex

**Setup.**

- **Agents:**
  - Claude Code 2.1.278 with its default model (recorded as `claude-opus-5`).
  - Codex CLI 0.157.1 with the owner's default configuration, reasoning effort max. The model name
    was not recorded.
- **Tasks:** the six public tasks, with the same questions and no mention of the map.
- **With the map:** the LayerMap MCP server (map prebuilt), plus the plugins' one-sentence note:

  > The layermap MCP server is available here. For questions about what calls a function, what a
  > change affects or where code is used, start with its project_explore_map tool (direction
  > INCOMING, depth up to 8) before grep, then confirm in source.

- **Without the map:** neither the server nor the note.
- **Runs:** read-only, no request limit, 45 minutes per run, one run per cell, graded blind as above.

**Adoption** depended on how the map was offered:

| How the map was offered | Claude Code | Codex |
|---|---|---|
| Tools only, original descriptions | 0 of 2 | 0 of 1 |
| Descriptions that open with when to use them | 1 of 1 | 0 of 1 |
| Those descriptions plus the note (what the plugins ship) | **6 of 6** | **6 of 6** |

Codex hides MCP tools behind a tool search when many are configured, so the note is what makes it
look. With the note, Claude Code made its first map call at its 2nd–3rd call and Codex at its first.

**Accuracy and cost** cover 147 endpoints. METER_FILTER is scored over its original 19 endpoints;
all four answers also found the 20th.

| | Claude Code with map | without | Codex with map | without |
|---|---|---|---|---|
| Endpoints found | 146 (99.3%) | 145.5 (99.0%) | 144 (98.0%) | 145 (98.6%) |
| False positives | 0 | 0 | 0 | 0 |

| | With map | Without | Change |
|---|---|---|---|
| Claude Code cost | $12.60 | $18.40 | **−32%** |
| Codex input tokens | 10.63M | 23.48M | **−55%** |
| Claude Code time | 2,313 s | 1,866 s | +24% |
| Codex time | 4,199 s | 3,594 s | +17% |

**What this shows:**

- **Accuracy:** with unlimited time both agents find nearly everything either way. Codex with the
  map lost 3 points on a business-logic judgment, even though the map showed the full chain.
- **Cost:** the map shortens the search. Most of Codex's saving is METER_FILTER, 2.4M against
  10.3M tokens.
- **Time:** runs take longer because agents with the map explore more widely. One Codex run made
  84 tool calls, 23 of them map calls. The map's change check costs about 1 s per call on these
  projects.

### Rerun with 0.1.5

0.1.5 shows each handler's HTTP methods and full path, and drops the explanations views repeated
on every call. The same six tasks were rerun on 2026-10-07, run and graded the same way:

- **Claude Code** 2.1.278 with the same model, with the map only. The first round's runs without
  the map are the baseline.
- **Codex CLI** 0.160.1 with the owner's current defaults (model `gpt-6-astra`, reasoning effort
  xhigh; the first round used effort max), with and without the map. Codex is compared within this
  round only. With the map, the installed plugin's server was replaced by the version under test;
  without it, plugins were turned off.

| | Claude Code with map | Codex with map | Codex without |
|---|---|---|---|
| Endpoints found (of 147) | 147 (100%) | 147 (100%) | 147 (100%) |
| False positives | 1 | 0 | 0 |
| Map calls / other tool calls | 41 / 142 | 36 / 103 | 0 / 159 |
| Time | 2,329 s | 2,264 s | 1,883 s |
| Cost | $12.32 | 5.55M input tokens | 4.86M input tokens |

Claude Code's false positive is the Miniflux share page from Experiment 1.

**What changed:**

- **Claude Code** made fewer other tool calls than with 0.1.4 (142 against 185) and more map calls
  (41 against 27). Time and cost were about the same as the first round (2,313 s, $12.60). Against
  its runs without the map it cost 33% less and took 25% longer.
- **Codex** with its current defaults searches far less on its own: 4.86M input tokens without the
  map, against 23.48M at effort max. With the map it made 35% fewer other tool calls, but used 14%
  more input tokens and 20% more time.

## Limitations

- **Small samples.** Experiment 1 has two tasks per language and three runs each. Experiment 2 has
  one run per cell, run at different times, mostly with the map first. Single runs of one task
  vary widely: in the rerun, one Claude Code answer took 665 s against 359 s in the first round.
- **One kind of task.** Every task is impact analysis up to HTTP endpoints, which is what LayerMap
  is built for.
- **Authorship.** LayerMap's authors wrote the tasks, and LayerMap's index is one of the two
  truth-set sources. Disagreements were checked in source, and the revisions are documented.
- **The grader is a model.** It was blind to the condition but saw the truth set.
- **Different questions.** Experiment 1 made the first request call the map; Experiment 2 measures
  unprompted use.
- **Shared environment.** In Experiment 2 agents inherited the owner's environment, including
  global instruction files and the projects' own `AGENTS.md`/`CLAUDE.md`, the same in both
  conditions. Codex's model name was not recorded in the first round, and its default reasoning
  effort changed before the rerun.
- **No dollar cost** was recorded for Experiment 1.
- **TypeScript.** The TypeScript tasks use a private codebase, so only aggregates are reported. A
  public TypeScript benchmark is planned.

## Reproducing

Each file in [`benchmark/tasks`](benchmark/tasks) holds:

- the project, version and commit;
- the original question and its English translation;
- the target and the truth set, with each endpoint's call chain;
- the neutral and verified-unaffected endpoints;
- the scoring rules and any revision.

The Experiment 1 harness is not published yet. Any agent can be given the questions and scored
against the truth sets.
