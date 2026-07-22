import * as vscode from 'vscode';
import type { ModelConfig } from '../../types';
import { getBaseModelId } from '../../model-id-utils';
import type { ZedUpstreamProvider } from './types';
import { isLanguageModelThinkingPart } from '../../proposed-api/thinking';

type NormalizedPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mediaType: string; data: string }
  | {
      kind: 'thinking';
      text: string;
      id?: string;
      signature?: string;
      redactedData?: string;
      completeThinking?: string;
      zedReasoningItem?: Record<string, unknown>;
    }
  | {
      kind: 'tool_call';
      callId: string;
      name: string;
      input: object;
      googleThoughtSignature?: string;
    }
  | { kind: 'tool_result'; callId: string; name: string; text: string };

interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant';
  parts: NormalizedPart[];
}

interface GoogleToolCallMetadata {
  callId: string;
  thoughtSignature: string;
}

const GOOGLE_TOOL_CALL_METADATA_KEY = 'zedGoogleToolCall';

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function googleToolCallMetadata(value: unknown): GoogleToolCallMetadata | undefined {
  const record = recordValue(value);
  const callId = nonEmptyString(record?.['callId']);
  const thoughtSignature = nonEmptyString(record?.['thoughtSignature']);
  return callId && thoughtSignature ? { callId, thoughtSignature } : undefined;
}

function roleName(
  role: vscode.LanguageModelChatMessageRole,
): NormalizedMessage['role'] {
  switch (role) {
    case vscode.LanguageModelChatMessageRole.System:
      return 'system';
    case vscode.LanguageModelChatMessageRole.Assistant:
      return 'assistant';
    default:
      return 'user';
  }
}

function textFromToolResult(part: vscode.LanguageModelToolResultPart): string {
  return part.content
    .map((item) => {
      if (item instanceof vscode.LanguageModelTextPart) return item.value;
      if (item instanceof vscode.LanguageModelDataPart) {
        return new TextDecoder().decode(item.data);
      }
      return '';
    })
    .join('');
}

function normalizeMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): NormalizedMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((message) => {
    const role = roleName(message.role);
    const parts: NormalizedPart[] = [];
    const googleToolSignatures = new Map<string, string>();
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value) parts.push({ kind: 'text', text: part.value });
      } else if (isLanguageModelThinkingPart(part)) {
        if (role !== 'assistant') {
          throw new Error('Zed thinking content must belong to an assistant message.');
        }
        const text = Array.isArray(part.value)
          ? part.value.join('')
          : part.value;
        const rawMetadata: unknown = part.metadata;
        const metadata = recordValue(rawMetadata);
        const googleToolCall = googleToolCallMetadata(
          metadata?.[GOOGLE_TOOL_CALL_METADATA_KEY],
        );
        if (googleToolCall) {
          googleToolSignatures.set(
            googleToolCall.callId,
            googleToolCall.thoughtSignature,
          );
          continue;
        }
        const reasoningItem = recordValue(metadata?.['zedReasoningItem']);
        if (text || metadata || part.id) {
          parts.push({
            kind: 'thinking',
            text,
            ...(part.id ? { id: part.id } : {}),
            ...(nonEmptyString(metadata?.['signature'])
              ? { signature: nonEmptyString(metadata?.['signature']) }
              : {}),
            ...(nonEmptyString(metadata?.['redactedData'])
              ? { redactedData: nonEmptyString(metadata?.['redactedData']) }
              : {}),
            ...(nonEmptyString(metadata?.['_completeThinking'])
              ? {
                  completeThinking: nonEmptyString(
                    metadata?.['_completeThinking'],
                  ),
                }
              : {}),
            ...(reasoningItem ? { zedReasoningItem: reasoningItem } : {}),
          });
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        if (role !== 'assistant') {
          throw new Error('Zed tool calls must belong to an assistant message.');
        }
        parts.push({
          kind: 'tool_call',
          callId: part.callId,
          name: part.name,
          input: part.input,
          ...(googleToolSignatures.has(part.callId)
            ? {
                googleThoughtSignature: googleToolSignatures.get(part.callId),
              }
            : {}),
        });
        toolNames.set(part.callId, part.name);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (role !== 'user') {
          throw new Error('Zed tool results must belong to a user message.');
        }
        parts.push({
          kind: 'tool_result',
          callId: part.callId,
          name: toolNames.get(part.callId) ?? part.callId,
          text: textFromToolResult(part),
        });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (!part.mimeType.startsWith('image/')) {
          throw new Error(
            `Unsupported Zed message data type: ${part.mimeType}.`,
          );
        }
        parts.push({
          kind: 'image',
          mediaType: part.mimeType,
          data: Buffer.from(part.data).toString('base64'),
        });
      } else if (part !== undefined && part !== null) {
        throw new Error('Unsupported Zed message part.');
      }
    }
    return {
      role,
      parts: parts.map((part) =>
        part.kind === 'tool_call' && googleToolSignatures.has(part.callId)
          ? {
              ...part,
              googleThoughtSignature: googleToolSignatures.get(part.callId),
            }
          : part,
      ),
    };
  });
}

