import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import {
  GenerateContentResponse,
  FunctionCallingConfigMode,
} from '@google/genai';
import type {
  Content,
  ContentUnion,
  FunctionCallingConfig,
  Part,
  Tool,
} from '@google/genai';
import { GoogleAIStudioProvider } from './ai-studio-client';
import type { RequestLogger } from '../../logger';
import type { AuthTokenInfo } from '../../auth/types';
import { ChatRequestTrace, ModelConfig } from '../../types';
import {
  createStatefulMarkerIdentity,
  DEFAULT_CHAT_RETRY_CONFIG,
  describeNetworkError,
  isAbortLikeError,
  isRawBaseUrlEnabled,
  isRetryableNetworkError,
  isRetryableStatusCode,
  resolveChatNetwork,
  sanitizeMessagesForModelSwitch,
  withIdleTimeout,
  type RetryConfig,
} from '../../utils';
import {
  createCustomFetch,
  getToken,
  getTokenType,
} from '../utils';
import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_MCP_XML_INSTRUCTION,
  ANTIGRAVITY_SILENT_BOUNDARY_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_PROMPT_END,
  CLAUDE_DESCRIPTION_PROMPT,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  getRandomizedHeaders,
  type AntigravityHeaderStyle,
} from '../../auth/providers/antigravity-oauth/constants';
import { getBaseModelId } from '../../model-id-utils';
import { extractServerSuggestedRetryDelayMs } from './retry-info';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPart(value: unknown): value is Part {
  return isRecord(value) && !Array.isArray(value['parts']);
}

function toGenerateContentResponse(
  value: Record<string, unknown>,
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  Object.assign(response, value);
  return response;
}

function snakeKeyToCamelKey(key: string): string {
  return key.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

function normalizeSnakeCaseInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeSnakeCaseInPlace(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const record = value;
  const keys = Object.keys(record);

  for (const key of keys) {
    const child = record[key];
    normalizeSnakeCaseInPlace(child);

    if (!key.includes('_')) {
      continue;
    }

    const camelKey = snakeKeyToCamelKey(key);
    if (!camelKey || camelKey === key) {
      continue;
    }

    if (record[camelKey] === undefined) {
      record[camelKey] = child;
    }
    delete record[key];
  }
}

function deleteSafetySettings(payload: Record<string, unknown>): void {
  delete payload['safetySettings'];
  delete payload['safety_settings'];

  const request = payload['request'];
  if (isRecord(request)) {
    delete request['safetySettings'];
    delete request['safety_settings'];
  }
}

function extractAntigravityResponsePayload(
  value: unknown,
): Record<string, unknown> | null {
  normalizeSnakeCaseInPlace(value);

  if (!isRecord(value)) {
    return null;
  }

  const nested = value['response'];
  if (isRecord(nested)) {
    return nested;
  }

  return value;
}

const PLUGIN_SESSION_ID = `-${randomUUID()}`;

function abortSignalToError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(
    reason === undefined ? 'The operation was aborted.' : String(reason),
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    throw abortSignalToError(signal);
  }
}

