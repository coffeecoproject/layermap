# LayerMap benchmark

[English](benchmark.md) · [中文](benchmark.zh-CN.md)

Does a code map help a coding agent answer "what does changing this affect?" Five experiments:

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

3. **Change check accuracy** (no model). Functions were made to fail on entry, one at a time, and the
   whole test suite was run. Of the test files that failed, `project_check_changes` listed **100%**
   on Miniflux (Go) and, with 0.1.10, **94–98%** directly, **97–99%** with indirect importers, on
   Starlette (Python, tests in their own directory; 83–88% and 90–98% before).
4. **Ripple tasks.** Requests whose obvious change breaks another feature. With the change check
   of 0.1.8 and 0.1.9, Codex left every other feature's tests passing in **23 of 24** runs with the
   map and 3 of 12 without. Claude Code showed no clear difference (11 of 24 and 4 of 12): it saw
   which tests of other features it had changed and kept the broader change on purpose, saying so.
   With 0.1.7's check the map made no difference.
5. **Everyday tasks.** Small local requests that need no impact analysis. Both agents did all of
   them right either way, and the map cost them about **a fifth more** time and money.

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

## Experiment 3: change check accuracy

Does `project_check_changes` list the tests a change can break? Like a test impact tool's
simulator, the check was compared with what the tests actually do, without a model:

1. Pick a function or method at random and make it fail on entry (Go `panic`, Python `raise`).
2. Run `project_check_changes` on that diff.
3. Run the project's whole test suite and record the test files that fail.
4. Restore the file. 60 functions per sample, with a fixed seed.

