import { open as openFile } from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import type { CommitMessageGenerationConfiguration } from './types';
import {
  CommitMessageHistoryEntry,
  CommitMessageRepositoryContext,
  NoChangesDetectedError,
} from './types';
import type { GitRepository } from './git';

const FILE_HISTORY_LIMIT = 30;
const FILE_HISTORY_QUERY_LIMIT = 10;
const REPOSITORY_HISTORY_LIMIT = 20;
const REPOSITORY_HISTORY_QUERY_LIMIT = 100;
const MAX_UNTRACKED_TEXT_CHARS = 12_000;
const MAX_UNTRACKED_TEXT_BYTES = MAX_UNTRACKED_TEXT_CHARS * 4;
const UNTRACKED_TRUNCATION_NOTICE = '\n... [untracked file content truncated]';
const GIT_STATUS_UNTRACKED = 7;
const GIT_STATUS_INTENT_TO_ADD = 9;

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

function toPosixRelativePath(repoPath: string, filePath: string): string {
  return path.relative(repoPath, filePath).split(path.sep).join('/');
}

function isOctalDigit(value: string): boolean {
  return value >= '0' && value <= '7';
}

function decodeGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }

  const body = trimmed.slice(1, -1);
  const bytes: number[] = [];

  for (let index = 0; index < body.length;) {
    const current = body[index];
    if (current !== '\\') {
      const codePoint = body.codePointAt(index);
      if (codePoint === undefined) {
        break;
      }

      const character = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(character, 'utf8'));
      index += character.length;
      continue;
    }

    index += 1;
    if (index >= body.length) {
      bytes.push('\\'.charCodeAt(0));
      break;
    }

    const escaped = body[index];
    if (isOctalDigit(escaped)) {
      let octal = escaped;
      index += 1;

      while (
        octal.length < 3 &&
        index < body.length &&
        isOctalDigit(body[index])
      ) {
        octal += body[index];
        index += 1;
      }

      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    switch (escaped) {
      case '\\':
        bytes.push('\\'.charCodeAt(0));
        break;
      case '"':
        bytes.push('"'.charCodeAt(0));
        break;
      case 't':
        bytes.push('\t'.charCodeAt(0));
        break;
      case 'n':
        bytes.push('\n'.charCodeAt(0));
        break;
      case 'r':
        bytes.push('\r'.charCodeAt(0));
        break;
      case 'b':
        bytes.push('\b'.charCodeAt(0));
        break;
      case 'f':
        bytes.push('\f'.charCodeAt(0));
        break;
      case 'v':
        bytes.push('\v'.charCodeAt(0));
        break;
      default:
        bytes.push(...Buffer.from(escaped, 'utf8'));
        break;
    }

    index += 1;
  }

  return Buffer.from(bytes).toString('utf8');
}

function extractRelativeDiffPath(
  value: string,
  prefix: 'a/' | 'b/',
): string | undefined {
  const decodedPath = decodeGitPath(value);
  if (decodedPath === '/dev/null') {
    return undefined;
  }

  return decodedPath.startsWith(prefix)
    ? decodedPath.slice(prefix.length)
    : decodedPath;
}

function looksLikeDiffPathToken(value: string, prefixes: readonly string[]): boolean {
  const decodedPath = decodeGitPath(value);
  return prefixes.some(
    (prefix) => decodedPath === prefix || decodedPath.startsWith(prefix),
  );
}

interface DiffPathPairCandidate {
  oldPath: string;
  newPath: string;
}

function collectDiffPathPairCandidates(
  body: string,
  separator: string,
  leftPrefixes: readonly string[],
  rightPrefixes: readonly string[],
): DiffPathPairCandidate[] {
  const candidates: DiffPathPairCandidate[] = [];
  let searchIndex = 0;

  for (;;) {
    const separatorIndex = body.indexOf(separator, searchIndex);
    if (separatorIndex === -1) {
      break;
    }

    const oldPath = body.slice(0, separatorIndex).trim();
    const newPath = body.slice(separatorIndex + separator.length).trim();
    if (
      looksLikeDiffPathToken(oldPath, leftPrefixes) &&
      looksLikeDiffPathToken(newPath, rightPrefixes)
    ) {
      candidates.push({ oldPath, newPath });
    }

    searchIndex = separatorIndex + separator.length;
  }

  return candidates;
}

