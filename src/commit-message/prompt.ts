import * as vscode from 'vscode';
import type {
  CommitMessageGenerationFormat,
  CommitMessagePromptState,
} from './types';
import { createOutgoingLanguageModelMessages } from '../proposed-api/system-message';

const MAX_COMMIT_MESSAGE_LENGTH = 100;

function buildFormatInstructions(
  format: CommitMessageGenerationFormat,
): string | undefined {
  switch (format) {
    case 'custom':
      return undefined;
    case 'auto':
      return [
        'Infer the repository commit message style from the provided repository history.',
        'If the style is not clear, fall back to Conventional Commits.',
        `Keep the final commit message concise and preferably within ${MAX_COMMIT_MESSAGE_LENGTH} characters.`,
      ].join(' ');
    case 'conventional':
      return [
        'Use Conventional Commits format: type(scope optional): subject.',
        `Keep the final commit message concise and preferably within ${MAX_COMMIT_MESSAGE_LENGTH} characters.`,
      ].join(' ');
    case 'angular':
      return [
        'Use Angular commit format: type(scope): subject.',
        `Keep the final commit message concise and preferably within ${MAX_COMMIT_MESSAGE_LENGTH} characters.`,
      ].join(' ');
    case 'google':
      return [
        'Use Google-style commit format with an imperative subject line.',
        `Keep the final commit message concise and preferably within ${MAX_COMMIT_MESSAGE_LENGTH} characters.`,
      ].join(' ');
    case 'atom':
      return [
        'Use Atom-style commit format, including the Atom prefix style when appropriate.',
        `Keep the final commit message concise and preferably within ${MAX_COMMIT_MESSAGE_LENGTH} characters.`,
      ].join(' ');
    case 'plain':
      return [
        'Use a plain one-line commit message with no prefix unless clearly justified by the changes.',
        `Keep the final commit message concise and preferably within ${MAX_COMMIT_MESSAGE_LENGTH} characters.`,
      ].join(' ');
    default:
      return [
        `Keep the final commit message concise and preferably within ${MAX_COMMIT_MESSAGE_LENGTH} characters.`,
      ].join(' ');
  }
}

export function buildSystemPrompt(state: CommitMessagePromptState): string {
  const sections: string[] = [
    'You are an AI assistant tasked with generating a Git commit message based on the provided code changes. Your goal is to create a clear, concise, and informative commit message that follows best practices.',
    'Use the repository information, per-file change summaries, file-related recent commit subjects, and repository-wide recent commit subjects as context. The current code changes are the primary source of truth; use commit history only to understand style and surrounding context.',
  ];

  const formatInstructions = buildFormatInstructions(state.configuration.format);
  if (formatInstructions) {
    sections.push(formatInstructions);
  }

  sections.push(
    'Output only the commit message text. Do not include explanations, quotes, markdown, bullets, prefixes like "Commit message:", or any surrounding commentary.',
  );

  const customInstructions = state.configuration.customInstructions.trim();
  if (customInstructions) {
    sections.push(customInstructions);
  }

  return sections.join('\n');
}

function buildRepositoryInfoMessage(state: CommitMessagePromptState): string {
  return [
    'Repository information:',
    `- Path: ${state.context.repositoryPath}`,
    `- Branch: ${state.context.branchName}`,
    `- Remote branch: ${state.context.remoteBranchName}`,
  ].join('\n');
}

function buildFileSummaryMessage(state: CommitMessagePromptState): string {
  const filePromptItems =
    state.context.filePromptItems.length > 0
      ? state.context.filePromptItems
      : [{ path: '(none)', summary: 'No file changes were collected.' }];

  return [
    'Per-file change summaries:',
    ...filePromptItems.map((item) => item.summary),
  ].join('\n\n');
}

function buildFileHistoryMessage(state: CommitMessagePromptState): string {
  if (state.context.fileHistoryEntries.length === 0) {
    return 'File-related recent commit subjects:\n- No file-specific commit history was available.';
  }

  const lines = ['File-related recent commit subjects:'];
  for (const entry of state.context.fileHistoryEntries) {
    const date = entry.authorDate?.toISOString().slice(0, 10) ?? 'unknown-date';
    const filePath = entry.path ?? '(unknown file)';
    lines.push(`- ${date} | ${filePath} | ${entry.subject}`);
  }

  return lines.join('\n');
}

function buildRepositoryHistoryMessage(state: CommitMessagePromptState): string {
  if (state.context.repositoryHistoryEntries.length === 0) {
    return 'Repository-wide recent commit subjects:\n- No repository commit history was available.';
  }

  const lines = ['Repository-wide recent commit subjects:'];
  for (const entry of state.context.repositoryHistoryEntries) {
    const date = entry.authorDate?.toISOString().slice(0, 10) ?? 'unknown-date';
    lines.push(`- ${date} | ${entry.subject}`);
  }

  return lines.join('\n');
}

export function buildPromptMessages(
  state: CommitMessagePromptState,
  canUseSystemMessage = true,
): vscode.LanguageModelChatMessage[] {
  return createOutgoingLanguageModelMessages(
    [
      { role: 'system', content: buildSystemPrompt(state) },
      { role: 'user', content: buildRepositoryInfoMessage(state) },
      { role: 'user', content: buildFileSummaryMessage(state) },
      { role: 'user', content: buildFileHistoryMessage(state) },
      { role: 'user', content: buildRepositoryHistoryMessage(state) },
    ],
    canUseSystemMessage,
  );
}

export function normalizeGeneratedCommitMessage(message: string): string {
  let normalized = message.trim();

  const fencedMatch = normalized.match(
    /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/,
  );
  if (fencedMatch) {
    normalized = fencedMatch[1].trim();
  }

  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  return normalized.trim();
}
