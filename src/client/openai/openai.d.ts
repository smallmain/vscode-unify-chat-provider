import 'openai/resources/chat/completions';
import 'openai/resources/responses/responses';
import 'openai/lib/ChatCompletionStream';
import { ChatCompletionReasoningEffort } from 'openai/resources/chat/completions';

declare module 'openai/resources/chat/completions' {
  /**
   * OpenRouter "reasoning_details" blocks (normalized across providers).
   *
   * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
   */
  type OpenRouterReasoningDetail =
    | {
        type: 'reasoning.summary';
        summary: string;
        id?: string | null;
        format?: string;
        index?: number;
      }
    | {
        type: 'reasoning.text';
        text: string;
        signature?: string | null;
        id?: string | null;
        format?: string;
        index?: number;
      }
    | {
        type: 'reasoning.encrypted';
        data: string;
        id?: string | null;
        format?: string;
        index?: number;
      };

  /**
   * OpenRouter unified reasoning configuration.
   *
   * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#controlling-reasoning-tokens
   */
  type OpenRouterReasoningEffort = Exclude<ChatCompletionReasoningEffort, null>;

  type OpenRouterReasoningConfig =
    | {
        effort: OpenRouterReasoningEffort;
        max_tokens?: never;
        exclude?: boolean;
        enabled?: boolean;
      }
    | {
        max_tokens: number;
        effort?: never;
        exclude?: boolean;
        enabled?: boolean;
      }
    | {
        exclude?: boolean;
        enabled?: boolean;
        effort?: never;
        max_tokens?: never;
      };

  interface ChatCompletionCreateParamsBase {
    /**
     * OpenRouter unified reasoning configuration.
     *
     * OpenRouter normalizes the different ways of customizing the amount of
     * reasoning tokens that the model will use, providing a unified interface
     * across different providers.
     *
     * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
     */
    reasoning?: OpenRouterReasoningConfig;

    /**
     * Control whether to enable the thinking process.
     *
     * @see https://platform.xiaomimimo.com/#/docs/api/text-generation/openai-api
     * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
     * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
     */
    thinking?: { type: 'enabled' | 'disabled' };

    /**
     * @see https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
     */
    clear_thinking?: boolean;

    /**
     * Non-standard sampling parameter supported by some OpenAI-compatible providers.
     *
     * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
     */
    top_k?: number;

    /**
     * Non-standard parameter supported by some OpenAI-compatible providers.
     *
     * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
     */
    max_input_tokens?: number;

    /**
     * Non-standard thinking toggle supported by some OpenAI-compatible providers.
     *
     * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
     */
    enable_thinking?: boolean;

    /**
     * Non-standard thinking budget supported by some OpenAI-compatible providers.
     *
     * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
     */
    thinking_budget?: number;

    /**
     * Non-standard reasoning toggle supported by some OpenAI-compatible providers.
     *
     * Used by Cerebras for GLM-family models.
     *
     * @see https://inference-docs.cerebras.ai/capabilities/reasoning
     */
    disable_reasoning?: boolean;
  }
  interface ChatCompletionMessage {
    /**
     * Thinking reasoning content to be included in the response.
     *
     * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
     * @see https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model
     * @see https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
     */
    reasoning_content?: string;

    /**
     * Thinking reasoning content to be included in the response.
     *
     * OpenRouter returns reasoning tokens in this field by default (if available).
     *
     * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
     */
    reasoning?: string;

    /**
     * Structured reasoning blocks for preserving tool-use reasoning continuity.
     *
     * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning-blocks
     */
    reasoning_details?: OpenRouterReasoningDetail[];
  }
  interface ChatCompletionAssistantMessageParam {
    /**
     * Thinking reasoning content to be included in the response.
     *
     * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
     * @see https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model
     * @see https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
     */
    reasoning_content?: string;

    /**
     * Thinking reasoning content carried in a single `reasoning` field.
     *
     * Some OpenAI-compatible providers return reasoning in this field.
     *
     * @see https://inference-docs.cerebras.ai/capabilities/reasoning
     */
    reasoning?: string;

    /**
     * Structured reasoning blocks.
     *
     * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning-blocks
     */
    reasoning_details?: OpenRouterReasoningDetail[];
  }
  interface ChatCompletionContentPartText {
    /**
     * OpenRouter cache control for prompt caching.
     *
     * @see https://openrouter.ai/docs/guides/best-practices/prompt-caching
     */
    cache_control?: {
      type: 'ephemeral';
    };
  }
  interface ChatCompletionFunctionTool {
    /**
     * OpenRouter cache control for prompt caching.
     *
     * @see https://openrouter.ai/docs/guides/best-practices/prompt-caching
     */
    cache_control?: {
      type: 'ephemeral';
    };
  }
  namespace ChatCompletionChunk {
    namespace Choice {
      interface Delta {
        /**
         * Thinking reasoning content to be included in the response chunk.
         *
         * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
         * @see https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model
         * @see https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
         */
        reasoning_content?: string;

        /**
         * Thinking reasoning content to be included in the response chunk.
         *
         * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
         */
        reasoning?: string;

        /**
         * Structured reasoning blocks to be included in the response chunk.
         *
         * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#responses-api-shape
         */
        reasoning_details?: OpenRouterReasoningDetail[];
      }
    }
  }
}

declare module 'openai/resources/responses/responses' {
  interface ResponseCreateParamsBase {
    /**
     * Control whether to enable the thinking process.
     *
     * @see https://www.volcengine.com/docs/82379/1569618?lang=zh
     */
    thinking?: { type: 'enabled' | 'disabled' | 'auto' };
  }
}

declare module 'openai/lib/ChatCompletionStream' {
  namespace ChatCompletionSnapshot {
    namespace Choice {
      interface Message {
        /**
         * Thinking reasoning content to be included in the response chunk.
         *
         * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
         * @see https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model
         * @see https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
         */
        reasoning_content?: string;

        /**
         * Thinking reasoning content.
         *
         * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
         */
        reasoning?: string;

        /**
         * Structured reasoning blocks.
         *
         * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#responses-api-shape
         */
        reasoning_details?: import('openai/resources/chat/completions').OpenRouterReasoningDetail[];
      }
    }
  }
}
