import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "SmallMain.vscode-unify-chat-provider";
const FAKE_LANGUAGE_MODEL_EXTENSION_ID = "ucp-e2e.fake-language-model";
const FAKE_NES_MODEL = { vendor: "ucp-e2e-fake", id: "controlled" } as const;

interface CompletionManagerState {
  registered: boolean;
  enabled: boolean;
  providerCount: number;
  providerIds: string[];
  excludedProviderGroups: string[];
  runtimeCount: number;
  runtimeInstances: Record<string, number>;
}

interface CompletionWarningEvent {
  key: string;
  message: string;
}

interface CompletionItemSnapshot {
  insertText: string;
  command?: string;
  uri?: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  showRange?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  isInlineEdit?: boolean;
  showInlineEditMenu?: boolean;
  jumpToPosition?: { line: number; character: number };
  displayLocation?: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    kind: vscode.InlineCompletionDisplayLocationKind;
    label: string;
  };
  correlationId?: string;
}

interface CompletionProvideResult {
  sessionId: number;
  items: CompletionItemSnapshot[];
}

interface FakeLanguageModelResponseInput {
  chunks: string[];
  delayMs?: number;
  chunkDelayMs?: number;
  error?: string;
}

interface FakeLanguageModelRequestRecord {
  modelId: string;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  modelOptions: Record<string, unknown>;
  justification?: string;
  messageBytes: number;
  optionsBytes: number;
  cancellationRequested: boolean;
}

interface CompletionExecutionOptionsRecord {
  candidateCount?: number;
  maxTokens?: number;
  stop?: string[];
}

interface SimpleAlgorithmRequestRecord {
  kind: "simple";
  prefix: string;
  suffix: string;
}

interface EditAlgorithmDocumentRecord {
  uri: string;
  path?: string;
  languageId: string;
  version: number;
  text: string;
  cursorOffset: number;
}

interface ZedAlgorithmRequestRecord {
  kind: "zed";
  document: EditAlgorithmDocumentRecord;
  trigger: string;
  maxTokens: number;
}

interface InceptionAlgorithmRequestRecord {
  kind: "inception";
  document: EditAlgorithmDocumentRecord;
}

interface MistralAlgorithmRequestRecord {
  kind: "mistral";
  document: EditAlgorithmDocumentRecord;
  maxTokens: number;
}

interface CopilotReplicaFimAlgorithmRequestRecord {
  kind: "copilot-replica/fim";
  targetPath?: string;
  prefix: string;
  suffix: string;
  contexts: Array<{ path?: string; content: string }>;
  options: CompletionExecutionOptionsRecord;
}

interface CopilotReplicaNesAlgorithmRequestRecord {
  kind: "copilot-replica/nes";
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxTokens?: number;
  prediction?: { type: "content"; content: string };
  responseFormat: { kind: "nes"; format: string };
}

interface CopilotReplicaCursorPredictionAlgorithmRequestRecord {
  kind: "copilot-replica/cursor-prediction";
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxTokens?: number;
  responseFormat: { kind: "cursor-prediction" };
}

type AlgorithmRequestRecord =
  | SimpleAlgorithmRequestRecord
  | ZedAlgorithmRequestRecord
  | InceptionAlgorithmRequestRecord
  | MistralAlgorithmRequestRecord
  | CopilotReplicaFimAlgorithmRequestRecord
  | CopilotReplicaNesAlgorithmRequestRecord
  | CopilotReplicaCursorPredictionAlgorithmRequestRecord;

interface RoutedCompletionChangeData {
  kind: string;
  providerId: string;
  change?: {
    branch?: "fim" | "nes" | "diagnostics";
    reason: string;
    data?: unknown;
  };
}

interface CompletionHarnessState {
  sessionIds: number[];
  lastSessionId?: number;
  requests: Array<{
    sessionId: number;
    origin: "vscode" | "harness";
    documentUri: string;
    triggerKind: vscode.InlineCompletionTriggerKind;
    requestUuid: string;
    itemCount: number;
    items: CompletionItemSnapshot[];
  }>;
  changes: Array<{ index: number; data?: RoutedCompletionChangeData }>;
  lifecycleEvents: Array<{
    action: string;
    sessionId: number;
    origin: "vscode" | "harness";
    itemIndex?: number;
    acceptedLength?: number;
    updatedInsertText?: string;
    userTypingDisagreed?: boolean;
    supersededSessionId?: number;
    disposeReason?: vscode.InlineCompletionsDisposeReasonKind;
  }>;
}

interface CopilotRuntimeDebugState {
  disposed: boolean;
  activePresentedBranch?: "fim" | "nes";
  workspace: {
    documentCount: number;
    historyCount: number;
    listenerCount: number;
    disposed: boolean;
  };
  trigger: {
    trackedDocuments: number;
    lastTriggerTime: number;
    lastRejectionTime: number;
    lastOutcome?: "accepted" | "rejected" | "ignored";
  };
  fim?: {
    cacheEntries: number;
    inFlightEntries: number;
    speculativeEntries: number;
    currentClientCompletionId?: string;
    lastShownItemIds: string[];
    trackedItemCount: number;
    trackedListCount: number;
  };
  nes?: {
    cacheSize: number;
    inFlight: number;
    hasSpeculativeRequest: boolean;
    lastRejectionTime: number;
    lastOutcome?: "accepted" | "rejected" | "ignored";
    cursorPrediction?: {
      outcome: string;
      reason?: string;
      targetUri?: string;
      lineNumber?: number;
    };
    diagnostics?: {
      workInProgress: boolean;
      lastComputation: string;
      lastValidity: string;
    };
  };
}

type BasicCompletionManagerState = Omit<
  CompletionManagerState,
  "runtimeCount" | "runtimeInstances"
>;

async function getCompletionState(): Promise<CompletionManagerState> {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return vscode.commands.executeCommand<CompletionManagerState>(
    "unifyChatProvider.completion.test.getState",
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function basicCompletionState(
  state: CompletionManagerState,
): BasicCompletionManagerState {
  return {
    registered: state.registered,
    enabled: state.enabled,
    providerCount: state.providerCount,
    providerIds: state.providerIds,
    excludedProviderGroups: state.excludedProviderGroups,
  };
}

async function provideDetailed(
  options?: Record<string, unknown>,
): Promise<CompletionProvideResult> {
  return vscode.commands.executeCommand<CompletionProvideResult>(
    "unifyChatProvider.completion.test.provideDetailed",
    options,
  );
}

async function getRuntimeState(
  providerId: string,
): Promise<CopilotRuntimeDebugState | undefined> {
  return vscode.commands.executeCommand<CopilotRuntimeDebugState | undefined>(
    "unifyChatProvider.completion.test.getRuntimeState",
    providerId,
  );
}

async function getHarnessState(): Promise<CompletionHarnessState> {
  return vscode.commands.executeCommand<CompletionHarnessState>(
    "unifyChatProvider.completion.test.getHarnessState",
  );
}

async function waitForHarnessState(
  description: string,
  predicate: (state: CompletionHarnessState) => boolean,
  timeoutMs = 5_000,
): Promise<CompletionHarnessState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await getHarnessState();
    if (predicate(state)) {
      return state;
    }
    await delay(20);
  }
  assert.fail(
    `Timed out waiting for ${description}: ${JSON.stringify(await getHarnessState())}`,
  );
}

function vscodeLifecycleForDocument(
  state: CompletionHarnessState,
  documentUri: string,
  action: string,
) {
  const sessionIds = new Set(
    state.requests
      .filter(
        (request) =>
          request.origin === "vscode" && request.documentUri === documentUri,
      )
      .map((request) => request.sessionId),
  );
  return state.lifecycleEvents.filter(
    (event) =>
      event.origin === "vscode" &&
      event.action === action &&
      sessionIds.has(event.sessionId),
  );
}

async function triggerInlineSuggestion(): Promise<void> {
  await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger", {
    explicit: true,
  });
}

async function waitForVscodeRequest(
  documentUri: string,
  minimumCount = 1,
): Promise<CompletionHarnessState> {
  return waitForHarnessState(
    `${minimumCount} VS Code request(s) for ${documentUri}`,
    (state) =>
      state.requests.filter(
        (request) =>
          request.origin === "vscode" && request.documentUri === documentUri,
      ).length >= minimumCount,
  );
}

async function waitForVscodeLifecycle(
  documentUri: string,
  action: string,
  predicate: (
    event: CompletionHarnessState["lifecycleEvents"][number],
  ) => boolean = () => true,
): Promise<CompletionHarnessState> {
  return waitForHarnessState(
    `VS Code ${action} lifecycle for ${documentUri}`,
    (state) =>
      vscodeLifecycleForDocument(state, documentUri, action).some(predicate),
  );
}

async function waitForActiveTextEditor(
  documentUri: string,
  timeoutMs = 5_000,
): Promise<vscode.TextEditor> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.toString() === documentUri) {
      return editor;
    }
    await delay(20);
  }
  assert.fail(
    `Timed out waiting for active text editor ${documentUri}; active text=${vscode.window.activeTextEditor?.document.uri.toString()}, active notebook=${vscode.window.activeNotebookEditor?.notebook.uri.toString()}`,
  );
}

function registerInitiallyUnavailableFile(
  uri: vscode.Uri,
  contents: string,
): vscode.Disposable {
  const changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const bytes = new TextEncoder().encode(contents);
  const timestamp = Date.now();
  let rejectNextRead = true;
  const assertTarget = (target: vscode.Uri): void => {
    if (target.toString() !== uri.toString()) {
      throw vscode.FileSystemError.FileNotFound(target);
    }
  };
  const rejectMutation = (target: vscode.Uri): never => {
    throw vscode.FileSystemError.NoPermissions(target);
  };
  const provider: vscode.FileSystemProvider = {
    onDidChangeFile: changeEmitter.event,
    watch: () => ({ dispose: () => undefined }),
    stat: (target) => {
      assertTarget(target);
      return {
        type: vscode.FileType.File,
        ctime: timestamp,
        mtime: timestamp,
        size: bytes.byteLength,
      };
    },
    readDirectory: () => [],
    createDirectory: rejectMutation,
    readFile: (target) => {
      assertTarget(target);
      if (rejectNextRead) {
        rejectNextRead = false;
        throw vscode.FileSystemError.FileNotFound(target);
      }
      return bytes;
    },
    writeFile: rejectMutation,
    delete: rejectMutation,
    rename: rejectMutation,
  };
  return vscode.Disposable.from(
    vscode.workspace.registerFileSystemProvider(uri.scheme, provider, {
      isCaseSensitive: true,
    }),
    changeEmitter,
  );
}

async function dispatchLifecycle(
  event: Record<string, unknown>,
): Promise<void> {
  const dispatched = await vscode.commands.executeCommand<boolean>(
    "unifyChatProvider.completion.test.dispatchLifecycle",
    event,
  );
  assert.equal(
    dispatched,
    true,
    `Lifecycle event was not dispatched: ${event.action}`,
  );
}

async function clearHarness(): Promise<void> {
  await vscode.commands.executeCommand(
    "unifyChatProvider.completion.test.clearHarness",
  );
}

async function setResponse(response: unknown): Promise<void> {
  const configured = await vscode.commands.executeCommand<boolean>(
    "unifyChatProvider.completion.test.setResponse",
    response,
  );
  assert.equal(configured, true, "The Completion test response must be valid");
}

async function getRequests(): Promise<AlgorithmRequestRecord[]> {
  return vscode.commands.executeCommand<AlgorithmRequestRecord[]>(
    "unifyChatProvider.completion.test.getRequests",
  );
}

function copilotFimRequests(
  requests: readonly AlgorithmRequestRecord[],
): CopilotReplicaFimAlgorithmRequestRecord[] {
  return requests.filter(
    (request): request is CopilotReplicaFimAlgorithmRequestRecord =>
      request.kind === "copilot-replica/fim",
  );
}

async function setNesResponse(
  response:
    | string
    | FakeLanguageModelResponseInput
    | { responses: Array<string | FakeLanguageModelResponseInput> }
    | undefined,
): Promise<void> {
  const configured = await vscode.commands.executeCommand<boolean>(
    "ucpE2E.fakeLanguageModel.setResponses",
    response,
  );
  assert.equal(configured, true);
}

async function getNesRequests(): Promise<FakeLanguageModelRequestRecord[]> {
  return vscode.commands.executeCommand<FakeLanguageModelRequestRecord[]>(
    "ucpE2E.fakeLanguageModel.getRequests",
  );
}

