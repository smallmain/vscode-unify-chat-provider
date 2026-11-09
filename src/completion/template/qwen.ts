import type { QwenCompletionRequest } from '../model/requests';
import { getSafeCompletionPath } from './codegemma';
import { FIM_PREFIX_TOKEN, FIM_SUFFIX_TOKEN, FIM_MIDDLE_TOKEN } from './fim';

export const QWEN_FIM_STOPS = [
  FIM_PREFIX_TOKEN, FIM_SUFFIX_TOKEN, FIM_MIDDLE_TOKEN,
  '<|file_sep|>', '<|repo_name|>', '<|fim_pad|>', '<|endoftext|>',
] as const;

function safePath(value: string | undefined): string | undefined {
  const path = getSafeCompletionPath(value);
  return path !== undefined && !QWEN_FIM_STOPS.some((token) => path.includes(token))
    ? path : undefined;
}

export function buildQwenPrompt(request: QwenCompletionRequest): string {
  const records = request.contexts.map((context) => {
    const path = safePath(context.path);
    return `<|file_sep|>${path === undefined ? '' : `${path}\n`}${context.content}`;
  });
  const path = safePath(request.targetPath);
  const target = `${FIM_PREFIX_TOKEN}${request.prefix}${FIM_SUFFIX_TOKEN}${request.suffix}${FIM_MIDDLE_TOKEN}`;
  records.push(path === undefined ? target : `<|file_sep|>${path}\n${target}`);
  return records.join('');
}
