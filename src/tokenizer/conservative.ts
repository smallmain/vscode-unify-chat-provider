import * as vscode from 'vscode';
import {
  isCacheControlMarker,
  isImageMarker,
  isInternalMarker,
  isUsageMarker,
} from '../utils';
import { isLanguageModelThinkingPart } from '../proposed-api/thinking';

/**
 * Default conservative token count estimator.
 *
 * Rationale: See `deep-research-report.md` — exact token counting across vendors/models
 * is effectively impossible; we prefer a stable, conservative approximation.
 */

const BYTES_PER_TOKEN = 3;
const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_PART_TOKENS = 512;

type CountState = {
  utf8Bytes: number;
  extraTokens: number;
};

function addUtf8Bytes(state: CountState, text: string): void {
  if (!text) return;
  state.utf8Bytes += Buffer.byteLength(text, 'utf8');
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json ?? '';
  } catch {
    return String(value);
  }
}

function countUnknown(state: CountState, value: unknown): void {
  if (value == null) return;

  if (typeof value === 'string') {
    addUtf8Bytes(state, value);
    return;
  }

  if (value instanceof vscode.LanguageModelTextPart) {
    addUtf8Bytes(state, value.value);
    return;
  }

  if (isLanguageModelThinkingPart(value)) {
    const contents =
      typeof value.value === 'string' ? [value.value] : value.value;
    addUtf8Bytes(state, contents.join(''));
    return;
  }

  if (value instanceof vscode.LanguageModelToolCallPart) {
    addUtf8Bytes(state, value.name);
    addUtf8Bytes(state, stringifyUnknown(value.input));
    return;
  }

  if (
    value instanceof vscode.LanguageModelToolResultPart ||
    value instanceof vscode.LanguageModelToolResultPart2
  ) {
    for (const part of value.content) {
      countUnknown(state, part);
    }
    return;
  }

  if (value instanceof vscode.LanguageModelPromptTsxPart) {
    addUtf8Bytes(state, stringifyUnknown(value.value));
    return;
  }

  if (value instanceof vscode.LanguageModelDataPart) {
    if (
      isInternalMarker(value) ||
      isCacheControlMarker(value) ||
      isUsageMarker(value)
    ) {
      return;
    }
    if (isImageMarker(value)) {
      state.extraTokens += IMAGE_PART_TOKENS;
      return;
    }
    state.extraTokens += value.data.byteLength;
    return;
  }

  if (value instanceof Uint8Array) {
    state.extraTokens += value.byteLength;
    return;
  }

  addUtf8Bytes(state, stringifyUnknown(value));
}

export function provideTokenCountConservative(
  _model: vscode.LanguageModelChatInformation,
  text: string | vscode.LanguageModelChatRequestMessage,
  _token: vscode.CancellationToken,
): number {
  const state: CountState = { utf8Bytes: 0, extraTokens: 0 };

  if (typeof text === 'string') {
    addUtf8Bytes(state, text);
  } else {
    state.extraTokens += MESSAGE_OVERHEAD_TOKENS;
    for (const part of text.content) {
      countUnknown(state, part);
    }
  }

  const tokensFromBytes = Math.ceil(state.utf8Bytes / BYTES_PER_TOKEN);
  const total = tokensFromBytes + state.extraTokens;

  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return total;
}
