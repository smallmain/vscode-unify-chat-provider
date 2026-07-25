import * as vscode from 'vscode';
import { authLog } from '../logger';

type ThinkingPartMetadata = object;
type ThinkingPartConstructor = new (
  value: string | string[],
  id?: string,
  metadata?: ThinkingPartMetadata,
) => vscode.LanguageModelThinkingPart;

let unavailableWarningLogged = false;

export function getLanguageModelThinkingPartConstructor():
  | ThinkingPartConstructor
  | undefined {
  const candidate: unknown = vscode.LanguageModelThinkingPart;
  return typeof candidate === 'function'
    ? vscode.LanguageModelThinkingPart
    : undefined;
}

export function canUseLanguageModelThinkingPart(): boolean {
  return getLanguageModelThinkingPartConstructor() !== undefined;
}

export function isLanguageModelThinkingPart(
  value: unknown,
): value is vscode.LanguageModelThinkingPart {
  const Constructor = getLanguageModelThinkingPartConstructor();
  return Constructor !== undefined && value instanceof Constructor;
}

export function createLanguageModelThinkingPart(
  value: string | string[],
  id?: string,
  metadata?: ThinkingPartMetadata,
): vscode.LanguageModelThinkingPart | undefined {
  const Constructor = getLanguageModelThinkingPartConstructor();
  if (!Constructor) {
    if (!unavailableWarningLogged) {
      unavailableWarningLogged = true;
      authLog.warn(
        'proposed-api',
        'LanguageModelThinkingPart is unavailable; thinking content will be omitted',
      );
    }
    return undefined;
  }
  return new Constructor(value, id, metadata);
}

export function* createLanguageModelThinkingParts(
  value: string | string[],
  id?: string,
  metadata?: ThinkingPartMetadata,
): Generator<vscode.LanguageModelThinkingPart> {
  const part = createLanguageModelThinkingPart(value, id, metadata);
  if (part) {
    yield part;
  }
}
