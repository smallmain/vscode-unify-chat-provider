import { realpath as nodeRealpath } from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import type {
  Zeta3InternalCompletionRequest,
  ZetaCompletionRequest,
} from '../model/requests';
import { ZED_LICENSE_PATTERN_SOURCES } from './license-patterns';

export interface ZedDataCollectionPolicy {
  readonly dataCollectionEnabled: boolean;
  readonly dataCollectionAllowed: boolean;
}

export interface ZedDataCollectionDecision {
  readonly canCollectData: boolean;
  readonly isInOpenSourceRepo: boolean;
  readonly repoUrl?: string;
}

export const NO_ZED_DATA_COLLECTION: ZedDataCollectionDecision = {
  canCollectData: false,
  isInOpenSourceRepo: false,
};

const PRIVATE_FILE_GLOBS = [
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/*.cert',
  '**/*.crt',
  '**/secrets.yml',
] as const;

const LICENSE_FILE_NAME = /^(?:(?:licen[cs]e)(?:[-._]?(?:apache(?:[-._](?:2\.0|2))?|0?bsd(?:[-._][0123])?(?:[-._]clause)?|isc|mit|upl|zlib))?|(?:apache(?:[-._](?:2\.0|2))?|0?bsd(?:[-._][0123])?(?:[-._]clause)?|isc|mit|upl|zlib))(?:[-._]?(?:licen[cs]e))?(?:\.txt|\.md)?$/i;

function canonicalizeLicenseText(text: string): string {
  let filtered = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    const asciiWhitespace =
      code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
    const alphanumeric = /[\p{L}\p{N}]/u.test(character);
    if (!asciiWhitespace && !alphanumeric) continue;
    filtered += code >= 65 && code <= 90
      ? String.fromCharCode(code + 32)
      : character;
  }
  return filtered.trim().split(/[\t\n\v\f\r ]+/).join(' ');
}

interface PatternPart {
  optional: boolean;
  matchAnyChars: { start: number; end: number };
  text: readonly string[];
}

interface ParsedLicensePatterns {
  readonly patterns: readonly (readonly PatternPart[])[];
  readonly approximateMaxLength: number;
}

function parsePattern(source: string): {
  readonly parts: readonly PatternPart[];
  readonly approximateMaxLength: number;
} {
  const parts: PatternPart[] = [];
  let part: PatternPart = {
    optional: false,
    matchAnyChars: { start: 0, end: 0 },
    text: [],
  };
  let approximateMaxLength = 0;
  const pushPart = (): void => {
    if (
      part.optional ||
      part.matchAnyChars.start !== 0 ||
      part.matchAnyChars.end !== 0 ||
      part.text.length > 0
    ) {
      parts.push(part);
    }
    part = {
      optional: false,
      matchAnyChars: { start: 0, end: 0 },
      text: [],
    };
  };

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) {
      pushPart();
      const chunks = trimmed.slice(2).trim().split(/\s+/);
      if (chunks.length < 1 || chunks.length > 2) {
        throw new Error(`Invalid Zed license pattern directive: ${line}`);
      }
      const bounds = chunks[0]?.split('..');
      const start = Number(bounds?.[0]);
      const end = Number(bounds?.[1]);
      if (
        bounds?.length !== 2 ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end
      ) {
        throw new Error(`Invalid Zed license pattern directive: ${line}`);
      }
      part.optional = chunks.length === 2;
      part.matchAnyChars = { start, end };
      approximateMaxLength += end;
      continue;
    }
    approximateMaxLength += Buffer.byteLength(line) + 1;
    const canonical = canonicalizeLicenseText(line);
    if (!canonical) continue;
    const current = [...part.text];
    if (current.length > 0) current.push(' ');
    current.push(...canonical);
    part.text = current;
  }
  pushPart();
  return { parts, approximateMaxLength };
}

const LICENSE_PATTERNS: ParsedLicensePatterns = (() => {
  const patterns: (readonly PatternPart[])[] = [];
  let approximateMaxLength = 0;
  for (const pattern of ZED_LICENSE_PATTERN_SOURCES) {
    const parsed = parsePattern(pattern.source);
    patterns.push(parsed.parts);
    approximateMaxLength = Math.max(
      approximateMaxLength,
      parsed.approximateMaxLength,
    );
  }
  return { patterns, approximateMaxLength };
})();

