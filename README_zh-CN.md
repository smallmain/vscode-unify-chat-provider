<p align="center">
<img src="icon.png" width="120" />
</p>

<h1 align="center">
Unify Chat Provider
</h1>

<p align="center">
通过 Language Model API，将多个大语言模型 API 提供商集成到 VS Code 的 GitHub Copilot Chat 中。
</p>

<!-- <br>
<p align="center">
<a href="https://unocss.dev/">Documentation</a> |
<a href="https://unocss.dev/play/">Playground</a>
</p>
<br> -->

<br>
<p align="center">
<a href="./README.md">English</a> |
<span>简体中文</span>
</p>

## 特性

- **[完美兼容](#api-格式支持表)**：支持所有主流的 LLM API 格式（OpenAI Chat Completion、OpenAI Responses、Anthropic Messages、Ollama Chat）。
- **[深度适配](#供应商支持表)**：深度适配各模型供应商的接口特性与最佳实践。
- **[最佳性能](#模型支持表)**：内置主流模型的推荐参数，确保充分发挥模型的全部潜力。
- **[开箱即用](#一键配置)**：支持一键配置主流供应商，支持自动同步官方模型列表，无需进行任何繁琐的配置。
- **[快速迁移](#一键迁移)**：支持从主流应用或扩展（Claude Code、CodeX、Gemini CLI...）一键迁移配置。
- **[导入导出](#导入与导出)**：拥有完善的导入和导出功能，支持多种方式（Base64、JSON、URL、URI）导入已有配置。
- **[可控参数](#调整参数)**：开放所有接口参数的调整，并支持自定义 Header 与 Request 字段。
- **[极佳体验](#管理供应商)**：内置可视化用户界面，支持无限个供应商及模型配置，且支持同个供应商或模型的多个配置共存。

## 安装

- 在 VS Code 扩展市场搜索 [Unify Chat Provider](https://marketplace.visualstudio.com/items?itemName=SmallMain.vscode-unify-chat-provider) 并安装。
- 通过 [GitHub Releases](https://github.com/smallmain/vscode-unify-chat-provider/releases) 下载最新的 `.vsix` 文件，在 VS Code 中通过 `从 VSIX 安装扩展...` 或拖动到扩展面板进行安装。

## 快速开始

选择一种最合适的方式开始：

- [一键迁移](#一键迁移)：从其它应用或扩展迁移。
- [一键配置](#一键配置)：添加内置支持的模型提供商。
- [导入与导出](#导入与导出)：已有备份的配置或他人分享的配置。
- [手动配置](#手动配置)：完全从零开始添加任何提供商与模型。

> 无论使用哪种方式，在导入完成前后都能够对任何字段进行自定义。

### 基本操作

用户界面集成在 VS Code 命令面板以提供更原生的体验，请了解其基本操作方式：

1. 打开面板：
   - 通过菜单 `查看` -> `命令面板...` 打开。
   - 通过 `Ctrl+Shift+P`（Windows/Linux）或 `Cmd+Shift+P`（Mac）快捷键打开。
2. 搜索命令：
   - 在命令面板中输入关键字 `Unify Chat Provider:` 或者 `ucp:` 搜索所有命令。
3. 选择命令：
   - 使用鼠标点击或键盘的上下箭头键选择命令，按回车键执行所选命令。

<div align="center">
  <img src="assets/screenshot-1.png" width="600" />
</div>

### 一键迁移

查看 [应用迁移支持表](#应用迁移支持表) 以了解支持一键迁移的应用和扩展。

> 如果使用的应用或扩展不在上述列表中，则可通过 [一键配置](#一键配置) 或 [手动配置](#手动配置) 来完成配置。

#### 操作步骤：

1. 打开 VS Code 命令面板，搜索 `Import Config From Other Applications`。

   <div align="center">
   <img src="assets/screenshot-2.png" width="600" />
   </div>

   - 界面会列出所有支持的应用或扩展，及其检测到的配置文件路径。
   - 通过列表项最右侧的按钮组可执行其他操作：
     1. `自定义路径`：选择自定义的配置文件路径导入。
     2. `从配置内容导入`：直接输入配置内容进行导入。

2. 在列表中选择要导入的应用或扩展，跳转到配置导入界面。

   - 该界面用于检查和修改即将导入的配置。
   - 详细介绍可查看 [供应商配置](#供应商配置) 文档。

3. 点击 `Save` 按钮即可完成整个导入，立即在 Copilot Chat 中使用导入的模型。

   <div align="center">
   <img src="assets/screenshot-3.png" width="600" />
   </div>

### 一键配置

查看 [供应商支持表](#供应商支持表) 以了解支持一键配置的模型供应商。

> 如果使用的供应商不在上述列表中，可通过 [手动配置](#手动配置) 来添加。

#### 操作步骤：

1. 打开 VS Code 命令面板，搜索 `Add Provider From Well-Known Provider List`。

   <div align="center">
   <img src="assets/screenshot-4.png" width="600" />
   </div>

2. 在列表中选择要添加的供应商。
3. 根据提示输入 API Key，跳转到配置导入界面。

   - 如果供应商不需要 API Key，回车跳过即可。
   - 该界面用于检查和修改即将导入的配置。
   - 详细介绍可查看 [供应商配置](#供应商配置) 文档。

4. 点击 `Save` 按钮即可完成整个导入，立即在 Copilot Chat 中使用导入的模型。

   <div align="center">
   <img src="assets/screenshot-5.png" width="600" />
   </div>

### 手动配置

本章节以 DeepSeek 为例，添加该供应商及其两个模型。

> 该供应商支持 [一键配置](#一键配置)，为教学用途本章节进行手动配置。

0. 准备工作，在供应商文档中获取 API 的相关信息，至少包括以下三个：

   - API Format：接口格式，如 OpenAI Chat Completion、Anthropic Messages 等。
   - API Base URL：接口基础 URL 地址。
   - API Key：通常是通过注册账号后在用户面板获取。

1. 打开 VS Code 命令面板，搜索 `Add Provider`。

   <div align="center">
   <img src="assets/screenshot-6.png" width="600" />
   </div>

   - 该界面与 [供应商配置](#供应商配置) 界面相似，你可以阅读该界面的文档了解每个字段。

2. 填写供应商的名称：`Name`。

   - 该名称必须唯一，会在模型列表中展示，这里填写的是 `DeepSeek`。
   - 同一个供应商可以添加多个不同名称的配置，比如 `DeepSeek-Person`、`DeepSeek-Team`。

3. 填写接口格式：`API Format`。

   - DeepSeek 的接口是 `OpenAI Chat Completion` 格式，所以选则该格式。
   - 要了解支持的所有格式可查看 [API 格式支持表](#api-格式支持表)。

4. 填写基础 URL：`API Base URL`。

   - DeepSeek 的基础 URL 是 `https://api.deepseek.com`。

5. 填写 API Key：`API Key`。

   - 将在 DeepSeek 控制台生成的 API Key 填写到该字段。

6. 点击 `Models` 字段跳转到模型管理界面。

   <div align="center">
   <img src="assets/screenshot-7.png" width="600" />
   </div>

7. 选中 `Auto-Fetch Official Models` 以启用自动拉取官方模型。

   - 本章节选择从官方自动拉取模型以减少配置步骤，该功能的详细介绍可查看 [自动拉取模型](#自动拉取模型)。
   - 有关模型字段或其它添加方式的介绍可查看 [管理模型](#管理模型) 文档。

8. 点击 `Save` 按钮即完成添加，你可以立即在 Copilot Chat 中使用其中的模型。

   <div align="center">
   <img src="assets/screenshot-5.png" width="600" />
   </div>

## 管理供应商

- 你可以创建无限个供应商配置，并且同个供应商可以创建多个不同配置共存。
- 供应商名称必须是唯一的。

### 供应商列表

打开 VS Code 命令面板，搜索 `Manage Providers`。

<div align="center">
<img src="assets/screenshot-8.png" width="600" />
</div>

- `Add Provider`: 通过 [手动配置](#手动配置) 添加新的供应商。
- `Add From Well-Known Provider List`: 通过 [一键配置](#一键配置) 添加新的供应商。
- `Import From Config`: 导入已有的供应商或供应商数组配置，详细介绍请查看 [导入与导出](#导入与导出)。
- `Import From Other Applications`: 通过 [一键迁移](#一键迁移) 从其它应用或扩展导入配置。
- `Export All Providers`: 导出所有供应商的配置，详细介绍请查看 [导入与导出](#导入与导出)。

界面还会展示当前所有的供应商，点击其中一个供应商列表项则进入 [模型列表](#模型列表) 界面。

列表项右侧的按钮组可执行其它操作：

- `Export`: 导出该供应商的配置，详细介绍请查看 [导入与导出](#导入与导出)。
- `Duplicate`: 克隆该供应商配置以创建一个新的配置。
- `Delete`: 删除该供应商配置。

### 供应商配置

<div align="center">
<img src="assets/screenshot-10.png" width="600" />
</div>

- `Models`: 仅在添加或导入配置时存在该按钮，点击则进入 [模型列表](#模型列表) 界面。

界面会展示当前供应商的所有配置字段，具体字段说明可查看 [供应商参数](#供应商参数)。

## 管理模型

- 每个供应商均可创建无限个模型配置。
- 不同供应商之间允许存在相同的模型 ID。
- 单个供应商配置中，不允许直接存在多个相同的模型 ID，但可通过 `#xxx` 后缀添加多个配置。
- 例如可以分别添加 ID 为 `glm4.7` 和 `glm4.7#thinking` 的两个模型配置以随时切换是否开启思考。
- 模型 ID `#xxx` 后缀在实际发送请求时会被自动移除。
- 虽然模型名称允许重复，但建议使用不同的名称避免混淆使用。

### 模型列表

<div align="center">
<img src="assets/screenshot-9.png" width="600" />
</div>

- `Add Model`: 进入 [手动添加模型](#手动添加模型) 界面。
- `Add From Well-Known Model List`: 进入 [一键添加模型](#一键添加模型) 界面。
- `Add From Official Model List`: 通过 API 接口拉取最新的官方模型列表，详细可查看 [一键添加模型](#一键添加模型)。
- `Import From Config`: 导入已有的模型或模型数组配置，详细介绍可查看 [导入与导出](#导入与导出)。
- `Auto-Fetch Official Models`：启用或禁用 [自动拉取模型](#自动拉取模型)。
- `Provider Settings`: 进入 [供应商配置](#供应商配置) 界面。
- `Export`: 导出该供应商或者模型数组配置，详细介绍请查看 [导入与导出](#导入与导出)。
- `Duplicate`: 克隆该供应商配置以创建一个新的配置。
- `Delete`: 删除该供应商配置。

### 手动添加模型

该界面与 [模型配置](#模型配置) 界面相似，你可以阅读该界面的文档了解详情。

### 一键添加模型

<div align="center">
<img src="assets/screenshot-12.png" width="600" />
</div>

该界面会列出所有支持一键添加的模型，你可以一次性导入选中的多个模型。

所有支持的模型可查看 [模型支持表](#模型支持表)。

### 自动拉取模型

该功能通过供应商的 API 接口定时拉取最新的模型列表，并且自动配置好推荐的参数，极大地简化了模型的添加过程。

> 提示
>
> 供应商的 API 接口不一定会返回模型的推荐参数，所以推荐参数将根据模型 ID 从内部数据库获取，支持的模型可查看 [模型支持表](#模型支持表)。

<div align="center">
<img src="assets/screenshot-7.png" width="600" />
</div>

- 自动拉取的模型名称前面会有一个 `互联网` 图标以示区分。
- 如果自动拉取的模型 ID 与手动配置的模型 ID 冲突，则只展示手动配置的模型。
- 自动拉取的模型会定期更新，也可以点击 `(click to fetch)` 手动更新。
- 通过 VS Code 命令 `Refresh All Provider's Official Models` 手动触发所有供应商的自动拉取更新。

### 模型配置

<div align="center">
<img src="assets/screenshot-11.png" width="600" />
</div>

- `Export`: 导出该模型的配置，详细介绍请查看 [导入与导出](#导入与导出)。
- `Duplicate`: 克隆该模型配置以创建一个新的配置。
- `Delete`: 删除该模型配置。

界面会展示当前供应商的所有配置字段，具体字段说明可查看 [模型参数](#模型参数)。

## 调整参数

### 供应商参数

以下字段对应 `ProviderConfig`（导入/导出 JSON 使用的字段名）。

| 名称             | ID                        | 介绍                                                                                |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| API 格式         | `type`                    | 供应商类型（决定 API 格式与兼容逻辑）。                                             |
| 供应商名称       | `name`                    | 该供应商配置的唯一名称（用于列表展示与引用）。                                      |
| API Base URL     | `baseUrl`                 | API 基础地址，例如 `https://api.anthropic.com`。                                    |
| API Key          | `apiKey`                  | 鉴权用 Key。                                                                        |
| 模型列表         | `models`                  | 模型配置数组（`ModelConfig[]`）。                                                   |
| Mimic            | `mimic`                   | 模拟/兼容某些上游行为的选项（不同 `type` 支持的选项不同）。                         |
| 额外 Headers     | `extraHeaders`            | 会附加到每次请求的 HTTP Header（`Record<string, string>`）。                        |
| 额外 Body 字段   | `extraBody`               | 会附加到请求 body 的额外字段（`Record<string, unknown>`），用于对齐供应商私有参数。 |
| 超时配置         | `timeout`                 | HTTP 请求与 SSE 流式的超时配置（毫秒）。                                            |
| 建连超时         | `timeout.connection`      | TCP 建立连接的最大等待时间；默认 `10000`（10 秒）。                                 |
| 响应间隔超时     | `timeout.response`        | SSE 流式接收数据块之间的最大等待时间；默认 `120000`（2 分钟）。                     |
| 自动拉取官方模型 | `autoFetchOfficialModels` | 是否定期从供应商 API 拉取官方模型列表并自动更新。                                   |

### 模型参数

以下字段对应 `ModelConfig`（导入/导出 JSON 使用的字段名）。

| 名称              | ID                         | 介绍                                                                             |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------- |
| 模型 ID           | `id`                       | 模型标识（可使用 `#xxx` 后缀创建同一模型的多份配置；发送请求时会自动移除后缀）。 |
| 显示名称          | `name`                     | UI 展示用名称（未填写时通常显示 `id`）。                                         |
| 模型家族          | `family`                   | 便于分组/匹配的一类模型标识（如 `gpt-4`、`claude-3`）。                          |
| 最大输入 Tokens   | `maxInputTokens`           | 最大输入/上下文 tokens（部分供应商语义为“输入+输出”总上下文）。                  |
| 最大输出 Tokens   | `maxOutputTokens`          | 最大生成 tokens（部分供应商要求必填，如 Anthropic 的 `max_tokens`）。            |
| 模型能力          | `capabilities`             | 能力声明（用于 UI 与路由逻辑判断，部分场景也会影响请求构造）。                   |
| 工具调用能力      | `capabilities.toolCalling` | 是否支持工具/函数调用；若为数字则表示最多工具数量。                              |
| 图片输入能力      | `capabilities.imageInput`  | 是否支持图像输入。                                                               |
| 流式输出          | `stream`                   | 是否启用流式响应（未设置则使用默认行为）。                                       |
| Temperature       | `temperature`              | 采样温度（随机性）。                                                             |
| Top-K             | `topK`                     | Top-k 采样。                                                                     |
| Top-P             | `topP`                     | Top-p（nucleus）采样。                                                           |
| Frequency Penalty | `frequencyPenalty`         | 频率惩罚。                                                                       |
| Presence Penalty  | `presencePenalty`          | 存在惩罚。                                                                       |
| 并行工具调用      | `parallelToolCalling`      | 是否允许并行工具调用（`true` 开启、`false` 禁用、`undefined` 使用默认）。        |
| 回复冗长度        | `verbosity`                | 约束回答冗长程度：`low` / `medium` / `high`（并非所有供应商支持）。              |
| 思考配置          | `thinking`                 | 思考/推理相关配置（不同供应商支持程度不同）。                                    |
| 思考模式          | `thinking.type`            | `enabled` / `disabled` / `auto`                                                  |
| 思考预算 Tokens   | `thinking.budgetTokens`    | 思考 token 预算。                                                                |
| 思考强度          | `thinking.effort`          | `none` / `minimal` / `low` / `medium` / `high` / `xhigh`                         |
| 额外 Headers      | `extraHeaders`             | 会附加到该模型请求的 HTTP Header（`Record<string, string>`）。                   |
| 额外 Body 字段    | `extraBody`                | 会附加到该模型请求 body 的额外字段（`Record<string, unknown>`）。                |

## 导入与导出

支持导入/导出内容：

- 单个供应商配置
- 单个模型配置
- 多个供应商配置（数组）
- 多个模型配置（数组）

支持导入/导出格式：

- Base64-url 编码的 JSON 配置字符串（仅会导出该格式）
- 纯 JSON 配置字符串
- 指向 Base64-url 编码或纯 JSON 配置字符串的 URL

## URI 支持

支持响应 VS Code URI 快速导入供应商配置。

例如：

```
vscode://SmallMain.vscode-unify-chat-provider/import-config?config=<input>
```

其中 `<input>` 支持格式与 [导入与导出](#导入与导出) 中导入支持的格式相同。

### 覆盖配置字段

你可以添加 `query` 查询参数来覆盖导入配置中的某些字段。

例如：

```
vscode://SmallMain.vscode-unify-chat-provider/import-config?config=<input>&apiKey=my-api-key
```

导入时将会覆盖配置中的 `apiKey` 字段再导入。

### 供应商倡议

如果你是某个模型供应商的开发者，可以通过在网站上添加类似如下的链接，方便用户一键将你的模型添加到扩展中：

```
<a href="vscode://SmallMain.vscode-unify-chat-provider/import-config?config=eyJ0eXBlIjoi...">Add to Unify Chat Provider</a>
```

## 云同步兼容

扩展配置存储在 `settings.json` 文件中，支持 VS Code 自带的设置云同步功能。

但密钥等敏感信息默认通过 VS Code 的 secrets API 存储，当前还不支持云同步。

所以当配置同步到其它设备后，可能会要求你重新输入密钥。

如果你希望同步密钥等敏感信息，可以在设置中启用 [`storeApiKeyInSettings`](vscode://settings/unifyChatProvider.storeApiKeyInSettings)，这将把密钥存储在 `settings.json` 中。

这可能会导致密钥泄露风险，你需要自行评估风险并决定是否启用该选项。

## API 格式支持表

| API                                                                                          | ID                       | 典型端点               | 备注                                      |
| :------------------------------------------------------------------------------------------- | :----------------------- | :--------------------- | :---------------------------------------- |
| [OpenAI Chat Completion API](https://platform.openai.com/docs/api-reference/chat)            | `openai-chat-completion` | `/v1/chat/completions` | 若非版本号后缀，则会自动追加 `/v1` 后缀。 |
| [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)             | `openai-responses`       | `/v1/responses`        | 若非版本号后缀，则会自动追加 `/v1` 后缀。 |
| [Anthropic Messages API](https://platform.claude.com/docs/en/api/typescript/messages/create) | `anthropic`              | `/v1/messages`         | 自动移除重复的 `/v1` 后缀。               |
| [Ollama Chat API](https://docs.ollama.com/api/chat)                                          | `ollama`                 | `/api/chat`            | 自动移除重复的 `/api` 后缀。              |

## 供应商支持表

以下列出的供应商均支持 [一键配置](#一键配置)，并且已在实现中遵循官方文档的最佳实践，能够发挥模型的最佳性能。

> 提示
>
> 即使是非支持的供应商，也可以通过 [手动配置](#手动配置) 使用。

| 供应商                                                                                          | 支持特性                                                 |
| :---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Open AI](https://openai.com/)                                                                  |
| [Google AI Studio](https://aistudio.google.com/)                                                |                                                          |
| [Anthropic](https://www.anthropic.com/)                                                         | <li>InterleavedThinking <li>FineGrainedToolStreaming     |
| [xAI](https://docs.x.ai/)                                                                       |
| [Hugging Face (Inference Providers)](https://huggingface.co/docs/inference-providers)           |
| [OpenRouter](https://openrouter.ai/)                                                            | <li>CacheControl <li>ReasoningParam <li>ReasoningDetails |
| [Alibaba Cloud Model Studio (China)](https://www.aliyun.com/product/bailian)                    | <li>ThinkingParam3 <li>ReasoningContent                  |
| [Alibaba Cloud Model Studio (International)](https://www.alibabacloud.com/help/en/model-studio) | <li>ThinkingParam3 <li>ReasoningContent                  |
| [Model Scope (API-Inference)](https://modelscope.cn/)                                           | <li>ThinkingParam3 <li>ReasoningContent                  |
| [Volcano Engine](https://www.volcengine.com/product/ark)                                        | <li>AutoThinking <li>ThinkingParam2                      |
| [Volcano Engine (Coding Plan)](https://www.volcengine.com/activity/codingplan)                  | <li>AutoThinking <li>ThinkingParam2                      |
| [Byte Plus](https://www.byteplus.com/en/product/modelark)                                       | <li>AutoThinking <li>ThinkingParam2                      |
| [Tencent Cloud (China)](https://cloud.tencent.com/product/hunyuan)                              |
| [DeepSeek](https://www.deepseek.com/)                                                           | <li>ThinkingParam <li>ReasoningContent                   |
| [Xiaomi MIMO](https://mimo.xiaomi.com/)                                                         | <li>ThinkingParam <li>ReasoningContent                   |
| [Ollama Local](https://ollama.com/)                                                             |
| [Ollama Cloud](https://ollama.com/)                                                             |
| [ZhiPu AI](https://open.bigmodel.cn/)                                                           | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [ZhiPu AI (Coding Plan)](https://open.bigmodel.cn/)                                             | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [Z.AI](https://z.ai/)                                                                           | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [Z.AI (Coding Plan)](https://z.ai/)                                                             | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [MiniMax (China)](https://www.minimaxi.com/)                                                    | <li>ReasoningDetails                                     |
| [MiniMax (International)](https://www.minimax.io/)                                              | <li>ReasoningDetails                                     |
| [Moonshot AI (China)](https://www.moonshot.cn/)                                                 | <li>ReasoningContent                                     |
| [Moonshot AI (International)](https://www.moonshot.ai/)                                         | <li>ReasoningContent                                     |
| [Moonshot AI (Coding Plan)](https://www.kimi.com/coding)                                        | <li>ReasoningContent                                     |

## 模型支持表

以下列出的模型均支持 [一键添加模型](#一键添加模型)，并且已内置推荐参数，能够发挥模型的最佳性能。

> 提示
>
> 即使是非支持的模型，也可以通过 [手动添加模型](#手动添加模型) 使用，并且自行配置参数以发挥最佳性能。

| 厂商            | 系列                | 支持的模型                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| :-------------- | :------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI**      | GPT-5 系列          | GPT-5, GPT-5.1, GPT-5.2, GPT-5.2 pro, GPT-5 mini, GPT-5 nano, GPT-5 pro, GPT-5-Codex, GPT-5.1-Codex, GPT-5.2-Codex, GPT-5.1-Codex-Max, GPT-5.1-Codex-mini, GPT-5.2 Chat, GPT-5.1 Chat, GPT-5 Chat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                 | GPT-4 系列          | GPT-4o, GPT-4o mini, GPT-4o Search Preview, GPT-4o mini Search Preview, GPT-4.1, GPT-4.1 mini, GPT-4.1 nano, GPT-4.5 Preview, GPT-4 Turbo, GPT-4 Turbo Preview, GPT-4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                 | GPT-3 系列          | GPT-3.5 Turbo, GPT-3.5 Turbo Instruct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                 | o 系列              | o1, o1 pro, o1 mini, o1 preview, o3, o3 mini, o3 pro, o4 mini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                 | oss 系列            | gpt-oss-120b, gpt-oss-20b                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                 | Deep Research 系列  | o3 Deep Research, o4 mini Deep Research                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                 | 其它模型            | babbage-002, davinci-002, Codex mini, Computer Use Preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Anthropic**   | Claude 4 系列       | Claude Sonnet 4.5, Claude Haiku 4.5, Claude Opus 4.5, Claude Sonnet 4, Claude Opus 4.1, Claude Opus 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                 | Claude 3 系列       | Claude Sonnet 3.7, Claude Sonnet 3.5, Claude Haiku 3.5, Claude Haiku 3, Claude Opus 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **xAI**         | Grok 4 系列         | Grok 4.1 Fast (Reasoning), Grok 4.1 Fast (Non-Reasoning), Grok 4, Grok 4 Fast (Reasoning), Grok 4 Fast (Non-Reasoning)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                 | Grok Code 系列      | Grok Code Fast 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                 | Grok 3 系列         | Grok 3, Grok 3 Mini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                 | Grok 2 系列         | Grok 2 Vision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **DeepSeek**    | DeepSeek V3 系列    | DeepSeek Chat, DeepSeek Reasoner, DeepSeek V3.2, DeepSeek V3.2 Exp, DeepSeek V3.2 Speciale, DeepSeek V3.1, DeepSeek V3.1 Terminus, DeepSeek V3, DeepSeek V3 (0324)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                 | DeepSeek R1 系列    | DeepSeek R1, DeepSeek R1 (0528)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                 | DeepSeek V2.5 系列  | DeepSeek V2.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                 | DeepSeek V2 系列    | DeepSeek V2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|                 | DeepSeek VL 系列    | DeepSeek VL, DeepSeek VL2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                 | DeepSeek Coder 系列 | DeepSeek Coder, DeepSeek Coder V2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                 | DeepSeek Math 系列  | DeepSeek Math V2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **ByteDance**   | Doubao 1.8 系列     | Doubao Seed 1.8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                 | Doubao 1.6 系列     | Doubao Seed 1.6, Doubao Seed 1.6 Lite, Doubao Seed 1.6 Flash, Doubao Seed 1.6 Vision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                 | Doubao 1.5 系列     | Doubao 1.5 Pro 32k, Doubao 1.5 Pro 32k Character, Doubao 1.5 Lite 32k                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                 | Doubao Code 系列    | Doubao Seed Code Preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                 | 其他模型            | Doubao Lite 32k Character                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **MiniMax**     | MiniMax M2 系列     | MiniMax-M2.1, MiniMax-M2.1-Lightning, MiniMax-M2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Moonshot AI** | Kimi K2 系列        | Kimi K2 Thinking, Kimi K2 Thinking Turbo, Kimi K2 0905 Preview, Kimi K2 Turbo Preview, Kimi For Coding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Qwen**        | Qwen 3 系列         | Qwen3-Max, Qwen3-Max Preview, Qwen3-Coder-Plus, Qwen3-Coder-Flash, Qwen3-VL-Plus, Qwen3-VL-Flash, Qwen3-VL-32B-Instruct, Qwen3 0.6B, Qwen3 1.7B, Qwen3 4B, Qwen3 8B, Qwen3 14B, Qwen3 32B, Qwen3 30B A3B, Qwen3 235B A22B, Qwen3 30B A3B Thinking 2507, Qwen3 30B A3B Instruct 2507, Qwen3 235B A22B Thinking 2507, Qwen3 235B A22B Instruct 2507, Qwen3 Coder 480B A35B Instruct, Qwen3 Coder 30B A3B Instruct, Qwen3-Omni-Flash, Qwen3-Omni-Flash-Realtime, Qwen3-Omni 30B A3B Captioner, Qwen-Omni-Turbo, Qwen-Omni-Turbo-Realtime, Qwen3-VL 235B A22B Thinking, Qwen3-VL 235B A22B Instruct, Qwen3-VL 32B Thinking, Qwen3-VL 30B A3B Thinking, Qwen3-VL 30B A3B Instruct, Qwen3-VL 8B Thinking, Qwen3-VL 8B Instruct, Qwen3 Next 80B A3B Thinking, Qwen3 Next 80B A3B Instruct, Qwen-Plus, Qwen-Flash, Qwen-Turbo, Qwen-Max, Qwen-Long, Qwen-Doc-Turbo, Qwen Deep Research |
|                 | Qwen 2.5 系列       | Qwen2.5 0.5B Instruct, Qwen2.5 1.5B Instruct, Qwen2.5 3B Instruct, Qwen2.5 7B Instruct, Qwen2.5 14B Instruct, Qwen2.5 32B Instruct, Qwen2.5 72B Instruct, Qwen2.5 7B Instruct (1M), Qwen2.5 14B Instruct (1M), Qwen2.5 Coder 0.5B Instruct, Qwen2.5 Coder 1.5B Instruct, Qwen2.5 Coder 3B Instruct, Qwen2.5 Coder 7B Instruct, Qwen2.5 Coder 14B Instruct, Qwen2.5 Coder 32B Instruct, Qwen2.5 Math 1.5B Instruct, Qwen2.5 Math 7B Instruct, Qwen2.5 Math 72B Instruct, Qwen2.5-VL 3B Instruct, Qwen2.5-VL 7B Instruct, Qwen2.5-VL 32B Instruct, Qwen2.5-Omni-7B, Qwen2 7B Instruct, Qwen2 72B Instruct, Qwen2 57B A14B Instruct, Qwen2-VL 72B Instruct                                                                                                                                                                                                                        |
|                 | Qwen 1.5 系列       | Qwen1.5 7B Chat, Qwen1.5 14B Chat, Qwen1.5 32B Chat, Qwen1.5 72B Chat, Qwen1.5 110B Chat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                 | QwQ/QvQ 系列        | QwQ-Plus, QwQ 32B, QwQ 32B Preview, QVQ-Max, QVQ-Plus, QVQ 72B Preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                 | Qwen Coder 系列     | Qwen-Coder-Plus, Qwen-Coder-Turbo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                 | 其它模型            | Qwen-Math-Plus, Qwen-Math-Turbo, Qwen-VL-OCR, Qwen-VL-Max, Qwen-VL-Plus, Qwen-Plus Character (JA)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Xiaomi MiMo** | MiMo V2 系列        | MiMo V2 Flash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **ZhiPu AI**    | GLM 4 系列          | GLM-4.7, GLM-4.6, GLM-4.5, GLM-4.5-X, GLM-4.5-Air, GLM-4.5-AirX, GLM-4-Plus, GLM-4-Air-250414, GLM-4-Long, GLM-4-AirX, GLM-4-FlashX-250414, GLM-4.5-Flash, GLM-4-Flash-250414, GLM-4.6V, GLM-4.5V, GLM-4.1V-Thinking-FlashX, GLM-4.6V-Flash, GLM-4.1V-Thinking-Flash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                 | CodeGeeX 系列       | CodeGeeX-4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Tencent HY**  | HY 2.0 系列         | HY 2.0 Think, HY 2.0 Instruct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                 | HY 1.5 系列         | HY Vision 1.5 Instruct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 应用迁移支持表

以下列出的供应商均支持 [一键迁移](#一键迁移)。

| 应用                                                  | 备注                                            |
| :---------------------------------------------------- | :---------------------------------------------- |
| [Claude Code](https://claude.com/product/claude-code) | 仅在使用自定义 Base URL 和 API Key 时支持迁移。 |
| [CodeX](https://openai.com/codex/)                    | 仅在使用自定义 Base URL 和 API Key 时支持迁移。 |
| [Gemini CLI](https://geminicli.com/)                  | 仅在使用自定义 Base URL 和 API Key 时支持迁移。 |

## 贡献

- 欢迎创建 Issue 来报告 Bug、请求新功能或适配新供应商/模型。
- 欢迎提交 Pull Request 来参与本项目的开发，你可以查看 [路线图](./ROADMAP.md)。

## 开发

- Build: `npm run compile`
- Watch: `npm run watch`
- Interactive release: `npm run release`

## 许可证

[MIT @ SmallMain](./LICENSE)
