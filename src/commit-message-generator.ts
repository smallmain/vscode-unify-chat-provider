import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import { t } from './i18n';
import {
    createCommitMessageRequestName,
    requestCommitMessageCancellation,
} from './commit-message-cancellation';

const execFileAsync = promisify(execFile);

const VENDOR_ID = 'unify-chat-provider';
const MODEL_SETTING_KEY = 'unifyChatProvider.commitMessageGeneration.model';
const IN_PROGRESS_CONTEXT_KEY =
    'unifyChatProvider.commitMessageGeneration.inProgress';
const MAX_GIT_OUTPUT_BYTES = 2_000_000;
const MAX_SINGLE_UNTRACKED_DIFF_CHARS = 12_000;
const COMMIT_MESSAGE_LOG_CHANNEL_NAME =
    'Unify Chat Provider: Commit Message Generation';
const GIT_OUTPUT_TRUNCATED_MARKER =
    '[git output truncated: exceeded process buffer limit]';
const DEFAULT_COMMIT_MESSAGE_PROMPT = `1. Use conventional commit message format
2. Choose message language according project rules. If not specified:
  1) Analyze code and determine the most appropriate language from code comments.
  2) If you cannot determine the language, default to English.
3. Present the generated commit message to the user in text format:
<type>(<scope>): <subject>
<BLANK LINE>
<body>`;

let generationInProgress = false;
let generationCancellationSource: vscode.CancellationTokenSource | undefined;
let activeCommitMessageRequestName: string | undefined;
let commitMessageLogChannel: vscode.LogOutputChannel | undefined;

interface GitRepositoryLike {
    readonly rootUri: vscode.Uri;
    readonly inputBox?: {
        value: string;
    };
}

interface RunGitCommandError extends Error {
    code?: number | string;
    stdout?: string;
    stderr?: string;
}

interface ModelPickItem extends vscode.QuickPickItem {
    readonly modelId: string;
}

interface CommitMessageContextLimits {
    readonly maxChangeContextChars: number;
    readonly maxUntrackedFileCount: number;
}

class OperationCancelledError extends Error {
    constructor() {
        super('operation cancelled');
    }
}

class GitOutputOverflowError extends Error {
    constructor() {
        super(`git output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`);
    }
}

/**
 * Generate and insert a commit message based on current uncommitted git changes.
 */