function lastSequenceIndex(
  input: readonly string[],
  needle: readonly string[],
  start: number,
  end: number,
): number | undefined {
  for (let index = end - needle.length; index >= start; index -= 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (input[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return undefined;
}

function checkPattern(parts: readonly PatternPart[], canonicalInput: string): boolean {
  const input = [...canonicalInput];
  let inputIndex = input.length;
  let matchAnyChars = { start: 0, end: 0 };
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part) continue;
    if (part.text.length === 0) {
      matchAnyChars = {
        start: matchAnyChars.start + part.matchAnyChars.start,
        end: matchAnyChars.end + part.matchAnyChars.end,
      };
      continue;
    }
    const searchEnd = Math.max(0, inputIndex - matchAnyChars.start);
    const searchStart = Math.max(
      0,
      searchEnd - (matchAnyChars.end - matchAnyChars.start + part.text.length),
    );
    const found = lastSequenceIndex(
      input,
      part.text,
      searchStart,
      searchEnd,
    );
    if (found !== undefined) {
      inputIndex = found;
      matchAnyChars = part.matchAnyChars;
    } else if (!part.optional) {
      return false;
    }
  }
  return inputIndex >= matchAnyChars.start && inputIndex < matchAnyChars.end;
}

function recognizesOpenSourceLicense(content: string): boolean {
  const canonical = canonicalizeLicenseText(content);
  return LICENSE_PATTERNS.patterns.some((pattern) =>
    checkPattern(pattern, canonical),
  );
}

function safeRelativePath(value: string | undefined): value is string {
  if (!value) return false;
  const normalized = value.replaceAll('\\', '/');
  return (
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    normalized.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function isZedPrivatePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  for (let length = parts.length; length > 0; length -= 1) {
    const ancestor = parts.slice(0, length).join('/');
    if (
      PRIVATE_FILE_GLOBS.some((glob) =>
        minimatch(ancestor, glob, {
          dot: true,
          nocase: process.platform === 'win32',
        }),
      )
    ) {
      return true;
    }
  }
  return false;
}

type Realpath = (value: string) => Promise<string>;
let resolveRealpath: Realpath = nodeRealpath;

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function rootLicenseNames(root: vscode.Uri): Promise<readonly string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    return entries
      .filter(([name, type]) =>
        LICENSE_FILE_NAME.test(name) &&
        (type & vscode.FileType.File) !== 0,
      )
      .map(([name]) => name);
  } catch {
    return [
      'LICENSE',
      'LICENSE.md',
      'LICENSE.txt',
      'LICENCE',
      'LICENCE.md',
      'LICENCE.txt',
      'MIT-LICENSE',
      'APACHE-2.0',
    ];
  }
}

async function hasRecognizedLicense(root: vscode.Uri): Promise<boolean> {
  for (const name of await rootLicenseNames(root)) {
    if (!LICENSE_FILE_NAME.test(name)) continue;
    const uri = vscode.Uri.joinPath(root, name);
    let size: number;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      size = stat.size;
    } catch {
      continue;
    }
    if (size > LICENSE_PATTERNS.approximateMaxLength) continue;
    const content = await readText(uri);
    if (content !== undefined && recognizesOpenSourceLicense(content)) {
      return true;
    }
  }
  return false;
}

function uriRelativePath(uri: vscode.Uri, root: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file' || root.scheme !== 'file') return undefined;
  const rootPath = decodeURIComponent(root.path).replace(/\/$/, '');
  const filePath = decodeURIComponent(uri.path);
  if (!filePath.startsWith(`${rootPath}/`)) return undefined;
  const relative = filePath.slice(rootPath.length + 1);
  return safeRelativePath(relative) ? relative : undefined;
}

interface RequestFile {
  readonly uri: vscode.Uri;
  readonly folder: vscode.WorkspaceFolder;
  readonly relativePath: string;
}

function parseUri(value: string | undefined): vscode.Uri | undefined {
  if (!value) return undefined;
  try {
    return vscode.Uri.parse(value, true);
  } catch {
    return undefined;
  }
}

function requestFile(
  uriValue: string | undefined,
  pathValue: string | undefined,
  fallbackFolder?: vscode.WorkspaceFolder,
): RequestFile | undefined {
  const explicitUri = parseUri(uriValue);
  const uri =
    explicitUri ??
    (fallbackFolder && safeRelativePath(pathValue)
      ? vscode.Uri.joinPath(fallbackFolder.uri, ...pathValue.split('/'))
      : undefined);
  if (!uri || uri.scheme !== 'file') return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const relativePath = uriRelativePath(uri, folder.uri);
  if (!relativePath || (pathValue && safeRelativePath(pathValue) && relativePath !== pathValue)) {
    return undefined;
  }
  return { uri, folder, relativePath };
}

function requestFiles(
  request: CompletionRequestZedCloud,
): readonly RequestFile[] | undefined {
  const current = requestFile(request.document.uri, request.document.path);
  if (!current) return undefined;
  const files: RequestFile[] = [current];
  for (const entry of request.editHistory) {
    const file = requestFile(entry.uri, entry.path, current.folder);
    if (!file) return undefined;
    files.push(file);
  }
  if ('contexts' in request) {
    for (const context of request.contexts) {
      const file = requestFile(context.uri, context.path, current.folder);
      if (!file) return undefined;
      files.push(file);
    }
  }
  return files;
}

