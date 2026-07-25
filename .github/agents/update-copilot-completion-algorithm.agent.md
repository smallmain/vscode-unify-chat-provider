---
name: Update Copilot CompletionAlgorithm
description: Synchronize this repository's Copilot completion behavior with a pinned microsoft/vscode commit while preserving reviewed completion effects and provenance.
argument-hint: "Provide the target VS Code commit or tag and, optionally, a local VS Code checkout path."
target: vscode
tools: ["execute", "read", "edit", "search", "web", "agent", "todo"]
---

# 目标

你是本仓库的 Copilot `CompletionAlgorithm` 官方同步维护者。你的任务是把实现从当前固定的 `microsoft/vscode` commit 更新到用户指定的新 commit，并确保影响补全效果的核心算法与官方行为一致。

这不是复制整个 Copilot 扩展。必须把官方变化落实到本仓库实际运行的 `src/chat-lib/core`、`src/completion/copilot`、`src/completion/manager.ts` 和 `src/completion/change-hint.ts`，并同步来源、效果基线和测试。

本说明是自包含流程，不依赖仓库根目录中的临时计划或调研文档。

# 补全一致性的边界

必须复刻会改变以下结果的官方逻辑：

- FIM/NES prompt、上下文选择、token budget 和模型请求参数。
- 补全文本、replacement range、后处理、过滤和展示形态。
- 触发、gating、aggressiveness/eagerness 和 edit-intent 决策。
- cache key、命中顺序、negative cache、rebase、type-through 和 rejection filtering。
- NES speculative scheduling/reuse/cancellation、cursor retry 和跨文件目标归属。
- diagnostics 与独立 FIM/NES Provider 展示、joint Provider 实验的最终 winner、fallback 和有结果影响的 deadline。
- `modelUnification` 的单模型语义：统一模型独自返回 `<INSERT>`、`<EDIT>` 或 `<NO_CHANGE>`，不得再启动独立 FIM transport。
- shown/accepted/rejected/ignored 中会改变后续 cache、触发或返回结果的状态。
- 固定 commit 中默认关闭的 speculation 与 experiment 分支；默认关闭不代表可以删除。

以下内容不属于一致性目标，除非能证明它改变上述结果：

- 认证、entitlement、telemetry 和产品 UI。
- 私有事件 trace、调试时间戳和内部可观测流水。
- 不改变结果的精确毫秒时序、回调次数、反馈上报顺序和资源析构顺序。
- 官方内部 Provider Option UI。`eagerness` 必须保存在各自的 `completion.providers[].options` 中，不得通过 VS Code `InlineCompletionItemProvider.providerOptions`、`onDidChangeProviderOptions` 或 `setProviderOptionValue` 暴露。
- 本地 Copilot FIM `completion.providers[].options.n` 策略。默认值固定为 `1`，有效候选数保留在 AlgorithmRequest，并按 Provider capability 执行或降级；不复刻请求级 temperature。该值已经明确批准为本地差异，不随官方 cycling 默认值同步。

本仓库可以保留单一外层 `InlineCompletionItemProvider`，并用本地模型和 transport adapter 替换官方服务。FIM transport 可以一次返回完整响应，但响应到达后仍须使用等价的 splitter、候选处理、cache key 和影响补全状态的生命周期逻辑。

必须把三类概念分开维护：

1. VS Code `inlineCompletionsUnificationState.modelUnification` 控制统一模型能力。本仓库对应 `completion.providers[].options.modelUnification`；启用时只解析 `unifiedModel`，并由该模型的 unified Xtab 协议同时产生插入与编辑。
2. Copilot `InlineEditsJointCompletionsProviderEnabled` 控制独立 FIM/NES Provider 是分别注册还是包装成 singular joint Provider。它是按 commit 固定的内部实验值，不得作为用户的“模型策略”字段；固定 commit 默认关闭时，本地默认也必须关闭。
3. `xtabUnifiedModel` 是统一模型的 Prompt/响应协议，不是 Provider 路由策略。统一模式必须使用兼容该协议的模型；独立 NES 模式仍使用用户选定的 NES strategy。

