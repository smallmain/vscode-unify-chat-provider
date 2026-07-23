import * as vscode from 'vscode';
import {
  isCacheControlMarker,
  isImageMarker,
  isInternalMarker,
  isUsageMarker,
} from '../utils';
import { isLanguageModelThinkingPart } from '../proposed-api/thinking';

const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_PART_TOKENS = 512;

type CountState = {
  textParts: string[];
  extraTokens: number;
};

export type TokenizedInput = {
  textContent: string;
  extraTokens: number;
};

function pushText(state: CountState, text: string): void {
  if (text.length > 0) {
    state.textParts.push(text);
  }
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

function collectUnknown(state: CountState, value: unknown): void {
  if (value == null) return;

  if (typeof value === 'string') {
    pushText(state, value);
    return;
  }

  if (value instanceof vscode.LanguageModelTextPart) {
    pushText(state, value.value);
    return;
  }

  if (isLanguageModelThinkingPart(value)) {
    const chunks =
      typeof value.value === 'string' ? [value.value] : value.value;
    pushText(state, chunks.join(''));
    return;
  }

  if (value instanceof vscode.LanguageModelToolCallPart) {
    pushText(state, value.name);
    pushText(state, stringifyUnknown(value.input));
    return;
  }

  if (
    value instanceof vscode.LanguageModelToolResultPart ||
    value instanceof vscode.LanguageModelToolResultPart2
  ) {
    for (const part of value.content) {
      collectUnknown(state, part);
    }
    return;
  }

  if (value instanceof vscode.LanguageModelPromptTsxPart) {
    pushText(state, stringifyUnknown(value.value));
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

  pushText(state, stringifyUnknown(value));
}

export function collectTokenizedInput(
  text: string | vscode.LanguageModelChatRequestMessage,
): TokenizedInput {
  const state: CountState = { textParts: [], extraTokens: 0 };

  if (typeof text === 'string') {
    pushText(state, text);
  } else {
    state.extraTokens += MESSAGE_OVERHEAD_TOKENS;
    for (const part of text.content) {
      collectUnknown(state, part);
    }
  }

  return {
    textContent: state.textParts.join(''),
    extraTokens: state.extraTokens,
  };
}
