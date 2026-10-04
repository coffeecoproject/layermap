# LayerMap 对比实验报告

[English](benchmark.md) · [中文](benchmark.zh-CN.md)

代码地图能不能帮编程 agent 回答"改这里会影响什么"？我们做了两组实验：

1. **限定预算对照**：同一个模型，每次作答最多 15 次请求，分别在用和不用 LayerMap 的条件下作答。6 道公开题里，
   用地图找到了 **97.9%** 的受影响 HTTP 接口，不用地图找到 **58.8%**。
2. **自然使用**：不告诉 Claude Code 和 Codex 有地图。装了插件后，12 次运行里 **12 次**都主动用了地图。不限
   请求次数时：
   - 有没有地图，准确率相同（98–99%）；
   - Claude Code **花费少 32%**，Codex **输入 token 少 55%**；
   - 用时多 17–24%。

样本量小，题目也由 LayerMap 作者编写，请先看[局限](#局限)。题目原文、标准答案和评分规则都在
[`benchmark/tasks`](benchmark/tasks)。

## 题目

每道题指定一个函数，问修改它会影响哪些 HTTP 接口，要求写出每个接口的调用链和没能确认的地方。题目不提地图。
题目原文是中文，题目文件里附有英文翻译。

| 题目 | 语言 | 项目 | 修改对象 | 接口数 |
|---|---|---|---|---|
| [SRCSET_PARSE](benchmark/tasks/SRCSET_PARSE.json) | Go | [Miniflux](https://github.com/miniflux/v2) v2.2.17 | `ParseSrcSetAttribute` | 29 |
| [ENTRY_QUERY](benchmark/tasks/ENTRY_QUERY.json) | Go | Miniflux v2.2.17 | `EntryQueryBuilder.GetEntries` | 36 |
| [TAX_SERVICE](benchmark/tasks/TAX_SERVICE.json) | Python | [Polar](https://github.com/polarsource/polar) `server/` @ `71bd203` | `_get_tax_service` | 21 |
| [METER_FILTER](benchmark/tasks/METER_FILTER.json) | Python | Polar `server/` @ `71bd203` | `FilterClause.matches` | 20 |
| [RETRY_DELAY_CAP](benchmark/tasks/RETRY_DELAY_CAP.json) | Java | [Conductor](https://github.com/conductor-oss/conductor) v3.32.5 | `DeciderService.applyMaxRetryDelayCap` | 20 |
| [SECRET_REF](benchmark/tasks/SECRET_REF.json) | Java | Conductor v3.32.5 | `ParametersUtils.resolveSecretRef` | 22 |
| TS-A | TypeScript | 未公开代码库 | 一个业务日期比较函数 | 33 |
| TS-B | TypeScript | 未公开代码库 | 一个审计事件写入函数 | 22 |

受影响接口距离目标 1 到 12 层调用。有些只能经由模板函数、类层次中别处实现的接口，或隐式调用的 `__aexit__` 到达。

**标准答案**：两份来源逐个接口核对，不一致的地方回源码核实。其中一份是独立工具链的结果：

- Go：`golang.org/x/tools` 的 VTA 调用图；
- Python：mypy，并补上 FastAPI 的 `Depends` 依赖；
- Java：Conductor 自己的 Gradle 构建编译出的字节码。

另一份是 LayerMap 自己的索引。

Python 的两道题在第一轮后修订过，原因记录在题目文件里：

- TAX_SERVICE：有一个接口运行时到不了，22 改为 21；
- METER_FILTER：有一个接口经由隐式的 `__aexit__` 到达，19 改为 20。

**计分**：

- 列为受影响且调用链等价：1 分；
- 标为不确定，或调用链错误、缺失：0.5 分；
- 遗漏：0 分；
- 把标准答案以外的接口说成确定受影响：记一处误报。评审回源码确认确实会到达的除外。

**评审是盲评**：每道题的答案打乱后用随机字母编号，交给一个 Claude Opus 5.5 agent 评审。评审能看到标准答案，
可以只读查看源码，但不知道哪个答案来自哪一组。

## 实验一：限定预算对照

**条件**：

- **模型**：`gpt-5.5`，推理强度 high，在一个最小的实验程序里通过 OpenAI Responses API 调用。
- **两组共有**：四个只读源码工具（列文件、查路径状态、精确文本搜索、读文件）。
- **地图组额外**：
  - 加上地图的三个工具；
  - 加一句说明：`project_explore_map` 可以查看调用方和被调用方；
  - 第一次请求必须调用地图。
- **预算**：每次作答最多 15 次请求，最后一次不提供工具。
- **次数**：每题每组 3 次，顺序随机，每次在只能看到项目文本文件的沙箱里运行。48 次全部完成，只看源码组有 1 次
  超时，记 0 分。

| 题目 | 接口数 | 用 LayerMap | 只看源码 |
|---|---|---|---|
| SRCSET_PARSE（Go） | 29 | 29 / 29 / 29，**100%** | 23.5 / 18.5 / 24，75.9% |
| ENTRY_QUERY（Go） | 36 | 36 / 36 / 36，**100%** | 35 / 36 / 35，98.1% |
| TAX_SERVICE（Python） | 21 | 16 / 20 / 19，**87.3%** | 6.5 / 7.5 / 4.5，29.4% |
| METER_FILTER（Python） | 20 | 20 / 20 / 20，**100%** | 1 / 1 / 1，5.0% |
| RETRY_DELAY_CAP（Java） | 20 | 19.5 / 20 / 19.5，**98.3%** | 6 / 0（超时）/ 12.5，30.8% |
| SECRET_REF（Java） | 22 | 21.5 / 22 / 22，**99.2%** | 18 / 13 / 18，74.2% |
| **6 道公开题合计** | 444 | **434.5，97.9%** | 261，58.8% |
| TS-A（未公开） | 33 | 33 / 33 / 33，100% | 12.5 / 17.5 / 11，41.4% |
| TS-B（未公开） | 22 | 22 / 22 / 22，100% | 17 / 18.5 / 15，76.5% |

**误报**：

- 用 LayerMap：18 份公开题答案共 4 处。
  - 1 处是 Miniflux 的分享页：它走的分支不做 srcset 改写。
  - 3 处是 Polar 的后台管理接口：静态上相连，但运行时不会触发计费。
- 只看源码：共 6 处，其中两份答案各编造了一个 Conductor 里不存在的接口。

**差距来自离目标远的接口**：

- METER_FILTER：只看源码的答案都找到了所有路径汇聚的那个函数，但 15 次请求内没能把它的调用方追到任何接口。
- RETRY_DELAY_CAP：只看源码的答案漏掉了大部分 9 层以上的接口。
- TS-A：有 7 个接口超出一次 8 层视图的范围。用 LayerMap 的答案顺着视图里"未展开"的声明继续追，每次都全部找到；
  只看源码的 3 次合计找到 21 个中的 2 个。
- ENTRY_QUERY：接口都在 1–3 层以内，两组都答得好。

**token 消耗**：请求次数封顶时，用 LayerMap 的作答输入 token 更多，因为深层地图视图较长，模型看完还要读源码核实。

- 6 道公开题合计：642 万对 516 万，多 24%；
- 按题看：0.57 倍（ENTRY_QUERY）到 2.19 倍（RETRY_DELAY_CAP）；
- 模型用时差不多：3,001 秒对 3,179 秒。

在这种设定下，地图换来的是准确率，不是省钱。

## 实验二：Claude Code 和 Codex 的自然使用

**条件**：

- **Agent**：
  - Claude Code 2.1.278，默认模型（记录为 `claude-opus-5`）；
  - Codex CLI 0.157.1，作者的默认配置，推理强度 max，模型名称未记录。
- **题目**：6 道公开题，问题原文相同，不提地图。
- **有地图**：LayerMap MCP 服务（地图已预先建好），加上插件附带的一句提示：

  > The layermap MCP server is available here. For questions about what calls a function, what a
  > change affects or where code is used, start with its project_explore_map tool (direction
  > INCOMING, depth up to 8) before grep, then confirm in source.

- **没地图**：既没有服务，也没有提示。
- **运行方式**：只读权限，不限请求次数，每次最多 45 分钟；每格只跑 1 次，按同样方式盲评。

**会不会主动用地图**，取决于地图怎么提供：

| 提供方式 | Claude Code | Codex |
|---|---|---|
| 只提供工具，用最初的工具说明 | 2 次中 0 次 | 1 次中 0 次 |
| 工具说明开头写清何时使用 | 1 次中 1 次 | 1 次中 0 次 |
| 上述说明加一句提示（插件现在的做法） | **6 次中 6 次** | **6 次中 6 次** |

Codex 配置的工具较多时，要先"搜索工具"才能看到 MCP 工具，是那句提示让它去找地图。加了提示后：

- Claude Code 在第 2–3 次调用时用上地图；
- Codex 第 1 次调用就用地图。

**准确率与消耗**（共 147 个接口。这里 METER_FILTER 按原来的 19 个接口计分，4 份答案也都找到了第 20 个）：

| | Claude Code 有地图 | 没地图 | Codex 有地图 | 没地图 |
|---|---|---|---|---|
| 找到的接口 | 146（99.3%） | 145.5（99.0%） | 144（98.0%） | 145（98.6%） |
| 误报 | 0 | 0 | 0 | 0 |

| | 有地图 | 没地图 | 变化 |
|---|---|---|---|
| Claude Code 花费 | $12.60 | $18.40 | **−32%** |
| Codex 输入 token | 1,063 万 | 2,348 万 | **−55%** |
| Claude Code 用时 | 2,313 秒 | 1,866 秒 | +24% |
| Codex 用时 | 4,199 秒 | 3,594 秒 | +17% |

**怎么理解**：

- **准确率**：不限时间时，有没有地图都几乎能找全。Codex 有地图那组少的 3 分，是业务逻辑上的判断失误，地图上
  完整显示了那条调用链。
- **花费**：地图让查找过程更短。Codex 省下的 token 大部分在 METER_FILTER：242 万对 1,029 万。
- **用时**：变长是因为有地图后 agent 查得更广。比如 Codex 有一次调用了 84 次工具，其中 23 次是地图。每次查地图前
  检查文件变化，在这几个项目上约 1 秒。

## 局限

- **样本量小**：
  - 实验一每种语言 2 道题，每组 3 次；
  - 实验二每格 1 次，两种条件在不同时间运行，多数是有地图的先跑。
- **只测了一类任务**：都是追到 HTTP 接口的影响范围分析，正是 LayerMap 擅长的。
- **题目和标准答案**：题目由 LayerMap 作者编写，标准答案的两份来源之一是 LayerMap 的索引。不一致处都回源码核实过，
  修订也都写明了。
- **评审是模型**：它不知道答案来自哪一组，但能看到标准答案。
- **两个实验测的东西不同**：实验一强制先调用地图，实验二测的是 agent 会不会自己用。
- **实验二的环境没有完全隔离**：agent 沿用了作者的环境，包括全局说明文件和项目自带的 `AGENTS.md`/`CLAUDE.md`，
  两种条件下相同。Codex 的模型名称没有记录。
- **实验一没有记录美元花费**，只有 token 数。
- **TypeScript 题用的是未公开代码库**，只报告汇总分数，之后会补公开项目上的 TypeScript 实验。

## 复现

[`benchmark/tasks`](benchmark/tasks) 里每个文件包含：

- 项目、版本和提交；
- 题目原文和英文翻译；
- 修改对象，以及带调用链的标准答案；
- 中立接口和已核实不受影响的接口；
- 评分规则和修订内容。

实验一的实验程序还没有公开。任何 agent 都可以拿题目作答，再按标准答案计分。