function extractRelativePathFromDiffHeaderLine(line: string): string | undefined {
  if (!line.startsWith('diff --git ')) {
    return undefined;
  }

  const candidates = collectDiffPathPairCandidates(
    line.slice('diff --git '.length),
    ' ',
    ['a/'],
    ['b/'],
  );

  if (candidates.length !== 1) {
    return undefined;
  }

  return (
    extractRelativeDiffPath(candidates[0].newPath, 'b/') ??
    extractRelativeDiffPath(candidates[0].oldPath, 'a/')
  );
}

function extractRelativePathFromBinaryDiffChunk(
  headerLine: string,
  binaryLine: string,
): string | undefined {
  const headerCandidates = collectDiffPathPairCandidates(
    headerLine.slice('diff --git '.length),
    ' ',
    ['a/'],
    ['b/'],
  );
  const binaryCandidates = collectDiffPathPairCandidates(
    binaryLine.slice('Binary files '.length, -' differ'.length),
    ' and ',
    ['a/', '/dev/null'],
    ['b/', '/dev/null'],
  );

  const matchingCandidate = headerCandidates.find((headerCandidate) =>
    binaryCandidates.some(
      (binaryCandidate) =>
        binaryCandidate.oldPath === headerCandidate.oldPath &&
        binaryCandidate.newPath === headerCandidate.newPath,
    ),
  );

  if (!matchingCandidate) {
    return undefined;
  }

  return (
    extractRelativeDiffPath(matchingCandidate.newPath, 'b/') ??
    extractRelativeDiffPath(matchingCandidate.oldPath, 'a/')
  );
}

function extractRelativePathFromDiffChunk(lines: readonly string[]): string | undefined {
  let deletedPath: string | undefined;
  let headerLine: string | undefined;
  let binaryLine: string | undefined;

  for (const line of lines) {
    if (!headerLine && line.startsWith('diff --git ')) {
      headerLine = line;
    }
    if (line.startsWith('rename to ')) {
      return decodeGitPath(line.slice('rename to '.length));
    }
    if (line.startsWith('copy to ')) {
      return decodeGitPath(line.slice('copy to '.length));
    }
    if (line.startsWith('--- ')) {
      deletedPath = extractRelativeDiffPath(line.slice(4).trim(), 'a/');
    }
    if (line.startsWith('+++ ')) {
      const relativePath = extractRelativeDiffPath(line.slice(4).trim(), 'b/');
      if (relativePath) {
        return relativePath;
      }
    }
    if (!binaryLine && line.startsWith('Binary files ') && line.endsWith(' differ')) {
      binaryLine = line;
    }
  }

  if (headerLine && binaryLine) {
    const binaryRelativePath = extractRelativePathFromBinaryDiffChunk(
      headerLine,
      binaryLine,
    );
    if (binaryRelativePath) {
      return binaryRelativePath;
    }
  }

  if (deletedPath) {
    return deletedPath;
  }

  return headerLine ? extractRelativePathFromDiffHeaderLine(headerLine) : undefined;
}

function appendChunk(
  map: Map<string, string>,
  relativePath: string,
  chunk: string,
): void {
  const existing = map.get(relativePath);
  map.set(relativePath, existing ? `${existing}\n\n${chunk}` : chunk);
}