function supportsThinkingEffort(model: ModelConfig, effort: string): boolean {
  return (
    model.presetTemplates?.some((template) =>
      template.presets.some((preset) => preset.id === effort),
    ) ?? false
  );
}

function thinkingIsAllowed(model: ModelConfig): boolean {
  return (
    model.thinking !== undefined &&
    model.thinking.type !== 'disabled' &&
    model.thinking.effort !== 'none'
  );
}

function toolsForOpenAi(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

function buildAnthropicRequest(
  model: ModelConfig,
  messages: NormalizedMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): Record<string, unknown> {
  const system: string[] = [];
  const providerMessages: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      switch (part.kind) {
        case 'text':
          content.push({ type: 'text', text: part.text });
          break;
        case 'thinking':
          if (part.redactedData) {
            content.push({
              type: 'redacted_thinking',
              data: part.redactedData,
            });
          } else if (part.completeThinking && part.signature) {
            content.push({
              type: 'thinking',
              thinking: part.completeThinking,
              signature: part.signature,
            });
          }
          break;
        case 'image':
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mediaType,
              data: part.data,
            },
          });
          break;
        case 'tool_call':
          content.push({
            type: 'tool_use',
            id: part.callId,
            name: part.name,
            input: part.input,
          });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: part.callId,
            content: part.text,
          });
          break;
      }
    }
    if (message.role === 'system') {
      const text = message.parts
        .filter(
          (part): part is Extract<NormalizedPart, { kind: 'text' }> =>
            part.kind === 'text',
        )
        .map((part) => part.text)
        .join('');
      if (text) system.push(text);
    } else if (content.length) {
      const previous = providerMessages.at(-1);
      if (previous?.['role'] === message.role && Array.isArray(previous['content'])) {
        previous['content'].push(...content);
      } else {
        providerMessages.push({ role: message.role, content });
      }
    }
  }
  const effort = model.thinking?.effort;
  const thinkingEnabled =
    model.thinking !== undefined &&
    model.thinking.type !== 'disabled' &&
    effort !== 'none';
  const adaptiveEffort =
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max'
      ? effort
      : undefined;
  const toolChoice = options.tools?.length
    ? options.toolMode === vscode.LanguageModelChatToolMode.Required
      ? { type: 'any' }
      : { type: 'auto' }
    : undefined;
  return {
    model: getBaseModelId(model.id),
    max_tokens: model.maxOutputTokens ?? 4096,
    messages: providerMessages,
    temperature: 1,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(options.tools?.length
      ? {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema ?? {
              type: 'object',
              properties: {},
            },
          })),
        }
      : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(thinkingEnabled
      ? adaptiveEffort
        ? {
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: adaptiveEffort },
          }
        : { thinking: { type: 'enabled', budget_tokens: 4096 } }
      : {}),
  };
}

