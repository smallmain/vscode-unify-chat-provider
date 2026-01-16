<p align="center">
<img src="icon.png" width="120" />
</p>

<h1 align="center">
Unify Chat Provider
</h1>

<p align="center">
Integrate multiple LLM API providers into VS Code's GitHub Copilot Chat using the Language Model API.
</p>

<!-- <br>
<p align="center">
<a href="https://unocss.dev/">Documentation</a> |
<a href="https://unocss.dev/play/">Playground</a>
</p>
<br> -->

<br>
<p align="center">
<span>English</span> |
<a href="https://github.com/smallmain/vscode-unify-chat-provider/blob/main/README_zh-CN.md">简体中文</a>
</p>

## Features

- **[Perfect Compatibility](#api-format-support-table)**: Supports all major LLM API formats (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Ollama Chat).
- **[Deep Adaptation](#provider-support-table)**: Deeply adapts to each provider’s API capabilities and best practices.
- **[Best Performance](#model-support-table)**: Built-in recommended parameters for mainstream models to help you get the most out of them.
- **[Out of the Box](#one-click-configuration)**: One-click setup for mainstream providers, with automatic syncing of official model lists—no tedious configuration.
- **[Quick Migration](#one-click-migration)**: One-click migration from popular apps/extensions (Claude Code, CodeX, Gemini CLI...).
- **[Import and Export](#import-and-export)**: Complete import/export support; import existing configs via Base64, JSON, URL, or URI.
- **[Controllable Parameters](#adjust-parameters)**: Exposes all request parameters, plus custom headers and request body fields.
- **[Great UX](#manage-providers)**: Built-in visual UI; unlimited provider/model configs; multiple configs can coexist for the same provider or model.

## Installation

- Search for [Unify Chat Provider](https://marketplace.visualstudio.com/items?itemName=SmallMain.vscode-unify-chat-provider) in the VS Code Extension Marketplace and install it.
- Download the latest `.vsix` file from [GitHub Releases](https://github.com/smallmain/vscode-unify-chat-provider/releases), then install it in VS Code via `Install from VSIX...` or by dragging it into the Extensions view.

## Quick Start

Choose the most suitable way to start:

- [One-Click Migration](#one-click-migration): Migrate from other apps or extensions.
- [One-Click Configuration](#one-click-configuration): Add built-in supported model providers.
- [Import and Export](#import-and-export): Import from your backups or configs shared by others.
- [Manual Configuration](#manual-configuration): Add any provider and model from scratch.

> No matter which method you use, you can customize any field before or after the import is completed.

### Basic Operations

The UI is integrated into the VS Code Command Palette for a more native experience. Here’s the basic workflow:

1. Open the Command Palette:
   - From the menu: `View` -> `Command Palette...`
   - Or with the shortcut: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Search commands:
   - Type `Unify Chat Provider:` or `ucp:` to find all commands.
3. Run a command:
   - Select a command with mouse or arrow keys, then press Enter.

<div align="center">
  <img src="assets/screenshot-20.png" width="600" />
</div>

### One-Click Migration

See the [Application Migration Support Table](#application-migration-support-table) to learn which apps and extensions are supported.

> If your app/extension is not in the list, you can configure it via [One-Click Configuration](#one-click-configuration) or [Manual Configuration](#manual-configuration).

**Steps:**

1. Open the VS Code Command Palette and search for `Unify Chat Provider: Import Config From Other Applications`.

   <div align="center">
   <img src="assets/screenshot-2.png" width="600" />
   </div>

   - The UI lists all supported apps/extensions and the detected config file paths.
   - Use the button group on the far right of each item for additional actions:
     1. `Custom Path`: Import from a custom config file path.
     2. `Import From Config Content`: Paste the config content directly.

2. Choose the app/extension you want to import, then you’ll be taken to the config import screen.

   - This screen lets you review and edit the config that will be imported.
   - For details, see the [Provider Settings](#provider-settings) section.

3. Click `Save` to complete the import and start using the imported models in Copilot Chat.

   <div align="center">
   <img src="assets/screenshot-23.png" width="600" />
   </div>

### One-Click Configuration

See the [Provider Support Table](#provider-support-table) for providers supported by one-click configuration.

> If your provider is not in the list, you can add it via [Manual Configuration](#manual-configuration).

**Steps:**

1. Open the VS Code Command Palette and search for `Unify Chat Provider: Add Provider From Well-Known Provider List`.

   <div align="center">
   <img src="assets/screenshot-4.png" width="600" />
   </div>

2. Select the provider you want to add.
3. Follow the prompts to configure authentication (usually an API key), then you’ll be taken to the config import screen.

   - This screen lets you review and edit the config that will be imported.
   - For details, see the [Provider Settings](#provider-settings) section.

4. Click `Save` to complete the import and start using the models in Copilot Chat.

   <div align="center">
   <img src="assets/screenshot-22.png" width="600" />
   </div>

### Manual Configuration

This section uses DeepSeek as an example, adding the provider and two models.

> DeepSeek supports [One-Click Configuration](#one-click-configuration). This section shows the manual setup for demonstration purposes.

0. Preparation: get the API information from the provider docs, at least the following:

   - `API Format`: The API format (e.g., OpenAI Chat Completions, Anthropic Messages).
   - `API Base URL`: The base URL of the API.
   - `Authentication`: Usually an API key; obtained from the user center or console after registration.

1. Open the VS Code Command Palette and search for `Unify Chat Provider: Add Provider`.

   <div align="center">
   <img src="assets/screenshot-6.png" width="600" />
   </div>

   - This screen is similar to the [Provider Settings](#provider-settings) screen, and includes in-place documentation for each field.

2. Fill in the provider name: `Name`.

   - The name must be unique and is shown in the model list. Here we use `DeepSeek`.
   - You can create multiple configs for the same provider with different names, e.g., `DeepSeek-Person`, `DeepSeek-Team`.

3. Choose the API format: `API Format`.

   - DeepSeek uses the `OpenAI Chat Completion` format, so select that.
   - To see all supported formats, refer to the [API Format Support Table](#api-format-support-table).

4. Set the base URL: `API Base URL`.

   - DeepSeek’s base URL is `https://api.deepseek.com`.

5. Configure authentication: `Authentication`.

   - DeepSeek uses API Key for authentication, so select `API Key`.
   - Enter the API key generated from the DeepSeek console.

6. Click `Models` to go to the model management screen.

   <div align="center">
   <img src="assets/screenshot-7.png" width="600" />
   </div>

7. Enable `Auto-Fetch Official Models`.

   - This example uses auto-fetch to reduce configuration steps; see [Auto-Fetch Official Models](#auto-fetch-official-models) for details.
   - For model fields and other ways to add models, see [Manage Models](#manage-models).

8. Click `Save` to finish. You can now use the models in Copilot Chat.

   <div align="center">
   <img src="assets/screenshot-22.png" width="600" />
   </div>

## Manage Providers

- You can create unlimited provider configurations, and multiple configs can coexist for the same provider.
- Provider names must be unique.

### Provider List

Open the VS Code Command Palette and search for `Unify Chat Provider: Manage Providers`.

<div align="center">
<img src="assets/screenshot-8.png" width="600" />
</div>

- `Add Provider`: Add a new provider via [Manual Configuration](#manual-configuration).
- `Add From Well-Known Provider List`: Add a new provider via [One-Click Configuration](#one-click-configuration).
- `Import From Config`: Import an existing provider config (or an array of provider configs). See [Import and Export](#import-and-export).
- `Import From Other Applications`: Import configs from other apps/extensions via [One-Click Migration](#one-click-migration).
- `Export All Providers`: Export all provider configs. See [Import and Export](#import-and-export).

The UI also shows all existing providers. Click a provider item to enter the [Model List](#model-list) screen.

The button group on the right of each provider item provides additional actions:

- `Export`: Export this provider config. See [Import and Export](#import-and-export).
- `Duplicate`: Clone this provider config to create a new one.
- `Delete`: Delete this provider config.

### Provider Settings

<div align="center">
<img src="assets/screenshot-10.png" width="600" />
</div>

- `Models`: This button only appears while adding or importing a config; click it to enter the [Model List](#model-list) screen.

This screen shows all configuration fields for the provider. For field details, see [Provider Parameters](#provider-parameters).

## Manage Models

- Each provider can have unlimited model configurations.
- The same model ID can exist under different providers.
- Within a single provider config, you cannot have multiple identical model IDs directly, but you can create multiple configs by adding a `#xxx` suffix.
- For example, you can add both `glm4.7` and `glm4.7#thinking` to quickly switch thinking on/off.
- The `#xxx` suffix is automatically removed when sending requests.
- Model names can be duplicated, but using distinct names is recommended to avoid confusion.

### Model List

<div align="center">
<img src="assets/screenshot-9.png" width="600" />
</div>

- `Add Model`: Go to [Add Model Manually](#add-model-manually).
- `Add From Well-Known Model List`: Go to [One-Click Add Models](#one-click-add-models).
- `Add From Official Model List`: Fetch the latest official model list via API. See [One-Click Add Models](#one-click-add-models).
- `Import From Config`: Import an existing model config (or an array of model configs). See [Import and Export](#import-and-export).
- `Auto-Fetch Official Models`: Enable or disable [Auto-Fetch Official Models](#auto-fetch-official-models).
- `Provider Settings`: Go to [Provider Settings](#provider-settings).
- `Export`: Export this provider config or the model array config. See [Import and Export](#import-and-export).
- `Duplicate`: Clone this provider config to create a new one.
- `Delete`: Delete this provider config.

### Add Model Manually

This screen is similar to the [Model Settings](#model-settings) screen; you can read the in-place documentation to understand each field.

### One-Click Add Models

<div align="center">
<img src="assets/screenshot-12.png" width="600" />
</div>

This screen lists all models that can be added with one click. You can import multiple selected models at once.

See the [Model Support Table](#model-support-table) for the full list of supported models.

### Auto-Fetch Official Models

This feature periodically fetches the latest official model list from the provider’s API and automatically configures recommended parameters, greatly simplifying model setup.

> Tip
>
> A provider’s API may not return recommended parameters. In that case, recommended parameters are looked up from an internal database by model ID. See the [Model Support Table](#model-support-table) for models that have built-in recommendations.

<div align="center">
<img src="assets/screenshot-7.png" width="600" />
</div>

- Auto-fetched models show an `internet` icon before the model name.
- If an auto-fetched model ID conflicts with a manually configured one, only the manually configured model is shown.
- Auto-fetched models are refreshed periodically; you can also click `(click to fetch)` to refresh manually.
- Run the VS Code command `Unify Chat Provider: Refresh All Provider's Official Models` to trigger refresh for all providers.

### Model Settings

<div align="center">
<img src="assets/screenshot-11.png" width="600" />
</div>

- `Export`: Export this model config. See [Import and Export](#import-and-export).
- `Duplicate`: Clone this model config to create a new one.
- `Delete`: Delete this model config.

This screen shows all configuration fields for the model. For field details, see [Model Parameters](#model-parameters).

## Adjust Parameters

### Provider Parameters

The following fields correspond to `ProviderConfig` (field names used in import/export JSON).

| Name                       | ID                        | Description                                                                                          |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| API Format                 | `type`                    | Provider type (determines the API format and compatibility logic).                                   |
| Provider Name              | `name`                    | Unique name for this provider config (used for list display and references).                         |
| API Base URL               | `baseUrl`                 | API base URL, e.g. `https://api.anthropic.com`.                                                      |
| Authentication             | `auth`                    | Authentication config object (`none` / `api-key` / `oauth2`).                                        |
| Models                     | `models`                  | Array of model configurations (`ModelConfig[]`).                                                     |
| Extra Headers              | `extraHeaders`            | HTTP headers appended to every request (`Record<string, string>`).                                   |
| Extra Body Fields          | `extraBody`               | Extra fields appended to request body (`Record<string, unknown>`), for provider-specific parameters. |
| Timeout                    | `timeout`                 | Timeout settings for HTTP requests and SSE streaming (milliseconds).                                 |
| Connection Timeout         | `timeout.connection`      | Maximum time to wait for establishing a TCP connection; default `10000` (10 seconds).                |
| Response Interval Timeout  | `timeout.response`        | Maximum time to wait between SSE chunks; default `120000` (2 minutes).                               |
| Auto-Fetch Official Models | `autoFetchOfficialModels` | Whether to periodically fetch and auto-update the official model list from the provider API.         |

#### Authentication (`auth`)

`auth` is optional. Recommended configurations:

```json
{ "method": "none" }
{ "method": "api-key", "apiKey": "<your-api-key-or-secret-ref>" }
{ "method": "oauth2", "oauth": { "grantType": "authorization_code", "authorizationUrl": "...", "tokenUrl": "...", "clientId": "..." } }
```

Legacy note: `apiKey` (top-level) is deprecated but still supported for migration and will be normalized into `auth`.

### Model Parameters

The following fields correspond to `ModelConfig` (field names used in import/export JSON).

| Name                   | ID                         | Description                                                                                                                                |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Model ID               | `id`                       | Model identifier (you can use a `#xxx` suffix to create multiple configs for the same model; the suffix is removed when sending requests). |
| Display Name           | `name`                     | Name shown in the UI (usually falls back to `id` if empty).                                                                                |
| Model Family           | `family`                   | A grouping identifier for grouping/matching models (e.g., `gpt-4`, `claude-3`).                                                            |
| Max Input Tokens       | `maxInputTokens`           | Maximum input/context tokens (some providers interpret this as total context for “input + output”).                                        |
| Max Output Tokens      | `maxOutputTokens`          | Maximum generated tokens (required by some providers, e.g., Anthropic’s `max_tokens`).                                                     |
| Capabilities           | `capabilities`             | Capability declaration (for UI and routing logic; may also affect request construction).                                                   |
| Tool Calling           | `capabilities.toolCalling` | Whether tool/function calling is supported; if a number, it represents the maximum tool count.                                             |
| Image Input            | `capabilities.imageInput`  | Whether image input is supported.                                                                                                          |
| Streaming              | `stream`                   | Whether streaming responses are enabled (if unset, default behavior is used).                                                              |
| Temperature            | `temperature`              | Sampling temperature (randomness).                                                                                                         |
| Top-K                  | `topK`                     | Top-k sampling.                                                                                                                            |
| Top-P                  | `topP`                     | Top-p (nucleus) sampling.                                                                                                                  |
| Frequency Penalty      | `frequencyPenalty`         | Frequency penalty.                                                                                                                         |
| Presence Penalty       | `presencePenalty`          | Presence penalty.                                                                                                                          |
| Parallel Tool Calling  | `parallelToolCalling`      | Whether to allow parallel tool calling (`true` enable, `false` disable, `undefined` use default).                                          |
| Verbosity              | `verbosity`                | Constrain verbosity: `low` / `medium` / `high` (not supported by all providers).                                                           |
| Thinking               | `thinking`                 | Thinking/reasoning related config (support varies by provider).                                                                            |
| Thinking Mode          | `thinking.type`            | `enabled` / `disabled` / `auto`                                                                                                            |
| Thinking Budget Tokens | `thinking.budgetTokens`    | Token budget for thinking.                                                                                                                 |
| Thinking Effort        | `thinking.effort`          | `none` / `minimal` / `low` / `medium` / `high` / `xhigh`                                                                                   |
| Extra Headers          | `extraHeaders`             | HTTP headers appended to this model request (`Record<string, string>`).                                                                    |
| Extra Body Fields      | `extraBody`                | Extra fields appended to this model request body (`Record<string, unknown>`).                                                              |

## Import and Export

Supported import/export payloads:

- Single provider configuration
- Single model configuration
- Multiple provider configurations (array)
- Multiple model configurations (array)

Supported import/export formats:

- Base64-url encoded JSON config string (export uses this format only)
- Plain JSON config string
- A URL pointing to a Base64-url encoded or plain JSON config string

## URI Support

Supports importing provider configs via VS Code URI.

Example:

```
vscode://SmallMain.vscode-unify-chat-provider/import-config?config=<input>
```

`<input>` supports the same formats as in [Import and Export](#import-and-export).

### Override Config Fields

You can add query parameters to override certain fields in the imported config.

Example:

```
vscode://SmallMain.vscode-unify-chat-provider/import-config?config=<input>&auth={"method":"api-key","apiKey":"my-api-key"}
```

The import will override the `auth` field before importing.

Note: override values are parsed as JSON when possible. Legacy `apiKey` is still accepted and will be normalized into `auth`.

### Provider Advocacy

If you are a developer for an LLM provider, you can add a link like the following on your website so users can add your model to this extension with one click:

```
<a href="vscode://SmallMain.vscode-unify-chat-provider/import-config?config=eyJ0eXBlIjoi...">Add to Unify Chat Provider</a>
```

## Cloud Sync Compatibility

Extension configs are stored in `settings.json`, so they work with VS Code Settings Sync.

However, sensitive information (API keys, OAuth tokens, client secrets) is stored in VS Code Secret Storage by default, which currently does not sync.

So after syncing to another device, you may be prompted to re-enter keys or re-authorize.

If you want to sync such data, enable [`storeApiKeyInSettings`](vscode://settings/unifyChatProvider.storeApiKeyInSettings). This stores sensitive information in `settings.json`.

This can increase the risk of user data leakage, so evaluate the risk before enabling.

## API Format Support Table

| API                                                                                          | ID                       | Typical Endpoint                 | Notes                                                                                       |
| :------------------------------------------------------------------------------------------- | :----------------------- | :------------------------------- | :------------------------------------------------------------------------------------------ |
| [OpenAI Chat Completion API](https://platform.openai.com/docs/api-reference/chat)            | `openai-chat-completion` | `/v1/chat/completions`           | If the base URL doesn’t end with a version suffix, `/v1` is appended automatically.         |
| [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)             | `openai-responses`       | `/v1/responses`                  | If the base URL doesn’t end with a version suffix, `/v1` is appended automatically.         |
| [Google AI Studio (Gemini API)](https://ai.google.dev/aistudio)                              | `google-ai-studio`       | `/v1beta/models:generateContent` | Automatically detect the version number suffix.                                             |
| [Google Vertex AI](https://cloud.google.com/vertex-ai)                                       | `google-vertex-ai`       | `/v1beta/models:generateContent` | Provide different base URL based on the [Authentication](#google-vertex-ai-authentication). |
| [Anthropic Messages API](https://platform.claude.com/docs/en/api/typescript/messages/create) | `anthropic`              | `/v1/messages`                   | Automatically removes duplicated `/v1` suffix.                                              |
| [Ollama Chat API](https://docs.ollama.com/api/chat)                                          | `ollama`                 | `/api/chat`                      | Automatically removes duplicated `/api` suffix.                                             |

## Provider Support Table

The providers listed below support [One-Click Configuration](#one-click-configuration). Implementations follow the best practices from official docs to help you get the best performance.

> Tip
>
> Even if a provider is not listed, you can still use it via [Manual Configuration](#manual-configuration).

| Provider                                                                                        | Supported Features                                       |
| :---------------------------------------------------------------------------------------------- | :------------------------------------------------------- |
| [OpenAI](https://openai.com/)                                                                   |                                                          |
| [Google AI Studio](https://aistudio.google.com/)                                                |                                                          |
| [Google Vertex AI](https://cloud.google.com/vertex-ai)                                          | <li>[Authentication](#google-vertex-ai-authentication)   |
| [Anthropic](https://www.anthropic.com/)                                                         | <li>InterleavedThinking <li>FineGrainedToolStreaming     |
| [xAI](https://docs.x.ai/)                                                                       |                                                          |
| [Hugging Face (Inference Providers)](https://huggingface.co/docs/inference-providers)           |                                                          |
| [OpenRouter](https://openrouter.ai/)                                                            | <li>CacheControl <li>ReasoningParam <li>ReasoningDetails |
| [OpenCode Zen (OpenAI Chat Completions)](https://opencode.ai/)                                  | <li>ReasoningContent                                     |
| [OpenCode Zen (OpenAI Responses)](https://opencode.ai/)                                         | <li>ReasoningContent                                     |
| [OpenCode Zen (Anthropic Messages)](https://opencode.ai/)                                       | <li>InterleavedThinking <li>FineGrainedToolStreaming     |
| [OpenCode Zen (Gemini)](https://opencode.ai/)                                                   |                                                          |
| [Alibaba Cloud Model Studio (China)](https://www.aliyun.com/product/bailian)                    | <li>ThinkingParam3 <li>ReasoningContent                  |
| [Alibaba Cloud Model Studio (Coding Plan)](https://www.aliyun.com/product/bailian)              | <li>ThinkingParam3 <li>ReasoningContent                  |
| [Alibaba Cloud Model Studio (International)](https://www.alibabacloud.com/help/en/model-studio) | <li>ThinkingParam3 <li>ReasoningContent                  |
| [Model Scope (API-Inference)](https://modelscope.cn/)                                           | <li>ThinkingParam3 <li>ReasoningContent                  |
| [Volcano Engine](https://www.volcengine.com/product/ark)                                        | <li>AutoThinking <li>ThinkingParam2                      |
| [Volcano Engine (Coding Plan)](https://www.volcengine.com/activity/codingplan)                  | <li>AutoThinking <li>ThinkingParam2                      |
| [Byte Plus](https://www.byteplus.com/en/product/modelark)                                       | <li>AutoThinking <li>ThinkingParam2                      |
| [Tencent Cloud (China)](https://cloud.tencent.com/product/hunyuan)                              |                                                          |
| [DeepSeek](https://www.deepseek.com/)                                                           | <li>ThinkingParam <li>ReasoningContent                   |
| [Xiaomi MiMo](https://mimo.xiaomi.com/)                                                         | <li>ThinkingParam <li>ReasoningContent                   |
| [Ollama Local](https://ollama.com/)                                                             |                                                          |
| [Ollama Cloud](https://ollama.com/)                                                             |                                                          |
| [ZhiPu AI](https://open.bigmodel.cn/)                                                           | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [ZhiPu AI (Coding Plan)](https://open.bigmodel.cn/)                                             | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [Z.AI](https://z.ai/)                                                                           | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [Z.AI (Coding Plan)](https://z.ai/)                                                             | <li>ThinkingParam <li>ReasoningContent <li>ClearThinking |
| [MiniMax (China)](https://www.minimaxi.com/)                                                    | <li>ReasoningDetails                                     |
| [MiniMax (International)](https://www.minimax.io/)                                              | <li>ReasoningDetails                                     |
| [Moonshot AI (China)](https://www.moonshot.cn/)                                                 | <li>ReasoningContent                                     |
| [Moonshot AI (International)](https://www.moonshot.ai/)                                         | <li>ReasoningContent                                     |
| [Moonshot AI (Coding Plan)](https://www.kimi.com/coding)                                        | <li>ReasoningContent                                     |

### Google Vertex AI Authentication

Google Cloud Vertex AI has three authentication methods:

- Application Default Credentials (ADC)

  Supported — just leave `Authentication` unset (or choose `No Authentication`).

- Service Account JSON key

  Supported, but note:

  - Set `Authentication` to `API Key`, then fill the JSON key file path in the `API Key` field, e.g. `/path/to/your/keyfile.json`.
  - Based on the `project` and `location` from the platform, set `API Base URL` to:

    ```
    https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>
    ```

    For example:

    ```
    https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1
    ```

- Google Cloud API key

  Supported — just configure `Authentication` (API Key).

## Model Support Table

The models listed below support [One-Click Add Models](#one-click-add-models), and have built-in recommended parameters to help you get the best performance.

> Tip
>
> Even if a model is not listed, you can still use it via [Add Model Manually](#add-model-manually) and tune the parameters yourself.

| Vendor           | Series                | Supported Models                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| :--------------- | :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI**       | GPT-5 Series          | GPT-5, GPT-5.1, GPT-5.2, GPT-5.2 pro, GPT-5 mini, GPT-5 nano, GPT-5 pro, GPT-5-Codex, GPT-5.1-Codex, GPT-5.2-Codex, GPT-5.1-Codex-Max, GPT-5.1-Codex-mini, GPT-5.2 Chat, GPT-5.1 Chat, GPT-5 Chat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                  | GPT-4 Series          | GPT-4o, GPT-4o mini, GPT-4o Search Preview, GPT-4o mini Search Preview, GPT-4.1, GPT-4.1 mini, GPT-4.1 nano, GPT-4.5 Preview, GPT-4 Turbo, GPT-4 Turbo Preview, GPT-4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                  | GPT-3 Series          | GPT-3.5 Turbo, GPT-3.5 Turbo Instruct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                  | o Series              | o1, o1 pro, o1 mini, o1 preview, o3, o3 mini, o3 pro, o4 mini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                  | oss Series            | gpt-oss-120b, gpt-oss-20b                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                  | Deep Research Series  | o3 Deep Research, o4 mini Deep Research                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                  | Other Models          | babbage-002, davinci-002, Codex mini, Computer Use Preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Google**       | Gemini 3 Series       | gemini-3-pro-preview, gemini-3-flash-preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                  | Gemini 2.5 Series     | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                  | Gemini 2.0 Series     | gemini-2.0-flash, gemini-2.0-flash-lite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Anthropic**    | Claude 4 Series       | Claude Sonnet 4.5, Claude Haiku 4.5, Claude Opus 4.5, Claude Sonnet 4, Claude Opus 4.1, Claude Opus 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                  | Claude 3 Series       | Claude Sonnet 3.7, Claude Sonnet 3.5, Claude Haiku 3.5, Claude Haiku 3, Claude Opus 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **xAI**          | Grok 4 Series         | Grok 4.1 Fast (Reasoning), Grok 4.1 Fast (Non-Reasoning), Grok 4, Grok 4 Fast (Reasoning), Grok 4 Fast (Non-Reasoning)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                  | Grok Code Series      | Grok Code Fast 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                  | Grok 3 Series         | Grok 3, Grok 3 Mini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                  | Grok 2 Series         | Grok 2 Vision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **DeepSeek**     | DeepSeek V3 Series    | DeepSeek Chat, DeepSeek Reasoner, DeepSeek V3.2, DeepSeek V3.2 Exp, DeepSeek V3.2 Speciale, DeepSeek V3.1, DeepSeek V3.1 Terminus, DeepSeek V3, DeepSeek V3 (0324)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                  | DeepSeek R1 Series    | DeepSeek R1, DeepSeek R1 (0528)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                  | DeepSeek V2.5 Series  | DeepSeek V2.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                  | DeepSeek V2 Series    | DeepSeek V2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|                  | DeepSeek VL Series    | DeepSeek VL, DeepSeek VL2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                  | DeepSeek Coder Series | DeepSeek Coder, DeepSeek Coder V2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                  | DeepSeek Math Series  | DeepSeek Math V2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **ByteDance**    | Doubao 1.8 Series     | Doubao Seed 1.8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                  | Doubao 1.6 Series     | Doubao Seed 1.6, Doubao Seed 1.6 Lite, Doubao Seed 1.6 Flash, Doubao Seed 1.6 Vision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                  | Doubao 1.5 Series     | Doubao 1.5 Pro 32k, Doubao 1.5 Pro 32k Character, Doubao 1.5 Lite 32k                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                  | Doubao Code Series    | Doubao Seed Code Preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                  | Other Models          | Doubao Lite 32k Character                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **MiniMax**      | MiniMax M2 Series     | MiniMax-M2.1, MiniMax-M2.1-Lightning, MiniMax-M2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Moonshot AI**  | Kimi K2 Series        | Kimi K2 Thinking, Kimi K2 Thinking Turbo, Kimi K2 0905 Preview, Kimi K2 Turbo Preview, Kimi For Coding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Qwen**         | Qwen 3 Series         | Qwen3-Max, Qwen3-Max Preview, Qwen3-Coder-Plus, Qwen3-Coder-Flash, Qwen3-VL-Plus, Qwen3-VL-Flash, Qwen3-VL-32B-Instruct, Qwen3 0.6B, Qwen3 1.7B, Qwen3 4B, Qwen3 8B, Qwen3 14B, Qwen3 32B, Qwen3 30B A3B, Qwen3 235B A22B, Qwen3 30B A3B Thinking 2507, Qwen3 30B A3B Instruct 2507, Qwen3 235B A22B Thinking 2507, Qwen3 235B A22B Instruct 2507, Qwen3 Coder 480B A35B Instruct, Qwen3 Coder 30B A3B Instruct, Qwen3-Omni-Flash, Qwen3-Omni-Flash-Realtime, Qwen3-Omni 30B A3B Captioner, Qwen-Omni-Turbo, Qwen-Omni-Turbo-Realtime, Qwen3-VL 235B A22B Thinking, Qwen3-VL 235B A22B Instruct, Qwen3-VL 32B Thinking, Qwen3-VL 30B A3B Thinking, Qwen3-VL 30B A3B Instruct, Qwen3-VL 8B Thinking, Qwen3-VL 8B Instruct, Qwen3 Next 80B A3B Thinking, Qwen3 Next 80B A3B Instruct, Qwen-Plus, Qwen-Flash, Qwen-Turbo, Qwen-Max, Qwen-Long, Qwen-Doc-Turbo, Qwen Deep Research |
|                  | Qwen 2.5 Series       | Qwen2.5 0.5B Instruct, Qwen2.5 1.5B Instruct, Qwen2.5 3B Instruct, Qwen2.5 7B Instruct, Qwen2.5 14B Instruct, Qwen2.5 32B Instruct, Qwen2.5 72B Instruct, Qwen2.5 7B Instruct (1M), Qwen2.5 14B Instruct (1M), Qwen2.5 Coder 0.5B Instruct, Qwen2.5 Coder 1.5B Instruct, Qwen2.5 Coder 3B Instruct, Qwen2.5 Coder 7B Instruct, Qwen2.5 Coder 14B Instruct, Qwen2.5 Coder 32B Instruct, Qwen2.5 Math 1.5B Instruct, Qwen2.5 Math 7B Instruct, Qwen2.5 Math 72B Instruct, Qwen2.5-VL 3B Instruct, Qwen2.5-VL 7B Instruct, Qwen2.5-VL 32B Instruct, Qwen2.5-Omni-7B, Qwen2 7B Instruct, Qwen2 72B Instruct, Qwen2 57B A14B Instruct, Qwen2-VL 72B Instruct                                                                                                                                                                                                                        |
|                  | Qwen 1.5 Series       | Qwen1.5 7B Chat, Qwen1.5 14B Chat, Qwen1.5 32B Chat, Qwen1.5 72B Chat, Qwen1.5 110B Chat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                  | QwQ/QvQ Series        | QwQ-Plus, QwQ 32B, QwQ 32B Preview, QVQ-Max, QVQ-Plus, QVQ 72B Preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                  | Qwen Coder Series     | Qwen-Coder-Plus, Qwen-Coder-Turbo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                  | Other Models          | Qwen-Math-Plus, Qwen-Math-Turbo, Qwen-VL-OCR, Qwen-VL-Max, Qwen-VL-Plus, Qwen-Plus Character (JA)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Xiaomi MiMo**  | MiMo V2 Series        | MiMo V2 Flash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **ZhiPu AI**     | GLM 4 Series          | GLM-4.7, GLM-4.6, GLM-4.5, GLM-4.5-X, GLM-4.5-Air, GLM-4.5-AirX, GLM-4-Plus, GLM-4-Air-250414, GLM-4-Long, GLM-4-AirX, GLM-4-FlashX-250414, GLM-4.5-Flash, GLM-4-Flash-250414, GLM-4.6V, GLM-4.5V, GLM-4.1V-Thinking-FlashX, GLM-4.6V-Flash, GLM-4.1V-Thinking-Flash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                  | CodeGeeX Series       | CodeGeeX-4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Tencent HY**   | HY 2.0 Series         | HY 2.0 Think, HY 2.0 Instruct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                  | HY 1.5 Series         | HY Vision 1.5 Instruct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **OpenCode Zen** | Zen                   | Big Pickle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Application Migration Support Table

The applications listed below support [One-Click Migration](#one-click-migration).

| Application                                           | Notes                                                                                                                                    |
| :---------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Code](https://claude.com/product/claude-code) | Migration is supported only when using a custom Base URL and API Key.                                                                    |
| [CodeX](https://openai.com/codex/)                    | Migration is supported only when using a custom Base URL and API Key.                                                                    |
| [Gemini CLI](https://geminicli.com/)                  | Migration is supported only when using the following auth methods: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`. |

## Contributing

- Feel free to open an issue to report bugs, request features, or ask for support of new providers/models.
- Pull requests are welcome. See the [roadmap](./ROADMAP.md).

## Development

- Build: `npm run compile`
- Watch: `npm run watch`
- Interactive release: `npm run release`
- GitHub Actions release: `Actions → Release (VS Code Extension) → Run workflow`

## License

[MIT @ SmallMain](./LICENSE)
