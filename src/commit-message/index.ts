import * as vscode from 'vscode';
import { t } from '../i18n';
import { createCommitMessageLogger } from '../logger';
import {
  readCommitMessageGenerationConfiguration,
  registerCommitMessageGenerationButtonsContext,
} from './config';
import { collectCommitMessageRepositoryContext } from './collector';
import {
  registerGitAvailabilityContext,
  resolveRepositoryFromContext,
} from './git';
import {
  changeCommitMessageModelConfiguration,
  resolveCommitMessageGenerationModel,
} from './model';
import { buildPromptMessages, normalizeGeneratedCommitMessage } from './prompt';
import type {
  CommitMessageCompressionResult,
  CommitMessageGenerationConfiguration,
  CommitMessageGenerationRequestScope,
  CommitMessageGenerationScope,
  CommitMessagePromptState,
  CommitMessageRepositoryContext,
} from './types';
import {
  GitExtensionUnavailableError,
  NoChangesDetectedError,
  NoGitRepositoriesFoundError,
  NoLanguageModelsAvailableError,
  PromptTooLargeError,
} from './types';

const MIN_FILE_HISTORY_ENTRIES = 5;
const MIN_REPOSITORY_HISTORY_ENTRIES = 5;
const SUMMARY_TRUNCATION_NOTICE = '\n... [summary truncated for context limit]';
const COMMIT_MESSAGE_CANCELLATION_TIMEOUT_MS = 5_000;
const COMMIT_MESSAGE_GENERATION_PHASES = [
  'configuration',
  'resolveRepository',
  'collectContext',
  'resolveModel',
  'buildPrompt',
  'requestModel',
  'readResponse',
  'applyResult',
] as const;

interface CommitMessageGenerationLease {
  readonly id: number;
  isCurrent(): boolean;
  release(): void;
}

let activeCommitMessageGenerationId: number | undefined;
let nextCommitMessageGenerationId = 1;

type CommitMessageGenerationPhase =
  (typeof COMMIT_MESSAGE_GENERATION_PHASES)[number];

interface CommitMessageGenerationTrace {
  startedAt: number;
  currentPhase: CommitMessageGenerationPhase;
  phaseDurationsMs: Partial<Record<CommitMessageGenerationPhase, number>>;
}

interface CommitMessageGenerationTimingSummary {
  totalMs: number;
  configurationMs?: number;
  resolveRepositoryMs?: number;
  collectContextMs?: number;
  resolveModelMs?: number;
  buildPromptMs?: number;
  requestModelMs?: number;
  readResponseMs?: number;
  applyResultMs?: number;
}

interface CommitMessageGenerationDurationBreakdown {
  preSendMs: number;
  postSendMs: number;
  totalMs: number;
}

interface CommitMessageResponseStreamSummary {
  partCount: number;
  textPartCount: number;
  thinkingPartCount: number;
  thinkingCharCount: number;
}

function tryAcquireCommitMessageGenerationLease():
  | CommitMessageGenerationLease
  | undefined {
  if (activeCommitMessageGenerationId !== undefined) {
    return undefined;
  }

  const id = nextCommitMessageGenerationId++;
  activeCommitMessageGenerationId = id;

  return {
    id,
    isCurrent: () => activeCommitMessageGenerationId === id,
    release: () => {
      if (activeCommitMessageGenerationId === id) {
        activeCommitMessageGenerationId = undefined;
      }
    },
  };
}

function createCommitMessageGenerationTrace(): CommitMessageGenerationTrace {
  return {
    startedAt: Date.now(),
    currentPhase: 'configuration',
    phaseDurationsMs: {},
  };
}

async function measureCommitMessageGenerationPhase<T>(
  trace: CommitMessageGenerationTrace,
  phase: CommitMessageGenerationPhase,
  task: () => Promise<T>,
): Promise<T> {
  trace.currentPhase = phase;
  const startedAt = Date.now();

  try {
    return await task();
  } finally {
    trace.phaseDurationsMs[phase] = Date.now() - startedAt;
  }
}

