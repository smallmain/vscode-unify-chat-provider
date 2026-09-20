import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
  LanguageModelTextPart: class {
    constructor(readonly value: string) {}
  },
  LanguageModelDataPart: class {
    constructor(readonly data: Uint8Array, readonly mimeType: string) {}
  },
  LanguageModelToolResultPart: class {
    constructor(readonly callId: string, readonly content: unknown[]) {}
  },
}));

import * as vscode from 'vscode';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../../src/types';
import {
  applyOpenCodeSessionHeader,
  deriveOpenCodeSessionId,
} from '../../src/client/opencode/session';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const model: ModelConfig = { id: 'glm-5.3-flash' };
const provider: ProviderConfig = {
  type: 'openai-chat-completion',
  name: 'OpenCode Go',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  models: [],
};

function message(
  content: vscode.LanguageModelChatRequestMessage['content'],
  role = vscode.LanguageModelChatMessageRole.User,
): vscode.LanguageModelChatRequestMessage {
  return { role, content, name: undefined };
}

function text(value: string): vscode.LanguageModelTextPart {
  return new vscode.LanguageModelTextPart(value);
}

function trace(): ChatRequestTrace {
  return { performance: { tts: 0, ttf: 0, ttft: 0, tps: 0, tl: 0 } };
}

function sessionId(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  requestTrace = trace(),
  requestModel = model,
): string | null {
  const headers: Record<string, string | null> = {};
  applyOpenCodeSessionHeader(headers, provider, requestModel, messages, requestTrace);
  return headers['x-opencode-session'];
}

describe('OpenCode history-derived session ID', () => {
  it('stays stable across turns, tool results, and changed system prompts', () => {
    const firstTurn = [message([text('hello')])];
    const laterTurn = [
      message([text('A different system prompt')], vscode.LanguageModelChatMessageRole.System),
      ...firstTurn,
      message([text('Hello')], vscode.LanguageModelChatMessageRole.Assistant),
      message([new vscode.LanguageModelToolResultPart('call-1', [text('tool output')])]),
      message([text('continue')]),
    ];
    expect(sessionId(firstTurn)).toMatch(UUID);
    expect(sessionId(laterTurn)).toBe(sessionId(firstTurn));
  });

  it('joins text parts and ignores image bytes', () => {
    const onePart = [message([text('hello')])];
    const splitParts = [message([
      text('hel'),
      new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
      text('lo'),
    ])];
    expect(sessionId(splitParts)).toBe(sessionId(onePart));
  });

  it('skips empty user text, non-user messages, and nested tool text', () => {
    expect(sessionId([
      message([text('ignore')], vscode.LanguageModelChatMessageRole.System),
      message([text('ignore')], vscode.LanguageModelChatMessageRole.Assistant),
      message([text(' \n\t')]),
      message([new vscode.LanguageModelToolResultPart('call-1', [text('ignore')])]),
      message([text('hello')]),
    ])).toBe(sessionId([message([text('hello')])]));
  });

  it('distinguishes different anchors and target models', () => {
    const anchor = [message([text('hello')])];
    const id = sessionId(anchor);
    expect(sessionId([message([text('different')])])).not.toBe(id);
    expect(sessionId(anchor, trace(), { id: 'glm-5.3' })).not.toBe(id);
    expect(sessionId([message([text(' hello ')])])).not.toBe(id);
  });

  it('uses the API model ID rather than a local preset suffix', () => {
    const anchor = [message([text('hello')])];
    expect(sessionId(anchor, trace(), { id: 'glm-5.3-flash#thinking' }))
      .toBe(sessionId(anchor));
  });

  it('reuses the random fallback for retries but isolates independent requests', () => {
    const messages = [message([
      new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png'),
    ])];
    const requestTrace = trace();
    const id = sessionId(messages, requestTrace);
    expect(id).toMatch(UUID);
    expect(sessionId(messages, requestTrace)).toBe(id);
    expect(sessionId(messages)).not.toBe(id);
    expect(sessionId([], requestTrace, { id: 'different-model' })).not.toBe(id);
  });

  it('matches the reference digest and changes when compaction replaces the anchor', () => {
    expect(deriveOpenCodeSessionId(model.id, [message([text('hello')])]))
      .toBe('ac9ada0c-c2ac-dd5f-fd4e-fe859738cd49');
    expect(sessionId([message([text('Compacted summary')])]))
      .not.toBe(sessionId([message([text('hello')])]));
  });
});

describe('OpenCode session header boundary', () => {
  it.each([
    'https://opencode.ai/zen',
    'https://opencode.ai/zen/v1/',
    'https://opencode.ai/zen/go/v1',
  ])('covers existing generic provider configurations at %s', (baseUrl) => {
    const headers: Record<string, string> = { Authorization: 'Bearer test', 'User-Agent': 'ucp/test' };
    applyOpenCodeSessionHeader(headers, { ...provider, baseUrl }, model, [], trace());
    expect(headers['x-opencode-session']).toMatch(UUID);
    expect(headers['Authorization']).toBe('Bearer test');
    expect(headers['User-Agent']).toBe('ucp/test');
  });

  it.each([
    'https://api.openai.com/v1',
    'https://opencode.ai.example.test/zen/go/v1',
    'https://example.test/opencode.ai/zen/go/v1',
    'https://opencode.ai/zenith',
    'https://opencode.ai/other',
    'invalid-url',
  ])('does not change headers for %s', (baseUrl) => {
    const headers = { 'X-OpenCode-Session': 'manual', 'Other': 'keep' };
    applyOpenCodeSessionHeader(headers, { ...provider, baseUrl }, model, [], trace());
    expect(headers).toEqual({ 'X-OpenCode-Session': 'manual', 'Other': 'keep' });
  });

  it('preserves model overrides and removes duplicate case variants', () => {
    const providerHeaders = Object.freeze({ 'X-OpenCode-Session': 'provider', 'x-opencode-session': 'provider-2' });
    const modelHeaders = Object.freeze({ 'X-OpenCode-Session': 'model', Other: 'keep' });
    const headers = { ...providerHeaders, ...modelHeaders };
    applyOpenCodeSessionHeader(headers,
      { ...provider, extraHeaders: providerHeaders },
      { ...model, extraHeaders: modelHeaders }, [], trace());
    expect(headers).toEqual({ 'x-opencode-session': 'model', Other: 'keep' });
    expect(providerHeaders['X-OpenCode-Session']).toBe('provider');
    expect(modelHeaders['X-OpenCode-Session']).toBe('model');
  });

  it('preserves provider overrides after API-key placeholder expansion', () => {
    const headers = { 'X-OpenCode-Session': 'resolved-value' };
    applyOpenCodeSessionHeader(headers, {
      ...provider, extraHeaders: { 'X-OpenCode-Session': '${APIKEY}' },
    }, model, [], trace());
    expect(headers).toEqual({ 'x-opencode-session': 'resolved-value' });
  });

  it('fills blank overrides instead of sending an empty required header', () => {
    const headers: Record<string, string> = { 'X-OpenCode-Session': '  ' };
    applyOpenCodeSessionHeader(headers, {
      ...provider, extraHeaders: { 'X-OpenCode-Session': '  ' },
    }, model, [], trace());
    expect(Object.keys(headers)).toEqual(['x-opencode-session']);
    expect(headers['x-opencode-session']).toMatch(UUID);
  });
});