function parseUnifiedDiffByFile(unifiedDiff: string): Map<string, string> {
  const byFile = new Map<string, string>();
  if (!unifiedDiff.trim()) {
    return byFile;
  }

  const lines = unifiedDiff.split(/\r?\n/);
  let currentChunk: string[] = [];

  const flush = (): void => {
    if (currentChunk.length === 0) {
      return;
    }
    const relativePath = extractRelativePathFromDiffChunk(currentChunk);
    const chunkText = currentChunk.join('\n').trim();
    if (relativePath && chunkText) {
      appendChunk(byFile, relativePath, chunkText);
    }
    currentChunk = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
    }

    if (currentChunk.length > 0 || line.startsWith('diff --git ')) {
      currentChunk.push(line);
    }
  }

  flush();
  return byFile;
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function buildNewFilePseudoDiff(relativePath: string, content: string): string {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const lines = normalizedContent.length === 0 ? [] : normalizedContent.split('\n');
  const addedLines = lines.map((line) => `+${line}`);
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
  ];

  if (addedLines.length > 0) {
    header.push(`@@ -0,0 +1,${addedLines.length} @@`);
    header.push(...addedLines);
  }

  return header.join('\n');
}

function buildRepositoryPathUri(
  repository: GitRepository,
  relativePath: string,
): vscode.Uri {
  return relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .reduce(
      (uri, segment) => vscode.Uri.joinPath(uri, segment),
      repository.rootUri,
    );
}

function normalizeGlobPath(value: string): string {
  return value.replace(/[\\/]+/g, '/');
}

function matchesMissingPathPattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeGlobPath(pattern.trim());
  if (!normalizedPattern) {
    return false;
  }

  return minimatch(normalizeGlobPath(relativePath), normalizedPattern, {
    dot: true,
    nocase: process.platform === 'win32' || process.platform === 'darwin',
    windowsPathsNoEscape: true,
  });
}

async function collectMissingPaths(
  repository: GitRepository,
  relativePaths: readonly string[],
  token: vscode.CancellationToken,
): Promise<Set<string>> {
  const missingPaths = new Set<string>();

  for (const relativePath of relativePaths) {
    throwIfCancelled(token);

    try {
      await vscode.workspace.fs.stat(buildRepositoryPathUri(repository, relativePath));
    } catch {
      missingPaths.add(relativePath);
    }
  }

  return missingPaths;
}

async function resolveExcludedPaths(
  repository: GitRepository,
  relativePaths: readonly string[],
  patterns: readonly string[],
  token: vscode.CancellationToken,
): Promise<Set<string>> {
  if (patterns.length === 0 || relativePaths.length === 0) {
    return new Set<string>();
  }

  const candidatePaths = new Set(relativePaths);
  const excludedPaths = new Set<string>();
  const missingPaths = await collectMissingPaths(repository, relativePaths, token);

  for (const pattern of patterns) {
    throwIfCancelled(token);

    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(repository.rootUri, pattern),
        null,
        undefined,
        token,
      );

      for (const uri of uris) {
        const relativePath = toPosixRelativePath(
          repository.rootUri.fsPath,
          uri.fsPath,
        );
        if (candidatePaths.has(relativePath)) {
          excludedPaths.add(relativePath);
        }
      }
    } catch {
      // Ignore invalid or unsupported patterns and continue with the rest.
    }

    // Deleted paths are no longer discoverable via findFiles, so match them directly.
    for (const relativePath of missingPaths) {
      if (!excludedPaths.has(relativePath) && matchesMissingPathPattern(relativePath, pattern)) {
        excludedPaths.add(relativePath);
      }
    }
  }

  return excludedPaths;
}

function buildExcludedFileSummary(relativePath: string): string {
  return [
    `File: ${relativePath}`,
    'Diff omitted because this file matches unifyChatProvider.commitMessageGeneration.excludeFiles.',
  ].join('\n');
}

function stripFileHeaderFromSummary(summary: string): string {
  const lines = summary.split('\n');
  if (lines[0]?.startsWith('File: ')) {
    return lines.slice(1).join('\n').trimStart();
  }

  return summary;
}

