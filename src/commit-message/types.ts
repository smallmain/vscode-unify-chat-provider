import * as vscode from 'vscode';

export type CommitMessageGenerationScope = 'all' | 'staged' | 'workingTree';

export type CommitMessageGenerationRequestScope =
  | CommitMessageGenerationScope
  | 'auto';

export type CommitMessageGenerationFormat =
  | 'auto'
  | 'conventional'
  | 'angular'
  | 'google'
  | 'atom'
  | 'plain'
  | 'custom';

export interface CommitMessageGenerationModelConfiguration {
  vendor: string;
  id: string;
}

export interface CommitMessageGenerationConfiguration {
  model: CommitMessageGenerationModelConfiguration;
  format: CommitMessageGenerationFormat;
  customInstructions: string;
  excludeFiles: string[];
}

export interface CommitMessageFilePromptItem {
  path: string;
  summary: string;
}

export interface CommitMessageHistoryEntry {
  path?: string;
  subject: string;
  authorDate?: Date;
}

export interface CommitMessageRepositoryContext {
  repositoryPath: string;
  branchName: string;
  remoteBranchName: string;
  filePromptItems: CommitMessageFilePromptItem[];
  fileHistoryEntries: CommitMessageHistoryEntry[];
  repositoryHistoryEntries: CommitMessageHistoryEntry[];
}

export interface CommitMessagePromptState {
  configuration: CommitMessageGenerationConfiguration;
  context: CommitMessageRepositoryContext;
}

export interface CommitMessageCompressionResult {
  messages: vscode.LanguageModelChatMessage[];
  totalTokens: number;
}

export class GitExtensionUnavailableError extends Error {
  constructor() {
    super('Git extension is unavailable.');
    this.name = 'GitExtensionUnavailableError';
  }
}

export class NoGitRepositoriesFoundError extends Error {
  constructor() {
    super('No Git repositories were found.');
    this.name = 'NoGitRepositoriesFoundError';
  }
}

export class NoChangesDetectedError extends Error {
  constructor() {
    super('No changes were detected for commit message generation.');
    this.name = 'NoChangesDetectedError';
  }
}

export class PromptTooLargeError extends Error {
  constructor() {
    super(
      'Unable to fit the commit prompt into the selected model context window.',
    );
    this.name = 'PromptTooLargeError';
  }
}

export class NoLanguageModelsAvailableError extends Error {
  constructor() {
    super('No language models are available.');
    this.name = 'NoLanguageModelsAvailableError';
  }
}
