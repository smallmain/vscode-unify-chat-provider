import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelChatTool,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import { LanguageModelChatToolMode } from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type {
  ModelConfig,
  PerformanceTrace,
  ProviderConfig,
} from '../../types';
import { buildBaseUrl } from '../utils';
import { OpenAIChatCompletionProvider } from '../openai/chat-completion-client';
import type { RequestLogger } from '../../logger';
import { mergeWithWellKnownModel } from '../../well-known/models';

const QWEN_USER_AGENT = 'QwenCode/0.10.3 (darwin; arm64)';
const QWEN_STAINLESS_RUNTIME_VERSION = 'v22.17.0';
const QWEN_STAINLESS_PACKAGE_VERSION = '5.11.0';
const QWEN_STAINLESS_OS = 'MacOS';
const QWEN_STAINLESS_ARCH = 'arm64';
const QWEN_STAINLESS_RUNTIME = 'node';
const QWEN_STAINLESS_LANG = 'js';
const QWEN_STAINLESS_RETRY_COUNT = '0';
const QWEN_AUTHTYPE = 'qwen-oauth';
const QWEN_CACHE_CONTROL = 'enable';
const QWEN_SEC_FETCH_MODE = 'cors';

const QWEN_SCRUBBED_HEADER_NAMES = new Set([
  'user-agent',
  'accept',
  'content-type',
  'x-goog-api-client',
  'client-metadata',
  'x-dashscope-useragent',
  'x-dashscope-cachecontrol',
  'x-dashscope-authtype',
  'x-stainless-runtime-version',
  'x-stainless-lang',
  'x-stainless-arch',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-os',
  'x-stainless-runtime',
  'sec-fetch-mode',
]);

const QWEN_STREAM_GUARD_DUMMY_TOOL = {
  name: 'do_not_call_me',
  description:
    'Do not call this tool under any circumstances, it will have catastrophic consequences.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'number',
        description: '1:poweroff\n2:rm -fr /\n3:mkfs.ext4 /dev/sda1',
      },
    },
    required: ['operation'],
  },
} satisfies LanguageModelChatTool;

export class QwenCodeProvider extends OpenAIChatCompletionProvider {
  private assertQwenCodeAuth(): void {
    if (this.config.auth?.method !== 'qwen-code') {
      throw new Error('Qwen Code provider requires auth method "qwen-code".');
    }
  }

  protected override resolveBaseUrl(config: ProviderConfig): string {
    const auth = config.auth;
    const resourceUrl =
      auth?.method === 'qwen-code' ? auth.resourceUrl : undefined;
    if (resourceUrl && resourceUrl.trim()) {
      const base = /^https?:\/\//i.test(resourceUrl)
        ? resourceUrl
        : `https://${resourceUrl}`;
      return buildBaseUrl(base, {
        ensureSuffix: '/v1',
        skipSuffixIfMatch: /\/v\d+$/,
      });
    }

    return super.resolveBaseUrl(config);
  }

  override async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
  ): AsyncGenerator<LanguageModelResponsePart2> {
    this.assertQwenCodeAuth();
    const streamEnabled = model.stream ?? true;
    const tools = options.tools ?? [];

    const shouldInjectDummyTool =
      streamEnabled &&
      tools.length === 0 &&
      options.toolMode !== LanguageModelChatToolMode.Required;

    const nextOptions: ProvideLanguageModelChatResponseOptions =
      shouldInjectDummyTool
        ? { ...options, tools: [QWEN_STREAM_GUARD_DUMMY_TOOL] }
        : options;

    yield* super.streamChat(
      encodedModelId,
      model,
      messages,
      nextOptions,
      performanceTrace,
      token,
      logger,
      credential,
    );
  }

  protected override buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(credential, modelConfig, messages);

    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (QWEN_SCRUBBED_HEADER_NAMES.has(lower)) {
        delete headers[key];
      }
    }

    const streamEnabled = modelConfig?.stream ?? true;
    headers['Content-Type'] = 'application/json';
    headers['Accept'] = modelConfig
      ? streamEnabled
        ? 'text/event-stream'
        : 'application/json'
      : 'application/json';

    headers['User-Agent'] = QWEN_USER_AGENT;
    headers['X-Dashscope-Useragent'] = QWEN_USER_AGENT;
    headers['X-Stainless-Runtime-Version'] = QWEN_STAINLESS_RUNTIME_VERSION;
    headers['Sec-Fetch-Mode'] = QWEN_SEC_FETCH_MODE;
    headers['X-Stainless-Lang'] = QWEN_STAINLESS_LANG;
    headers['X-Stainless-Arch'] = QWEN_STAINLESS_ARCH;
    headers['X-Stainless-Package-Version'] = QWEN_STAINLESS_PACKAGE_VERSION;
    headers['X-Dashscope-Cachecontrol'] = QWEN_CACHE_CONTROL;
    headers['X-Stainless-Retry-Count'] = QWEN_STAINLESS_RETRY_COUNT;
    headers['X-Stainless-Os'] = QWEN_STAINLESS_OS;
    headers['X-Dashscope-Authtype'] = QWEN_AUTHTYPE;
    headers['X-Stainless-Runtime'] = QWEN_STAINLESS_RUNTIME;
    return headers;
  }

  async getAvailableModels(_credential: AuthTokenInfo): Promise<ModelConfig[]> {
    this.assertQwenCodeAuth();
    const coderModel = mergeWithWellKnownModel({ id: 'qwen3.5-plus' });
    coderModel.id = 'coder-model';
    const visionModel = mergeWithWellKnownModel({ id: 'qwen3-vl-plus' });
    visionModel.id = 'vision-model';
    return [
      { id: 'qwen3-coder-plus' },
      { id: 'qwen3-coder-flash' },
      coderModel,
      visionModel,
    ];
  }
}
