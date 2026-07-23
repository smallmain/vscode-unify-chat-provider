import { NO_COMPLETION_SENTINEL } from './compatible-prompt';
import { FIM_PROTOCOL_STOPS } from './fim';

export function buildEffectiveStops(
  requestStops: readonly string[] | undefined,
): readonly string[] {
  return [
    ...new Set([
      ...(requestStops ?? []).filter((stop) => stop.length > 0),
      ...FIM_PROTOCOL_STOPS,
    ]),
  ];
}

export function truncateAtFirstStop(
  text: string,
  effectiveStops: readonly string[],
): string {
  let end = text.length;
  for (const stop of effectiveStops) {
    if (stop.length === 0) {
      continue;
    }
    const index = text.indexOf(stop);
    if (index !== -1 && index < end) {
      end = index;
    }
  }
  return text.slice(0, end);
}

export function removeCompleteMarkdownFence(text: string): string {
  const match = text.match(
    /^[ \t]*```(?!`)[^`\r\n]*\r?\n(?:([\s\S]*?)\r?\n)?[ \t]*```(?!`)[ \t]*(?:\r?\n)?$/,
  );
  return match === null ? text : (match[1] ?? '');
}

export function postprocessCompatibleCompletionText(
  text: string,
  userPrompt: string,
  effectiveStops: readonly string[],
): string {
  let processed = removeCompleteMarkdownFence(text);
  if (userPrompt.length > 0 && processed.startsWith(userPrompt)) {
    processed = processed.slice(userPrompt.length);
  }
  if (processed === NO_COMPLETION_SENTINEL) {
    return '';
  }
  return truncateAtFirstStop(processed, effectiveStops);
}

export function postprocessNativeCompletionText(
  text: string,
  effectiveStops: readonly string[],
): string {
  return truncateAtFirstStop(text, effectiveStops);
}