function buildCommitMessageGenerationTimingSummary(
  trace: CommitMessageGenerationTrace,
): CommitMessageGenerationTimingSummary {
  return {
    totalMs: Date.now() - trace.startedAt,
    configurationMs: trace.phaseDurationsMs.configuration,
    resolveRepositoryMs: trace.phaseDurationsMs.resolveRepository,
    collectContextMs: trace.phaseDurationsMs.collectContext,
    resolveModelMs: trace.phaseDurationsMs.resolveModel,
    buildPromptMs: trace.phaseDurationsMs.buildPrompt,
    requestModelMs: trace.phaseDurationsMs.requestModel,
    readResponseMs: trace.phaseDurationsMs.readResponse,
    applyResultMs: trace.phaseDurationsMs.applyResult,
  };
}

function buildCommitMessageGenerationDurationBreakdown(
  timings: CommitMessageGenerationTimingSummary,
): CommitMessageGenerationDurationBreakdown {
  return {
    preSendMs:
      (timings.configurationMs ?? 0) +
      (timings.resolveRepositoryMs ?? 0) +
      (timings.collectContextMs ?? 0) +
      (timings.resolveModelMs ?? 0) +
      (timings.buildPromptMs ?? 0),
    postSendMs: (timings.requestModelMs ?? 0) + (timings.readResponseMs ?? 0),
    totalMs: timings.totalMs,
  };
}

function getCommitMessageRoleLabel(
  role: vscode.LanguageModelChatMessageRole,
): string {
  switch (role) {
    case vscode.LanguageModelChatMessageRole.System:
      return 'system';
    case vscode.LanguageModelChatMessageRole.User:
      return 'user';
    case vscode.LanguageModelChatMessageRole.Assistant:
      return 'assistant';
    default:
      return String(role);
  }
}

function summarizePromptMessages(
  messages: readonly vscode.LanguageModelChatMessage[],
): Array<{
  role: string;
  name?: string;
  partCount: number;
  textChars: number;
  nonTextPartCount: number;
}> {
  return messages.map((message) => {
    let textChars = 0;
    let nonTextPartCount = 0;

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textChars += part.value.length;
      } else {
        nonTextPartCount += 1;
      }
    }

    return {
      role: getCommitMessageRoleLabel(message.role),
      name: message.name,
      partCount: message.content.length,
      textChars,
      nonTextPartCount,
    };
  });
}

function summarizeCommitMessageGenerationConfiguration(
  configuration: CommitMessageGenerationConfiguration,
): Record<string, unknown> {
  const trimmedInstructions = configuration.customInstructions.trim();

  return {
    format: configuration.format,
    excludeFilesCount: configuration.excludeFiles.length,
    hasCustomInstructions: trimmedInstructions.length > 0,
    customInstructionsLength: configuration.customInstructions.length,
  };
}

function summarizeCommitMessageRepositoryContext(
  context: CommitMessageRepositoryContext,
): Record<string, unknown> {
  const filePaths = context.filePromptItems.map((item) => item.path);
  const previewLimit = 20;
  const previewFilePaths = filePaths.slice(0, previewLimit);
  const summaryCharCount = context.filePromptItems.reduce(
    (sum, item) => sum + item.summary.length,
    0,
  );

  return {
    branchName: context.branchName,
    remoteBranchName: context.remoteBranchName,
    changedFileCount: context.filePromptItems.length,
    changedFiles: previewFilePaths,
    changedFilesTruncated: filePaths.length > previewFilePaths.length,
    fileSummaryCharCount: summaryCharCount,
    fileHistoryEntryCount: context.fileHistoryEntries.length,
    repositoryHistoryEntryCount: context.repositoryHistoryEntries.length,
  };
}

function describeResourceGroup(
  resourceGroup: vscode.SourceControlResourceGroup | undefined,
): { id: string; label: string; resourceCount: number } | undefined {
  if (!resourceGroup) {
    return undefined;
  }

  return {
    id: resourceGroup.id,
    label: resourceGroup.label,
    resourceCount: resourceGroup.resourceStates.length,
  };
}

function describeLanguageModel(
  model: vscode.LanguageModelChat,
): Record<string, unknown> {
  return {
    vendor: model.vendor,
    id: model.id,
    name: model.name,
    family: model.family,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
  };
}

function throwIfCancelled(
  token: vscode.CancellationToken,
  generationLease?: CommitMessageGenerationLease,
): void {
  if (
    token.isCancellationRequested ||
    (generationLease !== undefined && !generationLease.isCurrent())
  ) {
    throw new vscode.CancellationError();
  }
}

