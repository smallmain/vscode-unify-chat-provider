import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
} from '../../chat-lib/core/behavior-config';
import {
  registerCopilotContextProvider,
  type CopilotContextProvider,
  type CopilotContextProviderItem,
  type CopilotContextProviderRequest,
} from './context-provider';

const TYPESCRIPT_CONTEXT_PROVIDER_ID = 'typescript-ai-context-provider';
const SCM_CONTEXT_PROVIDER_ID = 'scm-context-provider';
const DIAGNOSTICS_CONTEXT_PROVIDER_ID = 'diagnostics-context-provider';

type DiagnosticsReader = (
  uri: vscode.Uri,
) => readonly vscode.Diagnostic[];

export interface DefaultCopilotContextProviderOptions {
  readonly behaviorConfig?: CopilotBehaviorConfig;
  readonly getDiagnostics?: DiagnosticsReader;
  readonly register?: typeof registerCopilotContextProvider;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function importance(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value * 100)))
    : undefined;
}

function convertTypeScriptItem(
  value: unknown,
  itemImportance: number | undefined,
): CopilotContextProviderItem | undefined {
  if (!isRecord(value)) return undefined;
  const kind = Reflect.get(value, 'kind');
  if (kind === 'trait') {
    const name = Reflect.get(value, 'name');
    const traitValue = Reflect.get(value, 'value');
    return typeof name === 'string' && typeof traitValue === 'string'
      ? {
          name,
          value: traitValue,
          ...(itemImportance === undefined
            ? {}
            : { importance: itemImportance }),
        }
      : undefined;
  }
  if (kind !== 'snippet') return undefined;
  const fileName = Reflect.get(value, 'fileName');
  const snippetValue = Reflect.get(value, 'value');
  const additionalFileNames = Reflect.get(value, 'additionalFileNames');
  if (
    typeof fileName !== 'string' ||
    typeof snippetValue !== 'string' ||
    (additionalFileNames !== undefined &&
      (!Array.isArray(additionalFileNames) ||
        !additionalFileNames.every((entry) => typeof entry === 'string')))
  ) {
    return undefined;
  }
  return {
    uri: vscode.Uri.file(fileName).toString(),
    value: snippetValue,
    ...(Array.isArray(additionalFileNames)
      ? {
          additionalUris: additionalFileNames
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => vscode.Uri.file(entry).toString()),
        }
      : {}),
    ...(itemImportance === undefined ? {} : { importance: itemImportance }),
  };
}

function parseTypeScriptResponse(
  response: unknown,
): readonly CopilotContextProviderItem[] {
  if (!isRecord(response) || Reflect.get(response, 'type') === 'cancelled') {
    return [];
  }
  const body = Reflect.get(response, 'body');
  if (!isRecord(body)) return [];
  const candidates: Array<{
    readonly value: unknown;
    readonly importance: number | undefined;
  }> = [];
  const contextItems = Reflect.get(body, 'contextItems');
  if (Array.isArray(contextItems)) {
    for (const value of contextItems) {
      candidates.push({ value, importance: undefined });
    }
  }
  const runnableResults = Reflect.get(body, 'runnableResults');
  if (Array.isArray(runnableResults)) {
    for (const result of runnableResults) {
      if (!isRecord(result)) continue;
      const values = Reflect.get(result, 'items');
      if (!Array.isArray(values)) continue;
      const resultImportance = importance(Reflect.get(result, 'priority'));
      for (const value of values) {
        candidates.push({ value, importance: resultImportance });
      }
    }
  }
  return candidates.flatMap(({ value, importance: itemImportance }) => {
    const item = convertTypeScriptItem(value, itemImportance);
    return item ? [item] : [];
  });
}

class TypeScriptContextResolver {
  private readonly cache = new Map<
    string,
    readonly CopilotContextProviderItem[]
  >();
  private activation: Promise<boolean> | undefined;