async function waitForNesRequestCount(
  minimum: number,
  timeoutMs = 5_000,
): Promise<FakeLanguageModelRequestRecord[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const requests = await getNesRequests();
    if (requests.length >= minimum) {
      return requests;
    }
    await delay(20);
  }
  assert.fail(
    `Timed out waiting for ${minimum} NES requests: ${JSON.stringify(await getNesRequests())}`,
  );
}

async function waitForNesCancellation(
  timeoutMs = 5_000,
): Promise<FakeLanguageModelRequestRecord[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const requests = await getNesRequests();
    if (requests.some((request) => request.cancellationRequested)) {
      return requests;
    }
    await delay(20);
  }
  assert.fail(
    `Timed out waiting for Language Model cancellation: ${JSON.stringify(await getNesRequests())}`,
  );
}

async function waitForNesCacheSize(
  providerId: string,
  minimum: number,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runtime = await getRuntimeState(providerId);
    if ((runtime?.nes?.cacheSize ?? 0) >= minimum) {
      return;
    }
    await delay(20);
  }
  assert.fail(
    `Timed out waiting for ${providerId} NES cache size ${minimum}: ${JSON.stringify(await getRuntimeState(providerId))}`,
  );
}

async function setFakeLanguageModelRegistered(
  registered: boolean,
): Promise<void> {
  const updated = await vscode.commands.executeCommand<boolean>(
    "ucpE2E.fakeLanguageModel.setRegistered",
    registered,
  );
  assert.equal(updated, true);
  await delay(40);
}

async function openScenarioDocument(
  workspaceFolder: vscode.WorkspaceFolder,
  filename: string,
  content: string,
  selection?: vscode.Position,
): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, filename);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const position =
    selection ?? document.lineAt(document.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(position, position);
  await delay(20);
  return editor;
}

function applyCompletionItemSnapshot(
  document: vscode.TextDocument,
  item: CompletionItemSnapshot,
): string {
  assert.ok(item.range, "Completion item should include a replacement range");
  const start = document.offsetAt(
    new vscode.Position(item.range.start.line, item.range.start.character),
  );
  const end = document.offsetAt(
    new vscode.Position(item.range.end.line, item.range.end.character),
  );
  const text = document.getText();
  return `${text.slice(0, start)}${item.insertText}${text.slice(end)}`;
}

async function updateCompletionProviders(
  configuration: vscode.WorkspaceConfiguration,
  providers: readonly Record<string, unknown>[],
): Promise<void> {
  await configuration.update(
    "providers",
    providers,
    vscode.ConfigurationTarget.Workspace,
  );
  await configuration.update(
    "enabled",
    true,
    vscode.ConfigurationTarget.Workspace,
  );
  await delay(40);
}

function copilotProvider(
  id: string,
  options: Record<string, unknown>,
): Record<string, unknown> {
  return { id, algorithm: "copilot-replica", options };
}

async function recordRecentEditForProvider(
  editor: vscode.TextEditor,
  providerId: string,
): Promise<void> {
  const inlineSuggest = vscode.workspace.getConfiguration(
    "editor.inlineSuggest",
  );
  const effectiveEnabled = inlineSuggest.get<boolean>("enabled", true);
  const workspaceEnabled =
    inlineSuggest.inspect<boolean>("enabled")?.workspaceValue;
  if (effectiveEnabled) {
    await inlineSuggest.update(
      "enabled",
      false,
      vscode.ConfigurationTarget.Workspace,
    );
    await delay(40);
  }
  try {
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    assert.equal(
      await editor.edit((builder) => builder.insert(end, " ")),
      true,
    );
    assert.equal(
      await editor.edit((builder) =>
        builder.delete(new vscode.Range(end, end.translate(0, 1))),
      ),
      true,
    );
    assert.ok(
      ((await getRuntimeState(providerId))?.workspace.historyCount ?? 0) > 0,
      `${providerId} should record recent edit history before NES`,
    );
  } finally {
    if (effectiveEnabled) {
      await inlineSuggest.update(
        "enabled",
        workspaceEnabled,
        vscode.ConfigurationTarget.Workspace,
      );
      await delay(40);
    }
  }
}

async function waitForRoutedChange(
  providerId: string,
  reason: string,
): Promise<{ index: number; data?: RoutedCompletionChangeData }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const state = await getHarnessState();
    const match = state.changes.find(
      (entry) =>
        entry.data?.providerId === providerId &&
        entry.data.change?.reason === reason,
    );
    if (match) {
      return match;
    }
    await delay(20);
  }
  assert.fail(
    `Timed out waiting for ${providerId} ${reason} change hint: ${JSON.stringify({ harness: await getHarnessState(), runtime: await getRuntimeState(providerId) })}`,
  );
}

async function waitForDiagnosticsSuggestion(providerId: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const diagnostics = (await getRuntimeState(providerId))?.nes?.diagnostics;
    if (
      diagnostics?.lastComputation === "suggestion" &&
      diagnostics.lastValidity === "current" &&
      !diagnostics.workInProgress
    ) {
      return;
    }
    await delay(20);
  }
  assert.fail(
    `Timed out waiting for diagnostics background suggestion: ${JSON.stringify(await getRuntimeState(providerId))}`,
  );
}

async function runIgnoredNesTriggerE2E(
  completionConfiguration: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  const providerId = "trigger-ignored-document";
  const ignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, ".copilotignore");
  try {
    await vscode.workspace.fs.writeFile(
      ignoreUri,
      new TextEncoder().encode("trigger-ignored-document.ts\n"),
    );
    await delay(150);
    await updateCompletionProviders(completionConfiguration, [
      copilotProvider(providerId, {
        enableFIM: false,
        enableNES: true,
        strategy: "xtabUnifiedModel",
        nesModel: FAKE_NES_MODEL,
      }),
    ]);
    await setNesResponse("<INSERT>\n // must-not-run\n</INSERT>");
    await openScenarioDocument(
      workspaceFolder,
      "trigger-allowed-document.ts",
      "export const allowedFirst = true;\nexport const allowedSecond = true;\n",
      new vscode.Position(0, 33),
    );
    await provideDetailed();

    const ignoredEditor = await openScenarioDocument(
      workspaceFolder,
      "trigger-ignored-document.ts",
      "export const ignoredFirst = true;\nexport const ignoredSecond = true;\n",
      new vscode.Position(0, 33),
    );
    await provideDetailed();
    await clearHarness();
    await setNesResponse("<INSERT>\n // must-not-run\n</INSERT>");

    await ignoredEditor.edit((builder) => {
      builder.insert(new vscode.Position(0, 0), "// ignored edit\n");
    });
    await vscode.commands.executeCommand("cursorMove", {
      to: "down",
      by: "line",
      value: 1,
      select: false,
    });
    await delay(350);

    const harness = await getHarnessState();
    assert.equal(
      harness.changes.filter((entry) => entry.data?.providerId === providerId)
        .length,
      0,
      "Ignored document edits and cursor moves must not emit NES change hints",
    );
    assert.equal(
      (await getNesRequests()).length,
      0,
      "Ignored document events must not reach the NES model",
    );
    assert.equal(
      (await getRuntimeState(providerId))?.trigger.trackedDocuments,
      0,
      "Ignored document edits must not enter the NES trigger state",
    );
  } finally {
    try {
      await vscode.workspace.fs.delete(ignoreUri);
    } catch {
      // The fixture may already have been cleaned after an earlier failure.
    }
    await delay(150);
  }
}

async function runCursorPredictionE2E(
  completionConfiguration: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  const options = {
    enableFIM: false,
    enableNES: true,
    strategy: "xtabUnifiedModel",
    nesModel: FAKE_NES_MODEL,
  };
  const sameFileLines = Array.from(
    { length: 14 },
    (_value, index) => `const sameLine${index} = ${index};`,
  );
  sameFileLines[2] = "function sameCursorSource() {";
  sameFileLines[10] = "  const sameTarget = true;";
  const sameEditor = await openScenarioDocument(
    workspaceFolder,
    "cursor-same-file.ts",
    sameFileLines.join("\n"),
    new vscode.Position(2, sameFileLines[2].length),
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("cursor-same-file", options),
  ]);
  await recordRecentEditForProvider(sameEditor, "cursor-same-file");
  await setNesResponse({
    responses: [
      "<NO_CHANGE>",
      "10",
      "<INSERT>\nconst predictedSame = true;\n</INSERT>",
    ],
  });
  const sameFile = await provideDetailed();
  assert.equal(sameFile.items.length, 1);
  assert.equal(
    sameFile.items[0]?.uri,
    undefined,
    "Same-document cursor retry items do not set InlineCompletionItem.uri",
  );
  assert.deepEqual(sameFile.items[0]?.range?.start, {
    line: 10,
    character: 8,
  });
  assert.equal(sameFile.items[0]?.isInlineEdit, true);
  assert.match(sameFile.items[0]?.correlationId ?? "", /cursor-jump$/);
  const expectedSameFileLines = [...sameFileLines];
  expectedSameFileLines[10] =
    "  const predictedSame = true;const sameTarget = true;";
  assert.equal(
    applyCompletionItemSnapshot(sameEditor.document, sameFile.items[0]),
    expectedSameFileLines.join("\n"),
  );
  const sameRequests = await getNesRequests();
  assert.equal(sameRequests.length, 3);
  assert.ok(
    sameRequests.every((request) => request.modelId === FAKE_NES_MODEL.id),
    "An omitted cursorPredictionModel must reuse the configured NES model",
  );
  assert.deepEqual(sameRequests[1].modelOptions, { max_tokens: 40 });
  assert.equal(sameRequests[1].modelId, FAKE_NES_MODEL.id);
  assert.ok(sameRequests[1].messageBytes > 0);
  assert.ok(sameRequests[1].optionsBytes > 0);
  assert.equal(sameRequests[1].messages[0]?.role, "system");
  assert.equal(
    sameRequests[1].messages[0]?.content,
    "Your task is to predict the line number where the developer is most likely to make their next edit. If you jump in the current file, just output the line number. If you want to jump to another file, output the filepath (relative to workspace root), colon, then line number. If you don't think anywhere is a good next line jump target, just output the current line number of the cursor. Make sure to output no explanation, reasoning, extra spaces, etc.",
  );
  assert.ok(
    sameRequests[2].messages[1]?.content.includes(
      "current_file_path: cursor-same-file.ts",
    ),
  );
  assert.deepEqual(
    (await getRuntimeState("cursor-same-file"))?.nes?.cursorPrediction,
    {
      outcome: "retry-edit",
      targetUri: sameEditor.document.uri.toString(),
      lineNumber: 10,
    },
  );

  const targetLines = [
    "export const target0 = 0;",
    "export const target1 = 1;",
    "export const target2 = 2;",
    "export const target3 = 3;",
    "  export const crossAnchor = true;",
    "export const target5 = 5;",
  ];
  const crossTargetEditor = await openScenarioDocument(
    workspaceFolder,
    "cursor-target.ts",
    targetLines.join("\n"),
  );
  const crossSourceLines = Array.from(
    { length: 14 },
    (_value, index) => `export const source${index} = ${index};`,
  );
  const crossSourceEditor = await openScenarioDocument(
    workspaceFolder,
    "cursor-cross-source.ts",
    crossSourceLines.join("\n"),
    new vscode.Position(2, crossSourceLines[2].length),
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("cursor-cross-file", options),
  ]);
  await recordRecentEditForProvider(crossSourceEditor, "cursor-cross-file");
  await setNesResponse({
    responses: [
      "<NO_CHANGE>",
      "cursor-target.ts:4",
      "<INSERT>\nexport const predictedCross = true;\n</INSERT>",
    ],
  });
  const crossFile = await provideDetailed();
  assert.equal(vscode.window.activeTextEditor, crossSourceEditor);
  assert.equal(crossFile.items.length, 1);
  assert.equal(
    crossFile.items[0]?.uri,
    crossTargetEditor.document.uri.toString(),
  );
  assert.deepEqual(crossFile.items[0]?.range?.start, {
    line: 4,
    character: 0,
  });
  assert.equal(crossFile.items[0]?.isInlineEdit, true);
  assert.match(crossFile.items[0]?.correlationId ?? "", /cursor-jump$/);
  assert.ok(
    applyCompletionItemSnapshot(
      crossTargetEditor.document,
      crossFile.items[0],
    ).includes("export const predictedCross = true;"),
  );
  const crossRequests = await getNesRequests();
  assert.equal(crossRequests.length, 3);
  assert.deepEqual(crossRequests[1].modelOptions, { max_tokens: 40 });
  assert.ok(
    crossRequests[2].messages[1]?.content.includes(
      "current_file_path: cursor-target.ts",
    ),
  );
  assert.deepEqual(
    (await getRuntimeState("cursor-cross-file"))?.nes?.cursorPrediction,
    {
      outcome: "retry-edit",
      targetUri: crossTargetEditor.document.uri.toString(),
      lineNumber: 4,
    },
  );

  const invalidEditor = await openScenarioDocument(
    workspaceFolder,
    "cursor-invalid.ts",
    crossSourceLines.join("\n"),
    new vscode.Position(2, crossSourceLines[2].length),
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("cursor-invalid", options),
  ]);
  await recordRecentEditForProvider(invalidEditor, "cursor-invalid");
  await setNesResponse({ responses: ["<NO_CHANGE>", "999"] });
  const invalid = await provideDetailed();
  assert.deepEqual(invalid.items, []);
  assert.equal((await getNesRequests()).length, 2);
  assert.deepEqual(
    (await getRuntimeState("cursor-invalid"))?.nes?.cursorPrediction,
    { outcome: "parse-failed", reason: "modelNotSeenLineNumber" },
  );

  const unavailableCursorEditor = await openScenarioDocument(
    workspaceFolder,
    "cursor-model-unavailable.ts",
    "export const unavailableCursorModel = true; ",
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("cursor-model-unavailable", {
      enableFIM: false,
      enableNES: true,
      strategy: "xtabUnifiedModel",
      nesModel: FAKE_NES_MODEL,
      cursorPredictionModel: {
        vendor: "missing-test-vendor",
        id: "missing-cursor-model",
      },
    }),
  ]);
  const unavailableCursorEnd = unavailableCursorEditor.document.lineAt(0).range
    .end;
  assert.equal(
    await unavailableCursorEditor.edit((builder) => {
      builder.delete(
        new vscode.Range(
          unavailableCursorEnd.translate(0, -1),
          unavailableCursorEnd,
        ),
      );
    }),
    true,
  );
  await setNesResponse("<INSERT>\n // main-nes-still-works\n</INSERT>");
  const unavailableCursorResult = await provideDetailed();
  assert.equal(unavailableCursorResult.items.length, 1);
  assert.equal((await getNesRequests()).length, 1);
  assert.ok(
    unavailableCursorResult.items[0]?.insertText.includes(
      "main-nes-still-works",
    ),
    "An unavailable explicit cursor model must not disable the NES main request",
  );

  const retryEmptyEditor = await openScenarioDocument(
    workspaceFolder,
    "cursor-retry-empty.ts",
    sameFileLines.join("\n"),
    new vscode.Position(2, sameFileLines[2].length),
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("cursor-retry-empty", options),
  ]);
  await recordRecentEditForProvider(retryEmptyEditor, "cursor-retry-empty");
  await setNesResponse({
    responses: ["<NO_CHANGE>", "10", "<NO_CHANGE>"],
  });
  const retryEmpty = await provideDetailed();
  assert.deepEqual(
    retryEmpty.items,
    [],
    "OnlyWithEdit must not create a jump-only completion item",
  );
  assert.equal((await getNesRequests()).length, 3);
  assert.equal(
    (await getRuntimeState("cursor-retry-empty"))?.nes?.cursorPrediction
      ?.outcome,
    "retry-empty",
  );

  const changedEditor = await openScenarioDocument(
    workspaceFolder,
    "cursor-document-changed.ts",
    sameFileLines.join("\n"),
    new vscode.Position(2, sameFileLines[2].length),
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("cursor-document-changed", options),
  ]);
  await recordRecentEditForProvider(changedEditor, "cursor-document-changed");
  await setNesResponse({
    responses: [
      { chunks: ["<NO_CHANGE>"], delayMs: 150 },
      "10",
      "<INSERT>\nconst staleEdit = true;\n</INSERT>",
    ],
  });
  const changedRequest = provideDetailed();
  await delay(25);
  await changedEditor.edit((builder) => {
    const end = changedEditor.document.lineAt(
      changedEditor.document.lineCount - 1,
    ).range.end;
    builder.insert(end, "\n// user changed document");
  });
  const changedResult = await changedRequest;
  assert.deepEqual(changedResult.items, []);
  assert.ok(
    (await getNesRequests()).length <= 1,
    "Document changes must prevent cursor prediction and retry requests",
  );
  assert.equal(
    (await getRuntimeState("cursor-document-changed"))?.nes?.cursorPrediction
      ?.outcome,
    "document-changed",
  );
}

