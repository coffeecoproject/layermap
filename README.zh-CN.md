<p align="center"><img src="https://raw.githubusercontent.com/coffeecoproject/layermap/main/assets/icon.png" alt="LayerMap" width="120"></p>

# LayerMap

[English](https://github.com/coffeecoproject/layermap/blob/main/README.md) · **中文**

[![npm](https://img.shields.io/npm/v/layermap)](https://www.npmjs.com/package/layermap)
[![GitHub stars](https://img.shields.io/github/stars/coffeecoproject/layermap?style=social)](https://github.com/coffeecoproject/layermap/stargazers)
[![npm downloads](https://img.shields.io/npm/dm/layermap)](https://www.npmjs.com/package/layermap)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/coffeecoproject/layermap/blob/main/LICENSE)

**LayerMap 一次调用就告诉编程 agent：谁调用了这个函数、改它会影响什么，一直追到 HTTP 路由。** 每次最多 15 次请求时，用 LayerMap 的 agent 找到 **97.9%** 的受影响接口，不用只有 58.8%；不限次数时，Claude Code 花费**降低 32%**（[基准测试](https://github.com/coffeecoproject/layermap/blob/main/docs/benchmark.zh-CN.md)）。

**由每种语言自己的编译器或类型检查器解析，而不是 tree-sitter 按名字猜：** 经由接口、基类、模板和装饰器的调用，都按编译器的方式关联，支持 TypeScript、JavaScript、Go、Python 和 Java。

<p align="center"><img src="https://raw.githubusercontent.com/coffeecoproject/layermap/main/assets/demo.svg" alt="Claude Code 询问改动 Storage.MarkFeedAsRead 会影响哪些 HTTP 接口，一次 LayerMap 调用返回全部 4 个调用方和路由" width="100%"></p>
<p align="center"><sub>在 <a href="https://github.com/miniflux/v2">Miniflux</a> 上的一次真实 Claude Code 会话回放：一次地图调用找全接口，agent 再到源码里逐一确认。</sub></p>

给编程 agent 用的分层代码地图。LayerMap 给 Claude Code、Codex、DeepSeek Harness 和其他 MCP 客户端提供几个只读工具，一次调用
就能回答 agent 平时要搜几十次才弄清的问题：

- **谁调用了它，改它会影响什么？** 调用方最多追 8 层，一直追到作为起点的 HTTP 路由、处理函数、定时任务和
  命令。
- **它调用了什么？** 被调用方，往下最多 8 层。
- **这里有什么？** 模块、每个文件的声明，以及某个符号的所有用法。
- **我刚改的影响到哪里？** 未提交的改动经过哪些路由、定时任务和命令，以及相关的已有测试。

支持 **TypeScript、JavaScript、Go、Python 和 Java**，用每种语言自己的编译器分析。所以经由接口、基类、模板
和装饰器的调用，都和编译器解析得一样，包括文本搜索会漏掉的那些。

## 示例

在 [Miniflux](https://github.com/miniflux/v2) 里，对 `Storage.MarkFeedAsRead` 调用一次，就找出了请求到达它
的全部 4 种途径，每条都带着路由：

```
DECLARATION internal/storage/entry.go: Storage.MarkFeedAsRead m656-680 exported
  ← called by internal/api/feed.go: handler.markFeedAsRead m140-155 @149
  ← called by internal/fever/handler.go: handler.handleWriteFeeds m492-519 @508
  ← called by internal/googlereader/handler.go: handler.markAllAsReadHandler m1261-1338 @1311
  ← called by internal/ui/feed_mark_as_read.go: handler.markFeedAsRead m14-30 @24
[1] internal/api/feed.go: handler.markFeedAsRead m140-155
  ← used as value by internal/api/api.go: Serve f25-84 @61 "PUT /v1/feeds/{feedID}/mark-all-as-read"
[1] internal/googlereader/handler.go: handler.markAllAsReadHandler m1261-1338
  ← used as value by internal/googlereader/handler.go: Serve f44-64 @62 "POST /reader/api/0/mark-all-as-read"
[1] internal/ui/feed_mark_as_read.go: handler.markFeedAsRead m14-30
  ← used as value by internal/ui/ui.go: Serve f18-180 @77 "POST /feed/{feedID}/mark-all-as-read"
… (the Fever API, then on down to main.go: main)
```

`m`、`f` 表示方法和函数，后面的数字是行号；`@` 后面是调用发生的那一行，引号里是注册的路由：HTTP 方法和
完整路径，包括子路由加上的 `/v1` 前缀。Java、Python 和 TypeScript 的路由直接标在处理函数上，例如
`@GetMapping("/{id}") route "GET /api/tasks/{id}"`。

## 实验结果

我们在公开的 Go、Python、Java 项目上，用"改这里会影响哪些 HTTP 接口"这类问题做了测试。标准答案用各语言自己的
工具链交叉核对，评审是盲评：

| | 用 LayerMap | 不用 |
|---|---|---|
| 找到的接口，每次最多 15 次请求（`gpt-5.5`，6 道题各 3 次） | **97.9%** | 58.8% |
| Claude Code / Codex 主动使用（装了插件，两轮） | **12 次中 12 次 / 12 次中 12 次** | — |
| 找到的接口，不限次数（Claude Code / Codex，0.1.5） | 100% / 100% | 99.0% / 100% |
| Claude Code 花费，不限次数 | **−33%** | |
| Codex 输入 token，不限次数（当前默认设置） | +14% | |
| 用时，不限次数（Claude Code / Codex） | +25% / +20% | |
| 改完自检列出的失败测试（Go / Python，让函数失败） | **100% / 83–88%** | — |

**怎么理解这些结果：**

- 预算紧时，用地图能找到多得多的受影响代码，代价是多用约 24% 的 token。
- 不限次数时，两个 agent 有没有地图最终都能找全。Claude Code 用地图花费少三分之一。
- Codex 现在的默认设置本来就查得很省，地图不再帮它省 token；第一轮用最高推理强度时，它省了 55%。
- 有地图时 agent 会查得更广，所以用时更长。

样本量小，题目也由 LayerMap 作者编写。实验条件、公开的题目和局限说明见
[报告](https://github.com/coffeecoproject/layermap/blob/main/docs/benchmark.zh-CN.md)。

## 和同类工具的区别

别的工具各自提供了其中一部分。LayerMap 把"编译器级的准确"和"一次追完整条调用链"合在了一张本地地图里：

| | tree-sitter 代码图（codegraph、GitNexus 等） | 语言服务器与 IDE（Claude Code 的 LSP 工具、Serena、JetBrains） | 向量检索（Claude Context、Augment） | **LayerMap** |
|---|---|---|---|---|
| 调用怎么连起来 | 按名字、导入和框架规则匹配，常附置信度 | 编译器自己的解析 | 不连调用，只检索相似代码 | **由每种语言的编译器或类型检查器解析** |
| 调用方追到路由和处理函数 | 部分工具支持，深度不一 | 每次请求只返回一层（JetBrains 默认 5 层） | 无 | **一次调用最多追 8 层** |
| 是否存成地图 | 是，监听文件变化 | 否，由运行中的服务现场回答 | 存的是代码片段索引 | **是，每次调用时更新到最新** |
| 是否在本机运行 | 是，部分工具发送匿名统计 | 是 | 通常要用云端向量服务 | **是，不发送任何数据** |

以下需求更适合用别的工具：

- 需要更多语言：tree-sitter 代码图支持 30 种以上；
- 需要支持 Windows；
- 需要重命名、重构：用语言服务器；
- 需要按含义搜代码：用向量检索；
- 需要跨大量仓库搜索：用 Sourcegraph。

## 安装

**Claude Code**

```
/plugin marketplace add coffeecoproject/layermap
/plugin install layermap@layermap
```

**Codex**

```
codex plugin marketplace add coffeecoproject/layermap
codex plugin add layermap@layermap
```

**DeepSeek Harness**

```
npx layermap setup dsh
```

这条命令会把 LayerMap 加到 dsh 的所有配置里。每个会话分析的是启动 dsh 时所在的项目。`npx layermap remove dsh`
可以撤销。

不管用哪个 agent，装好后在 Git 仓库里新开会话，照常提问即可。LayerMap 会告诉 agent 什么时候该用地图。第一次
启动时，npx 会从 npm 下载锁定版本的 `layermap`。

Claude Code 在每个项目里第一次用到某个地图工具时会问一次，选"不再询问"即可；
也可以运行一次 `npx layermap allow claude`，在所有项目里放行这些只读工具。

**改完自检**：agent 改完代码后，`project_check_changes` 会列出这次改动影响到哪里：经过改动函数的路由、
定时任务和命令，地图看不到、需要人工核对的地方，以及相关的已有测试。它不会写测试，也不会运行测试。在
Claude Code 里，如果 agent 在本仓库里改了代码、之后还没做这个检查，插件会在它结束前提醒一次（同一工作目录里其他会话的改动不算）；设置 `LAYERMAP_STOP_CHECK=0`
可以关掉。Codex 和 DeepSeek Harness 通过说明文字提示 agent 去做。

**不用插件**：运行 `npx layermap setup claude` 或 `npx layermap setup codex`，它会：

- 注册地图服务；
- 让这些只读工具不再弹确认；
- 在 agent 的说明文件里加一句带标记的话。

加 `--scope project` 可以给整个团队配置；`npx layermap remove …` 撤销。其他 MCP 客户端，在仓库里把
`npx -y layermap mcp` 作为 stdio 服务运行即可。

**运行要求**：

- Node.js 22.22 或更高；
- macOS 或 Linux（x64 或 arm64）；
- Git 仓库；
- Java 项目另需 JDK 21 或更高。

## 工作方式

在一个仓库里第一次调用时建地图：小项目几秒，大项目几分钟。之后每次调用只重新分析改动的部分，所以地图总是和
当前工作区一致。

地图存在用户缓存目录里（`~/Library/Caches/layermap`、`~/.cache/layermap` 或 `LAYERMAP_CACHE`），不会放进
仓库。LayerMap 完全在本机运行，不向任何地方发送数据（见
[隐私说明](https://github.com/coffeecoproject/layermap/blob/main/PRIVACY.md)、
[安全说明](https://github.com/coffeecoproject/layermap/blob/main/SECURITY.md)）。

| 工具 | 用法 |
|---|---|
| `project_explore_map` | 查看目录、文件，或一个声明的调用方和被调用方（`direction` 为 INCOMING 或 OUTGOING，`depth` 最多 8）。 |
| `project_search_map` | 按名称、路径或文档里的词查找声明。 |
| `project_find_references` | 一个声明的所有用法，基于当前源码编译得出。 |
| `project_check_changes` | 未提交的改动（或自 `base` 以来的改动）影响到哪里：改动和删除的声明、经过它们的路由、定时任务和命令、需要人工核对的地方，以及相关测试。 |

命令行用法：

```
npx layermap explore src/api/users.ts --name createUser --direction INCOMING --depth 8
npx layermap search "invoice total"
npx layermap refs src/billing/tax.ts calculateTax
npx layermap check --base main
```

## 常见问题

**第一次建地图要多久？** 在较新的 Mac 上：

- Miniflux（400 个 Go 文件）：约 3 秒；
- Polar 服务端（1,900 个 Python 文件）：约 1 分钟；
- Conductor（1,500 个 Java 文件和 1,300 个 TypeScript 文件）：不到 2 分钟。

**有什么看不到？** 编译器无法静态解析的调用，比如依赖注入、它不认识的框架路由、反射和计算出的名字。追踪停在
哪里工具会说明。另外，地图上没有某条关系，不代表它不存在。

**支持 Windows 吗？** 暂不支持。

**怎么卸载？**

- Claude Code：`/plugin uninstall layermap@layermap`
- Codex：`codex plugin remove layermap@layermap`

卸载后再删掉缓存目录即可。

## 开发

需要 pnpm、Go 1.24 和 JDK 21 或更高；缺哪个工具链，对应的语言就不做分析。

先运行 `pnpm install`。第一次安装时 pnpm 会询问允许哪些依赖运行构建脚本；只允许 esbuild，SQLite 包自带预编译
文件：

```
pnpm approve-builds esbuild '!@photostructure/sqlite'
```

之后按需运行：

- `pnpm test`：运行测试；
- `pnpm typecheck`：类型检查；
- `pnpm lint`：代码规范检查；
- `pnpm package`：打出 npm 包。

## 许可证

Apache-2.0。见 [LICENSE](https://github.com/coffeecoproject/layermap/blob/main/LICENSE) 和
[NOTICE](https://github.com/coffeecoproject/layermap/blob/main/NOTICE)。