  async resolve(
    request: CopilotContextProviderRequest,
    token: vscode.CancellationToken,
  ): Promise<readonly CopilotContextProviderItem[]> {
    if (token.isCancellationRequested || !(await this.activateTypeScript())) {
      return [];
    }
    const document = vscode.workspace.textDocuments.find(
      (candidate) =>
        candidate.uri.toString() === request.documentContext.uri &&
        candidate.version === request.documentContext.version,
    );
    if (!document?.fileName || token.isCancellationRequested) {
      return [];
    }
    const cacheKey = this.cacheKey(request);
    try {
      const response = await vscode.commands.executeCommand<unknown>(
        'typescript.tsserverRequest',
        '_.copilot.context',
        {
          file: vscode.Uri.file(document.fileName),
          line: request.documentContext.position.line + 1,
          offset: request.documentContext.position.character + 1,
          startTime: Date.now(),
          timeBudget: request.timeBudget,
          primaryCharacterBudget: 7 * 1024 * 4,
          secondaryCharacterBudget: 8 * 1024 * 4,
          includeDocumentation: false,
          $traceId: request.completionId,
        },
        { executionTarget: 0 },
        token,
      );
      if (token.isCancellationRequested) return [];
      const items = parseTypeScriptResponse(response);
      if (items.length > 0) this.cache.set(cacheKey, items);
      return items;
    } catch {
      return [];
    }
  }

  resolveOnTimeout(
    request: CopilotContextProviderRequest,
  ): readonly CopilotContextProviderItem[] | undefined {
    return this.cache.get(this.cacheKey(request));
  }

  private cacheKey(request: CopilotContextProviderRequest): string {
    const context = request.documentContext;
    return `${context.uri}:${context.version}:${context.position.line}:${context.position.character}`;
  }

  private activateTypeScript(): Promise<boolean> {
    this.activation ??= (async () => {
      const extension = vscode.extensions.getExtension(
        'vscode.typescript-language-features',
      );
      if (!extension) return false;
      try {
        await extension.activate();
        return true;
      } catch {
        return false;
      }
    })();
    return this.activation;
  }
}

function runGit(
  cwd: string,
  args: readonly string[],
  token: vscode.CancellationToken,
): Promise<string> {
  if (token.isCancellationRequested) return Promise.resolve('');
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...args],
      { cwd, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : stdout),
    );
    const subscription = token.onCancellationRequested(() => child.kill());
    child.once('close', () => subscription.dispose());
  });
}

async function scmContext(
  request: CopilotContextProviderRequest,
  token: vscode.CancellationToken,
): Promise<readonly CopilotContextProviderItem[]> {
  const subjectLength = vscode.workspace
    .getConfiguration('git')
    .get<number>('inputValidationSubjectLength', 50);
  const lineLength = vscode.workspace
    .getConfiguration('git')
    .get<number>('inputValidationLength', 72);
  const guidelines = [
    'This is a git commit message input field.',
    'The commit message should accurately describe the changes being committed in less than a sentence.',
    "Only provide a completion if you are confident you understand the intent of the user's commit based on the staged changes.",
    'Write in natural human language, not code or technical syntax.',
    'Use imperative mood (e.g., "Add feature" not "Added feature").',
    `Keep the first line (subject) under ${subjectLength} characters.`,
    `Keep all lines under ${lineLength} characters.`,
    'If the changes are unclear or ambiguous, do not complete the commit message.',
  ].join(' ');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root?.fsPath || token.isCancellationRequested) {
    return [{ name: 'Commit message guidelines', value: guidelines, importance: 100 }];
  }
  const staged = (
    await runGit(root.fsPath, ['diff', '--cached', '--name-only', '--'], token)
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const names =
    staged.length > 0
      ? staged
      : (
          await runGit(root.fsPath, ['diff', '--name-only', '--'], token)
        )
          .split(/\r?\n/)
          .filter(Boolean);
  const items: CopilotContextProviderItem[] = [
    { name: 'Commit message guidelines', value: guidelines, importance: 100 },
  ];
  for (const path of names.slice(0, 20)) {
    if (token.isCancellationRequested) break;
    const args = [
      'diff',
      ...(staged.length > 0 ? ['--cached'] : []),
      '--no-ext-diff',
      '--unified=3',
      '--',
      path,
    ];
    const diff = await runGit(root.fsPath, args, token);
    if (!diff) continue;
    items.push({
      uri: vscode.Uri.joinPath(root, path).toString(),
      value: diff,
      importance: 50,
    });
  }
  return items;
}

