import type {
  CodeGemmaCompletionContext,
  CodeGemmaCompletionRequest,
} from '../model/requests';
import {
  FILE_SEPARATOR_TOKEN,
  FIM_MIDDLE_TOKEN,
  FIM_PREFIX_TOKEN,
  FIM_SUFFIX_TOKEN,
  containsFimProtocolToken,
} from './fim';

export function getSafeCompletionPath(
  path: string | undefined,
): string | undefined {
  const normalized = path
    ?.replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '');
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) ||
    normalized.split('/').includes('..') ||
    /[\r\n]/.test(normalized) ||
    containsFimProtocolToken(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function formatRecord(path: string | undefined, content: string): string {
  const safePath = getSafeCompletionPath(path);
  return safePath === undefined ? content : `${safePath}\n${content}`;
}

function formatContext(context: CodeGemmaCompletionContext): string {
  return formatRecord(context.path, context.content);
}

export function buildCodeGemmaPrompt(
  request: CodeGemmaCompletionRequest,
): string {
  const target = formatRecord(
    request.targetPath,
    `${FIM_PREFIX_TOKEN}${request.prefix}${FIM_SUFFIX_TOKEN}${request.suffix}${FIM_MIDDLE_TOKEN}`,
  );
  return [...request.contexts.map(formatContext), target].join(
    FILE_SEPARATOR_TOKEN,
  );
}