async function runRealVsCodeCompletionLifecycleE2E(
  completionConfiguration: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  await vscode.workspace
    .getConfiguration("editor")
    .update(
      "inlineSuggest.enabled",
      true,
      vscode.ConfigurationTarget.Workspace,
    );

  await setResponse(" realLifecycleWord anotherWord");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-lifecycle-accept", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "vscode-lifecycle-accept" },
    }),
  ]);
  const acceptedEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-lifecycle-accept.ts",
    "export const realAccepted = true;",
  );
  const acceptedUri = acceptedEditor.document.uri.toString();
  await clearHarness();
  await triggerInlineSuggestion();
  const acceptedRequestState = await waitForVscodeRequest(acceptedUri);
  const acceptedRequest = acceptedRequestState.requests.find(
    (request) =>
      request.origin === "vscode" && request.documentUri === acceptedUri,
  );
  assert.equal(
    acceptedRequest?.triggerKind,
    vscode.InlineCompletionTriggerKind.Invoke,
  );
  assert.ok((acceptedRequest?.itemCount ?? 0) > 0);
  await waitForVscodeLifecycle(acceptedUri, "show");
  await vscode.commands.executeCommand(
    "editor.action.inlineSuggest.acceptNextWord",
  );
  const partialState = await waitForVscodeLifecycle(
    acceptedUri,
    "partial",
    (event) => (event.acceptedLength ?? 0) > 0,
  );
  assert.ok(
    vscodeLifecycleForDocument(partialState, acceptedUri, "partial").some(
      (event) => (event.acceptedLength ?? 0) > 0,
    ),
  );
  await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
  await waitForVscodeLifecycle(acceptedUri, "accept");
  await waitForVscodeLifecycle(acceptedUri, "listDispose");
  assert.ok(
    acceptedEditor.document.getText().includes("realLifecycleWord anotherWord"),
    "The real commit command must apply the FIM suggestion",
  );

  await setResponse(" // real-rejection");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-lifecycle-reject", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "vscode-lifecycle-reject" },
    }),
  ]);
  const rejectedEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-lifecycle-reject.ts",
    "export const realRejected = true;",
  );
  const rejectedUri = rejectedEditor.document.uri.toString();
  await clearHarness();
  await triggerInlineSuggestion();
  await waitForVscodeRequest(rejectedUri);
  await waitForVscodeLifecycle(rejectedUri, "show");
  await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
  await waitForVscodeLifecycle(rejectedUri, "reject");
  await waitForVscodeLifecycle(rejectedUri, "listDispose");
  assert.equal(
    rejectedEditor.document.getText(),
    "export const realRejected = true;",
    "Rejecting through VS Code must not apply the suggestion",
  );

  await setResponse(" // real-supersede");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-lifecycle-supersede", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "vscode-lifecycle-supersede" },
    }),
  ]);
  const supersededEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-lifecycle-supersede.ts",
    "export const realSuperseded = true;",
  );
  const supersededUri = supersededEditor.document.uri.toString();
  await clearHarness();
  await triggerInlineSuggestion();
  await waitForVscodeRequest(supersededUri);
  await waitForVscodeLifecycle(supersededUri, "show");
  await setResponse("// real-supersede");
  await vscode.commands.executeCommand("type", { text: " " });
  await triggerInlineSuggestion();
  await waitForVscodeRequest(supersededUri, 2);
  await waitForVscodeLifecycle(
    supersededUri,
    "ignored",
    (event) => event.supersededSessionId !== undefined,
  );

  await setResponse(" // real-typing");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-lifecycle-typing", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "vscode-lifecycle-typing" },
    }),
  ]);
  const typingEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-lifecycle-typing.ts",
    "export const realTyping = true;",
  );
  const typingUri = typingEditor.document.uri.toString();
  await clearHarness();
  await triggerInlineSuggestion();
  await waitForVscodeRequest(typingUri);
  await waitForVscodeLifecycle(typingUri, "show");
  await vscode.commands.executeCommand("type", { text: "X" });
  await waitForVscodeLifecycle(typingUri, "ignored");
  assert.ok(typingEditor.document.getText().endsWith("X"));

  await setResponse(" // real-switch");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-lifecycle-switch", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "vscode-lifecycle-switch" },
    }),
  ]);
  const switchSourceEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-lifecycle-switch-source.ts",
    "export const switchSource = true;",
  );
  const switchSourceUri = switchSourceEditor.document.uri.toString();
  await clearHarness();
  await triggerInlineSuggestion();
  await waitForVscodeRequest(switchSourceUri);
  await waitForVscodeLifecycle(switchSourceUri, "show");
  await openScenarioDocument(
    workspaceFolder,
    "vscode-lifecycle-switch-target.ts",
    "export const switchTarget = true;",
  );
  await waitForVscodeLifecycle(switchSourceUri, "ignored");
  await waitForVscodeLifecycle(switchSourceUri, "listDispose");

  await setResponse(undefined);
  await setNesResponse({
    chunks: [" // cancelled-compatible-fim"],
    delayMs: 2_000,
  });
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-compatible-cancellation", {
      enableFIM: true,
      enableNES: false,
      fimModel: FAKE_NES_MODEL,
    }),
  ]);
  await openScenarioDocument(
    workspaceFolder,
    "vscode-compatible-cancellation.ts",
    "export const cancellation = true;",
  );
  await clearHarness();
  const cancellationKey = "compatible-fim";
  const pendingCancellationRequest = provideDetailed({ cancellationKey });
  await waitForNesRequestCount(1);
  assert.equal(
    await vscode.commands.executeCommand<boolean>(
      "unifyChatProvider.completion.test.cancelProvide",
      cancellationKey,
    ),
    true,
  );
  const cancelledRequests = await waitForNesCancellation();
  assert.equal(cancelledRequests[0]?.cancellationRequested, true);
  assert.deepEqual((await pendingCancellationRequest).items, []);

  await setResponse(undefined);
  await setNesResponse("<INSERT>\n // real-nes\n</INSERT>");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-nes-success", {
      enableFIM: false,
      enableNES: true,
      strategy: "xtabUnifiedModel",
      nesModel: FAKE_NES_MODEL,
    }),
  ]);
  const nesEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-nes-success.ts",
    "export const realNes = true;",
  );
  const nesUri = nesEditor.document.uri.toString();
  await recordRecentEditForProvider(nesEditor, "vscode-nes-success");
  await setNesResponse("<INSERT>\n // real-nes\n</INSERT>");
  await clearHarness();
  await triggerInlineSuggestion();
  await waitForVscodeRequest(nesUri);
  await waitForVscodeLifecycle(nesUri, "show");
  await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
  await waitForVscodeLifecycle(nesUri, "accept");
  assert.equal(
    nesEditor.document.getText(),
    "export const realNes = true; // real-nes",
  );

  const realCrossTargetLines = [
    "export const crossTarget0 = 0;",
    "export const crossTarget1 = 1;",
    "export const crossTarget2 = 2;",
    "export const crossTarget3 = 3;",
    "export const crossTarget4 = 4;",
    "export const crossTarget5 = 5;",
  ];
  const crossTargetEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-cross-target.ts",
    realCrossTargetLines.join("\n"),
  );
  const realCrossSourceLines = [
    "export const crossSource0 = 0;",
    "export const crossSource1 = 1;",
    "export const crossSource2 = 2;",
    "export const crossSource3 = 3;",
    "export const crossSource4 = 4;",
    "export const crossSource5 = 5;",
  ];
  const crossSourceEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-cross-source.ts",
    realCrossSourceLines.join("\n"),
    new vscode.Position(4, realCrossSourceLines[4].length),
  );
  await setNesResponse({
    responses: [
      "<NO_CHANGE>",
      "vscode-cross-target.ts:4",
      "<INSERT>\nexport const committedAcrossFiles = true;\n</INSERT>",
    ],
  });
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-nes-cross-file", {
      enableFIM: false,
      enableNES: true,
      strategy: "xtabUnifiedModel",
      nesModel: FAKE_NES_MODEL,
    }),
  ]);
  await recordRecentEditForProvider(crossSourceEditor, "vscode-nes-cross-file");
  await setNesResponse({
    responses: [
      "<NO_CHANGE>",
      "vscode-cross-target.ts:4",
      "<INSERT>\nexport const committedAcrossFiles = true;\n</INSERT>",
    ],
  });
  const crossSourceUri = crossSourceEditor.document.uri.toString();
  await clearHarness();
  await triggerInlineSuggestion();
  const crossRequestState = await waitForVscodeRequest(crossSourceUri);
  const crossRequest = crossRequestState.requests.find(
    (request) =>
      request.origin === "vscode" && request.documentUri === crossSourceUri,
  );
  assert.equal(crossRequest?.itemCount, 1);
  await waitForVscodeLifecycle(crossSourceUri, "show");
  await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
  await waitForVscodeLifecycle(crossSourceUri, "accept");
  assert.equal(
    vscode.window.activeTextEditor?.document.uri.toString(),
    crossTargetEditor.document.uri.toString(),
    "The first cross-file commit must navigate to the target editor",
  );
  await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
  await delay(100);
  assert.ok(
    crossTargetEditor.document
      .getText()
      .includes("export const committedAcrossFiles = true;"),
    `VS Code must apply a committed cross-file NES edit to its target document: ${JSON.stringify(
      {
        activeUri: vscode.window.activeTextEditor?.document.uri.toString(),
        sourceText: crossSourceEditor.document.getText(),
        targetText: crossTargetEditor.document.getText(),
        harness: await getHarnessState(),
      },
    )}`,
  );

  const pureJumpTargetUri = vscode.Uri.parse(
    "ucp-e2e-jump://memory/vscode-pure-cursor-jump-target.ts",
  );
  const pureJumpTargetText = Array.from(
    { length: 8 },
    (_value, index) => `export const pureJumpTarget${index} = ${index};`,
  ).join("\n");
  const pureJumpFileSystem = registerInitiallyUnavailableFile(
    pureJumpTargetUri,
    pureJumpTargetText,
  );
  const pureJumpSourceLines = Array.from(
    { length: 14 },
    (_value, index) => `export const pureJumpSource${index} = ${index};`,
  );
  const pureJumpSourceEditor = await openScenarioDocument(
    workspaceFolder,
    "vscode-pure-cursor-jump-source.ts",
    pureJumpSourceLines.join("\n"),
    new vscode.Position(2, pureJumpSourceLines[2].length),
  );
  await setNesResponse({
    responses: ["<NO_CHANGE>", `${pureJumpTargetUri.toString()}:4`],
  });
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("vscode-nes-pure-cursor-jump", {
      enableFIM: false,
      enableNES: true,
      strategy: "xtabUnifiedModel",
      nesModel: FAKE_NES_MODEL,
    }),
  ]);
  await recordRecentEditForProvider(
    pureJumpSourceEditor,
    "vscode-nes-pure-cursor-jump",
  );
  await setNesResponse({
    responses: ["<NO_CHANGE>", `${pureJumpTargetUri.toString()}:4`],
  });
  const pureJumpSourceUri = pureJumpSourceEditor.document.uri.toString();
  await clearHarness();
  await triggerInlineSuggestion();
  const pureJumpRequestState = await waitForVscodeRequest(pureJumpSourceUri);
  const pureJumpRequest = pureJumpRequestState.requests.find(
    (request) =>
      request.origin === "vscode" && request.documentUri === pureJumpSourceUri,
  );
  assert.equal(
    pureJumpRequest?.itemCount,
    1,
    "An unavailable cursor target must still produce the jump-only item",
  );
  assert.deepEqual(
    pureJumpRequest?.items[0],
    {
      insertText: "",
      uri: pureJumpTargetUri.toString(),
      jumpToPosition: { line: 4, character: 0 },
      correlationId: `${pureJumpRequest.requestUuid}:cursor-jump`,
    },
    "A jump-only item must use native uri/jumpToPosition navigation without an extra command",
  );
  await waitForVscodeLifecycle(pureJumpSourceUri, "show");
  await vscode.commands.executeCommand("editor.action.inlineSuggest.jump");
  await waitForVscodeLifecycle(pureJumpSourceUri, "accept");
  const pureJumpTargetEditor = await waitForActiveTextEditor(
    pureJumpTargetUri.toString(),
  );
  await vscode.commands.executeCommand("editor.action.inlineSuggest.jump");
  const selectionStartedAt = Date.now();
  while (
    (pureJumpTargetEditor.selection.active.line !== 4 ||
      pureJumpTargetEditor.selection.active.character !== 0) &&
    Date.now() - selectionStartedAt < 2_000
  ) {
    await delay(20);
  }
  assert.deepEqual(
    {
      line: pureJumpTargetEditor.selection.active.line,
      character: pureJumpTargetEditor.selection.active.character,
    },
    { line: 4, character: 0 },
    "Committing a jump-only item must move the real VS Code cursor",
  );
  assert.equal(
    pureJumpSourceEditor.document.getText(),
    pureJumpSourceLines.join("\n"),
    "A jump-only item must not edit its source document",
  );
  assert.equal(
    pureJumpTargetEditor.document.getText(),
    pureJumpTargetText,
    "A jump-only item must not edit its target document",
  );
  pureJumpFileSystem.dispose();

  await setNesResponse(undefined);
  await setResponse(undefined);
}