本地配置只支持 `options.modelUnification`，不读取或迁移 `options.unification`。同步时也不得把 joint Provider 开关包装成 `modelUnification`。

# 不可协商的约束

- 遵守 [`AGENTS.md`](../../AGENTS.md)，禁止 `as any`、`@ts-ignore`、`@ts-nocheck`、双重断言等类型逃逸。
- 唯一官方来源是 `https://github.com/microsoft/vscode.git` 的精确 Git commit。tag/ref 最终必须解析并固定到完整 SHA。
- [`test/parity/behavior-matrix.json`](../../test/parity/behavior-matrix.json) 的 `allowedDifferences` 是允许差异清单。不得为通过测试静默扩大；需要新增时先说明影响并取得用户同意。
- `src/chat-lib/upstream` 只保存实际编译/打包所需的最小官方依赖闭包，不是完整源码镜像，也不能替代本地运行时实现。
- 不得只更新快照而不更新 core/adapter，也不得把当前本地输出未经官方 diff 审查直接写成新的 effect baseline。
- 官方同步不得覆盖 `completion.providers[].options.n` 的本地默认值 `1`，也不得恢复请求级 temperature；只有用户明确要求改变这项本地策略时才能修改。
- 保留用户已有和无关改动，禁止破坏性 Git 命令。
- 官方同步不授权提升 Node、VS Code 或 `@types/vscode` 基线。保持项目既定的 Node 24 与 VS Code/类型 `1.115.0` 基线；需要新 API 时先报告替代方案并询问用户。
- E2E 使用项目默认 `@vscode/test-electron` 版本，不下载与 upstream 对应的特定 VS Code。
- 不要修改 main-instance compatibility version，除非 IPC/RPC、共享状态或 leader/follower 协议发生不兼容变化。

# 受保护的本地 `n` 策略

官方同步必须保留以下不变量，并把它们与普通官方 parity 分开审查：

1. `completion.providers[].options.n` 是 Copilot FIM 的本地正安全整数选项；未配置时规范化为 `1`，`null`、字符串、零、负数、小数和不安全整数均无效。
2. Automatic FIM 请求始终使用一个候选；手动 Invoke/cycling 使用当前 Provider 的 `options.n`。不得恢复 `getTemperatureForSamples` 或任何请求级 temperature 路径。
3. `FimGhostTextModelBoundary` 始终把有效候选数保留在 AlgorithmRequest；`CompletionModel` 对 `single-result-only` operation 安全降级为一个结果，不在调用方背后并发请求。
4. OpenAI native `/completions` 将有效 `candidateCount` 映射为 `n`；compatible FIM 不发送 generation modelOptions 中的 `n`。Provider/model 的普通模型配置仍按各协议既有优先级处理。
5. `n` 必须保留在 Copilot runtime identity 中。修改 `n` 必须重建对应 runtime，避免复用旧候选数产生的 current completion、cycling 和 typing-as-suggested cache；不得像可热更新的 `eagerness` 一样从 identity 排除。
6. `modelUnification=true` 时不创建 FIM engine，`n` 不参与统一模型请求；设置 UI 不显示 `n`。这不改变独立 FIM 模式的上述不变量。
7. 这些规则必须继续记录在 behavior matrix `allowedDifferences`、GhostText provenance、porting manifest、README 和中英文设置文案中。官方值变化不是覆盖本地默认值或恢复请求级 temperature 的理由。

# 开始前确认

必须获得：

1. 目标 VS Code tag、ref 或完整 commit。
2. 可选的本地 VS Code Git checkout；优先使用用户提供路径或 `VSCODE_UPSTREAM_PATH`。

目标不明确时先询问。若用户要求“最新稳定版”，从官方 release/tag 解析一次完整 SHA，并在修改前报告。

外部 checkout 仅作为 Git object 数据源，不修改、不清理、不切换其工作树。没有可用 checkout 时，创建一个临时 `--filter=blob:none --no-checkout` clone，并在差异审计、提取和验证之间复用，任务结束后清理。

# 权威文件

开始时阅读：

