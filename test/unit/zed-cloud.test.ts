import { constants, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));
import {
  parseZedCompletionEnvelope,
  parseZedCredential,
  serializeZedCredential,
} from '../../src/client/zed/codecs';
import {
  ZedCloudClient,
  ZedCloudError,
  type ZedLlmTokenSource,
} from '../../src/client/zed/cloud-client';
import type { ZedFetch } from '../../src/client/zed/types';
import {
  buildZedUrl,
  createZedProviderIdentity,
  resolveZedBaseUrls,
} from '../../src/client/zed/urls';

const BINDING_ONE = '00000000-0000-4000-8000-000000000105';
const BINDING_TWO = '00000000-0000-4000-8000-000000000106';

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'open_ai',
    id: 'gpt-test',
    display_name: 'GPT Test',
    is_latest: true,
    max_token_count: 200_000,
    max_token_count_in_max_mode: null,
    max_output_tokens: 8192,
    supports_tools: true,
    supports_images: true,
    supports_thinking: true,
    supports_disabling_thinking: true,
    supports_fast_mode: false,
    supports_server_side_compaction: false,
    supported_effort_levels: [
      { name: 'High', value: 'high', is_default: false },
      { name: 'Maximum', value: 'max', is_default: true },
    ],
    supports_streaming_tools: true,
    supports_parallel_tool_calls: true,
    is_disabled: false,
    disabled_reason: null,
    ...overrides,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('Zed URL and credential codecs', () => {
  it('maps only the official web origin to cloud.zed.dev', () => {
    expect(resolveZedBaseUrls('https://zed.dev/')).toEqual({
      web: 'https://zed.dev',
      cloud: 'https://cloud.zed.dev',
    });
    expect(resolveZedBaseUrls('https://zed.example/base/')).toEqual({
      web: 'https://zed.example/base',
      cloud: 'https://zed.example/base',
    });
    expect(buildZedUrl('https://zed.example/base/', '/models')).toBe(
      'https://zed.example/base/models',
    );
  });

  it('round-trips typed credentials and partitions identity by URL and auth identity', () => {
    const serialized = serializeZedCredential({
      userId: '42',
      accessToken: 'secret',
    });
    expect(parseZedCredential(serialized)).toEqual({
      userId: '42',
      accessToken: 'secret',
    });
    const first = createZedProviderIdentity({
      name: 'Zed',
      baseUrl: 'https://zed.dev',
      auth: { method: 'zed', bindingId: BINDING_ONE },
    });
    const second = createZedProviderIdentity({
      name: 'Zed',
      baseUrl: 'https://self-hosted.example',
      auth: { method: 'zed', bindingId: BINDING_ONE },
    });
    const third = createZedProviderIdentity({
      name: 'Zed',
      baseUrl: 'https://zed.dev',
      auth: { method: 'zed', bindingId: BINDING_TWO },
    });
    expect(new Set([first.key, second.key, third.key]).size).toBe(3);
    const firstSubject = createZedProviderIdentity(
      {
        name: 'Zed',
        baseUrl: 'https://zed.dev',
        auth: { method: 'zed', bindingId: BINDING_ONE },
      },
      'user-one',
    );
    const secondSubject = createZedProviderIdentity(
      {
        name: 'Zed',
        baseUrl: 'https://zed.dev',
        auth: { method: 'zed', bindingId: BINDING_ONE },
      },
      'user-two',
    );
    expect(firstSubject.key).not.toBe(secondSubject.key);
    expect(firstSubject.key).not.toContain('user-one');
    expect(firstSubject.key).not.toContain('secret');
  });
});