async function runRealNotebookCompletionLifecycleE2E(
  completionConfiguration: vscode.WorkspaceConfiguration,
): Promise<void> {
  const notebookType = "ucp-e2e-notebook";
  const serializer = vscode.workspace.registerNotebookSerializer(notebookType, {
    deserializeNotebook: () => new vscode.NotebookData([]),
    serializeNotebook: () => new Uint8Array(),
  });
  try {
    const fimNotebook = await vscode.workspace.openNotebookDocument(
      notebookType,
      new vscode.NotebookData([
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "const shared = 1;",
          "typescript",
        ),
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "const Component = <div />;",
          "typescriptreact",
        ),
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "shared = 2",
          "python",
        ),
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "const active = sha",
          "typescript",
        ),
      ]),
    );
    const fimNotebookEditor =
      await vscode.window.showNotebookDocument(fimNotebook);
    fimNotebookEditor.selection = new vscode.NotebookRange(3, 4);
    fimNotebookEditor.revealRange(new vscode.NotebookRange(3, 4));
    await vscode.commands.executeCommand("notebook.cell.edit");
    const fimCellDocument = fimNotebook.cellAt(3).document;
    const fimCellEditor = await waitForActiveTextEditor(
      fimCellDocument.uri.toString(),
    );
    const fimEnd = fimCellDocument.lineAt(0).range.end;
    fimCellEditor.selection = new vscode.Selection(fimEnd, fimEnd);
    await setNesResponse(undefined);
    await setResponse("red;");
    await updateCompletionProviders(completionConfiguration, [
      copilotProvider("vscode-fim-notebook", {
        enableFIM: true,
        enableNES: false,
        fimModel: { vendor: "test", id: "vscode-fim-notebook" },
      }),
    ]);
    const fimResult = await provideDetailed();
    assert.equal(fimResult.items.length, 1);
    assert.equal(fimResult.items[0]?.range?.start.line, 0);
    assert.equal(fimResult.items[0]?.range?.end.line, 0);
    assert.ok(
      !fimResult.items[0]?.insertText.includes("const shared = 1;"),
      "Notebook context cells must never become active-cell insertion text",
    );
    const [fimRequest] = copilotFimRequests(await getRequests());
    assert.ok(fimRequest, "The notebook FIM request must be captured");
    assert.ok(fimRequest.prefix.includes("const shared = 1;\n\n"));
    assert.ok(fimRequest.prefix.includes("// const Component = <div />;\n\n"));
    assert.ok(!fimRequest.prefix.includes("shared = 2"));
    assert.ok(fimRequest.prefix.endsWith("const active = sha"));
    const fimContext = fimRequest.contexts
      .map((file) => file.content)
      .join("\n");
    assert.ok(
      fimContext.includes("Language: typescript"),
      "Notebook FIM prompts must use the language document marker",
    );
    assert.ok(
      !fimContext.includes("Path:"),
      "Notebook FIM prompts must not use the virtual cell path marker",
    );

    const fimCellRange = new vscode.Range(
      new vscode.Position(0, 0),
      fimCellDocument.lineAt(fimCellDocument.lineCount - 1).range.end,
    );
    assert.equal(
      await fimCellEditor.edit((builder) => {
        builder.replace(fimCellRange, "export const notebookNes = true;");
      }),
      true,
    );
    const cellDocument = fimCellDocument;
    const cellUri = cellDocument.uri.toString();
    const cellEditor = fimCellEditor;
    const end = cellDocument.lineAt(cellDocument.lineCount - 1).range.end;
    cellEditor.selection = new vscode.Selection(end, end);

    await setResponse(undefined);
    await setNesResponse("<INSERT>\n // notebook-nes\n</INSERT>");
    await updateCompletionProviders(completionConfiguration, [
      copilotProvider("vscode-nes-notebook", {
        enableFIM: false,
        enableNES: true,
        strategy: "xtabUnifiedModel",
        nesModel: FAKE_NES_MODEL,
      }),
    ]);
    await recordRecentEditForProvider(cellEditor, "vscode-nes-notebook");
    await setNesResponse("<INSERT>\n // notebook-nes\n</INSERT>");
    await vscode.window.showNotebookDocument(fimNotebook);
    fimNotebookEditor.selection = new vscode.NotebookRange(3, 4);
    fimNotebookEditor.revealRange(new vscode.NotebookRange(3, 4));
    await vscode.commands.executeCommand("notebook.cell.edit");
    const focusedCellEditor = await waitForActiveTextEditor(cellUri);
    const focusedEnd = cellDocument.lineAt(cellDocument.lineCount - 1).range
      .end;
    focusedCellEditor.selection = new vscode.Selection(focusedEnd, focusedEnd);
    await clearHarness();
    await triggerInlineSuggestion();
    const requestState = await waitForVscodeRequest(cellUri);
    const request = requestState.requests.find(
      (entry) => entry.origin === "vscode" && entry.documentUri === cellUri,
    );
    assert.equal(cellDocument.uri.scheme, "vscode-notebook-cell");
    assert.equal(
      request?.triggerKind,
      vscode.InlineCompletionTriggerKind.Invoke,
    );
    assert.equal(request?.itemCount, 1);
    await waitForVscodeLifecycle(cellUri, "show");
    assert.equal(
      cellDocument.getText(),
      "export const notebookNes = true;",
      "Showing a notebook suggestion must not apply it before acceptance",
    );
  } finally {
    serializer.dispose();
  }
}