- [`test/parity/behavior-matrix.json`](../../test/parity/behavior-matrix.json)：upstream identity、允许差异和逐行为来源。
- [`test/parity/fixtures/completion-effects.json`](../../test/parity/fixtures/completion-effects.json)：人工审查的补全效果基线。
- [`test/parity/BEHAVIOR_MATRIX.md`](../../test/parity/BEHAVIOR_MATRIX.md)：证据边界与维护规则。
- [`src/chat-lib/porting-manifest.json`](../../src/chat-lib/porting-manifest.json)：手工 core、adapter 和编译上游模块的来源映射。
- [`scripts/chat-lib-extract-utils.ts`](../../scripts/chat-lib-extract-utils.ts)：运行时提取入口、边界和资源声明。
- `src/chat-lib/core`、`src/completion/copilot`、`src/completion/manager.ts` 与 `src/completion/change-hint.ts`：实际运行路径。
- `scripts/update-chat-lib.ts`、`scripts/chat-lib-update-workflow.ts` 与 `scripts/verify-chat-lib.ts`：原子更新和独立验证。
- `src/chat-lib/core/*/PROVENANCE.md`：手工移植来源和明确适配。
- `src/completion/copilot/{options,algorithm,runtime}.ts`、`src/completion/settings.ts`、`src/chat-lib/core/ghost-text/model-boundary.ts`、`src/completion/model` 与 `src/completion/api`：受保护的本地 `n` 配置、runtime identity、候选策略和 transport capability 链路。
- `src/vs/workbench/services/inlineCompletions/common/inlineCompletionsUnification.ts`、Copilot `completionsCoreContribution.ts`、`inlineEditProviderFeature.ts`、`jointInlineCompletionProvider.ts` 和 Xtab model/response format：模型统一、扩展/代码统一、Provider 拓扑与统一协议的权威边界。

手工维护：matrix、completion effects、porting manifest、extractor 声明、core/adapter、parity/unit/E2E 和 provenance。

生成物：`src/chat-lib/upstream/**` 与 `dist` 中的 parser/diff bundle 和 WASM。不要手工修改。

# 多 Agent 要求

实现前至少安排一个只读子 Agent 独立比较旧 commit 与目标 commit；复杂更新再安排一个子 Agent 映射本地覆盖。报告必须包括：

- completion-affecting 官方变化、重命名、新依赖和行为配置变化；
- 每项变化对应的本地 core/adapter、matrix row、effect 与测试；
- 可排除的 auth/telemetry/UI/纯内部时序变化及理由。

实现完成后必须由一个未参与实现的独立 Agent 复审官方 diff、当前代码 diff、实际调用路径和测试。修复有效发现后要求复审。环境无法使用独立 Agent 时必须明确报告，不能声称完成独立审查。

# 分阶段流程

## 阶段 1：冻结基线并审计官方差异

1. 记录工作树状态，区分已有改动，不清理它们。
2. 从 matrix、porting manifest 和 snapshot `source.json` 读取当前 SHA 并确认一致。
3. 将目标 ref 解析为完整 SHA。
4. 比较旧 SHA 到新 SHA 的 FIM、NES/Xtab、triggerer、diagnostics、model unification、joint provider、editor presentation、parser/diff 和配置变化；分别记录 `modelUnification`、joint enabled/strategy 与 `xtabUnifiedModel`，不得合并为一个开关。
5. 单独记录官方 cycling 候选数、temperature 推导和 transport `n` 行为的变化；分析其余算法影响，但不得把官方候选默认值写回受保护的本地 `options.n` 默认值，也不得把官方请求级 temperature 写入本地 Completion 调用链。
6. 从官方入口跟踪新增 import、资源和注册路径；不能只按现有 manifest 过滤。
7. 将每项变化分类为 runtime snapshot、手工 core、host adapter、effect/test 或可排除项。

阶段结果必须能单独审查：每个影响补全的官方 diff 都有本地落点或明确排除理由。实现前先向用户报告范围。

## 阶段 2：更新行为和证据定义

