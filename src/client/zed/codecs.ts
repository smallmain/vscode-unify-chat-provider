import type { ModelConfig, ThinkingEffort } from '../../types';
import { t } from '../../i18n';
import type {
  ZedAuthenticatedUser,
  ZedChatChunk,
  ZedCloudModel,
  ZedCompletionEnvelope,
  ZedCompletionStatus,
  ZedLongLivedCredential,
  ZedModelDiscoveryResult,
  ZedModelRoute,
  ZedOrganization,
  ZedPredictEditsV3Response,
  ZedPredictEditsV4Response,
  ZedSupportedEffortLevel,
  ZedUpstreamProvider,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid Zed ${description}: expected an object.`);
  }
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  description: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid Zed ${description}: missing ${key}.`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredStringValue(
  record: Record<string, unknown>,
  key: string,
  description: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Invalid Zed ${description}: missing ${key}.`);
  }
  return value;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
  description: string,
): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid Zed ${description}: missing ${key}.`);
  }
  return value;
}

function booleanOrDefault(
  record: Record<string, unknown>,
  key: string,
  defaultValue = false,
): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : defaultValue;
}

function requiredNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  description: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid Zed ${description}: invalid ${key}.`);
  }
  return value as number;
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

export function serializeZedCredential(
  credential: ZedLongLivedCredential,
): string {
  return JSON.stringify(credential);
}

export function parseZedCredential(value: string): ZedLongLivedCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error('Invalid Zed credential. Please sign in again.');
  }
  const record = requiredRecord(raw, 'credential');
  const userId = requiredString(record, 'userId', 'credential');
  const accessToken = requiredString(record, 'accessToken', 'credential');
  return { userId, accessToken };
}

export function parseZedUpstreamProvider(
  value: unknown,
): ZedUpstreamProvider | undefined {
  switch (value) {
    case 'anthropic':
    case 'open_ai':
    case 'google':
    case 'x_ai':
      return value;
    default:
      return undefined;
  }
}

function parseOrganizationConfiguration(
  value: unknown,
): { isEnabled: boolean; isFeedbackEnabled: boolean } {
  if (!isRecord(value)) {
    return { isEnabled: true, isFeedbackEnabled: false };
  }
  const editPrediction = value['edit_prediction'];
  if (!isRecord(editPrediction)) {
    return { isEnabled: true, isFeedbackEnabled: false };
  }
  return {
    isEnabled: booleanOrDefault(editPrediction, 'is_enabled', true),
    isFeedbackEnabled: booleanOrDefault(
      editPrediction,
      'is_feedback_enabled',
      false,
    ),
  };
}

export function parseZedAuthenticatedUser(raw: unknown): ZedAuthenticatedUser {
  const root = requiredRecord(raw, 'authenticated user response');
  const user = requiredRecord(root['user'], 'authenticated user');
  const organizationsValue = root['organizations'];
  if (!Array.isArray(organizationsValue)) {
    throw new Error(
      'Invalid Zed authenticated user response: missing organizations.',
    );
  }
  const configurationByOrganization = isRecord(
    root['configuration_by_organization'],
  )
    ? root['configuration_by_organization']
    : {};

  const organizations: ZedOrganization[] = organizationsValue.map((value) => {
    const organization = requiredRecord(value, 'organization');
    const id = requiredString(organization, 'id', 'organization');
    return {
      id,
      name: requiredString(organization, 'name', 'organization'),
      isPersonal: requiredBoolean(
        organization,
        'is_personal',
        'organization',
      ),
      editPrediction: parseOrganizationConfiguration(
        configurationByOrganization[id],
      ),
    };
  });

  return {
    id: requiredString(user, 'id_v2', 'authenticated user'),
    username: requiredString(user, 'username', 'authenticated user'),
    name: optionalString(user, 'name'),
    email: optionalString(user, 'email'),
    organizations,
    defaultOrganizationId: optionalString(root, 'default_organization_id'),
  };
}

function parseEffortLevel(value: unknown): ZedSupportedEffortLevel {
  const record = requiredRecord(value, 'model effort level');
  return {
    name: requiredString(record, 'name', 'model effort level'),
    value: requiredString(record, 'value', 'model effort level'),
    isDefault: booleanOrDefault(record, 'is_default'),
  };
}

function parseCloudModel(
  value: unknown,
  onUnknownProvider?: (modelId: string, provider: unknown) => void,
): ZedCloudModel | undefined {
  const record = requiredRecord(value, 'model');
  const id = requiredString(record, 'id', 'model');
  const provider = parseZedUpstreamProvider(record['provider']);
  if (!provider) {
    onUnknownProvider?.(id, record['provider']);
    return undefined;
  }
  const efforts = record['supported_effort_levels'];
  if (!Array.isArray(efforts)) {
    throw new Error(
      `Invalid Zed model ${id}: missing supported_effort_levels.`,
    );
  }
  return {
    provider,
    id,
    displayName: requiredString(record, 'display_name', 'model'),
    isLatest: booleanOrDefault(record, 'is_latest'),
    maxTokenCount: requiredNonNegativeInteger(
      record,
      'max_token_count',
      `model ${id}`,
    ),
    maxTokenCountInMaxMode: optionalNonNegativeInteger(
      record,
      'max_token_count_in_max_mode',
    ),
    maxOutputTokens: requiredNonNegativeInteger(
      record,
      'max_output_tokens',
      `model ${id}`,
    ),
    supportsTools: requiredBoolean(record, 'supports_tools', `model ${id}`),
    supportsImages: requiredBoolean(
      record,
      'supports_images',
      `model ${id}`,
    ),
    supportsThinking: requiredBoolean(
      record,
      'supports_thinking',
      `model ${id}`,
    ),
    supportsDisablingThinking: booleanOrDefault(
      record,
      'supports_disabling_thinking',
    ),
    supportsFastMode: booleanOrDefault(record, 'supports_fast_mode'),
    supportsServerSideCompaction: booleanOrDefault(
      record,
      'supports_server_side_compaction',
    ),
    supportedEffortLevels: efforts.map(parseEffortLevel),
    supportsStreamingTools: booleanOrDefault(
      record,
      'supports_streaming_tools',
    ),
    supportsParallelToolCalls: booleanOrDefault(
      record,
      'supports_parallel_tool_calls',
    ),
    isDisabled: booleanOrDefault(record, 'is_disabled'),
    disabledReason: optionalString(record, 'disabled_reason'),
  };
}

const THINKING_EFFORTS: ReadonlySet<string> = new Set([
  'max',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function asThinkingEffort(value: string): ThinkingEffort | undefined {
  return THINKING_EFFORTS.has(value) ? (value as ThinkingEffort) : undefined;
}

export function zedCloudModelToModelConfig(model: ZedCloudModel): ModelConfig {
  const supportedEfforts = model.supportedEffortLevels.flatMap((level) => {
    const effort = asThinkingEffort(level.value.toLowerCase());
    return effort ? [{ level, effort }] : [];
  });
  const defaultEffort =
    supportedEfforts.find(({ level }) => level.isDefault)?.effort ??
    supportedEfforts[0]?.effort;
  return {
    id: model.id,
    name: model.displayName,
    family: model.id,
    maxInputTokens: model.maxTokenCount,
    maxOutputTokens: model.maxOutputTokens,
    stream: true,
    capabilities: {
      toolCalling: model.supportsTools,
      imageInput: model.supportsImages,
    },
    ...(model.supportsThinking
      ? {
          thinking: {
            type: model.supportsDisablingThinking ? 'auto' : 'enabled',
            ...(defaultEffort ? { effort: defaultEffort } : {}),
          },
        }
      : {}),
    parallelToolCalling: model.supportsParallelToolCalls,
    ...(supportedEfforts.length
      ? {
          presetTemplates: [
            {
              id: 'reasoningEffort',
              name: t('Reasoning Effort'),
              default: defaultEffort ?? supportedEfforts[0].effort,
              presets: supportedEfforts.map(({ level, effort }) => ({
                id: effort,
                name: level.name,
                config: {
                  thinking:
                    effort === 'none'
                      ? { type: 'disabled' as const }
                      : {
                          type: model.supportsDisablingThinking
                            ? ('auto' as const)
                            : ('enabled' as const),
                          effort,
                        },
                },
              })),
            },
          ],
        }
      : {}),
  };
}

export function parseZedModelDiscovery(
  raw: unknown,
  organizationId: string,
  onUnknownProvider?: (modelId: string, provider: unknown) => void,
): ZedModelDiscoveryResult {
  const root = requiredRecord(raw, 'model list');
  if (!Array.isArray(root['models'])) {
    throw new Error('Invalid Zed model list: missing models.');
  }
  const cloudModels = root['models']
    .map((value) => parseCloudModel(value, onUnknownProvider))
    .filter((model): model is ZedCloudModel => model !== undefined);
  const routes: ZedModelRoute[] = cloudModels.map((model) => ({
    organizationId,
    modelId: model.id,
    upstreamProvider: model.provider,
  }));
  return {
    organizationId,
    models: cloudModels.map(zedCloudModelToModelConfig),
    routes,
  };
}

function parseEditableRange(value: unknown): { start: number; end: number } {
  const range = requiredRecord(value, 'editable range');
  const start = requiredNonNegativeInteger(range, 'start', 'editable range');
  const end = requiredNonNegativeInteger(range, 'end', 'editable range');
  if (end < start) {
    throw new Error('Invalid Zed editable range: end is before start.');
  }
  return { start, end };
}

export function parseZedPredictEditsV3Response(
  raw: unknown,
): ZedPredictEditsV3Response {
  const record = requiredRecord(raw, 'predict edits v3 response');
  return {
    requestId: requiredString(record, 'request_id', 'predict edits v3 response'),
    output: requiredStringValue(record, 'output', 'predict edits v3 response'),
    editableRange: parseEditableRange(record['editable_range']),
    modelVersion: optionalString(record, 'model_version'),
    cursorOffset: optionalNonNegativeInteger(record, 'cursor_offset'),
  };
}

export function parseZedPredictEditsV4Response(
  raw: unknown,
): ZedPredictEditsV4Response {
  const record = requiredRecord(raw, 'predict edits v4 response');
  return {
    requestId: requiredString(record, 'request_id', 'predict edits v4 response'),
    patch: requiredStringValue(record, 'patch', 'predict edits v4 response'),
    modelVersion: optionalString(record, 'model_version'),
  };
}

function parseCompletionStatus(value: unknown): ZedCompletionStatus {
  if (value === 'started') return { kind: 'started' };
  if (value === 'stream_ended') return { kind: 'stream_ended' };
  if (typeof value === 'string') return { kind: 'unknown' };
  const record = requiredRecord(value, 'completion status');
  if ('queued' in record) {
    const queued = requiredRecord(record['queued'], 'queued completion status');
    return {
      kind: 'queued',
      position: requiredNonNegativeInteger(
        queued,
        'position',
        'queued completion status',
      ),
    };
  }
  if ('started' in record) {
    return { kind: 'started' };
  }
  if ('stream_ended' in record) {
    return { kind: 'stream_ended' };
  }
  if ('failed' in record) {
    const failed = requiredRecord(record['failed'], 'failed completion status');
    const retryAfter = failed['retry_after'];
    return {
      kind: 'failed',
      code: requiredString(failed, 'code', 'failed completion status'),
      message: requiredString(failed, 'message', 'failed completion status'),
      requestId: requiredString(
        failed,
        'request_id',
        'failed completion status',
      ),
      ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter)
        ? { retryAfter }
        : {}),
    };
  }
  return { kind: 'unknown' };
}

export function parseZedCompletionEnvelope<T>(
  raw: unknown,
): ZedCompletionEnvelope<T> {
  const record = requiredRecord(raw, 'completion event');
  if ('status' in record) {
    return { kind: 'status', status: parseCompletionStatus(record['status']) };
  }
  if ('event' in record) {
    return { kind: 'event', event: record['event'] as T };
  }
  throw new Error('Invalid Zed completion event envelope.');
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseJsonObject(value: string, description: string): object {
  if (!value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object'
      ? parsed
      : { value: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Zed ${description} JSON: ${message}`);
  }
}