async function runCopilotCompletionE2E(
  completionConfiguration: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  await clearHarness();

  const fimEditor = await openScenarioDocument(
    workspaceFolder,
    "fim-only.ts",
    "export const fimOnly = true;",
  );
  await setResponse(" // fim-only");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("copilot-fim-success", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "controlled" },
    }),
  ]);
  const fimOnly = await provideDetailed();
  assert.deepEqual(
    fimOnly.items.map((item) => item.insertText),
    ["export const fimOnly = true; // fim-only"],
    "FIM-only should traverse the CopilotRuntime GhostText branch",
  );
  assert.equal(fimOnly.items[0]?.uri, undefined);
  assert.ok((await getRuntimeState("copilot-fim-success"))?.fim);
  assert.equal(vscode.window.activeTextEditor, fimEditor);
  assert.equal(
    copilotFimRequests(await getRequests())[0]?.options.candidateCount,
    1,
    "The Copilot FIM AlgorithmRequest must carry the resolved default candidate count",
  );

  const defaultNRuntimeId = (await getCompletionState()).runtimeInstances[
    "copilot-fim-success"
  ];
  await setResponse(" // fim-custom-n");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("copilot-fim-success", {
      enableFIM: true,
      enableNES: false,
      n: 3,
      fimModel: { vendor: "test", id: "controlled" },
    }),
  ]);
  const customN = await provideDetailed();
  assert.deepEqual(
    customN.items.map((item) => item.insertText),
    ["export const fimOnly = true; // fim-custom-n"],
  );
  assert.equal(
    copilotFimRequests(await getRequests())[0]?.options.candidateCount,
    3,
    "A custom Copilot n must reach a multi-candidate FIM transport",
  );
  assert.notEqual(
    (await getCompletionState()).runtimeInstances["copilot-fim-success"],
    defaultNRuntimeId,
    "Changing n must rebuild the runtime so old candidate caches are discarded",
  );

  await setResponse(undefined);
  await setNesResponse(" // compatible-fim");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("copilot-fim-compatible", {
      enableFIM: true,
      enableNES: false,
      fimModel: FAKE_NES_MODEL,
    }),
  ]);
  const compatibleFim = await provideDetailed();
  assert.deepEqual(
    compatibleFim.items.map((item) => item.insertText),
    ["export const fimOnly = true; // compatible-fim"],
  );
  const [compatibleFimRequest] = await getNesRequests();
  assert.ok(compatibleFimRequest, "Compatible Copilot FIM request must be sent");
  assert.deepEqual(
    compatibleFimRequest.messages.map((message) => message.role),
    ["system", "user"],
  );
  assert.ok(
    compatibleFimRequest.messages[1]?.content.includes(
      "<|fim_prefix|>export const fimOnly = true;",
    ),
  );
  assert.deepEqual(compatibleFimRequest.modelOptions, {});

  const strategyCases = [
    {
      strategy: "copilotNesXtab",
      response: "```ts\nexport const strategyCopilot = true;\n```",
      source: "export const strategyCopilot = false;",
      expectedDocument: "export const strategyCopilot = true;",
      inlineEdit: true,
    },
    {
      strategy: "xtab275",
      response: "export const strategy275 = true;",
      source: "export const strategy275 = false;",
      expectedDocument: "export const strategy275 = true;",
      inlineEdit: true,
    },
    {
      strategy: "xtabUnifiedModel",
      response: "<INSERT>\n // unified\n</INSERT>",
      source: "export const strategyUnified = true;",
      expectedDocument: "export const strategyUnified = true; // unified",
      inlineEdit: false,
    },
  ] as const;
  for (const testCase of strategyCases) {
    const strategyEditor = await openScenarioDocument(
      workspaceFolder,
      `nes-${testCase.strategy}.ts`,
      `${testCase.source} `,
    );
    await setNesResponse(testCase.response);
    const providerId = `nes-${testCase.strategy}`;
    await updateCompletionProviders(completionConfiguration, [
      copilotProvider(providerId, {
        enableFIM: false,
        enableNES: true,
        strategy: testCase.strategy,
        nesModel: FAKE_NES_MODEL,
      }),
    ]);
    const trailingSpaceStart = strategyEditor.document.positionAt(
      testCase.source.length,
    );
    const editApplied = await strategyEditor.edit((builder) => {
      builder.delete(
        new vscode.Range(
          trailingSpaceStart,
          strategyEditor.document.positionAt(testCase.source.length + 1),
        ),
      );
    });
    assert.equal(editApplied, true);
    await delay(20);
    assert.ok(
      ((await getRuntimeState(providerId))?.workspace.historyCount ?? 0) > 0,
      `${testCase.strategy} should record recent edit history before NES`,
    );
    const result = await provideDetailed();
    const failureState =
      result.items.length === 1
        ? undefined
        : {
            requests: await getNesRequests(),
            runtime: await getRuntimeState(providerId),
            harness: await getHarnessState(),
          };
    assert.equal(
      result.items.length,
      1,
      `${testCase.strategy} should return an edit: ${JSON.stringify(failureState)}`,
    );
    assert.equal(
      applyCompletionItemSnapshot(strategyEditor.document, result.items[0]),
      testCase.expectedDocument,
    );
    assert.equal(result.items[0]?.isInlineEdit, testCase.inlineEdit);
    assert.ok(result.items[0]?.correlationId);
    assert.ok((await getRuntimeState(providerId))?.nes);
    const [receivedRequest] = await getNesRequests();
    assert.equal(receivedRequest?.modelId, FAKE_NES_MODEL.id);
    assert.equal(receivedRequest?.messages[0]?.role, "system");
    assert.equal(receivedRequest?.messages[1]?.role, "user");
    assert.ok((receivedRequest?.messageBytes ?? 0) > testCase.source.length);
    assert.ok((receivedRequest?.optionsBytes ?? 0) > 0);
    assert.deepEqual(
      Object.keys(receivedRequest?.modelOptions ?? {}),
      ["prediction"],
    );
    assert.equal(typeof receivedRequest?.modelOptions.prediction, "object");
  }

  const relatedEditor = await openScenarioDocument(
    workspaceFolder,
    "related.ts",
    "export const related = false;\nexport const untouched = true;\n",
  );
  const crossFileEditor = await openScenarioDocument(
    workspaceFolder,
    "cross-file.ts",
    "export const crossFile = true; ",
  );
  await setNesResponse({
    responses: [
      "<NO_CHANGE>",
      "related.ts:0",
      "<INSERT>\n// cross-file insertion\n</INSERT>",
    ],
  });
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("nes-cross-file", {
      enableFIM: false,
      enableNES: true,
      strategy: "xtabUnifiedModel",
      nesModel: FAKE_NES_MODEL,
    }),
  ]);
  const crossFileEditApplied = await crossFileEditor.edit((builder) => {
    const end = crossFileEditor.document.lineAt(0).range.end;
    builder.delete(new vscode.Range(end.translate(0, -1), end));
  });
  assert.equal(crossFileEditApplied, true);
  assert.ok(
    ((await getRuntimeState("nes-cross-file"))?.workspace.historyCount ?? 0) >
      0,
    "Cross-file NES should record recent edit history before requesting",
  );
  const crossFile = await provideDetailed();
  assert.equal(vscode.window.activeTextEditor, crossFileEditor);
  assert.equal(crossFile.items.length, 1);
  assert.equal(crossFile.items[0]?.uri, relatedEditor.document.uri.toString());
  assert.equal(crossFile.items[0]?.isInlineEdit, true);
  assert.ok(crossFile.items[0]?.insertText.includes("// cross-file insertion"));

  const diagnosticsEditor = await openScenarioDocument(
    workspaceFolder,
    "diagnostics-race.ts",
    "const missingValue = 1;\nexport const diagnosticValue = missingValu;",
  );
  await setNesResponse({
    chunks: ["<INSERT>\n// background LLM edit\n</INSERT>"],
    delayMs: 250,
  });
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("nes-diagnostics-race", {
      enableFIM: false,
      enableNES: true,
      strategy: "xtabUnifiedModel",
      nesModel: FAKE_NES_MODEL,
    }),
  ]);
  const typo = "missingValu";
  const usageOffset = diagnosticsEditor.document.getText().lastIndexOf(typo);
  assert.ok(usageOffset >= 0);
  const typoRange = new vscode.Range(
    diagnosticsEditor.document.positionAt(usageOffset),
    diagnosticsEditor.document.positionAt(usageOffset + typo.length),
  );
  await diagnosticsEditor.edit((builder) => {
    builder.replace(typoRange, "missingValue");
  });
  const diagnosticRange = new vscode.Range(
    diagnosticsEditor.document.positionAt(usageOffset),
    diagnosticsEditor.document.positionAt(usageOffset + "missingValue".length),
  );
  diagnosticsEditor.selection = new vscode.Selection(
    diagnosticRange.start,
    diagnosticRange.start,
  );
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "unify-completion-e2e",
  );
  const missingImportDiagnostic = new vscode.Diagnostic(
    diagnosticRange,
    "Cannot find name 'missingValue'.",
    vscode.DiagnosticSeverity.Error,
  );
  missingImportDiagnostic.code = 2304;
  missingImportDiagnostic.source = "ts";
  diagnosticCollection.set(diagnosticsEditor.document.uri, [
    missingImportDiagnostic,
  ]);
  const codeActions = vscode.languages.registerCodeActionsProvider(
    { scheme: "file", language: "typescript" },
    {
      provideCodeActions(document) {
        if (
          document.uri.toString() !== diagnosticsEditor.document.uri.toString()
        ) {
          return [];
        }
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          document.uri,
          new vscode.Position(0, 0),
          "import { missingValue } from './missing-value';\n",
        );
        const action = new vscode.CodeAction(
          "Add import from './missing-value'",
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = edit;
        action.isPreferred = true;
        action.diagnostics = [missingImportDiagnostic];
        return [action];
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  );
  try {
    await waitForDiagnosticsSuggestion("nes-diagnostics-race");
    const diagnosticsResult = await provideDetailed();
    assert.equal(
      diagnosticsResult.items.length,
      1,
      JSON.stringify(await getRuntimeState("nes-diagnostics-race")),
    );
    assert.equal(
      diagnosticsResult.items[0]?.insertText,
      "import { missingValue } from './missing-value';\n",
      JSON.stringify(await getRuntimeState("nes-diagnostics-race")),
    );
    assert.equal(
      diagnosticsResult.items[0]?.uri,
      undefined,
      "Same-document diagnostics edits do not set InlineCompletionItem.uri",
    );
    assert.deepEqual(diagnosticsResult.items[0]?.displayLocation, {
      range: {
        start: {
          line: diagnosticRange.start.line,
          character: diagnosticRange.start.character,
        },
        end: {
          line: diagnosticRange.end.line,
          character: diagnosticRange.end.character,
        },
      },
      kind: vscode.InlineCompletionDisplayLocationKind.Code,
      label: "import missingValue",
    });
    const diagnosticsRequests = await waitForNesRequestCount(1);
    assert.equal(diagnosticsRequests.length, 1);
    assert.equal(
      diagnosticsRequests[0]?.cancellationRequested,
      false,
      "The diagnostics winner must leave the LanguageModelChat request running",
    );
    await waitForNesCacheSize("nes-diagnostics-race", 1);
    assert.equal(
      (await getRuntimeState("nes-diagnostics-race"))?.nes?.cacheSize,
      1,
      "The detached LLM result must populate the NES cache",
    );
    diagnosticCollection.delete(diagnosticsEditor.document.uri);
    const detachedCacheHit = await provideDetailed();
    assert.equal(detachedCacheHit.items.length, 1);
    assert.ok(
      detachedCacheHit.items[0]?.insertText.includes("// background LLM edit"),
      JSON.stringify({
        item: detachedCacheHit.items[0],
        runtime: await getRuntimeState("nes-diagnostics-race"),
      }),
    );
    assert.equal(
      (await getNesRequests()).length,
      1,
      "The follow-up request must reuse the detached LLM cache entry",
    );
  } finally {
    codeActions.dispose();
    diagnosticCollection.dispose();
  }

  const unifiedInsertEditor = await openScenarioDocument(
    workspaceFolder,
    "unified-insert.ts",
    "export const unifiedInsert = true;",
  );
  await setResponse(" // must-not-run");
  await setNesResponse("<INSERT>\n // unified-insert\n</INSERT>");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("unified-insert", {
      enableFIM: true,
      enableNES: true,
      modelUnification: true,
      unifiedModel: FAKE_NES_MODEL,
    }),
  ]);
  const inlineSuggest = vscode.workspace.getConfiguration(
    "editor.inlineSuggest",
  );
  const inlineSuggestEnabled = inlineSuggest.get<boolean>("enabled", true);
  const workspaceInlineSuggestEnabled =
    inlineSuggest.inspect<boolean>("enabled")?.workspaceValue;
  if (inlineSuggestEnabled) {
    await inlineSuggest.update(
      "enabled",
      false,
      vscode.ConfigurationTarget.Workspace,
    );
    await delay(40);
  }
  let unifiedInsert: CompletionProvideResult;
  try {
    await recordRecentEditForProvider(unifiedInsertEditor, "unified-insert");
    assert.ok(
      ((await getRuntimeState("unified-insert"))?.workspace.historyCount ?? 0) >
        0,
      "Unified model insertion should be history-eligible",
    );
    unifiedInsert = await provideDetailed();
  } finally {
    if (inlineSuggestEnabled) {
      await inlineSuggest.update(
        "enabled",
        workspaceInlineSuggestEnabled,
        vscode.ConfigurationTarget.Workspace,
      );
      await delay(40);
    }
  }
  assert.equal(
    unifiedInsert.items.length,
    1,
    JSON.stringify({
      requests: await getNesRequests(),
      runtime: await getRuntimeState("unified-insert"),
      harness: await getHarnessState(),
      warnings: await vscode.commands.executeCommand<CompletionWarningEvent[]>(
        "unifyChatProvider.completion.test.getWarnings",
      ),
    }),
  );
  assert.equal(
    applyCompletionItemSnapshot(
      unifiedInsertEditor.document,
      unifiedInsert.items[0],
    ),
    "export const unifiedInsert = true; // unified-insert",
  );
  assert.equal(unifiedInsert.items[0]?.isInlineEdit, false);
  assert.equal(
    copilotFimRequests(await getRequests()).length,
    0,
    "Model unification must not invoke the independent FIM transport",
  );
  assert.equal((await getNesRequests()).length, 1);
  assert.equal(
    (await getNesRequests())[0]?.modelId,
    FAKE_NES_MODEL.id,
    "The unified model must serve insertion results",
  );
  assert.equal(
    (await getRuntimeState("unified-insert"))?.fim,
    undefined,
    "Model unification must not construct a FIM runtime",
  );
  assert.ok((await getRuntimeState("unified-insert"))?.nes);

  const unifiedEditEditor = await openScenarioDocument(
    workspaceFolder,
    "unified-edit.ts",
    "export const unifiedEdit = false; ",
  );
  await setResponse(" // must-not-run");
  await setNesResponse("<EDIT>\nexport const unifiedEdit = true;\n</EDIT>");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("unified-edit", {
      enableFIM: true,
      enableNES: true,
      modelUnification: true,
      unifiedModel: FAKE_NES_MODEL,
    }),
  ]);
  const unifiedEditHistoryRecorded = await unifiedEditEditor.edit((builder) => {
    const end = unifiedEditEditor.document.lineAt(0).range.end;
    builder.delete(new vscode.Range(end.translate(0, -1), end));
  });
  assert.equal(unifiedEditHistoryRecorded, true);
  assert.ok(
    ((await getRuntimeState("unified-edit"))?.workspace.historyCount ?? 0) > 0,
    "Unified model edit should be history-eligible",
  );
  const unifiedEdit = await provideDetailed();
  assert.equal(unifiedEdit.items.length, 1);
  assert.equal(
    applyCompletionItemSnapshot(
      unifiedEditEditor.document,
      unifiedEdit.items[0],
    ),
    "export const unifiedEdit = true;",
  );
  assert.equal(unifiedEdit.items[0]?.isInlineEdit, true);
  assert.equal(
    copilotFimRequests(await getRequests()).length,
    0,
    "Model unification edit results must not invoke the FIM transport",
  );
  assert.equal((await getNesRequests()).length, 1);

  const unifiedNoChangeEditor = await openScenarioDocument(
    workspaceFolder,
    "unified-no-change.ts",
    "export const unifiedNoChange = true; ",
  );
  await setResponse(" // must-not-run");
  await setNesResponse({ responses: ["<NO_CHANGE>", "999"] });
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("unified-no-change", {
      enableFIM: true,
      enableNES: true,
      modelUnification: true,
      unifiedModel: FAKE_NES_MODEL,
    }),
  ]);
  const unifiedNoChangeHistoryRecorded = await unifiedNoChangeEditor.edit(
    (builder) => {
      const end = unifiedNoChangeEditor.document.lineAt(0).range.end;
      builder.delete(new vscode.Range(end.translate(0, -1), end));
    },
  );
  assert.equal(unifiedNoChangeHistoryRecorded, true);
  const unifiedNoChange = await provideDetailed();
  assert.equal(unifiedNoChange.items.length, 0);
  assert.equal(
    copilotFimRequests(await getRequests()).length,
    0,
    "Model unification no-change results must not invoke the FIM transport",
  );
  const unifiedNoChangeRequests = await getNesRequests();
  assert.equal(
    unifiedNoChangeRequests.length,
    2,
    "Unified NO_CHANGE must retain the official cursor-prediction follow-up",
  );
  assert.ok(
    unifiedNoChangeRequests.every(
      (request) => request.modelId === FAKE_NES_MODEL.id,
    ),
  );

  const independentEditor = await openScenarioDocument(
    workspaceFolder,
    "independent-fim-nes.ts",
    "export const independent = true; ",
  );
  await setResponse(" // independent-fim");
  await setNesResponse("<INSERT>\n // independent-nes\n</INSERT>");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("independent-fim-nes", {
      enableFIM: true,
      enableNES: true,
      strategy: "xtabUnifiedModel",
      fimModel: { vendor: "test", id: "controlled" },
      nesModel: FAKE_NES_MODEL,
    }),
  ]);
  const independentHistoryRecorded = await independentEditor.edit((builder) => {
    const end = independentEditor.document.lineAt(0).range.end;
    builder.delete(new vscode.Range(end.translate(0, -1), end));
  });
  assert.equal(independentHistoryRecorded, true);
  assert.ok(
    ((await getRuntimeState("independent-fim-nes"))?.workspace.historyCount ??
      0) > 0,
    "Independent FIM and NES should share history eligibility",
  );
  const independentResult = await provideDetailed();
  assert.equal(independentResult.items.length, 2);
  assert.equal(
    applyCompletionItemSnapshot(
      independentEditor.document,
      independentResult.items[0],
    ),
    "export const independent = true; // independent-fim",
  );
  assert.equal(
    applyCompletionItemSnapshot(
      independentEditor.document,
      independentResult.items[1],
    ),
    "export const independent = true; // independent-nes",
  );
  assert.equal(independentResult.items[0]?.showInlineEditMenu, undefined);
  assert.equal(independentResult.items[1]?.showInlineEditMenu, true);
  assert.equal(
    copilotFimRequests(await getRequests()).length,
    1,
    "Independent mode must retain its FIM transport",
  );
  assert.equal(
    (await getNesRequests()).length,
    1,
    "Independent mode must retain its NES transport",
  );
  await dispatchLifecycle({
    action: "show",
    sessionId: independentResult.sessionId,
    itemIndex: 0,
  });
  assert.equal(
    (await getRuntimeState("independent-fim-nes"))?.activePresentedBranch,
    "fim",
  );
  await dispatchLifecycle({
    action: "show",
    sessionId: independentResult.sessionId,
    itemIndex: 1,
  });
  assert.equal(
    (await getRuntimeState("independent-fim-nes"))?.activePresentedBranch,
    "nes",
  );
  await dispatchLifecycle({
    action: "ignored",
    sessionId: independentResult.sessionId,
    itemIndex: 0,
    supersededSessionId: independentResult.sessionId,
    supersededItemIndex: 1,
  });
  assert.equal(
    (await getRuntimeState("independent-fim-nes"))?.activePresentedBranch,
    "nes",
    "Ending the old FIM item must preserve the currently shown NES owner",
  );
  await dispatchLifecycle({
    action: "reject",
    sessionId: independentResult.sessionId,
    itemIndex: 1,
  });
  assert.equal(
    (await getRuntimeState("independent-fim-nes"))?.activePresentedBranch,
    undefined,
  );
  await dispatchLifecycle({
    action: "listDispose",
    sessionId: independentResult.sessionId,
  });

  await openScenarioDocument(
    workspaceFolder,
    "runtime-reuse.ts",
    "export const runtimeReuse = true;",
  );
  await setResponse(" // runtime");
  const runtimeProviders = [
    copilotProvider("runtime-a", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "runtime-a-v1" },
    }),
    copilotProvider("runtime-b", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "runtime-b-v1" },
    }),
  ];
  await updateCompletionProviders(completionConfiguration, runtimeProviders);
  const runtimeInitial = await getCompletionState();
  await provideDetailed();
  await provideDetailed();
  const runtimeReused = await getCompletionState();
  assert.deepEqual(
    runtimeReused.runtimeInstances,
    runtimeInitial.runtimeInstances,
    "Repeated requests must reuse provider runtimes",
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("runtime-a", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "runtime-a-v2" },
    }),
    runtimeProviders[1],
  ]);
  const runtimeTargetedRebuild = await getCompletionState();
  assert.notEqual(
    runtimeTargetedRebuild.runtimeInstances["runtime-a"],
    runtimeInitial.runtimeInstances["runtime-a"],
  );
  assert.equal(
    runtimeTargetedRebuild.runtimeInstances["runtime-b"],
    runtimeInitial.runtimeInstances["runtime-b"],
    "An unrelated provider runtime must survive a targeted options change",
  );
  await provideDetailed();
  assert.ok((await getRuntimeState("runtime-a"))?.fim);
  assert.ok((await getRuntimeState("runtime-b"))?.fim);
  await setFakeLanguageModelRegistered(false);
  const preservedAfterModelRemoval = await getCompletionState();
  assert.equal(
    preservedAfterModelRemoval.runtimeInstances["runtime-a"],
    runtimeTargetedRebuild.runtimeInstances["runtime-a"],
    "A model catalog removal must preserve the Copilot runtime instance",
  );
  assert.equal(
    preservedAfterModelRemoval.runtimeInstances["runtime-b"],
    runtimeTargetedRebuild.runtimeInstances["runtime-b"],
    "A payload-free model event must preserve unrelated Copilot state",
  );
  await setFakeLanguageModelRegistered(true);
  const preservedAfterModelRegistration = await getCompletionState();
  assert.equal(
    preservedAfterModelRegistration.runtimeInstances["runtime-a"],
    preservedAfterModelRemoval.runtimeInstances["runtime-a"],
    "A model catalog registration must retain the stateful runtime boundary",
  );
  await provideDetailed();
  assert.ok((await getRuntimeState("runtime-a"))?.fim);
  assert.ok((await getRuntimeState("runtime-b"))?.fim);
  await completionConfiguration.update(
    "enabled",
    false,
    vscode.ConfigurationTarget.Workspace,
  );
  const disabledRuntimeState = await getCompletionState();
  assert.equal(disabledRuntimeState.runtimeCount, 0);
  assert.deepEqual(disabledRuntimeState.runtimeInstances, {});
  await completionConfiguration.update(
    "enabled",
    true,
    vscode.ConfigurationTarget.Workspace,
  );
  await delay(40);
  const rebuiltAfterEnable = await getCompletionState();
  assert.equal(rebuiltAfterEnable.runtimeCount, 2);
  assert.notEqual(
    rebuiltAfterEnable.runtimeInstances["runtime-a"],
    preservedAfterModelRegistration.runtimeInstances["runtime-a"],
  );
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("runtime-a", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "runtime-a-v2" },
    }),
  ]);
  const removedRuntimeState = await getCompletionState();
  assert.equal(removedRuntimeState.runtimeCount, 1);
  assert.equal(removedRuntimeState.runtimeInstances["runtime-b"], undefined);
  assert.equal(
    removedRuntimeState.runtimeInstances["runtime-a"],
    rebuiltAfterEnable.runtimeInstances["runtime-a"],
  );

  await clearHarness();
  await setResponse(" // lifecycle");
  await updateCompletionProviders(completionConfiguration, [
    copilotProvider("lifecycle-fim", {
      enableFIM: true,
      enableNES: false,
      fimModel: { vendor: "test", id: "controlled" },
    }),
  ]);
  await openScenarioDocument(
    workspaceFolder,
    "lifecycle-accepted.ts",
    "export const accepted = true;",
  );
  const acceptedSession = await provideDetailed();
  await dispatchLifecycle({
    action: "show",
    sessionId: acceptedSession.sessionId,
  });
  assert.equal(
    (await getRuntimeState("lifecycle-fim"))?.fim?.lastShownItemIds.length,
    1,
  );
  await dispatchLifecycle({
    action: "accept",
    sessionId: acceptedSession.sessionId,
  });

  await openScenarioDocument(
    workspaceFolder,
    "lifecycle-rejected.ts",
    "export const rejected = true;",
  );
  const rejectedSession = await provideDetailed();
  await dispatchLifecycle({
    action: "reject",
    sessionId: rejectedSession.sessionId,
  });

  await openScenarioDocument(
    workspaceFolder,
    "lifecycle-ignored.ts",
    "export const ignored = true;",
  );
  const ignoredSession = await provideDetailed();
  await openScenarioDocument(
    workspaceFolder,
    "lifecycle-superseding.ts",
    "export const superseding = true;",
  );
  const supersedingSession = await provideDetailed();
  await dispatchLifecycle({
    action: "ignored",
    sessionId: ignoredSession.sessionId,
    supersededSessionId: supersedingSession.sessionId,
    userTypingDisagreed: true,
  });
  await dispatchLifecycle({
    action: "listDispose",
    sessionId: supersedingSession.sessionId,
    reason: "notTaken",
  });
  const lifecycleState = await getHarnessState();
  assert.deepEqual(
    lifecycleState.lifecycleEvents.map((event) => event.action),
    ["show", "accept", "reject", "ignored", "listDispose"],
  );

  const inlineSuggestConfiguration = vscode.workspace.getConfiguration(
    "editor.inlineSuggest",
  );
  const inlineSuggestWasEnabled =
    inlineSuggestConfiguration.get<boolean>("enabled");
  await inlineSuggestConfiguration.update(
    "enabled",
    false,
    vscode.ConfigurationTarget.Workspace,
  );
  await delay(40);
  await clearHarness();
  await setResponse(" // unrelated-fim");
  await setNesResponse("<INSERT>\n // routed-nes\n</INSERT>");
  const triggerTargetProvider = copilotProvider("trigger-target", {
    enableFIM: false,
    enableNES: true,
    strategy: "xtabUnifiedModel",
    nesModel: FAKE_NES_MODEL,
  });
  await updateCompletionProviders(completionConfiguration, [
    triggerTargetProvider,
  ]);
  const triggerEditor = await openScenarioDocument(
    workspaceFolder,
    "trigger-selection.ts",
    "export const first = true;\nexport const second = true;\n",
    new vscode.Position(0, 26),
  );
  await provideDetailed();
  await updateCompletionProviders(completionConfiguration, [
    triggerTargetProvider,
    {
      id: "trigger-unrelated",
      algorithm: "simple",
      options: { model: { vendor: "test", id: "controlled" } },
    },
  ]);
  await triggerEditor.edit((builder) => {
    builder.insert(new vscode.Position(0, 0), "// recent edit\n");
  });
  await vscode.commands.executeCommand("cursorMove", {
    to: "down",
    by: "line",
    value: 1,
    select: false,
  });
  const selectionChange = await waitForRoutedChange(
    "trigger-target",
    "selectionChange",
  );
  const routedSelection = await provideDetailed({
    changeIndex: selectionChange.index,
  });
  assert.deepEqual(
    routedSelection.items.map((item) => item.insertText),
    [" // routed-nes"],
    "A routed NES change hint must bypass unrelated global providers and FIM",
  );
  assert.ok(
    ((await getRuntimeState("trigger-target"))?.workspace.historyCount ?? 0) >
      0,
    "The real workspace adapter should observe the edit before selection trigger",
  );
  await dispatchLifecycle({
    action: "show",
    sessionId: routedSelection.sessionId,
  });
  await dispatchLifecycle({
    action: "accept",
    sessionId: routedSelection.sessionId,
  });
  assert.equal(
    (await getRuntimeState("trigger-target"))?.nes?.lastOutcome,
    "accepted",
  );

  await clearHarness();
  const switchedEditor = await openScenarioDocument(
    workspaceFolder,
    "trigger-document-switch.ts",
    "export const switched = true;\nexport const destination = true;\n",
    new vscode.Position(0, 29),
  );
  assert.equal(vscode.window.activeTextEditor, switchedEditor);
  await vscode.commands.executeCommand("cursorMove", {
    to: "down",
    by: "line",
    value: 1,
    select: false,
  });
  const documentSwitch = await waitForRoutedChange(
    "trigger-target",
    "activeDocumentSwitch",
  );
  const routedSwitch = await provideDetailed({
    changeIndex: documentSwitch.index,
  });
  assert.deepEqual(
    routedSwitch.items.map((item) => item.insertText),
    [" // routed-nes"],
  );
  assert.equal(
    documentSwitch.data?.change?.branch,
    "nes",
    "Document-switch hints must preserve the target internal branch",
  );

  await runIgnoredNesTriggerE2E(completionConfiguration, workspaceFolder);
  await inlineSuggestConfiguration.update(
    "enabled",
    inlineSuggestWasEnabled,
    vscode.ConfigurationTarget.Workspace,
  );

  await runCursorPredictionE2E(completionConfiguration, workspaceFolder);

  await runRealVsCodeCompletionLifecycleE2E(
    completionConfiguration,
    workspaceFolder,
  );

  await runRealNotebookCompletionLifecycleE2E(completionConfiguration);

  await setNesResponse(undefined);
  await setResponse(undefined);
}