function buildTrackedFileSummary(
  relativePath: string,
  stagedDiff: string | undefined,
  workingTreeDiff: string | undefined,
  untrackedSummary?: string,
): string {
  const sections = [`File: ${relativePath}`];

  if (stagedDiff) {
    sections.push('Staged changes:');
    sections.push('```diff');
    sections.push(stagedDiff);
    sections.push('```');
  }

  if (workingTreeDiff) {
    sections.push('Working tree changes:');
    sections.push('```diff');
    sections.push(workingTreeDiff);
    sections.push('```');
  }

  if (!workingTreeDiff && untrackedSummary) {
    const untrackedDetails = stripFileHeaderFromSummary(untrackedSummary);
    if (untrackedDetails) {
      sections.push('Untracked file in working tree:');
      sections.push(untrackedDetails);
    }
  }

  return sections.join('\n');
}

async function collectUntrackedSummaries(
  repository: GitRepository,
  token: vscode.CancellationToken,
): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  const repositoryPath = repository.rootUri.fsPath;
  const seenPaths = new Set<string>();
  const untrackedUris = await collectUntrackedUris(repository, token);

  for (const uri of untrackedUris) {
    throwIfCancelled(token);

    const relativePath = toPosixRelativePath(repositoryPath, uri.fsPath);
    if (!relativePath || relativePath.startsWith('..') || seenPaths.has(relativePath)) {
      continue;
    }
    seenPaths.add(relativePath);

    let summary: string;
    try {
      const { bytes, truncated } = await readUntrackedFilePreview(uri);
      if (looksBinary(bytes)) {
        summary = [
          `File: ${relativePath}`,
          'Status: untracked',
          'New untracked binary file. Content omitted because the file appears to be binary.',
        ].join('\n');
      } else {
        summary = [
          `File: ${relativePath}`,
          'Status: untracked',
          '```diff',
          buildNewFilePseudoDiff(
            relativePath,
            buildUntrackedTextPreview(bytes, truncated),
          ),
          '```',
        ].join('\n');
      }
    } catch {
      summary = [
        `File: ${relativePath}`,
        'Status: untracked',
        'New untracked file. Contents could not be read.',
      ].join('\n');
    }

    summaries.set(relativePath, summary);
  }

  return summaries;
}

async function collectUntrackedUris(
  repository: GitRepository,
  _token: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
  const uris = new Map<string, vscode.Uri>();

  for (const change of repository.state.untrackedChanges) {
    uris.set(change.uri.toString(), change.uri);
  }

  for (const change of repository.state.workingTreeChanges ?? []) {
    if (
      change.status === GIT_STATUS_UNTRACKED ||
      change.status === GIT_STATUS_INTENT_TO_ADD
    ) {
      uris.set(change.uri.toString(), change.uri);
    }
  }

  return [...uris.values()];
}

async function readUntrackedFilePreview(
  uri: vscode.Uri,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (uri.scheme !== 'file') {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return {
      bytes: bytes.subarray(0, MAX_UNTRACKED_TEXT_BYTES),
      truncated: bytes.length > MAX_UNTRACKED_TEXT_BYTES,
    };
  }

  const fileHandle = await openFile(uri.fsPath, 'r');
  try {
    const stats = await fileHandle.stat();
    const previewByteLength = Math.min(stats.size, MAX_UNTRACKED_TEXT_BYTES);
    const buffer = Buffer.alloc(previewByteLength);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      previewByteLength,
      0,
    );

    return {
      bytes: buffer.subarray(0, bytesRead),
      truncated: stats.size > bytesRead,
    };
  } finally {
    await fileHandle.close();
  }
}

function buildUntrackedTextPreview(
  bytes: Uint8Array,
  truncatedByByteLimit: boolean,
): string {
  let text = Buffer.from(bytes).toString('utf8');
  let truncated = truncatedByByteLimit;

  if (text.length > MAX_UNTRACKED_TEXT_CHARS) {
    text = text.slice(
      0,
      Math.max(0, MAX_UNTRACKED_TEXT_CHARS - UNTRACKED_TRUNCATION_NOTICE.length),
    );
    truncated = true;
  }

  return truncated ? `${text}${UNTRACKED_TRUNCATION_NOTICE}` : text;
}