function buildOpenAiResponsesRequest(
  model: ModelConfig,
  messages: NormalizedMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  threadId?: string,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    let content: Array<Record<string, unknown>> = [];
    const flushContent = (): void => {
      if (!content.length) return;
      input.push({ type: 'message', role: message.role, content });
      content = [];
    };
    for (const part of message.parts) {
      if (part.kind === 'text') {
        content.push({
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: part.text,
        });
      } else if (part.kind === 'thinking') {
        flushContent();
        if (part.zedReasoningItem) {
          input.push({ ...part.zedReasoningItem, type: 'reasoning' });
        } else if (
          part.redactedData ||
          part.completeThinking ||
          part.text
        ) {
          input.push({
            type: 'reasoning',
            ...(part.id || part.signature
              ? { id: part.id ?? part.signature }
              : {}),
            summary: [],
            ...(part.redactedData
              ? { encrypted_content: part.redactedData }
              : {
                  content: [
                    {
                      type: 'reasoning_text',
                      text: part.completeThinking ?? part.text,
                    },
                  ],
                }),
          });
        }
        continue;
      } else if (part.kind === 'image') {
        content.push({
          type: 'input_image',
          image_url: `data:${part.mediaType};base64,${part.data}`,
        });
      } else if (part.kind === 'tool_call') {
        flushContent();
        input.push({
          type: 'function_call',
          call_id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.input),
        });
      } else {
        flushContent();
        input.push({
          type: 'function_call_output',
          call_id: part.callId,
          output: part.text,
        });
      }
    }
    flushContent();
  }
  const configuredEffort = model.thinking?.effort;
  const reasoning = thinkingIsAllowed(model)
    ? configuredEffort && configuredEffort !== 'none'
      ? { effort: configuredEffort, summary: 'auto' }
      : undefined
    : supportsThinkingEffort(model, 'none')
      ? { effort: 'none' }
      : undefined;
  const includeEncryptedReasoning =
    (reasoning !== undefined && reasoning.effort !== 'none') ||
    input.some((item) => item['type'] === 'reasoning');
  return {
    model: getBaseModelId(model.id),
    input,
    store: false,
    ...(includeEncryptedReasoning
      ? { include: ['reasoning.encrypted_content'] }
      : {}),
    stream: true,
    tools: toolsForOpenAi(options.tools),
    ...(options.tools?.length && model.parallelToolCalling !== undefined
      ? { parallel_tool_calls: model.parallelToolCalling }
      : {}),
    ...(options.tools?.length
      ? {
          tool_choice:
            options.toolMode === vscode.LanguageModelChatToolMode.Required
              ? 'required'
              : 'auto',
        }
      : {}),
    ...(threadId ? { prompt_cache_key: threadId } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function buildXaiRequest(
  model: ModelConfig,
  messages: NormalizedMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): Record<string, unknown> {
  const providerMessages: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const textParts = message.parts
      .filter(
        (part): part is Extract<NormalizedPart, { kind: 'text' | 'thinking' }> =>
          part.kind === 'text' || part.kind === 'thinking',
      )
      .map((part) => ({ type: 'text', text: part.text }));
    const imageParts = message.parts
      .filter(
        (part): part is Extract<NormalizedPart, { kind: 'image' }> =>
          part.kind === 'image',
      )
      .map((part) => ({
        type: 'image_url',
        image_url: {
          url: `data:${part.mediaType};base64,${part.data}`,
        },
      }));
    const contentParts = [...textParts, ...imageParts];
    const toolCalls = message.parts
      .filter(
        (part): part is Extract<NormalizedPart, { kind: 'tool_call' }> =>
          part.kind === 'tool_call',
      )
      .map((part) => ({
        id: part.callId,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input) },
      }));
    const toolResults = message.parts.filter(
      (part): part is Extract<NormalizedPart, { kind: 'tool_result' }> =>
        part.kind === 'tool_result',
    );
    if (toolResults.length) {
      for (const result of toolResults) {
        providerMessages.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: result.text,
        });
      }
    } else {
      providerMessages.push({
        role: message.role,
        content:
          imageParts.length > 0
            ? contentParts
            : textParts.map((part) => part.text).join(''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  const tools = toolsForOpenAi(options.tools)?.map((tool) => ({
    type: 'function',
    function: {
      name: tool['name'],
      description: tool['description'],
      parameters: tool['parameters'],
    },
  }));
  return {
    model: getBaseModelId(model.id),
    messages: providerMessages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 1,
    ...(tools?.length ? { tools } : {}),
    ...(tools?.length && model.parallelToolCalling !== undefined
      ? { parallel_tool_calls: model.parallelToolCalling }
      : {}),
    ...(tools?.length
      ? {
          tool_choice:
            options.toolMode === vscode.LanguageModelChatToolMode.Required
              ? 'required'
              : 'auto',
        }
      : {}),
  };
}

function buildGoogleRequest(
  model: ModelConfig,
  messages: NormalizedMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): Record<string, unknown> {
  const systemParts: Array<Record<string, unknown>> = [];
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      switch (part.kind) {
        case 'text':
          parts.push({ text: part.text });
          break;
        case 'thinking':
          if (part.signature) {
            parts.push({
              text: part.completeThinking ?? part.text,
              thought: true,
              thoughtSignature: part.signature,
            });
          }
          break;
        case 'image':
          parts.push({
            inlineData: { mimeType: part.mediaType, data: part.data },
          });
          break;
        case 'tool_call':
          parts.push({
            functionCall: {
              id: part.callId,
              name: part.name,
              args: part.input,
            },
            ...(part.googleThoughtSignature
              ? { thoughtSignature: part.googleThoughtSignature }
              : {}),
          });
          break;
        case 'tool_result':
          parts.push({
            functionResponse: {
              id: part.callId,
              name: part.name,
              response: { output: part.text },
            },
          });
          break;
      }
    }
    if (message.role === 'system') {
      systemParts.push(...parts);
    } else if (parts.length) {
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
  }
  const baseModelId = getBaseModelId(model.id);
  const thinkingConfig = googleThinkingConfig(baseModelId, model);
  return {
    model: `models/${baseModelId}`,
    contents,
    ...(systemParts.length
      ? { systemInstruction: { parts: systemParts } }
      : {}),
    generationConfig: {
      candidateCount: 1,
      stopSequences: [],
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
    ...(options.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: options.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema ?? {
                  type: 'object',
                  properties: {},
                },
              })),
            },
          ],
          toolConfig: {
            functionCallingConfig: {
              mode:
                options.toolMode === vscode.LanguageModelChatToolMode.Required
                  ? 'any'
                  : 'auto',
            },
          },
        }
      : {}),
  };
}