function reportCommitMessageProgress(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  generationLease: CommitMessageGenerationLease,
  message: string,
): void {
  throwIfCancelled(token, generationLease);
  progress.report({ message });
}

function getLanguageModelPartCharCount(value: string | string[]): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, part) => sum + part.length, 0);
  }

  return value.length;
}

function withCommitMessageCancellationTimeout<T>(
  task: Promise<T>,
  token: vscode.CancellationToken,
  generationLease: CommitMessageGenerationLease,
  logger: ReturnType<typeof createCommitMessageLogger>,
  trace: CommitMessageGenerationTrace,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancellationListener: vscode.Disposable | undefined;

    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      cancellationListener?.dispose();
    };

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (value: T): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    };

    const scheduleTimeout = (): void => {
      if (timeoutId !== undefined) {
        return;
      }

      timeoutId = setTimeout(() => {
        generationLease.release();
        logger.warn(
          'Cancellation grace period expired; releasing commit message generation lock.',
          {
            generationId: generationLease.id,
            currentPhase: trace.currentPhase,
            timeoutMs: COMMIT_MESSAGE_CANCELLATION_TIMEOUT_MS,
          },
        );
        rejectOnce(new vscode.CancellationError());
      }, COMMIT_MESSAGE_CANCELLATION_TIMEOUT_MS);
    };

    cancellationListener = token.onCancellationRequested(scheduleTimeout);
    if (token.isCancellationRequested) {
      scheduleTimeout();
    }

    void task.then(resolveOnce, rejectOnce);
  });
}

function clonePromptState(
  state: CommitMessagePromptState,
): CommitMessagePromptState {
  return {
    configuration: {
      ...state.configuration,
      model: { ...state.configuration.model },
      excludeFiles: [...state.configuration.excludeFiles],
    },
    context: {
      ...state.context,
      filePromptItems: state.context.filePromptItems.map((item) => ({
        ...item,
      })),
      fileHistoryEntries: state.context.fileHistoryEntries.map((entry) => ({
        ...entry,
      })),
      repositoryHistoryEntries: state.context.repositoryHistoryEntries.map(
        (entry) => ({ ...entry }),
      ),
    },
  };
}

async function countPromptTokens(
  model: vscode.LanguageModelChat,
  messages: readonly vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
): Promise<number> {
  const tokenCounts = await Promise.all(
    messages.map((message) => model.countTokens(message, token)),
  );
  return tokenCounts.reduce((sum, count) => sum + count, 0);
}

function stripSummaryTruncationNotice(summary: string): string {
  return summary.endsWith(SUMMARY_TRUNCATION_NOTICE)
    ? summary.slice(0, -SUMMARY_TRUNCATION_NOTICE.length)
    : summary;
}

function truncateSummary(summary: string): string | undefined {
  const baseSummary = stripSummaryTruncationNotice(summary);
  if (baseSummary.length <= SUMMARY_TRUNCATION_NOTICE.length + 1) {
    return undefined;
  }

  const targetBaseLength = Math.max(
    1,
    Math.floor(baseSummary.length * 0.8) - SUMMARY_TRUNCATION_NOTICE.length,
  );
  if (targetBaseLength >= baseSummary.length) {
    return undefined;
  }

  return baseSummary.slice(0, targetBaseLength) + SUMMARY_TRUNCATION_NOTICE;
}

function truncateLongestFileSummaries(
  state: CommitMessagePromptState,
): boolean {
  const longestItems = [...state.context.filePromptItems]
    .sort((left, right) => right.summary.length - left.summary.length)
    .slice(0, 10);

  let changed = false;
  for (const item of longestItems) {
    const truncatedSummary = truncateSummary(item.summary);
    if (!truncatedSummary || truncatedSummary === item.summary) {
      continue;
    }

    item.summary = truncatedSummary;
    changed = true;
  }

  return changed;
}