export async function isZedFileEligibleForDataCollection(
  uriValue: string | undefined,
  pathValue: string | undefined,
): Promise<boolean> {
  const file = requestFile(uriValue, pathValue);
  return (
    file !== undefined &&
    !isZedPrivatePath(file.relativePath) &&
    (await validateRequestFiles([file])) &&
    (await hasRecognizedLicense(file.folder.uri))
  );
}

async function validateRequestFiles(
  files: readonly RequestFile[],
): Promise<boolean> {
  const rootRealpaths = new Map<string, string>();
  try {
    for (const file of files) {
      const stat = await vscode.workspace.fs.stat(file.uri);
      if ((stat.type & vscode.FileType.File) === 0) return false;
      const rootKey = file.folder.uri.toString();
      let rootRealpath = rootRealpaths.get(rootKey);
      if (!rootRealpath) {
        rootRealpath = await resolveRealpath(file.folder.uri.fsPath);
        rootRealpaths.set(rootKey, rootRealpath);
      }
      const fileRealpath = await resolveRealpath(file.uri.fsPath);
      const relative = path.relative(rootRealpath, fileRealpath);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

function resolveUri(base: vscode.Uri, relative: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(new URL(relative, `${base.toString().replace(/\/$/, '')}/`).toString());
  } catch {
    return undefined;
  }
}

async function gitDirectory(root: vscode.Uri): Promise<vscode.Uri | undefined> {
  const dotGit = vscode.Uri.joinPath(root, '.git');
  const gitFile = await readText(dotGit);
  if (gitFile === undefined) return dotGit;
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(gitFile);
  return match?.[1] ? resolveUri(root, match[1]) : dotGit;
}

function sanitizeRepoUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return /^[^\s]+@[^\s:]+:[^\s]+$/.test(trimmed) ? trimmed : undefined;
  }
}

function remoteUrl(config: string, name: 'origin' | 'upstream'): string | undefined {
  let inRemote = false;
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inRemote = new RegExp(`^\\[remote\\s+"${name}"\\]$`, 'i').test(trimmed);
      continue;
    }
    if (!inRemote) continue;
    const match = /^url\s*=\s*(.+)$/i.exec(trimmed);
    if (match?.[1]) return sanitizeRepoUrl(match[1]);
  }
  return undefined;
}

async function readRepoUrl(root: vscode.Uri): Promise<string | undefined> {
  const gitDir = await gitDirectory(root);
  if (!gitDir) return undefined;
  const commonDirText = await readText(vscode.Uri.joinPath(gitDir, 'commondir'));
  const commonDir = commonDirText?.trim()
    ? resolveUri(gitDir, commonDirText.trim())
    : gitDir;
  const config = commonDir ? await readText(vscode.Uri.joinPath(commonDir, 'config')) : undefined;
  return config
    ? remoteUrl(config, 'origin') ?? remoteUrl(config, 'upstream')
    : undefined;
}

export async function evaluateZedDataCollection(
  request: CompletionRequestZedCloud,
  policy: ZedDataCollectionPolicy,
): Promise<ZedDataCollectionDecision> {
  const files = requestFiles(request);
  if (
    !files ||
    files.some((file) => isZedPrivatePath(file.relativePath)) ||
    !(await validateRequestFiles(files))
  ) {
    return NO_ZED_DATA_COLLECTION;
  }
  const roots = new Map<string, vscode.Uri>();
  for (const file of files) roots.set(file.folder.uri.toString(), file.folder.uri);
  const licenseResults = await Promise.all(
    [...roots.values()].map((root) => hasRecognizedLicense(root)),
  );
  const isInOpenSourceRepo = licenseResults.every(Boolean);
  if (!isInOpenSourceRepo) return NO_ZED_DATA_COLLECTION;
  const canCollectData =
    policy.dataCollectionEnabled && policy.dataCollectionAllowed;
  if (!canCollectData) {
    return { canCollectData: false, isInOpenSourceRepo: true };
  }
  const current = files[0];
  const repoUrl = current ? await readRepoUrl(current.folder.uri) : undefined;
  return {
    canCollectData: true,
    isInOpenSourceRepo: true,
    ...(repoUrl ? { repoUrl } : {}),
  };
}

type CompletionRequestZedCloud =
  | (ZetaCompletionRequest & { readonly kind: 'zeta2.1' })
  | Zeta3InternalCompletionRequest;

export const zedPrivacyTesting = {
  canonicalizeLicenseText,
  parsePattern,
  checkPattern,
  recognizesOpenSourceLicense,
  approximateMaxLength: LICENSE_PATTERNS.approximateMaxLength,
  setRealpathForTests(realpath: Realpath): () => void {
    const previous = resolveRealpath;
    resolveRealpath = realpath;
    return () => {
      resolveRealpath = previous;
    };
  },
};