interface PendingToolCall {
  callId: string;
  name: string;
  arguments: string;
}

interface PendingThinking {
  text: string;
  signature?: string;
}

function eventIndex(record: Record<string, unknown>, key: string): number {
  return requiredNonNegativeInteger(record, key, 'upstream completion event');
}

export class ZedChatEventDecoder {
  private readonly anthropicTools = new Map<number, PendingToolCall>();
  private readonly anthropicThinking = new Map<number, PendingThinking>();
  private readonly xaiTools = new Map<number, PendingToolCall>();
  private googleThinkingText = '';
  private googleThinkingSignature?: string;
  private googleThinkingMetadataEmitted = false;

  constructor(private readonly provider: ZedUpstreamProvider) {}

  decode(event: unknown): ZedChatChunk[] {
    switch (this.provider) {
      case 'anthropic':
        return this.decodeAnthropic(event);
      case 'open_ai':
        return this.decodeOpenAi(event);
      case 'x_ai':
        return this.decodeXai(event);
      case 'google':
        return this.decodeGoogle(event);
    }
  }

  finish(): ZedChatChunk[] {
    if (
      this.provider !== 'google' ||
      !this.googleThinkingSignature ||
      this.googleThinkingMetadataEmitted
    ) {
      return [];
    }
    this.googleThinkingMetadataEmitted = true;
    return [
      {
        kind: 'thinking',
        text: '',
        metadata: {
          signature: this.googleThinkingSignature,
          _completeThinking: this.googleThinkingText,
        },
      },
    ];
  }