function googleThinkingConfig(
  modelId: string,
  model: ModelConfig,
): Record<string, unknown> | undefined {
  const supportsThinking =
    modelId.startsWith('gemini-2.5-') || modelId.startsWith('gemini-3');
  if (!supportsThinking) return undefined;

  if (thinkingIsAllowed(model)) {
    const effort = model.thinking?.effort?.toLowerCase();
    const thinkingLevel =
      effort === 'minimal' ||
      effort === 'low' ||
      effort === 'medium' ||
      effort === 'high'
        ? effort.toUpperCase()
        : undefined;
    return {
      includeThoughts: true,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  if (modelId.startsWith('gemini-3')) {
    return {
      thinkingLevel:
        modelId.includes('-pro') ? 'LOW' : 'MINIMAL',
    };
  }
  if (
    new Set([
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-preview-latest',
      'gemini-2.5-flash-preview-04-17',
      'gemini-2.5-flash-preview-05-20',
      'gemini-2.5-flash-lite-preview-06-17',
    ]).has(modelId)
  ) {
    return { thinkingBudget: 0 };
  }
  return undefined;
}

export function buildZedProviderRequest(
  provider: ZedUpstreamProvider,
  model: ModelConfig,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  requestIds?: { threadId?: string },
): Record<string, unknown> {
  const normalized = normalizeMessages(messages);
  switch (provider) {
    case 'anthropic':
      return buildAnthropicRequest(model, normalized, options);
    case 'open_ai':
      return buildOpenAiResponsesRequest(
        model,
        normalized,
        options,
        requestIds?.threadId,
      );
    case 'x_ai':
      return buildXaiRequest(model, normalized, options);
    case 'google':
      return buildGoogleRequest(model, normalized, options);
  }
}
