<p align="center">
<img src="./icon.png" style="width:100px;" />
</p>

<h1 align="center">
Unify Chat Provider
</h1>

<p align="center">
Integrate multiple LLM API providers into VS Code's Github Copilot Chat using the Language Model API.
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
<a href="./README_zh-CN.md">简体中文</a>
</p>

## Features

- **[Perfect Compatibility]()**: Supports all mainstream LLM API formats (OpenAI Chat Completion, OpenAI Responses, Anthropic Messages, Ollama Chat).
- **[Best Performance]()**: Extremely focused on special optimizations and best practices for model providers, ensuring 100% model performance.
- **[Out of the Box]()**: Built-in recommended parameters for mainstream providers and models, and supports automatic synchronization of provider model lists via API, without any tedious configuration.
- **[Fast Migration](#one-click-migration)**: Comprehensive configuration import/export functions, and supports one-click migration of configurations from mainstream applications or extensions (Claude Code, CodeX, Gemini CLI...).
- **[Controllable Parameters]()**: Open adjustment of all interface parameters, and supports custom Header and Request fields.
- **[Excellent Experience]()**: Built-in visual user interface, supports unlimited provider and model configurations, and supports coexistence of multiple configurations for the same provider or model.

## Installation

- Search for [Unify Chat Provider](https://marketplace.visualstudio.com/items?itemName=SmallMain.vscode-unify-chat-provider) in the VS Code Extension Marketplace and install it.
- Download the latest `.vsix` file from [Github Releases](https://github.com/smallmain/vscode-unify-chat-provider/releases), and install it in VS Code via `Install from VSIX...` or by dragging it to the extensions panel.

## Quick Start

For different scenarios, you can use the following most suitable ways to configure:

- [One-Click Migration](#one-click-migration): Migrate from other applications or extensions.
- [One-Click Configuration](#one-click-configuration): Add built-in supported model providers.
- [Import and Export](#import-and-export): Existing backup configurations or configurations shared by others.
- [Manual Configuration](#manual-configuration): Add any provider and model completely from scratch.

Regardless of the configuration method used, you can customize any field along the way.

### Basic Operations

Most of the extension's interfaces are integrated into the VS Code Command Palette. Please understand its basic operation to complete subsequent operations:

1. Open VS Code Command Palette:
   - Open via menu `View` -> `Command Palette...`.
   - Open via shortcut `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac).
2. Search Command:
   - Enter keyword `Unify Chat Provider:` or `ucp:` in the command palette to search all commands.
3. Select Command:
   - Use mouse click or keyboard up/down arrow keys to select command, press Enter to execute selected command.

<div align="center">
  <img src="./assets/screenshot-1.png" width="500" />
</div>

### One-Click Migration

Applications or extensions supported for one-click migration:

- Claude Code
- CodeX
- Gemini CLI

> If the application or extension you are using is not in the list above, you can complete the configuration via [One-Click Configuration](#one-click-configuration) or [Manual Configuration](#manual-configuration).

#### Steps:

1. Open VS Code Command Palette, search for `Import Config From Other Applications`.

   <div align="center">
   <img src="assets/screenshot-2.png" width="500" />
   </div>

   - The interface displays all supported applications or extensions and their detected configuration file paths.
   - Perform other operations via the button group on the far right of the list item:
     1. `Custom Path`: Select a custom configuration file path to import.
     2. `Import from Config Content`: Directly input configuration content to import.

2. Select the application or extension configuration you want to import from the popup list.
3. After selection, you will enter the configuration import interface, which is similar to the [Provider Configuration]() interface. You can view or edit any field.
4. Click the `Save` button to complete the import. You can immediately use the models in Copilot Chat.

   <div align="center">
   <img src="assets/screenshot-3.png" width="500" />
   </div>

### One-Click Configuration

Model providers supported for one-click configuration:

- OpenAI
- Anthropic
- Hugging Face
- Alibaba Cloud Model Studio
- Model Scope
- Volcano Engine
- Byte Plus
- Tencent Cloud
- DeepSeek
- Xiaomi MIMO
- Ollama
- ZhiPu AI
- Z.AI
- MiniMax
- Moonshot AI

> If the application or extension you are using is not in the list above, you can add it via [Manual Configuration](#manual-configuration).

#### Steps:

1. Open VS Code Command Palette, search for `Add Provider From Well-Known Provider List`.

   <div align="center">
   <img src="assets/screenshot-4.png" width="500" />
   </div>

2. Select the provider you want to add from the popup list.
3. Enter the API Key as prompted, press Enter to enter the configuration import interface, which is similar to the [Provider Configuration]() interface. You can view or edit any field.
   - Some providers may not require an API Key, just press Enter to skip.
4. Click the `Save` button to complete the import. You can immediately use the models in Copilot Chat.

   <div align="center">
   <img src="assets/screenshot-5.png" width="500" />
   </div>

### Manual Configuration

1. Open VS Code Command Palette, search for `Add Provider`.
   <div align="center">
   <img src="assets/screenshot-6.png" width="500" />
   </div>
2. Fill in the configuration in the add configuration interface, which is similar to the [Provider Configuration]() interface. You can read the documentation of that interface to understand the function of each field.
3. Click the `Save` button to complete the addition. You can immediately use the models in Copilot Chat.

## Out of the Box Support

To be added...

## Import and Export

To be added...

## Contribution

- Build: `npm run compile`
- Watch: `npm run watch`
- Interactive release: `npm run release`

## License

[MIT @ SmallMain](./LICENSE)