export async function generateCommitMessageFromChanges(
    configStore: ConfigStore,
    commandContext?: unknown,
): Promise<void> {
    logCommitMessageInfo('command invoked');

    if (generationInProgress) {
        logCommitMessageInfo('command ignored because generation is already in progress');
        vscode.window.showInformationMessage(
            t('Commit message generation is already running.'),
        );
        return;
    }

    const configuredModelId = configStore.commitMessageGenerationModel;
    if (!configuredModelId) {
        logCommitMessageInfo('command aborted because no model is configured');
        vscode.window.showInformationMessage(
            t(
                'Commit message generation is disabled. Select a model in settings to enable it.',
            ),
        );
        return;
    }

    let repository: GitRepositoryLike | undefined;
    try {
        logCommitMessageInfo('resolving repository from context/git extension');
        repository = await resolveRepository(commandContext);
        logCommitMessageInfo('repository resolved', {
            rootPath: repository?.rootUri.fsPath ?? 'undefined',
        });
    } catch (error) {
        logCommitMessageError('failed to resolve repository', error);
        showCommitMessageGenerationError(error);
        return;
    }

    if (!repository) {
        logCommitMessageInfo('no repository resolved for current workspace/context');
        vscode.window.showErrorMessage(
            t('No Git repository found in the current workspace.'),
        );
        return;
    }

    let model: vscode.LanguageModelChat | undefined;
    try {
        logCommitMessageInfo('resolving configured model', {
            modelId: configuredModelId,
        });
        model = await resolveConfiguredModel(configuredModelId);
        logCommitMessageInfo('model resolve completed', {
            found: Boolean(model),
        });
    } catch (error) {
        logCommitMessageError('failed to resolve configured model', error);
        showCommitMessageGenerationError(error);
        return;
    }

    if (!model) {
        vscode.window.showErrorMessage(
            t(
                'Selected model "{0}" is unavailable. Update setting "{1}".',
                configuredModelId,
                MODEL_SETTING_KEY,
            ),
        );
        return;
    }

    const cancellationSource = new vscode.CancellationTokenSource();
    generationCancellationSource = cancellationSource;
    let requestName: string | undefined;

    generationInProgress = true;
    try {
        logCommitMessageInfo('starting generation workflow');
        await vscode.commands.executeCommand(
            'setContext',
            IN_PROGRESS_CONTEXT_KEY,
            true,
        );
        const token = cancellationSource.token;

        logCommitMessageInfo('collecting git change context', {
            repositoryPath: repository.rootUri.fsPath,
        });
        const changeContext = await collectGitChangeContext(
            repository.rootUri.fsPath,
            token,
            {
                maxChangeContextChars:
                    configStore.commitMessageGenerationMaxChangeContextChars,
                maxUntrackedFileCount:
                    configStore.commitMessageGenerationMaxUntrackedFileCount,
            },
        );
        if (!changeContext) {
            if (token.isCancellationRequested) {
                logCommitMessageInfo('generation cancelled before prompt preparation');
                return;
            }
            logCommitMessageInfo('no git changes detected, skipping generation');
            vscode.window.showInformationMessage(
                t('No changes detected. Commit message was not generated.'),
            );
            return;
        }
        logCommitMessageInfo('git change context collected', {
            chars: changeContext.length,
        });

        const fullPrompt = buildGenerationPrompt({
            instruction: resolveEffectivePrompt(configStore),
            gitChangeContext: changeContext,
        });
        logCommitMessageInfo('prompt prepared', {
            promptChars: fullPrompt.length,
        });

        requestName = createCommitMessageRequestName();
        activeCommitMessageRequestName = requestName;

        const generated = await requestCommitMessageText(
            model,
            fullPrompt,
            requestName,
            token,
        );

        if (!generated) {
            if (token.isCancellationRequested) {
                logCommitMessageInfo('generation cancelled before writing to scm input');
                return;
            }
            logCommitMessageInfo('generation produced empty result');
            vscode.window.showInformationMessage(
                t('The model returned an empty commit message. Please try again.'),
            );
            return;
        }

        try {
            await setCommitMessageInputValue(
                repository,
                commandContext,
                generated,
            );
            logCommitMessageInfo('commit message inserted into SCM input', {
                chars: generated.length,
            });
        } catch (error) {
            logCommitMessageError('failed to write generated message to SCM input', error);
            throw new Error(
                `failed to write generated message to SCM input: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    } catch (error) {
        if (cancellationSource.token.isCancellationRequested) {
            logCommitMessageInfo('generation cancelled by user action');
            return;
        }
        logCommitMessageError('generation workflow failed', error);
        showCommitMessageGenerationError(error);
    } finally {
        if (requestName && activeCommitMessageRequestName === requestName) {
            activeCommitMessageRequestName = undefined;
        }
        cancellationSource.dispose();
        if (generationCancellationSource === cancellationSource) {
            generationCancellationSource = undefined;
        }
        generationInProgress = false;
        logCommitMessageInfo('generation workflow finished');
        await vscode.commands.executeCommand(
            'setContext',
            IN_PROGRESS_CONTEXT_KEY,
            false,
        );
    }
}

/**
 * Cancel active commit-message generation (used by SCM in-progress button).
 */
export function cancelCommitMessageGeneration(): void {
    if (!generationInProgress || !generationCancellationSource) {
        return;
    }

    logCommitMessageInfo('cancellation requested from scm toolbar button');
    requestCommitMessageCancellation(activeCommitMessageRequestName);
    generationCancellationSource.cancel();
}

/**
 * Let user choose commit-message generation model from currently available models.
 */
export async function selectCommitMessageGenerationModel(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
    if (models.length === 0) {
        vscode.window.showInformationMessage(
            t('No models are currently available for commit message generation.'),
        );
        return;
    }

    const picks: ModelPickItem[] = [
        {
            label: t('Disable commit message generation'),
            description: t('Feature disabled (no model selected)'),
            modelId: '',
        },
        ...models
            .map<ModelPickItem>((model) => ({
                label: model.name && model.name.trim().length > 0 ? model.name : model.id,
                description: model.id,
                detail:
                    model.family && model.family.trim().length > 0
                        ? `${model.vendor} · ${model.family}`
                        : model.vendor,
                modelId: model.id,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    ];

    const selected = await vscode.window.showQuickPick(picks, {
        title: t('Select model for commit message generation'),
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!selected) {
        return;
    }

    await vscode.workspace
        .getConfiguration('unifyChatProvider')
        .update(
            'commitMessageGeneration.model',
            selected.modelId,
            vscode.ConfigurationTarget.Global,
        );
}

/**
 * Resolve the model configured in settings from currently available LM models.
 */
async function resolveConfiguredModel(
    modelId: string,
): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
    return models.find((candidate) => candidate.id === modelId);
}

/**
 * Resolve a git repository from SCM command context or git CLI discovery.
 */
async function resolveRepository(
    commandContext?: unknown,
): Promise<GitRepositoryLike | undefined> {
    const contextRepository = getContextRepository(commandContext);
    if (contextRepository) {
        return contextRepository;
    }

    const contextRootUri = getContextRootUri(commandContext);
    if (contextRootUri) {
        return {
            rootUri: contextRootUri,
        };
    }

    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFilePath) {
        const activeFileGitRoot = await resolveGitRootFromPath(path.dirname(activeFilePath));
        if (activeFileGitRoot) {
            return {
                rootUri: vscode.Uri.file(activeFileGitRoot),
            };
        }
    }

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
        const workspaceGitRoot = await resolveGitRootFromPath(
            workspaceFolder.uri.fsPath,
        );
        if (workspaceGitRoot) {
            return {
                rootUri: vscode.Uri.file(workspaceGitRoot),
            };
        }
    }

    return undefined;
}

/**
 * Resolve git repository root for an arbitrary path via git CLI.
 */
async function resolveGitRootFromPath(startPath: string): Promise<string | undefined> {
    try {
        const output = await runGitCommand(startPath, ['rev-parse', '--show-toplevel']);
        const trimmed = output.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extract repository-like object from SCM command context when possible.
 */
function getContextRepository(commandContext: unknown): GitRepositoryLike | undefined {
    const rootUri = getContextRootUri(commandContext);
    const inputBox = getContextInputBox(commandContext);

    if (!rootUri || !inputBox) {
        return undefined;
    }

    return {
        rootUri,
        inputBox,
    };
}

/**
 * Collect git changes for commit-message generation.
 *
 * Selection strategy:
 * 1) if staged changes exist, use only staged diff,
 * 2) otherwise, use unstaged diff and untracked context.
 */
async function collectGitChangeContext(
    repositoryPath: string,
    token: vscode.CancellationToken,
    limits: CommitMessageContextLimits,
): Promise<string | undefined> {
    throwIfCancelled(token);
    const stagedDiff = await runGitCommand(
        repositoryPath,
        ['diff', '--cached', '--'],
        [0],
        token,
        true,
    );

    if (stagedDiff.trim().length > 0) {
        return truncateChangeContext(stagedDiff, limits.maxChangeContextChars);
    }

    throwIfCancelled(token);
    const unstagedDiff = await runGitCommand(
        repositoryPath,
        ['diff', '--'],
        [0],
        token,
        true,
    );
    throwIfCancelled(token);
    let untrackedFiles: string[] = [];
    let untrackedListOverflowed = false;

    try {
        const untrackedRaw = await runGitCommand(
            repositoryPath,
            ['ls-files', '--others', '--exclude-standard'],
            [0],
            token,
            false,
        );
        untrackedFiles = splitNonEmptyLines(untrackedRaw);
    } catch (error) {
        if (error instanceof GitOutputOverflowError) {
            untrackedListOverflowed = true;
        } else {
            throw error;
        }
    }

    if (
        unstagedDiff.trim().length === 0 &&
        untrackedFiles.length === 0 &&
        !untrackedListOverflowed
    ) {
        return undefined;
    }

    const sections: string[] = [];

    if (unstagedDiff.trim().length > 0) {
        sections.push(`## Unstaged changes\n${unstagedDiff}`);
    }

    if (untrackedFiles.length > 0) {
        sections.push(
            `## Untracked files\n${untrackedFiles.map((file) => `- ${file}`).join('\n')}`,
        );

        const untrackedDiffs = await collectUntrackedDiffs(
            repositoryPath,
            untrackedFiles,
            token,
            limits.maxUntrackedFileCount,
        );
        if (untrackedDiffs.length > 0) {
            sections.push(`## Untracked file diffs\n${untrackedDiffs.join('\n\n')}`);
        }
    }

    if (untrackedListOverflowed) {
        sections.push(
            `## Untracked files\n[skipped untracked file list: ${GIT_OUTPUT_TRUNCATED_MARKER}]`,
        );
    }

    const combined = sections.join('\n\n');
    return truncateChangeContext(combined, limits.maxChangeContextChars);
}

/**
 * Collect synthetic diffs for newly created files so model sees actual content.
 */
async function collectUntrackedDiffs(
    repositoryPath: string,
    untrackedFiles: readonly string[],
    token: vscode.CancellationToken,
    maxUntrackedFileCount: number,
): Promise<string[]> {
    const diffs: string[] = [];
    const filesToProcess = untrackedFiles.slice(0, maxUntrackedFileCount);
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

    for (const relativePath of filesToProcess) {
        if (token.isCancellationRequested) {
            break;
        }

        try {
            const rawDiff = await runGitCommand(
                repositoryPath,
                ['diff', '--no-index', '--', nullDevice, relativePath],
                [0, 1],
                token,
                true,
            );

            if (rawDiff.trim().length === 0) {
                continue;
            }

            const perFileDiff =
                rawDiff.length > MAX_SINGLE_UNTRACKED_DIFF_CHARS
                    ? `${rawDiff.slice(0, MAX_SINGLE_UNTRACKED_DIFF_CHARS)}\n\n[truncated ${rawDiff.length - MAX_SINGLE_UNTRACKED_DIFF_CHARS} characters for ${relativePath}]`
                    : rawDiff;

            diffs.push(perFileDiff);
        } catch {
            diffs.push(`[skipped diff for ${relativePath}: unable to render diff]`);
        }
    }

    if (untrackedFiles.length > filesToProcess.length) {
        diffs.push(
            `[skipped ${untrackedFiles.length - filesToProcess.length} additional untracked file(s)]`,
        );
    }

    return diffs;
}

/**
 * Build a complete LLM prompt from instructions and git change context.
 */
function buildGenerationPrompt(params: {
    instruction: string;
    gitChangeContext: string;
    userDescription?: string;
}): string {
    const normalizedDescription = (params.userDescription ?? '').trim();

    const promptSections = [
        'Generate a single commit message based on the provided repository changes.',
        'Instructions:',
        params.instruction,
        normalizedDescription.length > 0
            ? `User-provided description of changes:\n${normalizedDescription}`
            : undefined,
        'Git change context:',
        params.gitChangeContext,
        'Return only the commit message text in plain text format.',
    ];

    return promptSections.filter((part): part is string => Boolean(part)).join('\n\n');
}

/**
 * Normalize model output to plain commit message text.
 */
function normalizeGeneratedCommitMessage(rawOutput: string): string {
    const trimmed = rawOutput.trim();
    const fencedMatch = trimmed.match(/^```(?:txt|text|markdown)?\s*([\s\S]*?)\s*```$/i);
    if (!fencedMatch) {
        return trimmed;
    }

    return fencedMatch[1].trim();
}

/**
 * Truncate aggregate git context to avoid oversized prompts.
 */
function truncateChangeContext(context: string, maxChangeContextChars: number): string {
    if (context.length <= maxChangeContextChars) {
        return context;
    }

    const truncatedChars = context.length - maxChangeContextChars;
    return `${context.slice(0, maxChangeContextChars)}\n\n[truncated ${truncatedChars} characters to stay within prompt limits]`;
}

/**
 * Run git command in a repository and return stdout.
 */
async function runGitCommand(
    repositoryPath: string,
    args: readonly string[],
    acceptedExitCodes: readonly number[] = [0],
    token?: vscode.CancellationToken,
    allowOutputTruncationOnMaxBuffer = false,
): Promise<string> {
    throwIfCancelled(token);

    const abortController = new AbortController();
    const cancellationDisposable = token?.onCancellationRequested(() => {
        abortController.abort();
    });

    try {
        const { stdout } = await execFileAsync('git', [...args], {
            cwd: repositoryPath,
            maxBuffer: MAX_GIT_OUTPUT_BYTES,
            signal: abortController.signal,
        });
        return stdout;
    } catch (error) {
        if (isAbortError(error) || token?.isCancellationRequested) {
            throw new OperationCancelledError();
        }

        if (!isRunGitCommandError(error)) {
            throw error;
        }

        if (isMaxBufferExceededError(error)) {
            if (allowOutputTruncationOnMaxBuffer) {
                return truncateOutputOnBufferOverflow(error.stdout ?? '');
            }
            throw new GitOutputOverflowError();
        }

        if (
            typeof error.code === 'number' &&
            acceptedExitCodes.includes(error.code)
        ) {
            return error.stdout ?? '';
        }

        const stderr = error.stderr?.trim();
        if (stderr) {
            throw new Error(stderr);
        }

        throw new Error(error.message);
    } finally {
        cancellationDisposable?.dispose();
    }
}

/**
 * Detect shape of child_process execution error used by execFile.
 */
function isRunGitCommandError(error: unknown): error is RunGitCommandError {
    return error instanceof Error;
}

/**
 * Check whether process execution failed because maxBuffer was exceeded.
 */
function isMaxBufferExceededError(error: RunGitCommandError): boolean {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return true;
    }

    const message = error.message.toLowerCase();
    return message.includes('maxbuffer');
}

/**
 * Check whether process execution failed due to cancellation abort signal.
 */
function isAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    return error.name === 'AbortError';
}