function diagnosticsToString(diagnostic: vscode.Diagnostic): string {
  const errorStartPosition =
    `${diagnostic.range.start.line + 1}:` +
    `${diagnostic.range.start.character + 1}`;
  const severity =
    diagnostic.severity === vscode.DiagnosticSeverity.Error
      ? 'error'
      : 'warning';
  const messageCode = diagnostic.code
    ? ` ${diagnostic.source?.toUpperCase() ?? ''}${String(diagnostic.code)}`
    : '';
  return `${errorStartPosition} - ${severity}${messageCode}: ${diagnostic.message}`;
}

function diagnosticsToTraits(
  diagnostics: readonly vscode.Diagnostic[],
): readonly CopilotContextProviderItem[] {
  if (diagnostics.length === 0) return [];
  return [
    {
      name: `Problems near the user's cursor`,
      value: diagnostics
        .map((diagnostic) => `\n\t${diagnosticsToString(diagnostic)}`)
        .join(''),
    },
  ];
}

export function createDiagnosticsContextProvider(
  behaviorConfig: CopilotBehaviorConfig = COPILOT_BEHAVIOR_CONFIG,
  getDiagnostics: DiagnosticsReader = (uri) =>
    vscode.languages.getDiagnostics(uri),
): CopilotContextProvider | undefined {
  if (!behaviorConfig.diagnosticsContextProvider.enabled) return undefined;

  return {
    id: DIAGNOSTICS_CONTEXT_PROVIDER_ID,
    selector: '*',
    resolver: {
      resolve: async () => [],
      resolveOnTimeout: (request) => {
        if (
          !behaviorConfig.diagnosticsContextProvider.enabledLanguages[
            request.documentContext.languageId
          ]
        ) {
          return [];
        }

        const uri = vscode.Uri.parse(request.documentContext.uri);
        const cursorLineNumber = request.documentContext.position.line + 1;
        const windowStartLine =
          request.documentContext.position.line -
          behaviorConfig.prompt.linesAboveEditWindow;
        const windowEndLine =
          request.documentContext.position.line +
          behaviorConfig.prompt.linesBelowEditWindow;
        const diagnostics = [...getDiagnostics(uri)]
          .filter(
            (diagnostic) =>
              diagnostic.range.start.line >= windowStartLine &&
              diagnostic.range.end.line <= windowEndLine,
          )
          .sort(
            (left, right) =>
              Math.abs(left.range.start.line - cursorLineNumber) -
              Math.abs(right.range.start.line - cursorLineNumber),
          )
          .slice(0, 3);
        return diagnosticsToTraits(diagnostics);
      },
    },
  };
}

export function registerDefaultCopilotContextProviders(
  options: DefaultCopilotContextProviderOptions = {},
): vscode.Disposable {
  const registrations: vscode.Disposable[] = [];
  const behaviorConfig = options.behaviorConfig ?? COPILOT_BEHAVIOR_CONFIG;
  const register = options.register ?? registerCopilotContextProvider;
  const typeScriptResolver = new TypeScriptContextResolver();
  registrations.push(
    register(
      {
        id: TYPESCRIPT_CONTEXT_PROVIDER_ID,
        selector: { scheme: 'file', language: 'typescript' },
        resolver: {
          resolve: (request, token) =>
            typeScriptResolver.resolve(request, token),
          resolveOnTimeout: (request) =>
            typeScriptResolver.resolveOnTimeout(request),
        },
      },
      ['completions', 'nes'],
    ),
    register(
      {
        id: SCM_CONTEXT_PROVIDER_ID,
        selector: { scheme: 'vscode-scm' },
        resolver: { resolve: scmContext },
      },
      ['completions'],
    ),
  );
  const diagnosticsProvider = createDiagnosticsContextProvider(
    behaviorConfig,
    options.getDiagnostics,
  );
  if (diagnosticsProvider) {
    registrations.push(register(diagnosticsProvider, ['nes']));
  }
  return {
    dispose: () => {
      for (const registration of registrations.splice(0)) {
        registration.dispose();
      }
    },
  };
}

export function contextProviderApiV1(): {
  registerContextProvider(provider: CopilotContextProvider): vscode.Disposable;
} {
  return {
    registerContextProvider: (provider) =>
      registerCopilotContextProvider(provider, ['completions']),
  };
}
