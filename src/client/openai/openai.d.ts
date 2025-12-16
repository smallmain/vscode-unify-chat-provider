import 'openai/resources/chat/completions';
import 'openai/lib/ChatCompletionStream';

declare module 'openai/resources/chat/completions' {
  interface ChatCompletionMessage {
    /**
     * Thinking reasoning content to be included in the response.
     *
     * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
     * @see https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model
     * @see https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
     */
    reasoning_content?: string;
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
      }
    }
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
      }
    }
  }
}