| Project | Test files | Samples with failing tests | Failing test files listed | Listed per change (median) |
|---|---|---|---|---|
| [Miniflux](https://github.com/miniflux/v2) (Go) | 71 | 22 of 60 | **33 of 33 (100%)** | 3 |
| [Starlette](https://github.com/Kludex/starlette) (Python), sample 1 | 31 | 60 of 60 | **163 of 167 (97.6%)**; 99.4% with indirect importers | 10 |
| Starlette, sample 2 | 31 | 58 of 60 | **231 of 245 (94.3%)**; 96.7% with indirect importers | 13 |

"Listed" means the RELATED TESTS list; "with indirect importers" adds the test files the check
only counts. The list errs on the side of more: on Starlette it holds about a third of the test
files. A check takes 2–4 s on these projects (median). Starlette's rows are from 0.1.10; with 0.1.9
the same samples listed 88.1% and 82.9% directly, before the Python analysis recorded a class
passed as a value (to `functools.partial` in a pytest fixture) as a use of it.

The remaining misses on Starlette are calls the framework makes at run time through the ASGI
protocol (`receive`, `__aenter__`) and file methods an upload calls. Functions no test runs (38 of
60 on Miniflux) can only be checked through the entry points the check lists.

## Experiment 4: ripple tasks

Does the change check keep an agent from breaking a feature it was not asked to change? Each task
is a request to a public project whose most obvious implementation changes shared code and breaks
another feature's tests. For example, "keep the feed's http scheme for protocol-relative RSS
links": the shared URL resolver also serves the HTML sanitizer, which must keep upgrading such
links to https.

- **Agents.** Claude Code and Codex (`gpt-6-astra`, reasoning effort xhigh), with LayerMap (Claude
  Code: the plugin and its reminder before finishing; Codex: the server and the plugin's note) and
  without. A fresh clone per run, 30 minutes at most.
- **Scoring.** The project's own test files are restored, so rewriting another feature's tests
  counts as breaking it; a hidden acceptance test is added; the whole suite runs. A run is clean
  when the acceptance test passes and no other test fails. One task's own feature test has to
  change and is not counted.

**Round 1** (0.1.7; 6 Starlette and 6 Miniflux tasks, one run each): no difference. Eight tasks
broke nothing in any run. Claude Code broke 5 tests with the map and 5 without; Codex broke more
with the map, one run not compiling. Codex ran no tests, because the owner's global instructions
forbid it unless asked, and the check listed so many related tests that the risk was buried.

0.1.8 changed the check: it names the areas (packages or modules) whose tests reach the changed
code, and says a failing test of an area the request is not about means the change reached it;
constructors no longer count as dispatched through a base class; the related tests list is shorter;
Go reads of package-level variables and constants are mapped.

**Round 2** (0.1.8; the 5 tasks some run failed in round 1, 3 runs per task and agent, with and
without; every request adds "You may run the project's tests to verify the change."). Clean runs:

| Task (project) | Codex, with | Codex, without | Claude Code, with | Claude Code, without |
|---|---|---|---|---|
| Keep http for protocol-relative RSS links (Miniflux) | **3/3** | 0/3 | 1/3 | 0/3 |
| Read two-digit years in JSON Feed dates (Miniflux) | **3/3** | 0/3 | 2/3 | 1/3 |
| Embed Invidious videos at 640×360 (Miniflux) | 3/3 | 3/3 | 2/3 | 0/3 |
| No charset on static files (Starlette) | **2/3** | 0/3 | 2/3 | 3/3 |
| **Total** | **11/12** | 3/12 | **7/12** | 4/12 |
| Weak ETags for static files (Starlette), not counted | 0/3 | 0/3 | 0/3 | 0/3 |

- Every run did what was asked.
- **Codex**: with the map it kept to code only the requested feature uses; without it, it changed
  the shared code and rewrote the other feature's tests to pass. A gap this size is unlikely by
  chance (Fisher's exact test, p = 0.003).
- **Claude Code**: the gap could be chance (p = 0.41). In 4 of its 5 failing runs with the map, the
  check had named the shared areas and Claude Code still rewrote the other feature's tests.
- **Weak ETags** are not counted: RFC 9110 makes every ETag built from a modification time weak, so
  changing the generator all file responses share is defensible. Every run of both agents did so.
- **Cost**: with the map, Claude Code took 54% longer and cost 29% more; Codex took 27% longer and
  used 14% more tokens.

0.1.9 names the existing tests a diff changed, comparing each test's code before and after, and
asks the agent to call the check once, when the edits are done.

**Round 3** (0.1.9; the same 4 tasks, 3 runs each with the map; the runs without the map are round
2's). Clean runs out of 12:

| | Without (round 2) | With 0.1.8 (round 2) | With 0.1.9 (round 3) |
|---|---|---|---|
| Codex | 3 | 11 | **12** |
| Claude Code | 4 | 7 | 4 |

- **Codex**: 23 of 24 runs with the map against 3 of 12 without (p < 0.001).
- **Claude Code**: 11 of 24 against 4 of 12, which could well be chance (p = 0.72); between rounds 2
  and 3 its result moved from 7 to 4 with almost the same setup. In every failing round 3 run the
  check named the other feature's test Claude Code had changed. Claude Code kept the change on
  purpose and said so in its answer, offering the narrower change: it judged the shared code to be
  the place to fix, as the owner's global instructions ask ("find the real owner, do not stack
  patches"). Two requests also read either way: whether "article links" include links inside an
  article, and whether YouTube links played through Invidious are part of "the Invidious player".
- **Time**: Claude Code's runs with the map took 22% less time than in round 2, at about the same
  cost; Codex's took about the same.

## Experiment 5: everyday tasks

What does the map cost on the ordinary requests that need no impact analysis? Eight small, local
tasks with no trap, four on Starlette and four on Miniflux, such as accepting yes/no in a boolean
setting, adding an option with a default, or recognizing one more file type. Each has a hidden
acceptance test; scoring is as in Experiment 4. Claude Code and Codex ran each task twice with
LayerMap 0.1.10 and twice without, and every request allows running the tests.

| | Done correctly | Broke another feature | Time, with / without | Cost, with / without |
|---|---|---|---|---|
| Claude Code | 16/16 and 16/16 | 0 and 0 | 2,439 s / 2,002 s (**+22%**) | $12.31 / $9.98 (**+23%**) |
| Codex | 16/16 and 16/16 | 0 and 0 | 2,397 s / 2,005 s (**+20%**) | 4.78M / 4.01M tokens (**+19%**) |

- The map made no difference to the result: every run did the task and broke nothing.
- **Claude Code** looked something up in the map in 2 of 16 runs; the cost was the change check,
  called 27 times in 16 runs although it is asked to call it once.
- **Codex** looked up the map in every run, about twice each, and called the check once per run.
- So on small local work the map is overhead, about a fifth; the earlier experiments show where it
  pays for itself.

0.1.12 removes two kinds of waste: the check no longer refuses arguments it lacks (Claude Code had
guessed one in 12 calls), and a test that only gained lines no longer counts as an existing test
changed. Rerun with both conditions at the same time on an idle machine, the map still cost Claude
Code 31% more time and 20% more money, and Codex 12% more time and 17% more tokens; every run did
the task right. What remains is the check at the end and, for Codex, looking up a function's
callers before changing it, which is what kept it from breaking other features in Experiment 4.

## Limitations

- **Small samples.** Experiment 1 has two tasks per language and three runs each. Experiment 2 has
  one run per cell, run at different times, mostly with the map first. Single runs of one task
  vary widely: in the rerun, one Claude Code answer took 665 s against 359 s in the first round.
- **One kind of task.** Every task is impact analysis up to HTTP endpoints, which is what LayerMap
  is built for.
- **Experiment 5** has eight tasks on two projects and two runs per cell; the tasks were designed
  to need no impact analysis, so it measures the map's overhead, not its use.
- **Experiment 4** has 3 runs per cell. Its round 2 tasks were the ones agents had failed in round
  1, chosen after seeing results, and LayerMap's authors wrote them. Round 1 and round 2 differ in
  the request too (round 2 allows running tests), so only results within a round compare; round 3
  reuses round 2's runs without the map. Scoring counts any change to another feature's tests as
  breaking it, even when an agent argues for it and says so, and the agents inherited the owner's
  global instructions.
- **Experiment 3** covers two projects, Go and Python. Failing on entry only shows which tests run a
  function, not whether they would notice a subtler bug.
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

The Experiment 5 tasks, with their acceptance tests, are in [`benchmark/everyday`](benchmark/everyday).

The Experiment 4 tasks, with each request, the obvious change, the tests it breaks, a correct
change and the hidden acceptance test, are in [`benchmark/ripple`](benchmark/ripple).

The Experiment 1 harness is not published yet. Any agent can be given the questions and scored
against the truth sets.
