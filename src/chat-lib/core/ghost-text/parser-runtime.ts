import { resolve } from 'node:path';

interface GhostTextParserRuntime {
  isSupportedLanguageId(languageId: string): boolean;
  isBlockTrimmerSupported(languageId: string): boolean;
  blockPositionTypeAt(
    languageId: string,
    text: string,
    offset: number,
  ): Promise<string>;
  isEmptyBlockStart(
    languageId: string,
    text: string,
    offset: number,
  ): Promise<boolean>;
  isBlockBodyFinished(
    languageId: string,
    prefix: string,
    completion: string,
    offset: number,
  ): Promise<number | undefined>;
  trimWithTerseBlockTrimmer(
    languageId: string,
    prefix: string,
    completion: string,
    lineLimit?: number,
    lookAhead?: number,
  ): Promise<number | undefined>;
}

let parserRuntime: GhostTextParserRuntime | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGhostTextParserRuntime(
  value: unknown,
): value is GhostTextParserRuntime {
  return (
    isRecord(value) &&
    typeof value.isSupportedLanguageId === 'function' &&
    typeof value.isBlockTrimmerSupported === 'function' &&
    typeof value.blockPositionTypeAt === 'function' &&
    typeof value.isEmptyBlockStart === 'function' &&
    typeof value.isBlockBodyFinished === 'function' &&
    typeof value.trimWithTerseBlockTrimmer === 'function'
  );
}

function getParserRuntime(): GhostTextParserRuntime {
  if (parserRuntime) {
    return parserRuntime;
  }
  const bundlePath = resolve(
    __dirname,
    '../../../../dist/chat-lib-parser.cjs',
  );
  const loaded: unknown = require(bundlePath);
  if (!isGhostTextParserRuntime(loaded)) {
    throw new Error(`Invalid GhostText parser runtime at ${bundlePath}.`);
  }
  parserRuntime = loaded;
  return loaded;
}

export function isSupportedParserLanguage(languageId: string): boolean {
  return getParserRuntime().isSupportedLanguageId(languageId);
}

export function isSupportedBlockTrimmerLanguage(languageId: string): boolean {
  return getParserRuntime().isBlockTrimmerSupported(languageId);
}

export async function blockPositionTypeAt(
  languageId: string,
  text: string,
  offset: number,
): Promise<GhostTextBlockPosition> {
  const value = await getParserRuntime().blockPositionTypeAt(
    languageId,
    text,
    offset,
  );
  if (!isGhostTextBlockPosition(value)) {
    throw new Error(`Invalid GhostText block position: ${value}.`);
  }
  return value;
}

export function isEmptyBlockStart(
  languageId: string,
  text: string,
  offset: number,
): Promise<boolean> {
  return getParserRuntime().isEmptyBlockStart(languageId, text, offset);
}

export function isBlockBodyFinished(
  languageId: string,
  prefix: string,
  completion: string,
  offset: number,
): Promise<number | undefined> {
  return getParserRuntime().isBlockBodyFinished(
    languageId,
    prefix,
    completion,
    offset,
  );
}

export function trimWithTerseBlockTrimmer(
  languageId: string,
  prefix: string,
  completion: string,
  lineLimit?: number,
  lookAhead?: number,
): Promise<number | undefined> {
  return getParserRuntime().trimWithTerseBlockTrimmer(
    languageId,
    prefix,
    completion,
    lineLimit,
    lookAhead,
  );
}

export type GhostTextBlockPosition =
  | 'non-block'
  | 'empty-block'
  | 'block-end'
  | 'mid-block';

function isGhostTextBlockPosition(value: string): value is GhostTextBlockPosition {
  return (
    value === 'non-block' ||
    value === 'empty-block' ||
    value === 'block-end' ||
    value === 'mid-block'
  );
}
