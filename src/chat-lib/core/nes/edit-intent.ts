import type { NesAggressivenessLevel, NesEditIntent } from '../behavior-config';

export type NesEditIntentParseMode = 'tags' | 'shortName';

export interface NesEditIntentParseResult {
  readonly editIntent: NesEditIntent;
  readonly remainingLines: AsyncIterable<string>;
  readonly parseError?: string;
}

function intentFromString(value: string): NesEditIntent {
  switch (value) {
    case 'no_edit':
    case 'low':
    case 'medium':
    case 'high':
      return value;
    default:
      return 'high';
  }
}

function intentFromShortName(value: string): NesEditIntent | undefined {
  switch (value) {
    case 'N':
      return 'no_edit';
    case 'L':
      return 'low';
    case 'M':
      return 'medium';
    case 'H':
      return 'high';
    default:
      return undefined;
  }
}

function restOfIterator(
  iterator: AsyncIterator<string>,
  firstLine?: string,
): AsyncIterable<string> {
  return (async function* (): AsyncIterable<string> {
    if (firstLine !== undefined) {
      yield firstLine;
    }
    let next = await iterator.next();
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }
  })();
}

export async function parseNesEditIntent(
  lines: AsyncIterable<string>,
  mode: NesEditIntentParseMode,
): Promise<NesEditIntentParseResult> {
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    return {
      editIntent: 'high',
      remainingLines: restOfIterator(iterator),
      parseError: 'emptyResponse',
    };
  }

  if (mode === 'shortName') {
    const value = first.value.trim();
    const editIntent = intentFromShortName(value);
    if (editIntent !== undefined) {
      return { editIntent, remainingLines: restOfIterator(iterator) };
    }
    return {
      editIntent: 'high',
      remainingLines: restOfIterator(iterator, first.value),
      parseError: `unknownIntentValue:${value}`,
    };
  }

  const startTag = '<|edit_intent|>';
  const endTag = '<|/edit_intent|>';
  const startIndex = first.value.indexOf(startTag);
  const endIndex = first.value.indexOf(endTag);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const value = first.value
      .substring(startIndex + startTag.length, endIndex)
      .trim()
      .toLowerCase();
    const known = ['no_edit', 'low', 'medium', 'high'].includes(value);
    const afterEndTag = first.value.substring(endIndex + endTag.length);
    return {
      editIntent: intentFromString(value),
      remainingLines: restOfIterator(
        iterator,
        afterEndTag.trim() === '' ? undefined : afterEndTag,
      ),
      ...(known ? {} : { parseError: `unknownIntentValue:${value}` }),
    };
  }

  const parseError =
    startIndex !== -1 && endIndex === -1
      ? 'malformedTag:startWithoutEnd'
      : startIndex === -1 && endIndex !== -1
        ? 'malformedTag:endWithoutStart'
        : 'noTagFound';
  return {
    editIntent: 'high',
    remainingLines: restOfIterator(iterator, first.value),
    parseError,
  };
}

export function shouldShowNesEditIntent(
  editIntent: NesEditIntent,
  aggressivenessLevel: NesAggressivenessLevel,
): boolean {
  switch (editIntent) {
    case 'no_edit':
      return false;
    case 'high':
      return true;
    case 'medium':
      return aggressivenessLevel === 'medium' || aggressivenessLevel === 'high';
    case 'low':
      return aggressivenessLevel === 'high';
  }
}