function delay(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  if (abortSignal.aborted) {
    return Promise.reject(abortSignalToError(abortSignal));
  }

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      reject(abortSignalToError(abortSignal));
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

function calculateBackoffDelay(
  attempt: number,
  config: {
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitterFactor: number;
  },
): number {
  const exponentialDelay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.round(cappedDelay + jitter);
}

function hashConversationSeed(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

function extractPrimaryTextFromParts(parts: Part[] | undefined): string {
  if (!parts || parts.length === 0) {
    return '';
  }
  for (const part of parts) {
    if (part && typeof part.text === 'string' && part.text.trim()) {
      return part.text.trim();
    }
  }
  return '';
}

function extractConversationSeed(
  systemInstruction: { role: 'user'; parts: Part[] } | undefined,
  contents: Content[],
): string {
  const systemText = systemInstruction
    ? extractPrimaryTextFromParts(systemInstruction.parts)
    : '';

  const userText = (() => {
    for (const content of contents) {
      if (content.role !== 'user') {
        continue;
      }
      const text = extractPrimaryTextFromParts(content.parts);
      if (text) {
        return text;
      }
    }
    return '';
  })();

  return [systemText, userText].filter(Boolean).join('|');
}

function extractFirstUserText(contents: Content[]): string {
  for (const content of contents) {
    if (content.role !== 'user') {
      continue;
    }
    const text = extractPrimaryTextFromParts(content.parts);
    if (text) {
      return text;
    }
  }
  return '';
}

function buildSignatureSessionId(options: {
  modelId: string;
  projectId: string;
  systemInstruction: { role: 'user'; parts: Part[] } | undefined;
  contents: Content[];
}): string {
  const modelForKey = options.modelId
    .trim()
    .toLowerCase()
    .replace(/-(minimal|low|medium|high)$/i, '');

  const projectKey = options.projectId.trim()
    ? options.projectId.trim()
    : 'default';

  const seed = extractConversationSeed(
    options.systemInstruction,
    options.contents,
  );
  const conversationKey = seed
    ? `seed-${hashConversationSeed(seed)}`
    : 'default';

  return `${PLUGIN_SESSION_ID}:${modelForKey}:${projectKey}:${conversationKey}`;
}

function buildStableAntigravitySessionId(contents: Content[]): string {
  const firstUserText = extractFirstUserText(contents);
  if (!firstUserText) {
    const digest = createHash('sha256').update(randomUUID(), 'utf8').digest();
    const value = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
    return `-${value.toString()}`;
  }

  const digest = createHash('sha256').update(firstUserText, 'utf8').digest();
  const value = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${value.toString()}`;
}

function sanitizeAntigravityToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '_';
  }

  let sanitized = trimmed.replace(/[^a-zA-Z0-9_.:-]/g, '_');

  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  if (sanitized.length > 64) {
    sanitized = sanitized.slice(0, 64);
  }

  return sanitized;
}

function hasMcpTools(tools: Tool[] | undefined): boolean {
  if (!tools) {
    return false;
  }

  return tools.some((tool) =>
    tool.functionDeclarations?.some(
      (decl) =>
        typeof decl.name === 'string' && decl.name.startsWith('mcp__'),
    ),
  );
}

function hasWebSearchTool(tools: Tool[] | undefined): boolean {
  if (!tools) {
    return false;
  }

  const isWebSearchName = (value: unknown): boolean => {
    if (typeof value !== 'string') {
      return false;
    }
    const name = value.trim().toLowerCase();
    return name === 'web_search' || name === 'google_search';
  };

  return tools.some((tool) => {
    if ('googleSearch' in tool && tool.googleSearch !== undefined) {
      return true;
    }
    if ('googleSearchRetrieval' in tool && tool.googleSearchRetrieval !== undefined) {
      return true;
    }
    return tool.functionDeclarations?.some((decl) => {
      if (isWebSearchName(decl.name)) {
        return true;
      }
      const record = decl as unknown as Record<string, unknown>;
      return isWebSearchName(record['type']);
    }) === true;
  });
}

function filterOpenCodePrompt(text: string): string {
  if (!text.includes('You are an interactive CLI tool')) {
    return text;
  }
  const instructionsIndex = text.indexOf('Instructions from:');
  return instructionsIndex >= 0 ? text.slice(instructionsIndex) : '';
}

function buildAntigravityModelIdentityText(modelId: string): string {
  const modelIdLower = modelId.trim().toLowerCase();
  let best:
    | {
        prefix: string;
        displayName: string;
        canonicalId: string;
      }
    | undefined;

  for (const info of ANTIGRAVITY_MODEL_INFO) {
    if (
      modelIdLower.startsWith(info.prefix) &&
      (!best || info.prefix.length > best.prefix.length)
    ) {
      best = info;
    }
  }

  if (!best) {
    return '';
  }
  return `You are Model ${best.displayName}, ModelId is ${best.canonicalId}.`;
}

function applyDummyThoughtSignatureForGemini(contents: Content[]): void {
  for (const content of contents) {
    const parts = content.parts;
    if (!parts || parts.length === 0) {
      continue;
    }

    content.parts = parts.map((part) => {
      if (part.thought && !part.thoughtSignature) {
        return { ...part, thoughtSignature: DUMMY_THOUGHT_SIGNATURE };
      }
      if (part.functionCall && !part.thoughtSignature) {
        return { ...part, thoughtSignature: DUMMY_THOUGHT_SIGNATURE };
      }
      return part;
    });
  }
}

function buildToolParameterSignature(schema: unknown): string {
  if (!isRecord(schema)) {
    return '';
  }

  const propertiesRaw = schema['properties'];
  if (!isRecord(propertiesRaw)) {
    return '';
  }

  const requiredRaw = schema['required'];
  const required = new Set<string>(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        )
      : [],
  );

  const segments: string[] = [];
  for (const [name, propSchema] of Object.entries(propertiesRaw)) {
    const trimmed = name.trim();
    if (!trimmed) {
      continue;
    }

    const typeValue = isRecord(propSchema) ? propSchema['type'] : undefined;
    const typeName =
      typeof typeValue === 'string' && typeValue.trim()
        ? typeValue.trim()
        : 'unknown';

    const optional = required.has(name) ? '' : '?';
    segments.push(`${trimmed}${optional}: ${typeName}`);
  }

  return segments.join(', ');
}

function cleanJsonSchemaForAntigravity(schema: unknown): unknown {
  const unsupportedConstraints = new Set<string>([
    'minLength',
    'maxLength',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'pattern',
    'minItems',
    'maxItems',
    'format',
    'default',
    'examples',
  ]);

  const droppedKeys = new Set<string>([
    '$schema',
    '$id',
    '$defs',
    'definitions',
    '$comment',
    'title',
    'readOnly',
    'writeOnly',
    'deprecated',
    'enumDescriptions',
    'markdownEnumDescriptions',
    'markdownDescription',
    'deprecationMessage',
    'errorMessage',
  ]);

  const appendHintToDescription = (
    target: Record<string, unknown>,
    hint: string,
  ): void => {
    const trimmed = hint.trim();
    if (!trimmed) {
      return;
    }

    const existing = target['description'];
    if (typeof existing === 'string' && existing.trim()) {
      target['description'] = `${existing.trim()} (${trimmed})`;
      return;
    }

    target['description'] = trimmed;
  };

  const stringifyEnumValue = (value: unknown): string => {
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (isRecord(value) || Array.isArray(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };

  const mergeRequired = (
    base: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): void => {
    const baseRequired = base['required'];
    const incomingRequired = incoming['required'];
    if (!Array.isArray(baseRequired) && !Array.isArray(incomingRequired)) {
      return;
    }

    const merged = new Set<string>();
    if (Array.isArray(baseRequired)) {
      for (const item of baseRequired) {
        if (typeof item === 'string' && item.trim().length > 0) {
          merged.add(item.trim());
        }
      }
    }
    if (Array.isArray(incomingRequired)) {
      for (const item of incomingRequired) {
        if (typeof item === 'string' && item.trim().length > 0) {
          merged.add(item.trim());
        }
      }
    }
    base['required'] = Array.from(merged);
  };

  const mergeProperties = (
    base: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): void => {
    const baseProps = base['properties'];
    const incomingProps = incoming['properties'];
    if (!isRecord(incomingProps)) {
      return;
    }
    if (!isRecord(baseProps)) {
      base['properties'] = { ...incomingProps };
      return;
    }
    base['properties'] = { ...baseProps, ...incomingProps };
  };

  const mergeSchemas = (
    base: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...base };

    const incomingDescription = incoming['description'];
    if (typeof incomingDescription === 'string' && incomingDescription.trim()) {
      appendHintToDescription(merged, incomingDescription);
    }

    mergeProperties(merged, incoming);
    mergeRequired(merged, incoming);

    for (const [key, value] of Object.entries(incoming)) {
      if (
        key === 'description' ||
        key === 'properties' ||
        key === 'required' ||
        key in merged
      ) {
        continue;
      }
      merged[key] = value;
    }

    return merged;
  };

  type CleanResult = { value: unknown; nullable: boolean };

  const clean = (value: unknown, ctx: { topLevel: boolean }): CleanResult => {
    if (Array.isArray(value)) {
      return {
        value: value.map((item) => clean(item, { topLevel: false }).value),
        nullable: false,
      };
    }

    if (!isRecord(value)) {
      return { value, nullable: false };
    }

    const refValue = value['$ref'];
    if (typeof refValue === 'string' && refValue.trim()) {
      const idx = refValue.lastIndexOf('/');
      const defName = idx >= 0 ? refValue.slice(idx + 1) : refValue;

      const out: Record<string, unknown> = { type: 'object' };
      const existingDescription =
        typeof value['description'] === 'string' ? value['description'] : '';
      out['description'] = existingDescription.trim()
        ? `${existingDescription.trim()} (See: ${defName})`
        : `See: ${defName}`;
      return { value: out, nullable: false };
    }

    const allOf = value['allOf'];
    if (Array.isArray(allOf) && allOf.length > 0) {
      let merged: Record<string, unknown> = { ...value };
      delete merged['allOf'];

      for (const item of allOf) {
        const cleaned = clean(item, ctx).value;
        if (isRecord(cleaned)) {
          merged = mergeSchemas(merged, cleaned);
        }
      }

      return clean(merged, ctx);
    }

    const unionKey: 'anyOf' | 'oneOf' | undefined = (() => {
      const anyOf = value['anyOf'];
      if (Array.isArray(anyOf) && anyOf.length > 0) {
        return 'anyOf';
      }
      const oneOf = value['oneOf'];
      if (Array.isArray(oneOf) && oneOf.length > 0) {
        return 'oneOf';
      }
      return undefined;
    })();

    if (unionKey) {
      const variantsRaw = value[unionKey];
      const variants = Array.isArray(variantsRaw) ? variantsRaw : [];

      const cleanedVariants = variants
        .map((item) => clean(item, { topLevel: false }).value)
        .filter((item): item is Record<string, unknown> => isRecord(item));

      if (cleanedVariants.length === 0) {
        const stripped: Record<string, unknown> = { ...value };
        delete stripped[unionKey];
        appendHintToDescription(
          stripped,
          `${unionKey} present but could not be normalized; falling back to generic object schema`,
        );
        return clean(stripped, ctx);
      }

      let bestIdx = 0;
      let bestScore = -1;
      const allTypes: string[] = [];

      for (let i = 0; i < cleanedVariants.length; i++) {
        const variant = cleanedVariants[i];
        const rawType = variant['type'];
        const typeString = typeof rawType === 'string' ? rawType : '';

        const hasProps = isRecord(variant['properties']);
        const hasItems = variant['items'] !== undefined;

        let score = 0;
        let kind = typeString;
        if (typeString === 'object' || hasProps) {
          score = 3;
          kind = 'object';
        } else if (typeString === 'array' || hasItems) {
          score = 2;
          kind = 'array';
        } else if (typeString && typeString !== 'null') {
          score = 1;
        } else {
          kind = kind || 'null';
        }

        allTypes.push(kind);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      const selected: Record<string, unknown> = { ...cleanedVariants[bestIdx] };

      const parentDescription =
        typeof value['description'] === 'string'
          ? value['description'].trim()
          : '';
      if (parentDescription) {
        appendHintToDescription(selected, parentDescription);
      }

      const distinctTypes: string[] = [];
      const seenTypes = new Set<string>();
      for (const t of allTypes) {
        if (!seenTypes.has(t)) {
          seenTypes.add(t);
          distinctTypes.push(t);
        }
      }
      if (distinctTypes.length > 1) {
        appendHintToDescription(
          selected,
          `Accepts: ${distinctTypes.join(' | ')}`,
        );
      }

      return { value: selected, nullable: false };
    }

    const out: Record<string, unknown> = {};
    const nullableProperties = new Set<string>();

    const description =
      typeof value['description'] === 'string'
        ? value['description'].trim()
        : '';
    if (description) {
      out['description'] = description;
    }

    for (const [k, v] of Object.entries(value)) {
      if (k === 'description') {
        continue;
      }
      if (droppedKeys.has(k)) {
        continue;
      }

      if (k === '$ref' || k === 'allOf' || k === 'anyOf' || k === 'oneOf') {
        continue;
      }

      if (k === 'const') {
        if (!Array.isArray(out['enum'])) {
          out['enum'] = [clean(v, { topLevel: false }).value];
        }
        continue;
      }

      if (unsupportedConstraints.has(k)) {
        if (
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean'
        ) {
          appendHintToDescription(out, `${k}: ${String(v)}`);
        }
        continue;
      }

      if (k === 'propertyNames') {
        appendHintToDescription(out, 'propertyNames: removed');
        continue;
      }

      if (
        k === 'additionalProperties' ||
        k === 'patternProperties' ||
        k === 'unevaluatedProperties'
      ) {
        if (typeof v === 'boolean') {
          appendHintToDescription(
            out,
            v ? `${k}: allowed` : `${k}: disallowed`,
          );
        } else if (isRecord(v)) {
          appendHintToDescription(out, `${k}: schema present (simplified)`);
        }
        continue;
      }

      if (k === 'properties') {
        if (!isRecord(v)) {
          continue;
        }

        const cleanedProps: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(v)) {
          const cleaned = clean(propSchema, { topLevel: false });
          cleanedProps[propName] = cleaned.value;
          if (cleaned.nullable) {
            nullableProperties.add(propName);
          }
        }
        out['properties'] = cleanedProps;
        continue;
      }

      if (k === 'required') {
        if (Array.isArray(v)) {
          out['required'] = v.filter(
            (item): item is string =>
              typeof item === 'string' && item.trim().length > 0,
          );
        }
        continue;
      }

      out[k] = clean(v, { topLevel: false }).value;
    }

    const enumRaw = out['enum'];
    if (Array.isArray(enumRaw)) {
      const normalized = enumRaw.map(stringifyEnumValue);
      out['enum'] = normalized;
      if (normalized.length > 1 && normalized.length <= 10) {
        appendHintToDescription(out, `Allowed: ${normalized.join(', ')}`);
      }
    }

    let nullable = false;
    const typeRaw = out['type'];
    if (Array.isArray(typeRaw)) {
      const typeStrings = typeRaw
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      const nonNullTypes = typeStrings.filter((t) => t !== 'null');
      const hasNull = typeStrings.some((t) => t === 'null');

      out['type'] = nonNullTypes[0] ?? 'string';
      if (nonNullTypes.length > 1) {
        appendHintToDescription(out, `Accepts: ${nonNullTypes.join(' | ')}`);
      }
      if (hasNull) {
        appendHintToDescription(out, '(nullable)');
        nullable = true;
      }
    }

    if (out['type'] === undefined) {
      if (isRecord(out['properties'])) {
        out['type'] = 'object';
      } else if (out['items'] !== undefined) {
        out['type'] = 'array';
      }
    }

    const propertiesRaw = out['properties'];
    const requiredRaw = out['required'];

    if (isRecord(propertiesRaw) && Array.isArray(requiredRaw)) {
      const propertyNames = new Set(Object.keys(propertiesRaw));
      const validRequired = requiredRaw.filter(
        (prop): prop is string =>
          typeof prop === 'string' &&
          prop.trim().length > 0 &&
          propertyNames.has(prop) &&
          !nullableProperties.has(prop),
      );

      if (validRequired.length > 0) {
        out['required'] = validRequired;
      } else {
        delete out['required'];
      }
    }

    const typeValue = out['type'];
    if (
      typeof typeValue === 'string' &&
      typeValue.toLowerCase() === 'array' &&
      out['items'] === undefined
    ) {
      out['items'] = { type: 'string' };
    }

    const treatAsObject =
      (typeof typeValue === 'string' && typeValue.toLowerCase() === 'object') ||
      isRecord(out['properties']);

    if (treatAsObject) {
      out['type'] = 'object';

      const properties = isRecord(out['properties'])
        ? { ...out['properties'] }
        : {};

      if (Object.keys(properties).length === 0) {
        properties[EMPTY_SCHEMA_PLACEHOLDER_NAME] = {
          type: 'boolean',
          description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
        };
        out['properties'] = properties;
        out['required'] = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
      }
    }

    return { value: out, nullable };
  };

  const cleanedRoot = clean(schema, { topLevel: true }).value;
  if (!isRecord(cleanedRoot)) {
    return cleanedRoot;
  }

  const { $defs: _defs, definitions: _definitions, ...rest } = cleanedRoot;
  return rest;
}

// function buildSyntheticProjectId(): string {
//   const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
//   const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
//   const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
//   const noun = nouns[Math.floor(Math.random() * nouns.length)];
//   const randomPart = randomUUID().slice(0, 5).toLowerCase();
//   return `${adj}-${noun}-${randomPart}`;
// }

const GEMINI_3_PRO_MAX_OUTPUT_TOKENS_ANTIGRAVITY = 65535;
const ANTIGRAVITY_WEB_SEARCH_FALLBACK_MODEL = 'gemini-2.5-flash';
const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const TOOL_ENABLED_INSTRUCTION =
  'When tools are provided, use tool calls instead of describing tool use. Never claim you lack tool access or permissions.';
const TOOL_DISABLED_INSTRUCTION =
  'Do not mention tool availability or lack thereof. If tools are unavailable, respond directly without narrating tool steps.';
const ANTIGRAVITY_MODEL_INFO: ReadonlyArray<{
  prefix: string;
  displayName: string;
  canonicalId: string;
}> = [
  {
    prefix: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    canonicalId: 'claude-fable-5',
  },
  {
    prefix: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    canonicalId: 'claude-opus-4-8',
  },
  {
    prefix: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    canonicalId: 'claude-opus-4-7',
  },
  {
    prefix: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    canonicalId: 'claude-opus-4-6',
  },
  {
    prefix: 'claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    canonicalId: 'claude-opus-4-5-20250929',
  },
  {
    prefix: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    canonicalId: 'claude-sonnet-4-6',
  },
  {
    prefix: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    canonicalId: 'claude-sonnet-4-5-20250929',
  },
  {
    prefix: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    canonicalId: 'claude-haiku-4-5-20251001',
  },
];

/**
 * Retry configuration for CodeAssist providers when using multiple endpoints.
 * More aggressive than default to handle transient endpoint issues quickly.
 */
const CODE_ASSIST_MULTI_ENDPOINT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

type CodeAssistBackoffRetryConfig = {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
};

const CODE_ASSIST_PRE_FIRST_PART_STREAM_RETRY_CONFIG: CodeAssistBackoffRetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

function normalizeToolParametersSchema(
  schema: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(schema) ? { ...schema } : {};
  out['type'] = 'object';

  const propertiesRaw = out['properties'];
  const properties = isRecord(propertiesRaw) ? { ...propertiesRaw } : {};
  const requiredRaw = out['required'];
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((value): value is string => typeof value === 'string')
    : [];

  if (Object.keys(properties).length === 0) {
    properties[EMPTY_SCHEMA_PLACEHOLDER_NAME] = {
      type: 'boolean',
      description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
    };
    required.length = 0;
    required.push(EMPTY_SCHEMA_PLACEHOLDER_NAME);
  }

  out['properties'] = properties;
  if (required.length > 0) {
    out['required'] = required;
  } else {
    delete out['required'];
  }
  return out;
}

export type Gemini3ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

const IMAGE_MODEL_PATTERN = /image|imagen/i;
const GEMINI_3_TIER_SUFFIX = /-(minimal|low|medium|high)$/i;
const GEMINI_3_PRO_PATTERN = /^gemini-3(?:\.\d+)?-pro/i;
const CLAUDE_THINKING_SUFFIX = /-thinking$/i;
const CLAUDE_OPUS_HIGH_THINKING_BUDGET_ANTIGRAVITY = 32768;
const CLAUDE_OPUS_LOW_THINKING_BUDGET_ANTIGRAVITY = 8192;
const CLAUDE_OPUS_MAX_OUTPUT_TOKENS_ANTIGRAVITY = 64000;

function mapThinkingEffortToGemini3ThinkingLevel(
  effort: NonNullable<NonNullable<ModelConfig['thinking']>['effort']>,
): Gemini3ThinkingLevel | undefined {
  switch (effort) {
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'max':
    case 'xhigh':
      return 'high';
    case 'none':
      return undefined;
  }
}

function resolveClaudeOpusThinkingBudgetForAntigravity(
  effort:
    | NonNullable<NonNullable<ModelConfig['thinking']>['effort']>
    | undefined,
): number | undefined {
  switch (effort) {
    case 'minimal':
    case 'none':
      return undefined;
    case 'low':
    case 'medium':
      return CLAUDE_OPUS_LOW_THINKING_BUDGET_ANTIGRAVITY;
    case 'high':
    case 'max':
    case 'xhigh':
      return CLAUDE_OPUS_HIGH_THINKING_BUDGET_ANTIGRAVITY;
    case undefined:
    default:
      return CLAUDE_OPUS_HIGH_THINKING_BUDGET_ANTIGRAVITY;
  }
}

function parseGemini3TierSuffix(modelId: string): {
  baseModelId: string;
  tier?: Gemini3ThinkingLevel;
} {
  const tierMatch = modelId.match(GEMINI_3_TIER_SUFFIX);
  if (!tierMatch || typeof tierMatch[1] !== 'string') {
    return { baseModelId: modelId };
  }

  const candidate = tierMatch[1].toLowerCase();
  if (
    candidate !== 'minimal' &&
    candidate !== 'low' &&
    candidate !== 'medium' &&
    candidate !== 'high'
  ) {
    return { baseModelId: modelId };
  }

  return {
    baseModelId: modelId.slice(0, modelId.length - tierMatch[0].length),
    tier: candidate,
  };
}

function hasMeaningfulPartValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }

  return true;
}

function normalizePartForRequest(part: Part): Part | null {
  let normalizedPart: Part = part;
  const functionCall = normalizedPart.functionCall;
  if (isRecord(functionCall) && functionCall['args'] === undefined) {
    normalizedPart = {
      ...normalizedPart,
      functionCall: {
        ...functionCall,
        args: {},
      },
    };
  }

  if (
    typeof normalizedPart.text === 'string' &&
    normalizedPart.text.trim().length > 0
  ) {
    return normalizedPart;
  }

  for (const key of Object.keys(normalizedPart) as Array<keyof Part>) {
    if (key === 'text') {
      continue;
    }
    if (hasMeaningfulPartValue(normalizedPart[key])) {
      return normalizedPart;
    }
  }

  return null;
}

function sanitizePartsForRequest(parts: Part[]): Part[] {
  const sanitized: Part[] = [];

  for (const part of parts) {
    const normalized = normalizePartForRequest(part);
    if (normalized) {
      sanitized.push(normalized);
    }
  }

  return sanitized;
}

function sanitizeContentsForRequest(contents: Content[]): void {
  let i = contents.length;
  while (i--) {
    const content = contents[i];
    const parts = content.parts;
    if (!parts || parts.length === 0) {
      contents.splice(i, 1);
      continue;
    }

    const sanitizedParts = sanitizePartsForRequest(parts);
    if (sanitizedParts.length === 0) {
      contents.splice(i, 1);
      continue;
    }

    content.parts = sanitizedParts;
  }
}

export function resolveAntigravityModelForRequest(
  modelId: string,
  preferredGemini3ThinkingLevel?: Gemini3ThinkingLevel,
  thinkingEnabled?: boolean,
): {
  requestModelId: string;
  gemini3ThinkingLevel?: Gemini3ThinkingLevel;
} {
  // Sync rule: `modelId` here is the model ID from this project's config.
  // Keep conversion minimal for request protocol needs (tier/thinking),
  // and do NOT port reference project's full alias/prefix resolver.
  const trimmed = modelId.trim();
  const modelLower = trimmed.toLowerCase();

  // Antigravity currently exposes Claude Opus as a dedicated `-thinking`
  // request model, while Claude Sonnet keeps its canonical model ID even
  // when thinking is enabled. Normalize any existing suffix first so we do
  // not accidentally produce `-thinking-thinking`.
  if (modelLower.includes('claude')) {
    const baseClaudeModelId = trimmed.replace(CLAUDE_THINKING_SUFFIX, '');
    const isOpus = baseClaudeModelId.toLowerCase().includes('opus');
    const requestModelId = isOpus
      ? `${baseClaudeModelId}-thinking`
      : baseClaudeModelId;
    return { requestModelId };
  }

  // Handle Gemini 3 models
  const isGemini3 = modelLower.includes('gemini-3');
  if (!isGemini3) {
    return { requestModelId: trimmed };
  }

  const isGemini3Pro = GEMINI_3_PRO_PATTERN.test(modelLower);

  if (isGemini3Pro) {
    const { baseModelId, tier } = parseGemini3TierSuffix(trimmed);
    const effectiveLevel: Gemini3ThinkingLevel =
      preferredGemini3ThinkingLevel ?? tier ?? 'high';
    // Antigravity requires tier suffix for Gemini 3 Pro. Default to -high.
    const isImageModel = IMAGE_MODEL_PATTERN.test(baseModelId);
    const requestModelId = isImageModel
      ? baseModelId
      : `${baseModelId}-${effectiveLevel}`;
    return { requestModelId, gemini3ThinkingLevel: effectiveLevel };
  }

  // Default thinking level for non-Pro Gemini 3 models is high.
  const effectiveLevel: Gemini3ThinkingLevel =
    preferredGemini3ThinkingLevel ?? 'high';

  // Other Gemini 3 models: keep as-is, but still expose default thinkingLevel.
  return {
    requestModelId: trimmed,
    gemini3ThinkingLevel: effectiveLevel,
  };
}

type AntigravityFunctionDeclaration = {
  name: string;
  description: string;
  parameters: unknown;
};

type AntigravityTool = {
  functionDeclarations: AntigravityFunctionDeclaration[];
};

export type CodeAssistHeaderDefaults = {
  'User-Agent': string;
  'X-Goog-Api-Client': string;
  'Client-Metadata': string;
};

export abstract class GoogleCodeAssistProvider extends GoogleAIStudioProvider {
  protected abstract readonly codeAssistName: string;
  protected abstract readonly codeAssistHeaders: CodeAssistHeaderDefaults;
  protected abstract readonly codeAssistHeaderStyle: AntigravityHeaderStyle;
  protected abstract readonly codeAssistEndpointFallbacks: readonly string[];

  protected abstract resolveModelForRequest(
    modelId: string,
    preferredGemini3ThinkingLevel?: Gemini3ThinkingLevel,
    thinkingEnabled?: boolean,
  ): {
    requestModelId: string;
    gemini3ThinkingLevel?: Gemini3ThinkingLevel;
  };

  protected shouldInjectAntigravitySystemInstruction(
    _modelIdLower: string,
    _isClaudeModel: boolean,
  ): boolean {
    return false;
  }

  private activeEndpointBaseUrl: string | undefined;

  /**
   * The Claude adapter for Antigravity rejects empty text fields in the message parts.
   * These fields may appear in the streamed history (for example, in signature
   * changes or as empty chunks of data) and must be removed or normalized
   * before sending any follow-up requests.
   *
   * The process involves merging the same role contents, merging the text parts
   * of each piece of content, removing any parts with empty text,
   * and then sorting the parts – with the thought parts always coming first.
   */
  private sanitizeClaudeContents(contents: Content[]): void {
    // Merge same role contents
    const newContents: Content[] = [];
    let lastContent: Content | undefined = undefined;
    for (const content of contents) {
      if (lastContent && lastContent.role === content.role) {
        if (lastContent.parts && content.parts) {
          lastContent.parts.push(...content.parts);
        } else if (content.parts) {
          lastContent.parts = content.parts;
        }
      } else {
        newContents.push(content);
        lastContent = content;
      }
    }
    contents.length = 0;
    contents.push(...newContents);

    // Merge text parts into a single part and sort parts
    for (const content of contents) {
      if (content.parts && content.role !== 'user') {
        let mergedThinkingText = '';
        let mergedThinkingSignature: string | undefined = undefined;
        let mergedText = '';
        const otherParts: Part[] = [];
        for (const part of content.parts) {
          if (part.thought) {
            if (part.thoughtSignature) {
              mergedThinkingSignature = part.thoughtSignature;
            }
            if (part.text) {
              mergedThinkingText += part.text;
            }
          } else if (typeof part.text === 'string') {
            mergedText += part.text;
          } else {
            otherParts.push(part);
          }
        }
        content.parts = [
          ...(mergedThinkingText
            ? [
                {
                  text: mergedThinkingText,
                  thought: true,
                  thoughtSignature: mergedThinkingSignature,
                } satisfies Part,
              ]
            : []),
          ...(mergedText ? [{ text: mergedText } satisfies Part] : []),
          ...otherParts,
        ];
      }
    }

    // Remove empty text parts
    let i = contents.length;
    while (i--) {
      const content = contents[i];
      if (content.parts) {
        content.parts = content.parts.filter((part) => {
          if (part.text) return true;
          let hasNonText = false;
          for (const key in part) {
            if (key === 'text' || key === 'thought') {
              continue;
            }
            if (part[key as keyof Part] !== undefined) {
              hasNonText = true;
              break;
            }
          }
          return hasNonText;
        });
        if (content.parts.length === 0) {
          contents.splice(i, 1);
        }
      }
    }

    sanitizeContentsForRequest(contents);
  }

  protected validateAuth(): void {
    if (this.config.auth?.method !== 'antigravity-oauth') {
      throw new Error(
        `Google ${this.codeAssistName} provider requires auth method "antigravity-oauth".`,
      );
    }
  }

  private normalizeEndpointBaseUrl(raw: string): string {
    if (isRawBaseUrlEnabled(this.config)) {
      return raw.trim();
    }

    const trimmed = raw.trim().replace(/\/+$/, '');
    return trimmed.replace(/\/v1internal(?::.*)?$/i, '');
  }

  private resolveEndpointBaseUrl(): string {
    return this.normalizeEndpointBaseUrl(this.baseUrl);
  }

  private resolveEndpointCandidates(): string[] {
    const primary = this.resolveEndpointBaseUrl();
    const active = this.activeEndpointBaseUrl
      ? this.normalizeEndpointBaseUrl(this.activeEndpointBaseUrl)
      : undefined;

    const canonical: string[] = [];
    const canonicalSeen = new Set<string>();
    for (const endpoint of this.codeAssistEndpointFallbacks) {
      const normalized = this.normalizeEndpointBaseUrl(endpoint);
      if (!canonicalSeen.has(normalized)) {
        canonicalSeen.add(normalized);
        canonical.push(normalized);
      }
    }

    const start = active ?? primary;
    const startIndex = canonical.indexOf(start);

    const ordered: string[] = [];
    const seen = new Set<string>();
    const pushEndpoint = (endpoint: string): void => {
      const normalized = this.normalizeEndpointBaseUrl(endpoint);
      if (!normalized) {
        return;
      }
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      ordered.push(normalized);
    };

    if (startIndex >= 0) {
      for (let i = 0; i < canonical.length; i++) {
        pushEndpoint(canonical[(startIndex + i) % canonical.length]);
      }
    } else {
      pushEndpoint(start);
      for (const endpoint of canonical) {
        pushEndpoint(endpoint);
      }
    }

    pushEndpoint(primary);
    return ordered;
  }

  protected resolveProjectId(): string {
    const auth = this.config.auth;
    if (
      auth?.method === 'antigravity-oauth' ||
      auth?.method === 'google-gemini-oauth'
    ) {
      const managedProjectId = auth.managedProjectId?.trim();
      if (managedProjectId) {
        return managedProjectId;
      }

      if (auth.method === 'antigravity-oauth') {
        const projectId = auth.projectId?.trim();
        if (projectId) {
          return projectId;
        }
      }
    }

    return ANTIGRAVITY_DEFAULT_PROJECT_ID;

    // if (!this.fallbackProjectId) {
    //   this.fallbackProjectId = buildSyntheticProjectId();
    // }
    // return this.fallbackProjectId;
  }

  private async buildCodeAssistContentHeaders(
    credential: AuthTokenInfo,
  ): Promise<Record<string, string>> {
    const token = getToken(credential);
    if (!token) {
      throw new Error(`Missing OAuth access token for ${this.codeAssistName}`);
    }

    const tokenType = getTokenType(credential) ?? 'Bearer';
    const randomized = await getRandomizedHeaders(this.codeAssistHeaderStyle);

    return {
      'Content-Type': 'application/json',
      Authorization: `${tokenType} ${token}`,
      'User-Agent':
        randomized['User-Agent'] ?? this.codeAssistHeaders['User-Agent'],
    };
  }

  private buildAntigravityFunctionCallingConfig(
    mode: vscode.LanguageModelChatToolMode,
    tools: AntigravityTool[] | undefined,
    modelId: string,
  ): FunctionCallingConfig | undefined {
    const isClaudeModel = modelId.toLowerCase().includes('claude');
    if (isClaudeModel) {
      return { mode: FunctionCallingConfigMode.VALIDATED };
    }

    if (!tools || tools.length === 0) {
      return undefined;
    }

    if (mode !== vscode.LanguageModelChatToolMode.Required) {
      return undefined;
    }

    const allowedFunctionNames = tools
      .flatMap((tool) => tool.functionDeclarations)
      .map((decl) => decl.name)
      .filter((name) => name !== '');

    return {
      mode: FunctionCallingConfigMode.ANY,
      ...(allowedFunctionNames.length > 0
        ? { allowedFunctionNames }
        : undefined),
    };
  }

  private collectSystemInstructionParts(
    systemInstruction: ContentUnion | undefined,
  ): Part[] {
    if (!systemInstruction) {
      return [];
    }

    const addPartUnion = (value: unknown, output: Part[]): void => {
      if (!value) {
        return;
      }
      if (typeof value === 'string') {
        const filtered = filterOpenCodePrompt(value);
        if (filtered.trim()) {
          output.push({ text: filtered });
        }
        return;
      }
      if (isRecord(value) && Array.isArray(value['parts'])) {
        for (const child of value['parts']) {
          addPartUnion(child, output);
        }
        return;
      }
      if (isPart(value)) {
        if (typeof value.text === 'string') {
          const filtered = filterOpenCodePrompt(value.text);
          if (filtered.trim()) {
            output.push({ ...value, text: filtered });
          }
          return;
        }
        output.push(value);
      }
    };

    const output: Part[] = [];

    if (Array.isArray(systemInstruction)) {
      for (const item of systemInstruction) {
        addPartUnion(item, output);
      }
      return output;
    }

    addPartUnion(systemInstruction, output);
    return output;
  }

  private buildSystemInstructionForRequest(
    systemInstruction: ContentUnion | undefined,
    options: {
      injectAntigravitySystemInstruction: boolean;
      toolsProvided: boolean;
      isClaudeModel: boolean;
      hasMcpTools: boolean;
      modelId: string;
    },
  ): { role: 'user'; parts: Part[] } {
    const userSystemParts =
      this.collectSystemInstructionParts(systemInstruction);
    const userHasAntigravityIdentity = userSystemParts.some(
      (part) =>
        typeof part.text === 'string' && part.text.includes('You are Antigravity'),
    );
    const parts: Part[] = [];

    const shouldInjectIdentity =
      options.injectAntigravitySystemInstruction && !userHasAntigravityIdentity;
    if (shouldInjectIdentity) {
      const modelIdentity = buildAntigravityModelIdentityText(options.modelId);
      parts.push(
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        {
          text: modelIdentity
            ? `${ANTIGRAVITY_SILENT_BOUNDARY_INSTRUCTION}\n${modelIdentity}`
            : ANTIGRAVITY_SILENT_BOUNDARY_INSTRUCTION,
        },
      );
    }

    parts.push(...userSystemParts);

    if (options.isClaudeModel && options.toolsProvided) {
      parts.push({ text: CLAUDE_TOOL_SYSTEM_INSTRUCTION });
    }

    const toolText = options.toolsProvided
      ? TOOL_ENABLED_INSTRUCTION
      : TOOL_DISABLED_INSTRUCTION;
    if (toolText.trim()) {
      parts.push({ text: toolText });
    }

    if (options.injectAntigravitySystemInstruction && options.hasMcpTools) {
      parts.push({ text: ANTIGRAVITY_MCP_XML_INSTRUCTION });
    }

    if (options.injectAntigravitySystemInstruction && !userHasAntigravityIdentity) {
      parts.push({ text: ANTIGRAVITY_SYSTEM_PROMPT_END });
    }

    return { role: 'user', parts: sanitizePartsForRequest(parts) };
  }

  private normalizeTools(
    tools: Tool[] | undefined,
    options?: { hardenClaudeTools: boolean },
  ): AntigravityTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const normalized: AntigravityTool[] = [];

    for (const tool of tools) {
      if (
        !tool.functionDeclarations ||
        tool.functionDeclarations.length === 0
      ) {
        continue;
      }

      const functionDeclarations: AntigravityFunctionDeclaration[] = [];
      for (const decl of tool.functionDeclarations) {
        const name = typeof decl.name === 'string' ? decl.name : '';
        let description =
          typeof decl.description === 'string' ? decl.description : '';

        const schemaSource = decl.parametersJsonSchema;
        const parameters = normalizeToolParametersSchema(
          cleanJsonSchemaForAntigravity(schemaSource),
        );

        if (options?.hardenClaudeTools) {
          const signature = buildToolParameterSignature(parameters);
          if (signature) {
            description += CLAUDE_DESCRIPTION_PROMPT.replace(
              '{params}',
              signature,
            );
          }
        }

        functionDeclarations.push({
          name: sanitizeAntigravityToolName(name),
          description,
          parameters,
        });
      }

      if (functionDeclarations.length > 0) {
        normalized.push({ functionDeclarations: [...functionDeclarations] });
      }
    }

    return normalized.length > 0 ? normalized : undefined;
  }

  private async *streamAntigravitySse(
    response: Response,
    abortSignal: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const stream = response.body;
    if (!stream) {
      throw new Error(
        `Missing response body for ${this.codeAssistName} streaming request`,
      );
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];

    const flushEvent = (): GenerateContentResponse | null => {
      if (dataLines.length === 0) {
        return new GenerateContentResponse();
      }

      const data = dataLines.join('\n').trim();
      dataLines = [];
      if (!data) {
        return new GenerateContentResponse();
      }
      if (data === '[DONE]') {
        return null;
      }

      try {
        const parsed: unknown = JSON.parse(data);
        const raw = extractAntigravityResponsePayload(parsed);
        return raw
          ? toGenerateContentResponse(raw)
          : new GenerateContentResponse();
      } catch {
        return new GenerateContentResponse();
      }
    };

    const reader = stream.getReader();

    try {
      while (true) {
        if (abortSignal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }

        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }

        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) {
            break;
          }

          const rawLine = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

          if (line === '') {
            const flushed = flushEvent();
            if (!flushed) {
              return;
            }
            if (abortSignal.aborted) {
              return;
            }
            yield flushed;
            continue;
          }

          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (abortSignal.aborted) {
      return;
    }

    buffer += decoder.decode();
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      if (line === '') {
        const flushed = flushEvent();
        if (!flushed) {
          return;
        }
        yield flushed;
      }
    }

    const flushed = flushEvent();
    if (flushed) {
      yield flushed;
    }
  }

  override async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    requestTrace: ChatRequestTrace,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const performanceTrace = requestTrace.performance;
    this.validateAuth();

    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });
    if (token.isCancellationRequested) {
      abortController.abort();
      cancellationListener.dispose();
      return;
    }

    const streamEnabled = model.stream ?? true;
    const chatNetwork = resolveChatNetwork(this.config);

    const requestedModelId = getBaseModelId(model.id);
    const preferredGemini3ThinkingLevel =
      model.thinking &&
      model.thinking.type !== 'disabled' &&
      model.thinking.effort &&
      model.thinking.effort !== 'none'
        ? mapThinkingEffortToGemini3ThinkingLevel(model.thinking.effort)
        : undefined;
    const thinkingEnabled =
      model.thinking &&
      (model.thinking.type === 'enabled' || model.thinking.type === 'auto');
    const resolvedModel = this.resolveModelForRequest(
      requestedModelId,
      preferredGemini3ThinkingLevel,
      thinkingEnabled,
    );

    const expectedIdentity = createStatefulMarkerIdentity(this.config, model);
    const sanitizedMessages = sanitizeMessagesForModelSwitch(messages, {
      modelId: encodedModelId,
      expectedIdentity,
      imageRetention:
        model.capabilities?.imageInput === true ? 'user-only' : 'discard',
    });

    const convertedMessages = this.convertMessages(
      encodedModelId,
      sanitizedMessages,
      expectedIdentity,
    );

    const { systemInstruction, contents } = convertedMessages;

    normalizeSnakeCaseInPlace(contents);

    const sdkTools = this.convertTools(options.tools);
    const hasWebSearch =
      this.codeAssistHeaderStyle === 'antigravity' && hasWebSearchTool(sdkTools);
    const requestModelId = hasWebSearch
      ? ANTIGRAVITY_WEB_SEARCH_FALLBACK_MODEL
      : resolvedModel.requestModelId;
    const gemini3ThinkingLevel = hasWebSearch
      ? undefined
      : resolvedModel.gemini3ThinkingLevel;
    const modelIdLower = requestModelId.toLowerCase();
    const isImageModel = IMAGE_MODEL_PATTERN.test(requestModelId);
    const isClaudeModel = modelIdLower.includes('claude');
    const isClaudeOpusModel = modelIdLower.includes('claude-opus');
    const isAntigravityImageRequest =
      this.codeAssistHeaderStyle === 'antigravity' && isImageModel;

    if (isClaudeModel) {
      this.sanitizeClaudeContents(contents);
    } else {
      sanitizeContentsForRequest(contents);
      if (this.codeAssistHeaderStyle === 'antigravity') {
        applyDummyThoughtSignatureForGemini(contents);
      }
    }

    if (isClaudeModel) {
      for (const content of contents) {
        const parts = content.parts;
        if (!parts || parts.length === 0) {
          continue;
        }

        const signature = parts.find((part) => {
          return (
            typeof part.thoughtSignature === 'string' &&
            part.thoughtSignature.trim().length > 0
          );
        })?.thoughtSignature;

        if (!signature) {
          continue;
        }

        let changed = false;
        const nextParts = parts.map((part) => {
          if (part.functionCall && !part.thoughtSignature) {
            changed = true;
            return { ...part, thoughtSignature: signature };
          }
          return part;
        });

        if (changed) {
          content.parts = nextParts;
        }
      }
    }

    // const hasFinalPositionThinking =
    //   contents
    //     .filter((v) => v.role === 'model')
    //     .at(-1)
    //     ?.parts?.find((v) => v.thought) ?? false;
    // const disableThinkingConfig = isClaudeModel
    //   ? !hasFinalPositionThinking
    //   : false;
    const tools = this.normalizeTools(sdkTools, {
      hardenClaudeTools: isClaudeModel,
    });
    const functionCallingConfig = this.buildAntigravityFunctionCallingConfig(
      options.toolMode,
      tools,
      requestModelId,
    );

    const injectSystemInstruction =
      this.shouldInjectAntigravitySystemInstruction(
        modelIdLower,
        isClaudeModel,
      );
    const toolsProvided = !!(options.tools && options.tools.length > 0);
    const systemInstructionForRequest = this.buildSystemInstructionForRequest(
      systemInstruction,
      {
        injectAntigravitySystemInstruction: injectSystemInstruction,
        toolsProvided,
        isClaudeModel,
        hasMcpTools: hasMcpTools(sdkTools),
        modelId: requestModelId,
      },
    );

    const generationConfig: Record<string, unknown> = {};
    if (model.temperature !== undefined)
      generationConfig.temperature = model.temperature;
    if (model.topP !== undefined) generationConfig.topP = model.topP;
    if (model.topK !== undefined) generationConfig.topK = model.topK;
    if (model.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = model.maxOutputTokens;
    }
    if (model.presencePenalty !== undefined) {
      generationConfig.presencePenalty = model.presencePenalty;
    }
    if (model.frequencyPenalty !== undefined) {
      generationConfig.frequencyPenalty = model.frequencyPenalty;
    }

    // !disableThinkingConfig
    if (model.thinking) {
      const thinkingDisabled =
        model.thinking.type === 'disabled' || model.thinking.effort === 'none';

      if (gemini3ThinkingLevel) {
        generationConfig.thinkingConfig = {
          includeThoughts: !thinkingDisabled,
          thinkingLevel: gemini3ThinkingLevel,
        };
      } else {
        const thinkingConfig: Record<string, unknown> = {
          includeThoughts: !thinkingDisabled,
        };

        const opusThinkingBudget =
          !thinkingDisabled && isClaudeOpusModel
            ? resolveClaudeOpusThinkingBudgetForAntigravity(
                model.thinking.effort,
              )
            : undefined;

        const budgetTokens = opusThinkingBudget ?? model.thinking.budgetTokens;
        const hasPositiveBudget =
          typeof budgetTokens === 'number' &&
          Number.isFinite(budgetTokens) &&
          budgetTokens > 0;

        if (!thinkingDisabled && hasPositiveBudget) {
          if (
            typeof generationConfig.maxOutputTokens === 'number' &&
            generationConfig.maxOutputTokens <= budgetTokens
          ) {
            throw new Error(
              'Invalid thinking config: maxOutputTokens must be greater than thinkingBudget',
            );
          }
          thinkingConfig.thinkingBudget = budgetTokens;
        }

        generationConfig.thinkingConfig = thinkingConfig;
      }
    }

    if (
      typeof generationConfig.maxOutputTokens === 'number' &&
      requestModelId.toLowerCase().startsWith('gemini-3-pro') &&
      !IMAGE_MODEL_PATTERN.test(requestModelId) &&
      generationConfig.maxOutputTokens >
        GEMINI_3_PRO_MAX_OUTPUT_TOKENS_ANTIGRAVITY
    ) {
      generationConfig.maxOutputTokens =
        GEMINI_3_PRO_MAX_OUTPUT_TOKENS_ANTIGRAVITY;
    }

    if (
      typeof generationConfig.maxOutputTokens === 'number' &&
      isClaudeOpusModel &&
      generationConfig.maxOutputTokens >
        CLAUDE_OPUS_MAX_OUTPUT_TOKENS_ANTIGRAVITY
    ) {
      generationConfig.maxOutputTokens =
        CLAUDE_OPUS_MAX_OUTPUT_TOKENS_ANTIGRAVITY;
    }

    const projectId = this.resolveProjectId();
    const sessionId = isAntigravityImageRequest
      ? undefined
      : this.codeAssistHeaderStyle === 'antigravity'
        ? buildStableAntigravitySessionId(contents)
        : buildSignatureSessionId({
            modelId: requestModelId,
            projectId,
            systemInstruction: systemInstructionForRequest,
            contents,
          });

    const requestPayload: Record<string, unknown> = {
      contents,
      systemInstruction: systemInstructionForRequest,
      ...(sessionId ? { sessionId } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(tools ? { tools } : {}),
      ...(functionCallingConfig
        ? { toolConfig: { functionCallingConfig } }
        : {}),
    };

    let body: Record<string, unknown>;

    if (this.codeAssistHeaderStyle === 'gemini-cli' && !projectId) {
      throw new Error(
        'No project ID found for Gemini CLI. Please try signing out and signing in again to provision a project.',
      );
    }

    body = {
      project: projectId,
      model: requestModelId,
      request: requestPayload,
      ...(this.codeAssistHeaderStyle === 'antigravity'
        ? {
            requestType: hasWebSearch
              ? 'web_search'
              : isAntigravityImageRequest
                ? 'image_gen'
                : 'agent',
            userAgent: 'antigravity',
            requestId: `agent-${randomUUID()}`,
          }
        : {}),
    };

    Object.assign(body, this.config.extraBody, model.extraBody);
    deleteSafetySettings(body);

    const headers = await this.buildCodeAssistContentHeaders(credential);

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      const endpointBases = this.resolveEndpointCandidates();
      const hasMultipleEndpoints = endpointBases.length > 1;

      // Determine retry config based on endpoint count
      const retryConfig = hasMultipleEndpoints
        ? CODE_ASSIST_MULTI_ENDPOINT_RETRY_CONFIG
        : undefined; // Use default retry config for single endpoint

      const effectiveRetryConfig = retryConfig ?? DEFAULT_CHAT_RETRY_CONFIG;
      const baseFetcher = createCustomFetch({
        connectionTimeoutMs: chatNetwork.timeout.connection,
        responseTimeoutMs: chatNetwork.timeout.response,
        logger,
        retryConfig: { ...effectiveRetryConfig, maxRetries: 0 },
        proxy: chatNetwork.proxy,
        type: 'chat',
        abortSignal: abortController.signal,
      });

      const fetchWithRetryInfo = async (
        url: string,
        init: RequestInit,
      ): Promise<Response> => {
        const maxRetries =
          effectiveRetryConfig.maxRetries ??
          DEFAULT_CHAT_RETRY_CONFIG.maxRetries;
        const initialDelayMs =
          effectiveRetryConfig.initialDelayMs ??
          DEFAULT_CHAT_RETRY_CONFIG.initialDelayMs;
        const maxDelayMs =
          effectiveRetryConfig.maxDelayMs ??
          DEFAULT_CHAT_RETRY_CONFIG.maxDelayMs;
        const backoffMultiplier =
          effectiveRetryConfig.backoffMultiplier ??
          DEFAULT_CHAT_RETRY_CONFIG.backoffMultiplier;
        const jitterFactor =
          effectiveRetryConfig.jitterFactor ??
          DEFAULT_CHAT_RETRY_CONFIG.jitterFactor;

        let lastResponse: Response | undefined;
        let lastError: Error | undefined;
        let attempt = 0;

        while (attempt <= maxRetries) {
          throwIfAborted(abortController.signal);

          try {
            const response = await baseFetcher(url, init);

            if (response.ok || !isRetryableStatusCode(response.status)) {
              return response;
            }

            lastResponse = response;

            if (attempt < maxRetries) {
              const backoffMs = calculateBackoffDelay(attempt, {
                initialDelayMs,
                maxDelayMs,
                backoffMultiplier,
                jitterFactor,
              });

              const serverDelayMs = await extractServerSuggestedRetryDelayMs(
                response,
                { parseBody: true },
              );

              const MAX_SERVER_RETRY_DELAY_MS = 30 * 60 * 1000;
              const cappedServerDelayMs =
                typeof serverDelayMs === 'number' &&
                Number.isFinite(serverDelayMs)
                  ? Math.min(serverDelayMs, MAX_SERVER_RETRY_DELAY_MS)
                  : null;

              const delayMs =
                cappedServerDelayMs == null
                  ? backoffMs
                  : Math.max(backoffMs, cappedServerDelayMs);

              // Read response body for logging
              let responseBody: string | undefined;
              try {
                responseBody = await response.text();
              } catch {
                // Ignore errors reading body
              }

              logger?.retry(
                attempt + 1,
                maxRetries,
                response.status,
                delayMs,
                responseBody,
              );
              await delay(delayMs, abortController.signal);
            }

            attempt++;
          } catch (error) {
            throwIfAborted(abortController.signal);

            if (isAbortLikeError(error)) {
              throw error;
            }

            if (!isRetryableNetworkError(error) || attempt >= maxRetries) {
              throw error;
            }

            lastError =
              error instanceof Error ? error : new Error(String(error));

            const delayMs = calculateBackoffDelay(attempt, {
              initialDelayMs,
              maxDelayMs,
              backoffMultiplier,
              jitterFactor,
            });
            logger?.retry(
              attempt + 1,
              maxRetries,
              0,
              delayMs,
              undefined,
              describeNetworkError(error),
            );
            await delay(delayMs, abortController.signal);
            attempt++;
          }
        }

        if (lastError) {
          throw lastError;
        }
        return lastResponse!;
      };

      const fetchAttemptResponse = async (): Promise<
        | {
            response: Response;
            responseEndpointBase: string;
          }
        | undefined
      > => {
        let lastError: Error | undefined;

        // Try each endpoint in sequence
        for (let i = 0; i < endpointBases.length; i++) {
          if (abortController.signal.aborted) {
            return undefined;
          }

          const endpointBase = endpointBases[i];
          const endpoint = `${endpointBase}/v1internal:${streamEnabled ? 'streamGenerateContent' : 'generateContent'}${streamEnabled ? '?alt=sse' : ''}`;

          try {
            const attemptResponse = await fetchWithRetryInfo(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: abortController.signal,
            });

            // Check if we should try the next endpoint
            const shouldRetryEndpoint =
              attemptResponse.status === 403 ||
              attemptResponse.status === 404 ||
              attemptResponse.status >= 500;

            if (!attemptResponse.ok) {
              if (shouldRetryEndpoint && i < endpointBases.length - 1) {
                await attemptResponse.body?.cancel().catch(() => {});
                continue;
              }

              const text = await attemptResponse.text().catch(() => '');
              const debugProjectIdValue = body['project'];
              const debugProjectId =
                typeof debugProjectIdValue === 'string'
                  ? debugProjectIdValue.trim()
                  : '';
              const projectInfo = debugProjectId
                ? ` (project: ${debugProjectId})`
                : '';
              lastError = new Error(
                `${this.codeAssistName} request failed (${attemptResponse.status})${projectInfo}: ${
                  text || attemptResponse.statusText || 'Unknown error'
                }`,
              );
              break;
            }

            return {
              response: attemptResponse,
              responseEndpointBase: endpointBase,
            };
          } catch (error) {
            if (abortController.signal.aborted) {
              return undefined;
            }

            lastError =
              error instanceof Error ? error : new Error(String(error));
            // Try next endpoint if available
            if (i < endpointBases.length - 1) {
              continue;
            }
          }
        }

        throw (
          lastError ?? new Error(`All ${this.codeAssistName} endpoints failed`)
        );
      };

      if (streamEnabled) {
        const responseTimeoutMs = chatNetwork.timeout.response;
        let streamRetryAttempt = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          let response: Response | undefined;
          let emittedPartCount = 0;

          try {
            const attemptResponse = await fetchAttemptResponse();
            if (!attemptResponse) {
              return;
            }

            response = attemptResponse.response;
            this.activeEndpointBaseUrl = attemptResponse.responseEndpointBase;

            const stream = this.streamAntigravitySse(
              response,
              abortController.signal,
            );
            const timedStream = withIdleTimeout(
              stream,
              responseTimeoutMs,
              abortController.signal,
              (error) => abortController.abort(error),
            );

            for await (const part of this.parseMessageStream(
              timedStream,
              token,
              logger,
              requestTrace,
              expectedIdentity,
            )) {
              emittedPartCount++;
              yield part;
            }

            return;
          } catch (error) {
            await response?.body?.cancel().catch(() => {});

            if (
              response !== undefined &&
              emittedPartCount === 0 &&
              !token.isCancellationRequested &&
              !abortController.signal.aborted &&
              isRetryableNetworkError(error) &&
              streamRetryAttempt <
                CODE_ASSIST_PRE_FIRST_PART_STREAM_RETRY_CONFIG.maxRetries
            ) {
              const delayMs = calculateBackoffDelay(
                streamRetryAttempt,
                CODE_ASSIST_PRE_FIRST_PART_STREAM_RETRY_CONFIG,
              );
              logger.retry(
                streamRetryAttempt + 1,
                CODE_ASSIST_PRE_FIRST_PART_STREAM_RETRY_CONFIG.maxRetries,
                0,
                delayMs,
                undefined,
                describeNetworkError(error),
              );
              await delay(delayMs, abortController.signal);
              streamRetryAttempt++;
              continue;
            }

            throw error;
          }
        }
      } else {
        const attemptResponse = await fetchAttemptResponse();
        if (!attemptResponse) {
          return;
        }

        this.activeEndpointBaseUrl = attemptResponse.responseEndpointBase;

        const payload: unknown = await attemptResponse.response.json();
        const raw = extractAntigravityResponsePayload(payload);
        if (!raw) {
          throw new Error(`Invalid ${this.codeAssistName} response payload`);
        }
        yield* this.parseMessage(
          toGenerateContentResponse(raw),
          requestTrace,
          logger,
          expectedIdentity,
        );
      }
    } finally {
      cancellationListener.dispose();
    }
  }
}
