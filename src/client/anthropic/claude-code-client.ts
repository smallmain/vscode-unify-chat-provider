import type { AuthTokenInfo } from '../../auth/types';
import type { AuthConfig } from '../../auth/types';
import type { ModelConfig } from '../../types';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
  MessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AnthropicProvider } from './client';

const DEFAULT_CLAUDE_CODE_CLI_VERSION = '2.1.5';
const DEFAULT_CLAUDE_SDK_VERSION = '0.71.2';

const CLAUDE_CODE_SYSTEM_PROMPT_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

function createClaudeCodeSystemPrompt(): BetaTextBlockParam {
  return {
    type: 'text',
    text: CLAUDE_CODE_SYSTEM_PROMPT_TEXT,
  };
}

const MCP_TOOL_PREFIX = 'mcp_';
const NON_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  'memory',
  'web_search',
]);

const SYSTEM_PROMPT_SANITIZERS: ReadonlyArray<[pattern: RegExp, to: string]> = [
  [/GitHub Copilot/gi, 'Claude Code'],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createToolNameTextRewriter(
  map: ReadonlyMap<string, string>,
): (text: string) => string {
  const toolNames = Array.from(map.keys()).sort((a, b) => b.length - a.length);
  if (toolNames.length === 0) {
    return (text) => text;
  }

  const alternation = toolNames.map(escapeRegExp).join('|');
  const identifierCharPattern = '0-9A-Za-z_';
  const pattern = new RegExp(
    `(^|[^${identifierCharPattern}])(${alternation})(?=[^${identifierCharPattern}]|$)`,
    'g',
  );
  return (text) =>
    text.replace(pattern, (_match: string, prefix: string, name: string) => {
      return `${prefix}${map.get(name) ?? name}`;
    });
}

function sanitizeSystemPromptText(text: string): string {
  let sanitized = text;
  for (const [pattern, to] of SYSTEM_PROMPT_SANITIZERS) {
    sanitized = sanitized.replace(pattern, to);
  }
  return sanitized;
}

function pickStableAuthIdentifier(auth: AuthConfig | undefined): string | null {
  if (!auth || auth.method === 'none') {
    return null;
  }
  if (
    'identityId' in auth &&
    typeof auth.identityId === 'string' &&
    auth.identityId.trim() !== ''
  ) {
    return auth.identityId.trim();
  }
  if ('email' in auth && typeof auth.email === 'string' && auth.email.trim()) {
    return auth.email.trim();
  }
  if (
    auth.method === 'api-key' &&
    'apiKey' in auth &&
    typeof auth.apiKey === 'string' &&
    auth.apiKey.trim()
  ) {
    return auth.apiKey.trim();
  }
  return null;
}

function generateFakeUserId(options?: { seed?: string | null }): string {
  const seed = options?.seed?.trim();
  const hexPart = seed
    ? createHash('sha256').update(seed, 'utf8').digest('hex')
    : randomBytes(32).toString('hex');
  const uuid = randomUUID();
  return `user_${hexPart}_account__session_${uuid}`;
}

function isValidUserId(userId: string): boolean {
  const pattern =
    /^user_[a-fA-F0-9]{64}_account__session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return pattern.test(userId);
}

function toTextBlocks(
  system: Omit<MessageCreateParamsStreaming, 'stream'>['system'],
): BetaTextBlockParam[] {
  if (!system) {
    return [];
  }
  if (typeof system === 'string') {
    const text = system.trim();
    return text ? [{ type: 'text', text }] : [];
  }
  return system;
}

export class AnthropicClaudeCodeProvider extends AnthropicProvider {
  protected override toProviderToolName(name: string): string {
    if (NON_MCP_TOOL_NAMES.has(name)) {
      return name;
    }
    return name.startsWith(MCP_TOOL_PREFIX)
      ? name
      : `${MCP_TOOL_PREFIX}${name}`;
  }

  protected override fromProviderToolName(name: string): string {
    return name.startsWith(MCP_TOOL_PREFIX)
      ? name.slice(MCP_TOOL_PREFIX.length)
      : name;
  }

  protected override buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    options?: { stream?: boolean },
  ): Record<string, string | null> {
    const headers = super.buildHeaders(credential, modelConfig, options);

    // const apiKey = getToken(credential);
    // if (apiKey) {
    //   headers['Authorization'] = `Bearer ${apiKey}`;
    // }

    const cliVersion = DEFAULT_CLAUDE_CODE_CLI_VERSION;
    const sdkVersion = DEFAULT_CLAUDE_SDK_VERSION;

    headers['User-Agent'] = `claude-cli/${cliVersion} (external, cli)`;
    headers['x-app'] = 'cli';
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    headers['Content-Type'] = 'application/json';
    headers['Accept'] = 'application/json';

    headers['X-Stainless-Lang'] = 'js';
    headers['X-Stainless-Package-Version'] = sdkVersion;
    headers['X-Stainless-OS'] = 'Linux';
    headers['X-Stainless-Arch'] = 'x64';
    headers['X-Stainless-Runtime'] = 'node';
    headers['X-Stainless-Runtime-Version'] = 'v24.6.0';
    headers['X-Stainless-Retry-Count'] = '0';
    headers['X-Stainless-Timeout'] = '600';

    if (options?.stream) {
      headers['x-stainless-helper-method'] = 'stream';
    }

    return headers;
  }

  protected override addAdditionalBetaFeatures(options: {
    betaFeatures: Set<string>;
    model: ModelConfig;
    stream: boolean;
    hasMemoryTool: boolean;
    fineGrainedToolStreamingEnabled: boolean;
    anthropicInterleavedThinkingEnabled: boolean;
  }): void {
    options.betaFeatures.add('claude-code-20250219');
    if (this.config.auth && this.config.auth.method !== 'api-key') {
      options.betaFeatures.add('oauth-2025-04-20');
    }
    options.betaFeatures.add('interleaved-thinking-2025-05-14');
    options.betaFeatures.add('context-management-2025-06-27');
  }

  protected override transformRequestBase(
    requestBase: Omit<MessageCreateParamsStreaming, 'stream'>,
    options: {
      model: ModelConfig;
      stream: boolean;
      credential?: AuthTokenInfo;
      historyUserId?: string;
      requestState: { userId?: string };
    },
  ): Omit<MessageCreateParamsStreaming, 'stream'> {
    const strictMode = false;
    const normalizeParams = true;

    // Match Claude-Cloak's behavior:
    // - System prompt injection (strict vs non-strict)
    // - Ensure metadata.user_id is stable across turns (Claude Code format)
    // - Strip top_p (only when NORMALIZE_PARAMS=true)
    const systemBlocks = toTextBlocks(requestBase.system);
    const claudeSystemPrompt = createClaudeCodeSystemPrompt();
    const mergedSystem = strictMode
      ? [claudeSystemPrompt]
      : [
          claudeSystemPrompt,
          ...systemBlocks.map((v) => {
            v.text = `${CLAUDE_CODE_SYSTEM_PROMPT_TEXT}\n\n${v.text}`;
            return v;
          }),
        ];

    // Sanitize system prompt - server may block "GitHub Copilot" string.
    for (const block of mergedSystem) {
      block.text = sanitizeSystemPromptText(block.text);
    }
    requestBase.system = mergedSystem;

    const userId =
      options.historyUserId && isValidUserId(options.historyUserId)
        ? options.historyUserId
        : generateFakeUserId({
            seed: pickStableAuthIdentifier(this.config.auth),
          });
    options.requestState.userId = userId;
    requestBase.metadata = { user_id: userId };

    if (normalizeParams && 'top_p' in requestBase) {
      delete requestBase.top_p;
    }

    this.rewriteToolNameReferences(requestBase);

    return requestBase;
  }

  private createMcpToolNameTextRewriter(
    requestBase: Omit<MessageCreateParamsStreaming, 'stream'>,
  ): (text: string) => string {
    const map = new Map<string, string>();

    const registerName = (name: string): void => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      const localName = this.fromProviderToolName(trimmed);
      const providerName = this.toProviderToolName(localName);
      if (localName !== providerName) {
        map.set(localName, providerName);
      }
    };

    if (requestBase.tools) {
      for (const tool of requestBase.tools) {
        if ('name' in tool && typeof tool.name === 'string') {
          registerName(tool.name);
        }
      }
    }

    if (requestBase.tool_choice?.type === 'tool') {
      registerName(requestBase.tool_choice.name);
    }

    for (const message of requestBase.messages) {
      if (typeof message.content === 'string') {
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          registerName(block.name);
        }
      }
    }

    return createToolNameTextRewriter(map);
  }

  private rewriteToolNameReferences(
    requestBase: Omit<MessageCreateParamsStreaming, 'stream'>,
  ): void {
    const rewriteText = this.createMcpToolNameTextRewriter(requestBase);

    if (requestBase.system) {
      const systemBlocks = toTextBlocks(requestBase.system);
      for (const block of systemBlocks) {
        block.text = rewriteText(block.text);
      }
      requestBase.system = systemBlocks;
    }

    for (const message of requestBase.messages) {
      this.rewriteToolNameReferencesInMessage(message, rewriteText);
    }

    if (requestBase.tools) {
      for (const tool of requestBase.tools) {
        if (
          'input_schema' in tool &&
          'name' in tool &&
          typeof tool.name === 'string'
        ) {
          tool.name = this.toProviderToolName(tool.name);
        }
        if ('description' in tool && typeof tool.description === 'string') {
          tool.description = rewriteText(tool.description);
        }
      }
    }

    if (requestBase.tool_choice?.type === 'tool') {
      requestBase.tool_choice.name = this.toProviderToolName(
        requestBase.tool_choice.name,
      );
    }
  }

  private rewriteToolNameReferencesInMessage(
    message: BetaMessageParam,
    rewriteText: (text: string) => string,
  ): void {
    if (typeof message.content === 'string') {
      message.content = rewriteText(message.content);
      return;
    }

    for (const block of message.content) {
      this.rewriteToolNameReferencesInContentBlock(block, rewriteText);
    }
  }

  private rewriteToolNameReferencesInContentBlock(
    block: BetaContentBlockParam,
    rewriteText: (text: string) => string,
  ): void {
    switch (block.type) {
      case 'text':
        block.text = rewriteText(block.text);
        break;

      case 'thinking':
        block.thinking = rewriteText(block.thinking);
        break;

      case 'tool_use':
        block.name = this.toProviderToolName(block.name);
        break;

      case 'tool_result':
        if (block.content === undefined) {
          break;
        }
        if (typeof block.content === 'string') {
          block.content = rewriteText(block.content);
        } else {
          for (const item of block.content) {
            if (item.type === 'text') {
              item.text = rewriteText(item.text);
            }
          }
        }
        break;

      default:
        break;
    }
  }
}