  private decodeAnthropic(event: unknown): ZedChatChunk[] {
    const record = requiredRecord(event, 'upstream completion event');
    const eventType = stringAt(record, 'type');
    if (eventType === 'error') {
      const error = isRecord(record['error']) ? record['error'] : undefined;
      throw new Error(
        `Zed Anthropic error: ${
          (error && stringAt(error, 'message')) ?? 'unknown upstream error'
        }`,
      );
    }
    const delta = isRecord(record['delta']) ? record['delta'] : undefined;
    const contentBlock = isRecord(record['content_block'])
      ? record['content_block']
      : undefined;
    if (
      eventType === 'content_block_start' &&
      contentBlock?.['type'] === 'tool_use'
    ) {
      const callId = stringAt(contentBlock, 'id');
      const name = stringAt(contentBlock, 'name');
      if (callId && name) {
        this.anthropicTools.set(eventIndex(record, 'index'), {
          callId,
          name,
          arguments: '',
        });
      }
      return [];
    }
    if (
      eventType === 'content_block_start' &&
      contentBlock?.['type'] === 'text'
    ) {
      const initialText = stringAt(contentBlock, 'text');
      return initialText ? [{ kind: 'text', text: initialText }] : [];
    }
    if (
      eventType === 'content_block_start' &&
      contentBlock?.['type'] === 'thinking'
    ) {
      const initialThinking = stringAt(contentBlock, 'thinking');
      this.anthropicThinking.set(eventIndex(record, 'index'), {
        text: initialThinking ?? '',
      });
      return initialThinking
        ? [{ kind: 'thinking', text: initialThinking }]
        : [];
    }
    if (
      eventType === 'content_block_start' &&
      contentBlock?.['type'] === 'redacted_thinking'
    ) {
      const redactedData = stringAt(contentBlock, 'data');
      return redactedData
        ? [
            {
              kind: 'thinking',
              text: 'Encrypted thinking...',
              metadata: { redactedData },
            },
          ]
        : [];
    }
    if (eventType === 'content_block_delta' && delta?.['type'] === 'text_delta') {
      const text = stringAt(delta, 'text');
      return text ? [{ kind: 'text', text }] : [];
    }
    if (
      eventType === 'content_block_delta' &&
      delta?.['type'] === 'thinking_delta'
    ) {
      const thinking = stringAt(delta, 'thinking');
      if (!thinking) return [];
      const index = eventIndex(record, 'index');
      const pending = this.anthropicThinking.get(index) ?? { text: '' };
      pending.text += thinking;
      this.anthropicThinking.set(index, pending);
      return [{ kind: 'thinking', text: thinking }];
    }
    if (
      eventType === 'content_block_delta' &&
      delta?.['type'] === 'signature_delta'
    ) {
      const signature = stringAt(delta, 'signature');
      if (!signature) return [];
      const index = eventIndex(record, 'index');
      const pending = this.anthropicThinking.get(index) ?? { text: '' };
      pending.signature = `${pending.signature ?? ''}${signature}`;
      this.anthropicThinking.set(index, pending);
      return [];
    }
    if (
      eventType === 'content_block_delta' &&
      delta?.['type'] === 'input_json_delta'
    ) {
      const pending = this.anthropicTools.get(eventIndex(record, 'index'));
      const partialJson = stringAt(delta, 'partial_json');
      if (pending && partialJson) pending.arguments += partialJson;
      return [];
    }
    if (eventType === 'content_block_stop') {
      const index = eventIndex(record, 'index');
      const pendingTool = this.anthropicTools.get(index);
      if (pendingTool) {
        this.anthropicTools.delete(index);
        return [
          {
            kind: 'tool_call',
            callId: pendingTool.callId,
            name: pendingTool.name,
            input: parseJsonObject(
              pendingTool.arguments,
              `Anthropic tool ${pendingTool.name} arguments`,
            ),
          },
        ];
      }
      const pendingThinking = this.anthropicThinking.get(index);
      if (pendingThinking) {
        this.anthropicThinking.delete(index);
        return pendingThinking.signature
          ? [
              {
                kind: 'thinking',
                text: '',
                metadata: {
                  signature: pendingThinking.signature,
                  _completeThinking: pendingThinking.text,
                },
              },
            ]
          : [];
      }
    }
    return [];
  }

