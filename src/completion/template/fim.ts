import type { FimCompletionRequest } from '../model/requests';

export const FIM_PREFIX_TOKEN = '<|fim_prefix|>';
export const FIM_SUFFIX_TOKEN = '<|fim_suffix|>';
export const FIM_MIDDLE_TOKEN = '<|fim_middle|>';
export const FILE_SEPARATOR_TOKEN = '<|file_separator|>';

export const FIM_PROTOCOL_STOPS = [
  FIM_PREFIX_TOKEN,
  FIM_SUFFIX_TOKEN,
  FIM_MIDDLE_TOKEN,
  FILE_SEPARATOR_TOKEN,
] as const;

export function containsFimProtocolToken(value: string): boolean {
  return FIM_PROTOCOL_STOPS.some((token) => value.includes(token));
}

export function buildFimPrompt(request: FimCompletionRequest): string {
  return `${FIM_PREFIX_TOKEN}${request.prefix}${FIM_SUFFIX_TOKEN}${request.suffix}${FIM_MIDDLE_TOKEN}`;
}