async function buildCompressedPromptMessages(
  model: vscode.LanguageModelChat,
  promptState: CommitMessagePromptState,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  generationLease: CommitMessageGenerationLease,
): Promise<CommitMessageCompressionResult> {
  const workingState = clonePromptState(promptState);

  for (;;) {
    throwIfCancelled(token, generationLease);

    const messages = buildPromptMessages(workingState);
    const totalTokens = await countPromptTokens(model, messages, token);
    if (totalTokens <= model.maxInputTokens) {
      return { messages, totalTokens };
    }

    reportCommitMessageProgress(
      progress,
      token,
      generationLease,
      t('Compressing prompt to fit model context...'),
    );

    if (
      workingState.context.repositoryHistoryEntries.length >
      MIN_REPOSITORY_HISTORY_ENTRIES
    ) {
      workingState.context.repositoryHistoryEntries.pop();
      continue;
    }

    if (
      workingState.context.fileHistoryEntries.length > MIN_FILE_HISTORY_ENTRIES
    ) {
      workingState.context.fileHistoryEntries.pop();
      continue;
    }

    if (truncateLongestFileSummaries(workingState)) {
      continue;
    }

    throw new PromptTooLargeError();
  }
}

async function generateCommitMessage(
  explicitRepository: unknown,
  scope: CommitMessageGenerationRequestScope,
  resourceGroup: vscode.SourceControlResourceGroup | undefined,
): Promise<void> {
  const logger = createCommitMessageLogger();
  const generationLease = tryAcquireCommitMessageGenerationLease();

  if (!generationLease) {
    logger.warn(
      'Generation request ignored because another request is already in progress.',
      {
        scope,
        resourceGroup: describeResourceGroup(resourceGroup),
      },
    );
    vscode.window.showInformationMessage(
      t('Commit message generation is already in progress.'),
    );
    return;
  }

  const trace = createCommitMessageGenerationTrace();
  let repositoryLabel = '';
  let effectiveScope: CommitMessageGenerationScope | undefined;
  let selectedModel: vscode.LanguageModelChat | undefined;
  let promptPayload: CommitMessageCompressionResult | undefined;
  let promptState: CommitMessagePromptState | undefined;
  let generatedText = '';

  try {
    logger.info(`▶ Generation started | Scope: ${scope}`);
    logger.verbose('Generation input', {
      hasExplicitRepository: explicitRepository !== undefined,
      resourceGroup: describeResourceGroup(resourceGroup),
    });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl },
      async () => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('Commit message generation'),
            cancellable: true,
          },
          (progress, token) =>
            withCommitMessageCancellationTimeout(
              (async () => {
                reportCommitMessageProgress(
                  progress,
                  token,
                  generationLease,
                  t('Initializing commit message generation...'),
                );

                const configuration = await measureCommitMessageGenerationPhase(
                  trace,
                  'configuration',
                  async () => readCommitMessageGenerationConfiguration(),
                );
                throwIfCancelled(token, generationLease);
                logger.verbose(
                  'Resolved commit message generation configuration',
                  summarizeCommitMessageGenerationConfiguration(configuration),
                );

                reportCommitMessageProgress(
                  progress,
                  token,
                  generationLease,
                  t('Resolving Git repository...'),
                );
                const repository = await measureCommitMessageGenerationPhase(
                  trace,
                  'resolveRepository',
                  async () =>
                    resolveRepositoryFromContext(
                      explicitRepository,
                      resourceGroup,
                    ),
                );
                throwIfCancelled(token, generationLease);
                repositoryLabel = repository.rootUri.fsPath;
                logger.verbose('Resolved target repository', {
                  repositoryPath: repositoryLabel,
                });

                const resolvedScope: CommitMessageGenerationScope =
                  scope === 'auto'
                    ? (await repository.diff(true)).trim().length > 0
                      ? 'staged'
                      : 'all'
                    : scope;
                effectiveScope = resolvedScope;
                throwIfCancelled(token, generationLease);
                if (scope === 'auto') {
                  logger.info(`Auto scope resolved to: ${resolvedScope}`);
                }

                reportCommitMessageProgress(
                  progress,
                  token,
                  generationLease,
                  t('Collecting repository changes...'),
                );
                const repositoryContext =
                  await measureCommitMessageGenerationPhase(
                    trace,
                    'collectContext',
                    async () =>
                      collectCommitMessageRepositoryContext(
                        repository,
                        resolvedScope,
                        configuration,
                        token,
                      ),
                  );
                throwIfCancelled(token, generationLease);
                logger.verbose(
                  'Collected repository context',
                  summarizeCommitMessageRepositoryContext(repositoryContext),
                );

                reportCommitMessageProgress(
                  progress,
                  token,
                  generationLease,
                  t('Loading language model...'),
                );
                selectedModel = await measureCommitMessageGenerationPhase(
                  trace,
                  'resolveModel',
                  async () => resolveCommitMessageGenerationModel(),
                );
                throwIfCancelled(token, generationLease);
                logger.verbose(
                  'Resolved language model for commit generation',
                  describeLanguageModel(selectedModel),
                );
                const model = selectedModel;

                promptState = {
                  configuration,
                  context: repositoryContext,
                };
                const resolvedPromptState = promptState;

                promptPayload = await measureCommitMessageGenerationPhase(
                  trace,
                  'buildPrompt',
                  async () =>
                    buildCompressedPromptMessages(
                      model,
                      resolvedPromptState,
                      progress,
                      token,
                      generationLease,
                    ),
                );
                const resolvedPromptPayload = promptPayload;
                throwIfCancelled(token, generationLease);
                logger.verbose(
                  'Prepared prompt payload for commit generation',
                  {
                    promptTokenCount: resolvedPromptPayload.totalTokens,
                    messageCount: resolvedPromptPayload.messages.length,
                    contextWindowUsagePct:
                      model.maxInputTokens > 0
                        ? Math.round(
                            (resolvedPromptPayload.totalTokens /
                              model.maxInputTokens) *
                              1000,
                          ) / 10
                        : undefined,
                    messageSummaries: summarizePromptMessages(
                      resolvedPromptPayload.messages,
                    ),
                  },
                );

                reportCommitMessageProgress(
                  progress,
                  token,
                  generationLease,
                  t('Requesting commit message generation...'),
                );
                const response = await measureCommitMessageGenerationPhase(
                  trace,
                  'requestModel',
                  async () =>
                    model.sendRequest(
                      resolvedPromptPayload.messages,
                      undefined,
                      token,
                    ),
                );
                throwIfCancelled(token, generationLease);

                generatedText = '';
                const responseStreamSummary =
                  await measureCommitMessageGenerationPhase(
                    trace,
                    'readResponse',
                    async (): Promise<CommitMessageResponseStreamSummary> => {
                      let partCount = 0;
                      let textPartCount = 0;
                      let thinkingPartCount = 0;
                      let thinkingCharCount = 0;
                      let hasReceivedText = false;

                      for await (const part of response.stream) {
                        throwIfCancelled(token, generationLease);
                        partCount += 1;

                        if (part instanceof vscode.LanguageModelThinkingPart) {
                          const thinkingChars = getLanguageModelPartCharCount(
                            part.value,
                          );
                          if (thinkingChars <= 0) {
                            continue;
                          }

                          thinkingPartCount += 1;
                          thinkingCharCount += thinkingChars;

                          if (!hasReceivedText) {
                            reportCommitMessageProgress(
                              progress,
                              token,
                              generationLease,
                              t(
                                'Thinking about commit message... ({0} chars)',
                                thinkingCharCount,
                              ),
                            );
                          }
                          continue;
                        }

                        if (part instanceof vscode.LanguageModelTextPart) {
                          if (!part.value) {
                            continue;
                          }

                          generatedText += part.value;
                          textPartCount += 1;
                          hasReceivedText = true;
                          reportCommitMessageProgress(
                            progress,
                            token,
                            generationLease,
                            t(
                              'Generating commit message... ({0} chars)',
                              generatedText.length,
                            ),
                          );
                        }
                      }

                      return {
                        partCount,
                        textPartCount,
                        thinkingPartCount,
                        thinkingCharCount,
                      };
                    },
                  );
                throwIfCancelled(token, generationLease);

                const normalizedCommitMessage =
                  normalizeGeneratedCommitMessage(generatedText);
                if (!normalizedCommitMessage) {
                  throw new Error(
                    t('The selected model returned an empty commit message.'),
                  );
                }
                logger.verbose('Received model response', {
                  streamPartCount: responseStreamSummary.partCount,
                  textPartCount: responseStreamSummary.textPartCount,
                  thinkingPartCount: responseStreamSummary.thinkingPartCount,
                  thinkingCharCount: responseStreamSummary.thinkingCharCount,
                  rawResponseCharCount: generatedText.length,
                  normalizedCommitMessage,
                  rawResponse:
                    generatedText !== normalizedCommitMessage
                      ? generatedText
                      : undefined,
                });

                reportCommitMessageProgress(
                  progress,
                  token,
                  generationLease,
                  t('Applying commit message to SCM input...'),
                );
                await measureCommitMessageGenerationPhase(
                  trace,
                  'applyResult',
                  async () => {
                    throwIfCancelled(token, generationLease);
                    repository.inputBox.value = normalizedCommitMessage;
                  },
                );
              })(),
              token,
              generationLease,
              logger,
              trace,
            ),
        );
      },
    );

    const generationTimings = buildCommitMessageGenerationTimingSummary(trace);
    const durationBreakdown =
      buildCommitMessageGenerationDurationBreakdown(generationTimings);
    logger.verbose('Generation timings', generationTimings);
    logger.info(
      `✓ Generation completed | Scope: ${effectiveScope ?? scope} | Repository: ${
        repositoryLabel || 'unknown'
      } | Pre-send: ${durationBreakdown.preSendMs}ms | Post-send: ${
        durationBreakdown.postSendMs
      }ms | Total: ${durationBreakdown.totalMs}ms`,
    );
  } catch (error) {
    const generationTimings = buildCommitMessageGenerationTimingSummary(trace);
    const durationBreakdown =
      buildCommitMessageGenerationDurationBreakdown(generationTimings);

    if (error instanceof vscode.CancellationError) {
      logger.warn(`Generation cancelled during phase: ${trace.currentPhase}`, {
        scope,
        repositoryPath: repositoryLabel || undefined,
        timings: durationBreakdown,
      });
      logger.verbose('Generation cancellation details', {
        scope,
        repositoryPath: repositoryLabel || undefined,
        timings: generationTimings,
        model: selectedModel ? describeLanguageModel(selectedModel) : undefined,
        promptTokenCount: promptPayload?.totalTokens,
        promptState,
        partialResponse: generatedText || undefined,
      });
    } else {
      logger.error(`Generation failed during phase: ${trace.currentPhase}`, {
        scope,
        repositoryPath: repositoryLabel || undefined,
        timings: durationBreakdown,
        error,
      });
      logger.verbose('Generation failure details', {
        scope,
        repositoryPath: repositoryLabel || undefined,
        timings: generationTimings,
        model: selectedModel ? describeLanguageModel(selectedModel) : undefined,
        promptTokenCount: promptPayload?.totalTokens,
        promptState,
        partialResponse: generatedText || undefined,
        error,
      });
    }
    await handleCommitMessageGenerationError(error);
  } finally {
    generationLease.release();
  }
}