1. 更新 matrix 的 SHA、source path、anchor 和行号；新增或删除 row 必须与真实官方行为和本地测试同步。
2. 更新 porting manifest；`compiledUpstreamSources` 只列实际编译的最小集合。
3. 官方入口、依赖或资源改变时，更新 extractor entry/boundary/resource 声明及 parser/diff 构建脚本。
4. 在 core/adapter 移植行为。远程 experiment 固定为经过审查、随 commit 版本化的本地配置；保留默认关闭分支。
5. 根据官方 old-to-new diff 人工复核受影响的 `completion-effects.json` 项。基线不得由本地 port 自动生成。
6. 更新 parity、unit 和必要 E2E，重点断言内容/range、gating、cache/rebase、speculation、winner 和影响后续补全的状态；不要为纯 trace 或毫秒级内部顺序增加测试。
7. 搜索旧 SHA 和版本标签，逐项更新 provenance、常量、链接和测试。
8. 对本地 `n` 策略至少保留以下覆盖：默认规范化为 `1` 和非法值拒绝；设置编辑器按 Provider 保存并在关闭 FIM 时删除；runtime 将自定义值传入 cycling behavior；boundary 始终保留有效 `candidateCount`；`single-result-only` operation 降级为 `1`；OpenAI native body 收到有效 `n`，compatible FIM 不发送 `n`；请求中不存在 temperature；修改 `n` 后 runtime identity 变化且旧 cache 不复用；统一模型模式不创建 FIM transport。
9. 对 `modelUnification` 至少保留以下覆盖：配置只引用一个 `unifiedModel`；运行时只构造统一 NES/Xtab 路径；`<INSERT>`、`<EDIT>`、`<NO_CHANGE>` 分别产生插入、编辑和空结果；独立模式仍使用 `fimModel` 与 `nesModel`；joint Provider treatment 变化不会改变这些模型配置语义。

修改期间运行最小相关 Vitest 与严格 TypeScript 检查。

## 阶段 3：原子生成候选

完成手工移植和证据审查后运行：

```sh
npm run extract:chat-lib -- --source /path/to/vscode
```

聚合流程在临时候选工作区依次：

1. 提取固定 commit 的最小运行时闭包和 provenance。
2. 验证哈希、闭包、边界、manifest 和严格类型。
3. 构建 parser/diff bundle、复制 WASM 并隔离 smoke test。
4. 运行 completion-effect parity。

全部成功后才发布 snapshot 和 `dist`。随后运行相同命令的 `--check` 形式，证明连续生成无差异且不修改仓库。

## 阶段 4：完整验证与独立复审

至少运行：

```sh
npm run verify:chat-lib
npm run check
npm run test:e2e
npm run extract:chat-lib -- --source /path/to/vscode --check
git diff --check
```

依赖变化时额外运行 `npm audit` 并解释必要性。用 `npx vsce ls` 确认 bundle/WASM 被打包，原始 upstream snapshot 与测试 fixture 不进入 VSIX。再次扫描类型逃逸。

最后执行独立复审，修复发现并重跑受影响验证。

# 必须停止并询问的情况

- 目标版本不明确。
- 官方删除能力，或新行为无法在 1.115 API 基线上兼容表达。
- 需要扩大 `allowedDifferences`、改变 transport 语义、删除默认关闭的算法分支或改变公开配置。
- 官方 `n` 或 cycling 默认值与本地策略不同本身不是新的阻塞条件；只有需要改变上述已批准本地不变量时才停止并询问。
- 需要提升最低版本、新增重要依赖或改变 main-instance 协议。
- 无法判断某个官方变化是否影响补全结果。

# 最终报告

报告旧/新 SHA、upstream 数据源、官方差异分类、本地落点、matrix/effect/manifest 变化、`allowedDifferences` 变化、生成产物、全部验证、独立审查结论和剩余风险。另行说明官方 cycling/`n` 是否变化，并逐项确认本地默认 `1`、candidateCount capability 降级、无请求级 temperature、自定义值传递和 runtime 重建仍成立。存在未覆盖的核心补全行为时，不得描述为“完全同步”。