  private decodeOpenAi(event: unknown): ZedChatChunk[] {
    const record = requiredRecord(event, 'upstream completion event');
    const type = stringAt(record, 'type');
    if (type === 'response.output_text.delta') {
      const delta = stringAt(record, 'delta');
      return delta ? [{ kind: 'text', text: delta }] : [];
    }
    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning.delta'
    ) {
      const delta = stringAt(record, 'delta');
      return delta ? [{ kind: 'thinking', text: delta }] : [];
    }
    if (type === 'response.reasoning_summary_part.added') {
      const summaryIndex = record['summary_index'];
      return typeof summaryIndex === 'number' && summaryIndex > 0
        ? [{ kind: 'thinking', text: '\n\n' }]
        : [];
    }
    if (
      type === 'response.failed' ||
      type === 'response.error' ||
      type === 'error'
    ) {
      const response = isRecord(record['response'])
        ? record['response']
        : undefined;
      const nestedError = isRecord(record['error'])
        ? record['error']
        : response && isRecord(response['error'])
          ? response['error']
          : undefined;
      const code =
        (nestedError && stringAt(nestedError, 'code')) ??
        stringAt(record, 'code');
      const message =
        (nestedError && stringAt(nestedError, 'message')) ??
        stringAt(record, 'message') ??
        (response && stringAt(response, 'status')) ??
        type;
      throw new Error(
        `Zed OpenAI response error: ${code ? `${code}: ` : ''}${message}`,
      );
    }
    if (type === 'response.output_item.done' && isRecord(record['item'])) {
      const item = record['item'];
      if (item['type'] === 'reasoning') {
        const id = stringAt(item, 'id');
        return [
          {
            kind: 'thinking',
            text: '',
            ...(id ? { id } : {}),
            metadata: { zedReasoningItem: item },
          },
        ];
      }
      if (item['type'] === 'function_call') {
        const callId = stringAt(item, 'call_id') ?? stringAt(item, 'id');
        const name = stringAt(item, 'name');
        if (callId && name) {
          return [
            {
              kind: 'tool_call',
              callId,
              name,
              input: parseJsonObject(
                stringAt(item, 'arguments') ?? '{}',
                `OpenAI tool ${name} arguments`,
              ),
            },
          ];
        }
      }
    }
    return [];
  }

  private decodeXai(event: unknown): ZedChatChunk[] {
    const record = requiredRecord(event, 'upstream completion event');
    const choices = record['choices'];
    if (!Array.isArray(choices)) return [];
    const chunks: ZedChatChunk[] = [];
    for (const choiceValue of choices) {
      if (!isRecord(choiceValue) || !isRecord(choiceValue['delta'])) continue;
      const delta = choiceValue['delta'];
      const content = stringAt(delta, 'content');
      if (content) chunks.push({ kind: 'text', text: content });
      const reasoning = stringAt(delta, 'reasoning_content');
      if (reasoning) chunks.push({ kind: 'thinking', text: reasoning });
      const toolCalls = delta['tool_calls'];
      if (Array.isArray(toolCalls)) {
        for (const value of toolCalls) {
          if (!isRecord(value)) continue;
          const index = eventIndex(value, 'index');
          const pending = this.xaiTools.get(index) ?? {
            callId: '',
            name: '',
            arguments: '',
          };
          const callId = stringAt(value, 'id');
          if (callId) pending.callId = callId;
          const fn = isRecord(value['function']) ? value['function'] : undefined;
          const name = fn ? stringAt(fn, 'name') : undefined;
          if (name) pending.name = name;
          const args = fn ? stringAt(fn, 'arguments') : undefined;
          if (args) pending.arguments += args;
          this.xaiTools.set(index, pending);
        }
      }
      if (choiceValue['finish_reason'] === 'tool_calls') {
        const complete = [...this.xaiTools.entries()].sort(
          ([left], [right]) => left - right,
        );
        this.xaiTools.clear();
        for (const [, pending] of complete) {
          if (!pending.callId || !pending.name) {
            throw new Error('Invalid Zed xAI tool call: missing id or name.');
          }
          chunks.push({
            kind: 'tool_call',
            callId: pending.callId,
            name: pending.name,
            input: parseJsonObject(
              pending.arguments,
              `xAI tool ${pending.name} arguments`,
            ),
          });
        }
      }
    }
    return chunks;
  }

  private decodeGoogle(event: unknown): ZedChatChunk[] {
    const record = requiredRecord(event, 'upstream completion event');
    const candidates = record['candidates'];
    if (!Array.isArray(candidates)) return [];
    const chunks: ZedChatChunk[] = [];
    for (const candidate of candidates) {
      if (!isRecord(candidate) || !isRecord(candidate['content'])) continue;
      const parts = candidate['content']['parts'];
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!isRecord(part)) continue;
        const text = stringAt(part, 'text');
        if (text) {
          if (part['thought'] === true) {
            this.googleThinkingText += text;
            chunks.push({ kind: 'thinking', text });
          } else {
            chunks.push({ kind: 'text', text });
          }
        }
        const signature = stringAt(part, 'thoughtSignature');
        if (isRecord(part['functionCall'])) {
          const call = part['functionCall'];
          const name = stringAt(call, 'name');
          if (name) {
            const callId = stringAt(call, 'id') ?? `${name}-${chunks.length}`;
            if (signature) {
              chunks.push({
                kind: 'thinking',
                text: '',
                metadata: {
                  zedGoogleToolCall: {
                    callId,
                    thoughtSignature: signature,
                  },
                },
              });
            }
            chunks.push({
              kind: 'tool_call',
              callId,
              name,
              input: isRecord(call['args']) ? call['args'] : {},
            });
          }
        } else if (signature) {
          this.googleThinkingSignature = signature;
        }
      }
    }
    return chunks;
  }
}

export function parseJsonLine(line: string, description: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Zed ${description} JSON: ${message}`);
  }
}