async function runPlan4CompletionE2E(
  completionConfiguration: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  const model = { vendor: "test", id: "plan4-controlled" };
  const sourceText = "export const plan4Value = true;\n";
  const predictedSource = "export const plan4Value = false;\n";
  await openScenarioDocument(
    workspaceFolder,
    "plan4-algorithms.ts",
    sourceText,
  );

  await setResponse(predictedSource);
  await updateCompletionProviders(completionConfiguration, [
    { id: "plan4-zed", algorithm: "zed", options: { model } },
  ]);
  assert.equal((await provideDetailed()).items.length, 1);
  const zedRequests = (await getRequests()).filter(
    (request): request is ZedAlgorithmRequestRecord => request.kind === "zed",
  );
  assert.ok(zedRequests.length > 0);
  assert.equal(zedRequests.at(-1)?.maxTokens, 64);
  assert.equal(zedRequests.at(-1)?.trigger, "explicit");

  await setResponse(predictedSource);
  await updateCompletionProviders(completionConfiguration, [
    {
      id: "plan4-inception",
      algorithm: "inception",
      options: { model },
    },
  ]);
  assert.equal((await provideDetailed()).items.length, 1);
  const inceptionRequest = (await getRequests()).find(
    (request): request is InceptionAlgorithmRequestRecord =>
      request.kind === "inception",
  );
  assert.ok(inceptionRequest);
  assert.equal("maxTokens" in inceptionRequest, false);

  await setResponse(predictedSource);
  await updateCompletionProviders(completionConfiguration, [
    { id: "plan4-mistral", algorithm: "mistral", options: { model } },
  ]);
  assert.equal((await provideDetailed()).items.length, 1);
  const mistralRequest = (await getRequests()).find(
    (request): request is MistralAlgorithmRequestRecord =>
      request.kind === "mistral",
  );
  assert.ok(mistralRequest);
  assert.equal(mistralRequest.maxTokens, 150);

  await openScenarioDocument(
    workspaceFolder,
    ".env.plan4",
    "PLAN4_SECRET=value\n",
  );
  const disabledProviders: readonly Record<string, unknown>[] = [
    { id: "plan4-disabled-simple", algorithm: "simple", options: { model } },
    { id: "plan4-disabled-zed", algorithm: "zed", options: { model } },
    {
      id: "plan4-disabled-inception",
      algorithm: "inception",
      options: { model },
    },
    {
      id: "plan4-disabled-mistral",
      algorithm: "mistral",
      options: { model },
    },
  ];
  for (const provider of disabledProviders) {
    await setResponse("must not be requested");
    await updateCompletionProviders(completionConfiguration, [provider]);
    assert.deepEqual((await provideDetailed()).items, []);
    assert.deepEqual(
      await getRequests(),
      [],
      `${String(provider.id)} must be blocked by the default disabledGlobs`,
    );
  }

  const targetText = "export const targetValue = 1;\n";
  const predictedTarget = "export const targetValue = 2;\n";
  const targetUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    "plan4-cross-target.ts",
  );
  await vscode.workspace.fs.writeFile(
    targetUri,
    new TextEncoder().encode(targetText),
  );
  const sourceEditor = await openScenarioDocument(
    workspaceFolder,
    "plan4-cross-source.ts",
    "export const sourceValue = true;\n",
  );
  const inlineSuggest = vscode.workspace.getConfiguration("editor.inlineSuggest");
  const inlineSuggestWorkspaceValue =
    inlineSuggest.inspect<boolean>("enabled")?.workspaceValue;
  await inlineSuggest.update(
    "enabled",
    false,
    vscode.ConfigurationTarget.Workspace,
  );
  await delay(40);
  await setResponse({
    text: predictedTarget,
    edit: {
      targetUri: targetUri.toString(),
      requestSnapshot: targetText,
      jumpOffset: predictedTarget.indexOf("2"),
      edits: [
        {
          startOffset: targetText.indexOf("1"),
          endOffset: targetText.indexOf("1") + 1,
          text: "2",
        },
      ],
    },
  });
  await updateCompletionProviders(completionConfiguration, [
    { id: "plan4-cross-file", algorithm: "zed", options: { model } },
  ]);
  await clearHarness();
  const crossFile = await provideDetailed();
  assert.equal(crossFile.items.length, 1);
  assert.equal(crossFile.items[0]?.uri, targetUri.toString());
  assert.deepEqual(crossFile.items[0]?.jumpToPosition, {
    line: 0,
    character: predictedTarget.indexOf("2"),
  });
  assert.equal(
    vscode.window.activeTextEditor?.document.uri.toString(),
    sourceEditor.document.uri.toString(),
    "Opening a cross-file target for a suggestion must stay silent",
  );

  await dispatchLifecycle({
    action: "show",
    sessionId: crossFile.sessionId,
    itemIndex: 0,
  });
  await dispatchLifecycle({
    action: "partial",
    sessionId: crossFile.sessionId,
    itemIndex: 0,
    acceptedLength: 1,
  });
  const partialChange = await waitForRoutedChange(
    "plan4-cross-file",
    "prediction-partially-accepted",
  );
  assert.ok(partialChange.index >= 0);
  const afterPartial = await provideDetailed({
    trigger: "automatic",
    changeIndex: partialChange.index,
  });
  assert.equal(afterPartial.items.length, 1);
  const partialRequest = (await getRequests()).filter(
    (request): request is ZedAlgorithmRequestRecord => request.kind === "zed",
  ).at(-1);
  assert.equal(partialRequest?.trigger, "prediction_partially_accepted");

  await dispatchLifecycle({
    action: "accept",
    sessionId: afterPartial.sessionId,
    itemIndex: 0,
  });
  const acceptedChange = await waitForRoutedChange(
    "plan4-cross-file",
    "prediction-accepted",
  );
  await waitForActiveTextEditor(targetUri.toString());
  assert.ok(acceptedChange.index >= 0);
  const afterAccept = await provideDetailed({
    trigger: "automatic",
    changeIndex: acceptedChange.index,
  });
  assert.equal(afterAccept.items.length, 1);
  const acceptedRequest = (await getRequests()).filter(
    (request): request is ZedAlgorithmRequestRecord => request.kind === "zed",
  ).at(-1);
  assert.equal(acceptedRequest?.trigger, "prediction_accepted");
  assert.equal(acceptedRequest?.document.uri, targetUri.toString());
  await inlineSuggest.update(
    "enabled",
    inlineSuggestWorkspaceValue,
    vscode.ConfigurationTarget.Workspace,
  );
  await setResponse(undefined);
}

