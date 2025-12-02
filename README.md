# Unify Chat Providers

A VS Code extension that allows you to integrate multiple LLM API providers into VS Code's Language Model Chat Provider API. Configure any number of API endpoints and use them seamlessly with GitHub Copilot Chat.

## Supported API Formats

| Type | Description | Example Providers |
|------|-------------|-------------------|
| `anthropic` | Anthropic Messages API format | Anthropic, AWS Bedrock, Google Vertex AI, OpenRouter, and other Anthropic-compatible APIs |

More API formats will be added in future releases.

## Features

- Register multiple LLM API endpoints as language model providers
- Support for different API formats (currently Anthropic, more coming soon)
- Multiple providers and models per provider
- Streaming responses with proper cancellation handling
- Tool calling support
- Token counting estimation
- Interactive commands to add and manage providers

## Requirements

- VS Code 1.104.0 or newer
- GitHub Copilot subscription (models are available to Copilot users)
- Network access to your configured provider endpoints

## Getting Started

1. Install dependencies and build the extension:

   ```bash
   npm install
   npm run compile
   ```

2. Press `F5` in VS Code to launch an Extension Development Host and load the extension.

## Configuration

Add providers to your workspace settings (`.vscode/settings.json`) using the `unifyChatProviders.endpoints` array:

```json
{
  "unifyChatProviders.endpoints": [
    {
      "type": "anthropic",
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com/v1/messages",
      "apiKey": "your-api-key",
      "models": [
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514"
      ],
      "defaultModel": "claude-sonnet-4-20250514"
    },
    {
      "type": "anthropic",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1/messages",
      "apiKey": "your-openrouter-key",
      "models": [
        "anthropic/claude-sonnet-4",
        "anthropic/claude-opus-4"
      ]
    }
  ]
}
```

### Model Configuration

Models can be specified as simple strings or as objects with additional configuration:

```json
{
  "unifyChatProviders.endpoints": [
    {
      "type": "anthropic",
      "name": "Custom Provider",
      "baseUrl": "https://api.example.com/v1/messages",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "model-a",
          "name": "Model A (Display Name)",
          "maxInputTokens": 200000,
          "maxOutputTokens": 8192
        },
        "model-b"
      ]
    }
  ]
}
```

### Configuration Properties

| Property | Required | Description |
|----------|----------|-------------|
| `type` | No | API format type. Currently supports `anthropic`. Defaults to `anthropic`. |
| `name` | Yes | Display name for the provider |
| `baseUrl` | Yes | API endpoint URL |
| `apiKey` | No | API key for authentication |
| `models` | Yes | List of available models (at least one required) |
| `defaultModel` | No | Default model ID for this provider |

## Commands

- **Unify Chat Providers: Add Provider** - Interactive wizard to add a new provider
- **Unify Chat Providers: Remove Provider** - Remove a configured provider
- **Unify Chat Providers: Manage Providers** - Open settings to manage providers

## Architecture

The extension implements the `LanguageModelChatProvider` interface with:

- `provideLanguageModelChatInformation()` - Returns available models from all configured providers
- `provideLanguageModelChatResponse()` - Handles chat requests with streaming support
- `provideTokenCount()` - Provides token count estimation

### Extensible Design

The extension uses a factory pattern to support multiple API formats:

```
src/
├── types.ts              # Type definitions and ApiClient interface
├── config/
│   └── store.ts          # Configuration management
├── client/
│   └── anthropic.ts      # Anthropic API client implementation
├── provider/
│   └── chatProvider.ts   # LanguageModelChatProvider with client factory
├── commands/
│   └── index.ts          # Command handlers
└── extension.ts          # Extension entry point
```

Adding support for a new API format involves:
1. Adding a new type to `ProviderType` in `types.ts`
2. Creating a new client class implementing `ApiClient` in `src/client/`
3. Updating the factory function in `chatProvider.ts`

## API Compatibility

### Anthropic Format (`type: "anthropic"`)

Compatible with APIs that follow the Anthropic Messages API format:

- **Endpoint**: POST to the configured `baseUrl`
- **Authentication**: `x-api-key` header
- **API Version**: `anthropic-version: 2023-06-01`
- **Request format**: Anthropic Messages API
- **Response format**: Server-Sent Events (SSE) streaming

This includes:
- Anthropic's official API
- AWS Bedrock (with Anthropic gateway)
- Google Vertex AI (with Anthropic gateway)
- OpenRouter
- Other Anthropic-compatible proxies and gateways

## Development

- Build: `npm run compile`
- Watch: `npm run watch`

## License

MIT
