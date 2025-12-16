# Unify Chat Provider

A VS Code extension that allows you to integrate multiple LLM API providers into VS Code's Language Model Chat Provider API. Configure any number of API endpoints and use them seamlessly with GitHub Copilot Chat.

## Supported API Formats

| Type        | Description            | Example Providers                                                                         |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `anthropic` | Anthropic Messages API | Anthropic, AWS Bedrock, Google Vertex AI, OpenRouter, and other Anthropic-compatible APIs |

More API formats will be added in future releases.

## Features

- Register multiple LLM API endpoints as language model providers
- Support for different API formats
- Multiple providers and models per provider
- Streaming responses with proper cancellation handling
- Tool calling support
- Token counting estimation
- Interactive commands to add and manage providers

## Configuration

Add providers to your workspace settings (`.vscode/settings.json`) using the `unifyChatProvider.endpoints` array:

```json
{
  "unifyChatProvider.endpoints": [
    {
      "type": "anthropic",
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "your-api-key",
      "models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514"]
    },
    {
      "type": "anthropic",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api",
      "apiKey": "your-openrouter-key",
      "models": ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4"]
    }
  ]
}
```

### Verbose Logging

By default only errors and failed requests are logged. Set `unifyChatProvider.verbose` to `true` to log full request and response details:

```json
{
  "unifyChatProvider.verbose": true
}
```

### Model Configuration

Models can be specified as simple strings or as objects with additional configuration:

```json
{
  "unifyChatProvider.endpoints": [
    {
      "type": "anthropic",
      "name": "Custom Provider",
      "baseUrl": "https://api.example.com",
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

### Provider Configuration Properties

| Property  | Required | Description                   |
| --------- | -------- | ----------------------------- |
| `type`    | Yes      | API format type               |
| `name`    | Yes      | Display name for the provider |
| `baseUrl` | Yes      | API base URL                  |
| `apiKey`  | No       | API key for authentication    |
| `models`  | No       | List of available models      |

## Commands

- **Unify Chat Provider: Add Provider** - Interactive wizard to add a new provider
- **Unify Chat Provider: Remove Provider** - Remove a configured provider
- **Unify Chat Provider: Manage Providers** - Open settings to manage providers

## API Compatibility

### Anthropic Format (`type: "anthropic"`)

Compatible with APIs that follow the Anthropic Messages API:

- **Endpoint**: POST to `<baseUrl>/v1/messages`
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

## Roadmap

- The `nativeTool` should include a configuration option within `ModelConfig`. In addition to `Default`, `Enable`, and `Disable`, add an `Auto` option that automatically selects the appropriate setting based on the model family. Also, include native tool implementations for various models to force a specific choice. Remove the related `Features`. Add the `Anthropic WebFetchTool` and ensure that citation content is handled correctly (it may not be displayed directly).
- Precise cache control to reduce the amount of network data (OpenAIConciseReasoning and Anthropic thinking).
- Support monitoring of balance usage.

## License

MIT