async function runCompletionTemplateEligibilityE2E(
  completionConfiguration: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  const endpointConfiguration =
    vscode.workspace.getConfiguration("unifyChatProvider");
  const providerName = "completion-template-e2e";
  const internalVendor = "unify-chat-provider";
  try {
    await endpointConfiguration.update(
      "endpoints",
      [
        {
          type: "openai-chat-completion",
          name: providerName,
          baseUrl: "http://127.0.0.1:1/v1",
          auth: { method: "none" },
          models: [
            { id: "disabled", completion: { templates: [] } },
            {
              id: "nes-only",
              completion: { templates: ["copilot-replica-nes"] },
            },
          ],
        },
      ],
      vscode.ConfigurationTarget.Global,
    );
    await delay(100);
    await openScenarioDocument(
      workspaceFolder,
      "template-eligibility.ts",
      "export const templateEligibility = true;",
    );
    await setResponse(undefined);
    await setNesResponse(undefined);

    await updateCompletionProviders(completionConfiguration, [
      {
        id: "templates-disabled",
        algorithm: "simple",
        options: {
          model: {
            vendor: internalVendor,
            id: `${providerName}/disabled`,
          },
        },
      },
    ]);
    assert.deepEqual(
      (await provideDetailed()).items,
      [],
      "templates: [] must disable Completion without issuing a request",
    );

    await updateCompletionProviders(completionConfiguration, [
      {
        id: "templates-no-intersection",
        algorithm: "simple",
        options: {
          model: {
            vendor: internalVendor,
            id: `${providerName}/nes-only`,
          },
        },
      },
    ]);
    assert.deepEqual(
      (await provideDetailed()).items,
      [],
      "A model with no template intersection must not execute Simple",
    );
    assert.equal(
      (await getNesRequests()).length,
      0,
      "Rejected internal template configurations must not fall through to the external model",
    );
  } finally {
    await endpointConfiguration.update(
      "endpoints",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await delay(100);
  }
}

export async function run(): Promise<void> {
  const fakeLanguageModelExtension = vscode.extensions.getExtension(
    FAKE_LANGUAGE_MODEL_EXTENSION_ID,
  );
  assert.ok(
    fakeLanguageModelExtension,
    `Extension ${FAKE_LANGUAGE_MODEL_EXTENSION_ID} should be installed`,
  );
  await fakeLanguageModelExtension.activate();
  assert.equal(fakeLanguageModelExtension.isActive, true);

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} should be installed`);

  await extension.activate();
  assert.equal(extension.isActive, true, "Extension should activate");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes("unifyChatProvider.manageProviders"),
    "Provider management command should be registered",
  );
  assert.ok(
    commands.includes("unifyChatProvider.completion.settings"),
    "Completion settings command should be registered",
  );

  const completionSettings = vscode.commands.executeCommand(
    "unifyChatProvider.completion.settings",
  );
  await delay(100);
  await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  await completionSettings;

  const verbose = vscode.workspace
    .getConfiguration("unifyChatProvider")
    .get<boolean>("verbose");
  assert.equal(verbose, false, "Fixture should read the default configuration");

  const completionConfiguration = vscode.workspace.getConfiguration(
    "unifyChatProvider.completion",
  );

  await completionConfiguration.update(
    "enabled",
    false,
    vscode.ConfigurationTarget.Global,
  );
  await completionConfiguration.update(
    "providers",
    [{ id: "user-provider", algorithm: "simple", options: {} }],
    vscode.ConfigurationTarget.Global,
  );
  await completionConfiguration.update(
    "enabled",
    true,
    vscode.ConfigurationTarget.Workspace,
  );
  await completionConfiguration.update(
    "providers",
    [{ id: "workspace-provider", algorithm: "simple", options: {} }],
    vscode.ConfigurationTarget.Workspace,
  );
  assert.equal(
    completionConfiguration.inspect<boolean>("enabled")?.globalValue,
    false,
    "User completion configuration should be persisted in isolated user data",
  );
  assert.equal(
    completionConfiguration.inspect<boolean>("enabled")?.workspaceValue,
    true,
    "Workspace completion configuration should override the User value",
  );
  assert.deepEqual(basicCompletionState(await getCompletionState()), {
    registered: true,
    enabled: true,
    providerCount: 1,
    providerIds: ["workspace-provider"],
    excludedProviderGroups: ["completions", "nes", "github.copilot"],
  });

  await completionConfiguration.update(
    "enabled",
    undefined,
    vscode.ConfigurationTarget.Workspace,
  );
  await completionConfiguration.update(
    "providers",
    undefined,
    vscode.ConfigurationTarget.Workspace,
  );
  assert.deepEqual(basicCompletionState(await getCompletionState()), {
    registered: false,
    enabled: false,
    providerCount: 1,
    providerIds: ["user-provider"],
    excludedProviderGroups: ["completions", "nes", "github.copilot"],
  });

  await completionConfiguration.update(
    "enabled",
    undefined,
    vscode.ConfigurationTarget.Global,
  );
  await completionConfiguration.update(
    "providers",
    undefined,
    vscode.ConfigurationTarget.Global,
  );
  await completionConfiguration.update(
    "enabled",
    true,
    vscode.ConfigurationTarget.Workspace,
  );
  await completionConfiguration.update(
    "providers",
    [],
    vscode.ConfigurationTarget.Workspace,
  );
  assert.deepEqual(basicCompletionState(await getCompletionState()), {
    registered: false,
    enabled: true,
    providerCount: 0,
    providerIds: [],
    excludedProviderGroups: ["completions", "nes", "github.copilot"],
  });

  await completionConfiguration.update(
    "providers",
    [{ id: "stub", algorithm: "simple", options: {} }],
    vscode.ConfigurationTarget.Workspace,
  );
  assert.deepEqual(basicCompletionState(await getCompletionState()), {
    registered: true,
    enabled: true,
    providerCount: 1,
    providerIds: ["stub"],
    excludedProviderGroups: ["completions", "nes", "github.copilot"],
  });

  await completionConfiguration.update(
    "enabled",
    false,
    vscode.ConfigurationTarget.Workspace,
  );
  assert.deepEqual(basicCompletionState(await getCompletionState()), {
    registered: false,
    enabled: false,
    providerCount: 1,
    providerIds: ["stub"],
    excludedProviderGroups: ["completions", "nes", "github.copilot"],
  });

  await vscode.commands.executeCommand(
    "unifyChatProvider.completion.test.setResponse",
    " = 42;",
  );
  await completionConfiguration.update(
    "providers",
    [
      {
        id: "stub-fim",
        algorithm: "simple",
        options: { model: { vendor: "test", id: "controlled" } },
      },
    ],
    vscode.ConfigurationTarget.Workspace,
  );
  await completionConfiguration.update(
    "enabled",
    true,
    vscode.ConfigurationTarget.Workspace,
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Fixture workspace should be open");
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspaceFolder.uri, "fixture.ts"),
  );
  const editor = await vscode.window.showTextDocument(document);
  const position = document.lineAt(0).range.end;
  editor.selection = new vscode.Selection(position, position);

  const completionItems = await vscode.commands.executeCommand<string[]>(
    "unifyChatProvider.completion.test.provide",
  );
  assert.deepEqual(completionItems, [" = 42;"]);
  const simpleRequests = await getRequests();
  assert.equal(simpleRequests.length, 1);
  const [simpleRequest] = simpleRequests;
  assert.equal(simpleRequest?.kind, "simple");
  if (simpleRequest?.kind === "simple") {
    assert.equal(simpleRequest.prefix, "export const fixture = true;");
    assert.equal(simpleRequest.suffix, "\n");
  }

  await setResponse(undefined);
  await setNesResponse("direct-model-response");
  const [directFakeModel] = await vscode.lm.selectChatModels({
    vendor: FAKE_NES_MODEL.vendor,
    id: FAKE_NES_MODEL.id,
  });
  assert.ok(directFakeModel, "The exact fake Language Model must be selectable");
  const directFakeResponse = await directFakeModel.sendRequest(
    [vscode.LanguageModelChatMessage.User("fixture health check")],
    {},
  );
  let directFakeText = "";
  for await (const chunk of directFakeResponse.text) {
    directFakeText += chunk;
  }
  assert.equal(directFakeText, "direct-model-response");

  await setNesResponse(" = 43;");
  await updateCompletionProviders(completionConfiguration, [
    {
      id: "external-simple",
      algorithm: "simple",
      options: { model: FAKE_NES_MODEL },
    },
  ]);
  const externalSimpleItems = await vscode.commands.executeCommand<string[]>(
    "unifyChatProvider.completion.test.provide",
  );
  const externalSimpleRequests = await getNesRequests();
  assert.deepEqual(
    externalSimpleItems,
    [" = 43;"],
    JSON.stringify({
      requests: externalSimpleRequests,
      warnings: await vscode.commands.executeCommand<CompletionWarningEvent[]>(
        "unifyChatProvider.completion.test.getWarnings",
      ),
    }),
  );
  const [externalSimpleRequest] = externalSimpleRequests;
  assert.ok(externalSimpleRequest, "Compatible Simple request must be sent");
  assert.equal(externalSimpleRequest.messages[0]?.role, "system");
  assert.equal(externalSimpleRequest.messages[1]?.role, "user");
  assert.ok(
    externalSimpleRequest.messages[1]?.content.startsWith(
      "<|fim_prefix|>export const fixture = true;",
    ),
  );
  assert.ok(
    externalSimpleRequest.messages[1]?.content.endsWith("<|fim_middle|>"),
  );
  assert.deepEqual(externalSimpleRequest.modelOptions, {});

  let excludedProbeCalls = 0;
  await vscode.workspace
    .getConfiguration("editor")
    .update(
      "inlineSuggest.enabled",
      true,
      vscode.ConfigurationTarget.Workspace,
    );
  const excludedProbe = vscode.languages.registerInlineCompletionItemProvider(
    { scheme: "untitled", language: "typescript" },
    {
      provideInlineCompletionItems: () => {
        excludedProbeCalls += 1;
        return [new vscode.InlineCompletionItem("probe-completion")];
      },
    },
    {
      groupId: "completions",
      displayName: "Completion exclusion probe",
    },
  );
  const invokeExcludedProbe = async (
    waitForInvocation: boolean,
  ): Promise<number> => {
    const observationWindowMs = 1_500;
    excludedProbeCalls = 0;
    const probeDocument = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: `const probe${Date.now()} = `,
    });
    await vscode.window.showTextDocument(probeDocument);
    await triggerInlineSuggestion();
    if (waitForInvocation) {
      const startedAt = Date.now();
      let nextTriggerAt = startedAt + 250;
      while (
        excludedProbeCalls === 0 &&
        Date.now() - startedAt < observationWindowMs
      ) {
        await delay(20);
        if (excludedProbeCalls === 0 && Date.now() >= nextTriggerAt) {
          await triggerInlineSuggestion();
          nextTriggerAt += 250;
        }
      }
    } else {
      await delay(observationWindowMs);
    }
    const calls = excludedProbeCalls;
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    return calls;
  };

  try {
    await completionConfiguration.update(
      "enabled",
      false,
      vscode.ConfigurationTarget.Workspace,
    );
    assert.equal(
      (await getCompletionState()).registered,
      false,
      "Unify completion provider should start the excludes test unregistered",
    );
    assert.ok(
      (await invokeExcludedProbe(true)) > 0,
      "The completions group probe should be callable without Unify registered",
    );

    await completionConfiguration.update(
      "enabled",
      true,
      vscode.ConfigurationTarget.Workspace,
    );
    const defaultExcludesState = await getCompletionState();
    assert.equal(defaultExcludesState.registered, true);
    assert.deepEqual(defaultExcludesState.excludedProviderGroups, [
      "completions",
      "nes",
      "github.copilot",
    ]);
    assert.equal(
      await invokeExcludedProbe(false),
      0,
      "The completions group should be excluded while Unify is registered",
    );

    await completionConfiguration.update(
      "strategy",
      {
        mode: "all",
        disableVSCodeBuiltinCompletion: false,
        stopWhen: { type: "firstUsable", graceMs: 0 },
      },
      vscode.ConfigurationTarget.Workspace,
    );
    const coexistenceState = await getCompletionState();
    assert.equal(coexistenceState.registered, true);
    assert.deepEqual(coexistenceState.excludedProviderGroups, []);
    assert.deepEqual(
      coexistenceState.runtimeInstances,
      defaultExcludesState.runtimeInstances,
      "Changing built-in completion exclusion must preserve algorithm runtimes",
    );
    assert.ok(
      (await invokeExcludedProbe(true)) > 0,
      "The completions group should remain callable when exclusion is disabled",
    );

    await completionConfiguration.update(
      "strategy",
      {
        mode: "all",
        disableVSCodeBuiltinCompletion: true,
        stopWhen: { type: "firstUsable", graceMs: 0 },
      },
      vscode.ConfigurationTarget.Workspace,
    );
    const restoredExcludesState = await getCompletionState();
    assert.equal(restoredExcludesState.registered, true);
    assert.deepEqual(restoredExcludesState.excludedProviderGroups, [
      "completions",
      "nes",
      "github.copilot",
    ]);
    assert.deepEqual(
      restoredExcludesState.runtimeInstances,
      defaultExcludesState.runtimeInstances,
      "Restoring built-in completion exclusion must preserve algorithm runtimes",
    );
    assert.equal(
      await invokeExcludedProbe(false),
      0,
      "The completions group should be excluded again after restoring the default",
    );

    await completionConfiguration.update(
      "enabled",
      false,
      vscode.ConfigurationTarget.Workspace,
    );
    assert.equal((await getCompletionState()).registered, false);
    assert.ok(
      (await invokeExcludedProbe(true)) > 0,
      "The completions group should recover after Unify unregisters",
    );

    await completionConfiguration.update(
      "enabled",
      true,
      vscode.ConfigurationTarget.Workspace,
    );
    assert.equal((await getCompletionState()).registered, true);
  } finally {
    excludedProbe.dispose();
    await completionConfiguration.update(
      "strategy",
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  }

  await runCompletionTemplateEligibilityE2E(
    completionConfiguration,
    workspaceFolder,
  );
  await runPlan4CompletionE2E(completionConfiguration, workspaceFolder);

  await vscode.commands.executeCommand(
    "unifyChatProvider.completion.test.setResponse",
    undefined,
  );
  await vscode.commands.executeCommand(
    "unifyChatProvider.completion.test.clearWarnings",
  );
  await completionConfiguration.update(
    "providers",
    [
      {
        id: "missing-compatible-model",
        algorithm: "simple",
        options: {
          model: { vendor: "missing-test-vendor", id: "missing-model" },
        },
      },
    ],
    vscode.ConfigurationTarget.Workspace,
  );
  const provideMissingModel = (): Thenable<string[]> =>
    vscode.commands.executeCommand<string[]>(
      "unifyChatProvider.completion.test.provide",
    );
  assert.deepEqual(await provideMissingModel(), []);
  assert.deepEqual(
    await provideMissingModel(),
    [],
    "An unresolved external language model should safely return no completion",
  );
  const missingModelWarnings = await vscode.commands.executeCommand<
    CompletionWarningEvent[]
  >("unifyChatProvider.completion.test.getWarnings");
  assert.equal(
    missingModelWarnings.length,
    1,
    "The same configuration warning should be shown only once per throttle window",
  );
  assert.equal(
    missingModelWarnings[0].key,
    "provider:missing-compatible-model:completion-model-not-found:missing-test-vendor:missing-model",
  );

  await runCopilotCompletionE2E(completionConfiguration, workspaceFolder);

  console.log("Extension Host completion lifecycle and parity E2E passed");
}