function toSubject(message: string): string {
  return message.split(/\r?\n/, 1)[0].trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringProperty(
  value: unknown,
  propertyName: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const propertyValue = value[propertyName];
  return typeof propertyValue === 'string' ? propertyValue : undefined;
}

function buildGitErrorSearchText(error: unknown): string {
  const parts: string[] = [];

  if (error instanceof Error) {
    parts.push(error.message);
  } else if (typeof error === 'string') {
    parts.push(error);
  } else {
    parts.push(String(error));
  }

  for (const propertyName of ['stderr', 'stdout', 'gitErrorCode']) {
    const propertyValue = readStringProperty(error, propertyName);
    if (propertyValue) {
      parts.push(propertyValue);
    }
  }

  return parts.join('\n').toLowerCase();
}

function isNoCommitHistoryError(error: unknown): boolean {
  const normalizedMessage = buildGitErrorSearchText(error);

  return (
    normalizedMessage.includes('does not have any commits yet') ||
    normalizedMessage.includes("ambiguous argument 'head'") ||
    normalizedMessage.includes("bad default revision 'head'") ||
    normalizedMessage.includes('bad revision') ||
    normalizedMessage.includes('unborn branch')
  );
}

type GitCommitLog = Awaited<ReturnType<GitRepository['log']>>;

async function readCommitLog(
  repository: GitRepository,
  options?: Parameters<GitRepository['log']>[0],
): Promise<GitCommitLog> {
  try {
    return await repository.log(options);
  } catch (error) {
    if (isNoCommitHistoryError(error)) {
      return [];
    }
    throw error;
  }
}

function dedupeHistoryEntries<T extends CommitMessageHistoryEntry>(
  entries: readonly T[],
  maxEntries: number,
): T[] {
  const sortedEntries = [...entries].sort((left, right) => {
    const leftTime = left.authorDate?.getTime() ?? 0;
    const rightTime = right.authorDate?.getTime() ?? 0;
    return rightTime - leftTime;
  });

  const withoutAdjacentDuplicates: T[] = [];
  for (const entry of sortedEntries) {
    const previous = withoutAdjacentDuplicates[withoutAdjacentDuplicates.length - 1];
    if (previous?.subject === entry.subject) {
      continue;
    }
    withoutAdjacentDuplicates.push(entry);
  }

  const seenSubjects = new Set<string>();
  const dedupedEntries: T[] = [];
  for (const entry of withoutAdjacentDuplicates) {
    if (seenSubjects.has(entry.subject)) {
      continue;
    }
    seenSubjects.add(entry.subject);
    dedupedEntries.push(entry);
    if (dedupedEntries.length >= maxEntries) {
      break;
    }
  }

  return dedupedEntries;
}

async function collectFileHistoryEntries(
  repository: GitRepository,
  trackedPaths: readonly string[],
  token: vscode.CancellationToken,
): Promise<CommitMessageHistoryEntry[]> {
  const historyEntries: CommitMessageHistoryEntry[] = [];

  for (const relativePath of trackedPaths) {
    throwIfCancelled(token);

    const commits = await readCommitLog(repository, {
      path: relativePath,
      maxEntries: FILE_HISTORY_QUERY_LIMIT,
    });

    for (const commit of commits) {
      const subject = toSubject(commit.message);
      if (!subject) {
        continue;
      }

      historyEntries.push({
        path: relativePath,
        subject,
        authorDate: commit.authorDate,
      });
    }
  }

  return dedupeHistoryEntries(historyEntries, FILE_HISTORY_LIMIT);
}

async function collectRepositoryHistoryEntries(
  repository: GitRepository,
  token: vscode.CancellationToken,
): Promise<CommitMessageHistoryEntry[]> {
  throwIfCancelled(token);

  const commits = await readCommitLog(repository, {
    maxEntries: REPOSITORY_HISTORY_QUERY_LIMIT,
  });

  const entries = commits
    .map((commit) => ({
      subject: toSubject(commit.message),
      authorDate: commit.authorDate,
    }))
    .filter((entry) => entry.subject.length > 0);

  return dedupeHistoryEntries(entries, REPOSITORY_HISTORY_LIMIT);
}

function buildBranchName(repository: GitRepository): {
  branchName: string;
  remoteBranchName: string;
} {
  const branchName = repository.state.HEAD?.name?.trim() || 'DETACHED';
  const upstream = repository.state.HEAD?.upstream;
  const remoteBranchName =
    upstream && upstream.remote && upstream.name
      ? `${upstream.remote}/${upstream.name}`
      : 'None';

  return { branchName, remoteBranchName };
}

export async function collectCommitMessageRepositoryContext(
  repository: GitRepository,
  scope: 'all' | 'staged' | 'workingTree',
  configuration: CommitMessageGenerationConfiguration,
  token: vscode.CancellationToken,
): Promise<CommitMessageRepositoryContext> {
  await repository.status();
  throwIfCancelled(token);

  const stagedDiff =
    scope === 'workingTree' ? '' : await repository.diff(true);
  throwIfCancelled(token);

  const workingTreeDiff =
    scope === 'staged' ? '' : await repository.diff(false);
  throwIfCancelled(token);

  const stagedDiffByFile = parseUnifiedDiffByFile(stagedDiff);
  const workingTreeDiffByFile = parseUnifiedDiffByFile(workingTreeDiff);
  const untrackedSummaries =
    scope === 'staged'
      ? new Map<string, string>()
      : await collectUntrackedSummaries(repository, token);

  const allPaths = [...new Set([
    ...stagedDiffByFile.keys(),
    ...workingTreeDiffByFile.keys(),
    ...untrackedSummaries.keys(),
  ])].sort((left, right) => left.localeCompare(right));

  if (allPaths.length === 0) {
    throw new NoChangesDetectedError();
  }

  const excludedPaths = await resolveExcludedPaths(
    repository,
    allPaths,
    configuration.excludeFiles,
    token,
  );
  throwIfCancelled(token);

  const filePromptItems = allPaths.map((relativePath) => {
    if (excludedPaths.has(relativePath)) {
      return {
        path: relativePath,
        summary: buildExcludedFileSummary(relativePath),
      };
    }

    const stagedDiff = stagedDiffByFile.get(relativePath);
    const workingTreeDiff = workingTreeDiffByFile.get(relativePath);
    const untrackedSummary = untrackedSummaries.get(relativePath);
    if (stagedDiff || workingTreeDiff) {
      return {
        path: relativePath,
        summary: buildTrackedFileSummary(
          relativePath,
          stagedDiff,
          workingTreeDiff,
          untrackedSummary,
        ),
      };
    }

    if (untrackedSummary) {
      return { path: relativePath, summary: untrackedSummary };
    }

    return {
      path: relativePath,
      summary: buildTrackedFileSummary(
        relativePath,
        stagedDiff,
        workingTreeDiff,
      ),
    };
  });

  const trackedPaths = [...new Set([
    ...stagedDiffByFile.keys(),
    ...workingTreeDiffByFile.keys(),
  ])].sort((left, right) => left.localeCompare(right));

  const fileHistoryEntries = await collectFileHistoryEntries(
    repository,
    trackedPaths,
    token,
  );
  const repositoryHistoryEntries = await collectRepositoryHistoryEntries(
    repository,
    token,
  );
  const { branchName, remoteBranchName } = buildBranchName(repository);

  return {
    repositoryPath: repository.rootUri.fsPath,
    branchName,
    remoteBranchName,
    filePromptItems,
    fileHistoryEntries,
    repositoryHistoryEntries,
  };
}
