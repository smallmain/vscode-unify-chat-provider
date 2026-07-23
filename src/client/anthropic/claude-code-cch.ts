import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/beta/messages';

type ClaudeCodeRequestBase = Omit<MessageCreateParamsStreaming, 'stream'>;

/**
 * Mirror the Anthropic SDK's wire body for the request shape produced here:
 * betas move to the anthropic-beta header, while stream stays in the JSON body.
 */
export function serializeClaudeCodeCchInput(
  requestBase: ClaudeCodeRequestBase,
  stream: boolean,
): string {
  const wireBody = { ...requestBase, stream };
  delete wireBody.betas;
  return JSON.stringify(wireBody);
}