/**
 * Truncate oversized process output while preserving useful partial context.
 */
function truncateOutputOnBufferOverflow(output: string): string {
    const normalized = output.trimEnd();
    if (normalized.length === 0) {
        return GIT_OUTPUT_TRUNCATED_MARKER;
    }

    return `${normalized}\n\n${GIT_OUTPUT_TRUNCATED_MARKER}`;
}

/**
 * Parse newline-separated output into a list without empty entries.
 */
function splitNonEmptyLines(value: string): string[] {
    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Extract SCM root URI from command invocation context.
 */
function getContextRootUri(commandContext: unknown): vscode.Uri | undefined {
    if (!isRecord(commandContext)) {
        return undefined;
    }

    const rootUri = commandContext['rootUri'];
    if (rootUri instanceof vscode.Uri) {
        return rootUri;
    }

    const sourceControl = commandContext['sourceControl'];
    if (!isRecord(sourceControl)) {
        return undefined;
    }

    const nestedRootUri = sourceControl['rootUri'];
    return nestedRootUri instanceof vscode.Uri ? nestedRootUri : undefined;
}

/**
 * Extract SCM input box from command invocation context.
 */
function getContextInputBox(
    commandContext: unknown,
): GitRepositoryLike['inputBox'] | undefined {
    if (!isRecord(commandContext)) {
        return undefined;
    }

    const directInputBox = commandContext['inputBox'];
    if (isSourceControlInputBoxLike(directInputBox)) {
        return directInputBox;
    }

    const sourceControl = commandContext['sourceControl'];
    if (!isRecord(sourceControl)) {
        return undefined;
    }

    const inputBox = sourceControl['inputBox'];
    return isSourceControlInputBoxLike(inputBox) ? inputBox : undefined;
}

/**
 * Assign generated message to SCM input box.
 *
 * Priority order:
 * 1) resolved repository input box,
 * 2) command context sourceControl input box,
 * 3) global vscode.scm input box.
 */
async function setCommitMessageInputValue(
    repository: GitRepositoryLike,
    commandContext: unknown,
    value: string,
): Promise<void> {
    const candidateInputBoxes: Array<NonNullable<GitRepositoryLike['inputBox']>> = [];

    if (isSourceControlInputBoxLike(repository.inputBox)) {
        candidateInputBoxes.push(repository.inputBox);
    }

    const contextInputBox = getContextInputBox(commandContext);
    if (contextInputBox) {
        candidateInputBoxes.push(contextInputBox);
    }

    if (isSourceControlInputBoxLike(vscode.scm.inputBox)) {
        candidateInputBoxes.push(vscode.scm.inputBox);
    }

    logCommitMessageInfo('scm input candidates prepared', {
        candidates: candidateInputBoxes.length,
    });

    const attempted = new Set<NonNullable<GitRepositoryLike['inputBox']>>();
    let lastError: unknown;

    for (const inputBox of candidateInputBoxes) {
        if (attempted.has(inputBox)) {
            continue;
        }
        attempted.add(inputBox);

        try {
            inputBox.value = value;
            return;
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError instanceof Error) {
        throw lastError;
    }

    if (lastError !== undefined) {
        throw new Error(String(lastError));
    }

    throw new Error('no source control input box available');
}

/**
 * Runtime guard for plain object records.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Runtime guard for source control input box shape without touching getters.
 */
function isSourceControlInputBoxLike(
    value: unknown,
): value is NonNullable<GitRepositoryLike['inputBox']> {
    return isRecord(value) && 'value' in value;
}

/**
 * Throw cancellation error when token indicates operation should stop.
 */
function throwIfCancelled(token: vscode.CancellationToken | undefined): void {
    if (token?.isCancellationRequested) {
        throw new OperationCancelledError();
    }
}

/**
 * Resolve prompt instructions for commit-message generation.
 */
function resolveEffectivePrompt(configStore: ConfigStore): string {
    const customPrompt = configStore.commitMessageGenerationPrompt;
    return customPrompt.trim().length > 0
        ? customPrompt
        : DEFAULT_COMMIT_MESSAGE_PROMPT;
}

/**
 * Request commit-message text from model and normalize streamed response.
 */
async function requestCommitMessageText(
    model: vscode.LanguageModelChat,
    fullPrompt: string,
    requestName: string,
    token: vscode.CancellationToken,
): Promise<string | undefined> {
    let response: vscode.LanguageModelChatResponse;
    try {
        response = await awaitWithCancellation(
            model.sendRequest(
                [vscode.LanguageModelChatMessage.User(fullPrompt, requestName)],
                {},
                token,
            ),
            token,
        );
    } catch (error) {
        if (token.isCancellationRequested) {
            logCommitMessageInfo('generation cancelled during model request');
            return undefined;
        }
        logCommitMessageError('model request failed', error);
        throw new Error(
            `model request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    logCommitMessageInfo('model request started streaming response');

    const combined = await readResponseTextWithCancellation(response.text, token);
    if (combined === undefined) {
        logCommitMessageInfo('generation cancelled during model response stream');
        return undefined;
    }
    logCommitMessageInfo('model response stream completed', {
        responseChars: combined.length,
    });

    const normalized = normalizeGeneratedCommitMessage(combined);
    logCommitMessageInfo('normalized generated message', {
        chars: normalized.length,
    });

    return normalized.length > 0 ? normalized : undefined;
}

/**
 * Lazily create commit-message generation log channel.
 */
function getCommitMessageLogChannel(): vscode.LogOutputChannel {
    if (!commitMessageLogChannel) {
        commitMessageLogChannel = vscode.window.createOutputChannel(
            COMMIT_MESSAGE_LOG_CHANNEL_NAME,
            { log: true },
        );
    }

    return commitMessageLogChannel;
}

/**
 * Write informational log for commit-message generation workflow.
 */
function logCommitMessageInfo(message: string, data?: unknown): void {
    const channel = getCommitMessageLogChannel();
    if (data !== undefined) {
        channel.info(`[commit-message-generation] ${message}`, data);
    } else {
        channel.info(`[commit-message-generation] ${message}`);
    }
}

/**
 * Write error log for commit-message generation workflow.
 */
function logCommitMessageError(message: string, error: unknown): void {
    const channel = getCommitMessageLogChannel();
    channel.error(`[commit-message-generation] ${message}`);
    channel.error(error instanceof Error ? error : String(error));
}

/**
 * Show a unified user-facing error message for commit-message generation failures.
 */
function showCommitMessageGenerationError(error: unknown): void {
    const normalized = error instanceof Error ? error.message : String(error);
    const details = normalized.trim().length > 0 ? normalized : 'unknown error';
    vscode.window.showErrorMessage(
        t('Failed to generate commit message: {0}', details),
    );
}

/**
 * Await a promise and fail fast when cancellation is requested.
 */
async function awaitWithCancellation<T>(
    operation: PromiseLike<T>,
    token: vscode.CancellationToken,
): Promise<T> {
    if (token.isCancellationRequested) {
        throw new OperationCancelledError();
    }

    return new Promise<T>((resolve, reject) => {
        const cancellationDisposable = token.onCancellationRequested(() => {
            cancellationDisposable.dispose();
            reject(new OperationCancelledError());
        });

        operation.then(
            (result) => {
                cancellationDisposable.dispose();
                resolve(result);
            },
            (error) => {
                cancellationDisposable.dispose();
                reject(error);
            },
        );
    });
}

/**
 * Read a model text stream and stop immediately when cancellation is requested.
 */
async function readResponseTextWithCancellation(
    responseText: AsyncIterable<string>,
    token: vscode.CancellationToken,
): Promise<string | undefined> {
    const iterator = responseText[Symbol.asyncIterator]();
    let combined = '';

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const chunk = await awaitWithCancellation(iterator.next(), token);
            if (chunk.done) {
                break;
            }

            combined += chunk.value;
        }
    } catch (error) {
        if (error instanceof OperationCancelledError || token.isCancellationRequested) {
            if (typeof iterator.return === 'function') {
                await iterator.return();
            }
            return undefined;
        }

        throw error;
    }

    return combined;
}