async function handleCommitMessageGenerationError(
  error: unknown,
): Promise<void> {
  if (error instanceof vscode.CancellationError) {
    return;
  }

  if (error instanceof NoChangesDetectedError) {
    vscode.window.showWarningMessage(
      t('No changes were detected for commit message generation.'),
    );
    return;
  }

  if (error instanceof NoGitRepositoriesFoundError) {
    vscode.window.showWarningMessage(t('No Git repositories were found.'));
    return;
  }

  if (error instanceof GitExtensionUnavailableError) {
    vscode.window.showErrorMessage(t('Git extension is unavailable.'));
    return;
  }

  if (error instanceof NoLanguageModelsAvailableError) {
    vscode.window.showWarningMessage(
      t('No available language models were found.'),
    );
    return;
  }

  if (error instanceof PromptTooLargeError) {
    vscode.window.showErrorMessage(
      t(
        'Unable to fit the commit prompt into the selected model context window.',
      ),
    );
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(
    t('Failed to generate a commit message: {0}', message),
  );
}

export function registerCommitMessageGeneration(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    registerCommitMessageGenerationButtonsContext(),
    registerGitAvailabilityContext(),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'unifyChatProvider.commitMessageGeneration.generate',
      async (repository?: unknown) => {
        await generateCommitMessage(repository, 'auto', undefined);
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.commitMessageGeneration.generateAll',
      async (repository?: unknown) => {
        await generateCommitMessage(repository, 'all', undefined);
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.commitMessageGeneration.generateStaged',
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        await generateCommitMessage(undefined, 'staged', resourceGroup);
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.commitMessageGeneration.generateWorkingTree',
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        await generateCommitMessage(undefined, 'workingTree', resourceGroup);
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.commitMessageGeneration.changeModel',
      async () => {
        try {
          await changeCommitMessageModelConfiguration();
        } catch (error) {
          await handleCommitMessageGenerationError(error);
        }
      },
    ),
  );
}