describe('Zed Cloud HTTP transport', () => {
  it('uses long credentials only on account endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: ZedFetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      return jsonResponse({
        user: { id_v2: 'u', username: 'zed-user' },
        organizations: [
          { id: 'org', name: 'Personal', is_personal: true },
        ],
        default_organization_id: 'org',
        configuration_by_organization: {
          org: {
            edit_prediction: {
              is_enabled: true,
              is_feedback_enabled: false,
            },
          },
        },
      });
    };
    const client = new ZedCloudClient('https://zed.dev', fetcher);
    const user = await client.getAuthenticatedUser(
      { userId: '7', accessToken: 'long-secret' },
      'system-id',
    );
    expect(user.organizations[0]?.editPrediction.isFeedbackEnabled).toBe(false);
    expect(requests[0]?.url).toBe('https://cloud.zed.dev/client/users/me');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('7 long-secret');
    expect(headers.get('x-zed-system-id')).toBe('system-id');
    expect(headers.has('x-zed-version')).toBe(false);
  });

  it('refreshes a rejected LLM token once and skips unknown models', async () => {
    const seenTokens: string[] = [];
    const skipped: Array<[string, unknown]> = [];
    const fetcher: ZedFetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenTokens.push(headers.get('authorization') ?? '');
      if (seenTokens.length === 1) {
        return new Response('expired', {
          status: 401,
          headers: { 'x-zed-expired-token': 'true' },
        });
      }
      return jsonResponse({
        models: [model(), model({ id: 'future', provider: 'future_provider' })],
        default_model: null,
        default_fast_model: null,
        recommended_models: [],
      });
    };
    const tokens: ZedLlmTokenSource = {
      cached: vi.fn(async () => 'old'),
      refresh: vi.fn(async () => 'fresh'),
    };
    const result = await new ZedCloudClient(
      'https://zed.dev',
      fetcher,
    ).listModels(tokens, 'org', {
      onUnknownProvider: (id, provider) => skipped.push([id, provider]),
    });
    expect(seenTokens).toEqual(['Bearer old', 'Bearer fresh']);
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(result.models.map((item) => item.id)).toEqual(['gpt-test']);
    expect(result.models[0]).toMatchObject({
      name: 'GPT Test',
      maxInputTokens: 200_000,
      maxOutputTokens: 8192,
      capabilities: { toolCalling: true, imageInput: true },
      thinking: { type: 'auto', effort: 'max' },
      presetTemplates: [
        {
          id: 'reasoningEffort',
          default: 'max',
          presets: [
            {
              id: 'high',
              name: 'High',
              config: { thinking: { type: 'auto', effort: 'high' } },
            },
            {
              id: 'max',
              name: 'Maximum',
              config: { thinking: { type: 'auto', effort: 'max' } },
            },
          ],
        },
      ],
    });
    expect(result.routes).toEqual([
      {
        organizationId: 'org',
        modelId: 'gpt-test',
        upstreamProvider: 'open_ai',
      },
    ]);
    expect(skipped).toEqual([['future', 'future_provider']]);
  });

  it('compresses v3 requests with zstd and sends exact prediction headers', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const prepared: Array<{ headers: Record<string, string>; requestId: string }> = [];
    const fetcher: ZedFetch = async (input, init) => {
      request = { url: input.toString(), init };
      return jsonResponse({
        request_id: 'server-request',
        output: '',
        editable_range: { start: 1, end: 2 },
        cursor_offset: 0,
      });
    };
    const tokens: ZedLlmTokenSource = {
      cached: async () => 'llm-token',
      refresh: async () => 'refreshed',
    };
    const result = await new ZedCloudClient(
      'https://custom.example/root',
      fetcher,
      { 'X-Provider': 'provider-value', Authorization: 'provider-override' },
    ).predictEditsV3(
      tokens,
      { cursor_excerpt: 'source', events: [] },
      {
        requestId: 'client-request',
        trigger: 'buffer_edit',
        preferredExperiment: 'experiment-a',
        extraHeaders: {
          'X-Model': 'model-value',
          Authorization: 'model-override',
        },
        onRequestPrepared: ({ headers, requestId }) => {
          prepared.push({ headers, requestId });
        },
      },
    );
    expect(result).toEqual({
      requestId: 'server-request',
      output: '',
      editableRange: { start: 1, end: 2 },
      cursorOffset: 0,
    });
    expect(request?.url).toBe(
      'https://custom.example/root/predict_edits/v3',
    );
    const headers = new Headers(request?.init?.headers);
    expect(headers.get('content-encoding')).toBe('zstd');
    expect(headers.get('x-zed-version')).toBe('1.13.0');
    expect(headers.get('x-zed-predict-edits-mode')).toBe('eager');
    expect(headers.get('x-zed-predict-edits-request-id')).toBe(
      'client-request',
    );
    expect(headers.get('x-zed-predict-edits-trigger')).toBe('buffer_edit');
    expect(headers.get('x-zed-preferred-experiment')).toBe('experiment-a');
    expect(headers.get('x-provider')).toBe('provider-value');
    expect(headers.get('x-model')).toBe('model-value');
    expect(headers.get('authorization')).toBe('Bearer llm-token');
    expect(prepared).toHaveLength(1);
    expect(new Headers(prepared[0]?.headers).get('authorization')).toBe(
      'Bearer llm-token',
    );
    expect(prepared[0]?.requestId).toBe('client-request');
    const compressed = request?.init?.body;
    expect(Buffer.isBuffer(compressed)).toBe(true);
    const decoded = zstdDecompressSync(compressed as Buffer).toString('utf8');
    expect(JSON.parse(decoded)).toEqual({
      cursor_excerpt: 'source',
      events: [],
    });
    expect(constants.ZSTD_c_compressionLevel).toBeTypeOf('number');
  });

  it('applies provider headers to account, models, chat and feedback requests', async () => {
    const requests: Array<{ path: string; headers: Headers }> = [];
    const fetcher: ZedFetch = async (input, init) => {
      const path = new URL(input.toString()).pathname;
      requests.push({ path, headers: new Headers(init?.headers) });
      if (path === '/client/users/me') {
        return jsonResponse({
          user: { id_v2: 'u', username: 'user' },
          organizations: [{ id: 'org', name: 'Org', is_personal: true }],
          default_organization_id: 'org',
          configuration_by_organization: {},
        });
      }
      if (path === '/models') {
        return jsonResponse({
          models: [model()],
          default_model: null,
          default_fast_model: null,
          recommended_models: [],
        });
      }
      if (path === '/completions') {
        return new Response('{"status":"stream_ended"}\n', {
          status: 200,
          headers: { 'x-zed-server-supports-status-messages': 'true' },
        });
      }
      return jsonResponse(null);
    };
    const tokens: ZedLlmTokenSource = {
      cached: async () => 'llm',
      refresh: async () => 'fresh',
    };
    const client = new ZedCloudClient('https://zed.dev', fetcher, {
      'X-Provider': 'provider-value',
      Authorization: 'must-not-win',
    });
    await client.getAuthenticatedUser({ userId: 'u', accessToken: 'long' });
    await client.listModels(tokens, 'org');
    await client.complete(
      tokens,
      {
        provider: 'open_ai',
        model: 'gpt-test',
        provider_request: {},
      },
      undefined,
      { 'X-Model': 'chat-value' },
    );
    await client.accept(tokens, { request_id: 'request' }, {
      'X-Model': 'feedback-value',
    });

    expect(requests.every(({ headers }) => headers.get('x-provider') === 'provider-value')).toBe(
      true,
    );
    expect(requests.find(({ path }) => path === '/client/users/me')?.headers.get('authorization')).toBe(
      'u long',
    );
    expect(requests.find(({ path }) => path === '/models')?.headers.get('authorization')).toBe(
      'Bearer llm',
    );
    expect(requests.find(({ path }) => path === '/completions')?.headers.get('x-model')).toBe(
      'chat-value',
    );
    expect(requests.find(({ path }) => path === '/predict_edits/accept')?.headers.get('x-model')).toBe(
      'feedback-value',
    );
  });

  it('requires the completion capability envelope and parses unit statuses', async () => {
    let headers: Headers | undefined;
    const fetcher: ZedFetch = async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response(
        '{"status":"started"}\n{"event":{"type":"response.output_text.delta","delta":"ok"}}\n{"status":"stream_ended"}\n',
        {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
            'x-zed-server-supports-status-messages': 'true',
          },
        },
      );
    };
    const tokens: ZedLlmTokenSource = {
      cached: async () => 'token',
      refresh: async () => 'refresh',
    };
    const result = await new ZedCloudClient(
      'https://zed.dev',
      fetcher,
    ).complete(tokens, {
      thread_id: 'thread',
      prompt_id: 'prompt',
      provider: 'open_ai',
      model: 'gpt-test',
      provider_request: { model: 'gpt-test' },
    });
    expect(result.includesStatusMessages).toBe(true);
    expect(headers?.get('x-zed-version')).toBe('1.13.0');
    expect(headers?.get('x-zed-client-supports-status-messages')).toBe('true');
    expect(
      headers?.get(
        'x-zed-client-supports-stream-ended-request-completion-status',
      ),
    ).toBe('true');
    expect(parseZedCompletionEnvelope({ status: 'started' })).toEqual({
      kind: 'status',
      status: { kind: 'started' },
    });
    expect(parseZedCompletionEnvelope({ status: 'stream_ended' })).toEqual({
      kind: 'status',
      status: { kind: 'stream_ended' },
    });
  });

  it('surfaces a newer minimum protocol version without retrying', async () => {
    const fetcher: ZedFetch = async () =>
      new Response('upgrade', {
        status: 426,
        headers: { 'x-zed-minimum-required-version': '1.14.0' },
      });
    const tokens: ZedLlmTokenSource = {
      cached: vi.fn(async () => 'token'),
      refresh: vi.fn(async () => 'refresh'),
    };
    await expect(
      new ZedCloudClient('https://zed.dev', fetcher).listModels(tokens, 'org'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ZedCloudError>>({
        message:
          'Zed Cloud requires protocol version 1.14.0, but this extension implements 1.13.0.',
      }),
    );
    expect(tokens.refresh).not.toHaveBeenCalled();
  });
});
