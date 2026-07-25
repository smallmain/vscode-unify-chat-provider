import * as vscode from "vscode";
import type { CompletionManager } from "./manager";

interface CompletionTestSession {
  readonly id: number;
  readonly list: vscode.InlineCompletionList;
  readonly items: readonly vscode.InlineCompletionItem[];
  readonly origin: CompletionTestInvocationOrigin;
  readonly documentUri: string;
  readonly triggerKind: vscode.InlineCompletionTriggerKind;
  readonly requestUuid: string;
}

type CompletionTestInvocationOrigin = "vscode" | "harness";

interface CompletionTestItemRoute {
  readonly session: CompletionTestSession;
  readonly itemIndex: number;
}

export interface CompletionTestItemSnapshot {
  readonly insertText: string;
  readonly command?: string;
  readonly uri?: string;
  readonly range?: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly showRange?: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly isInlineEdit?: boolean;
  readonly showInlineEditMenu?: boolean;
  readonly jumpToPosition?: {
    readonly line: number;
    readonly character: number;
  };
  readonly displayLocation?: {
    readonly range: {
      readonly start: { readonly line: number; readonly character: number };
      readonly end: { readonly line: number; readonly character: number };
    };
    readonly kind: vscode.InlineCompletionDisplayLocationKind;
    readonly label: string;
  };
  readonly correlationId?: string;
}

export interface CompletionTestProvideResult {
  readonly sessionId: number;
  readonly items: readonly CompletionTestItemSnapshot[];
}

type CompletionTestLifecycleAction =
  "show" | "partial" | "accept" | "reject" | "ignored" | "listDispose";

interface CompletionTestLifecycleEvent {
  readonly action: CompletionTestLifecycleAction;
  readonly sessionId: number;
  readonly origin: CompletionTestInvocationOrigin;
  readonly itemIndex?: number;
  readonly acceptedLength?: number;
  readonly updatedInsertText?: string;
  readonly userTypingDisagreed?: boolean;
  readonly supersededSessionId?: number;
  readonly disposeReason?: vscode.InlineCompletionsDisposeReasonKind;
}

export interface CompletionTestHarnessState {
  readonly sessionIds: readonly number[];
  readonly lastSessionId?: number;
  readonly requests: readonly {
    readonly sessionId: number;
    readonly origin: CompletionTestInvocationOrigin;
    readonly documentUri: string;
    readonly triggerKind: vscode.InlineCompletionTriggerKind;
    readonly requestUuid: string;
    readonly itemCount: number;
    readonly items: readonly CompletionTestItemSnapshot[];
  }[];
  readonly changes: readonly {
    readonly index: number;
    readonly data?: unknown;
  }[];
  readonly lifecycleEvents: readonly CompletionTestLifecycleEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positionSnapshot(position: vscode.Position): {
  readonly line: number;
  readonly character: number;
} {
  return { line: position.line, character: position.character };
}

function rangeSnapshot(range: vscode.Range): {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
} {
  return {
    start: positionSnapshot(range.start),
    end: positionSnapshot(range.end),
  };
}

function itemText(item: vscode.InlineCompletionItem): string {
  const insertText: unknown = Reflect.get(item, "insertText");
  if (typeof insertText === "string") return insertText;
  if (typeof insertText !== "object" || insertText === null) return "";
  const value = Reflect.get(insertText, "value");
  return typeof value === "string" ? value : "";
}

function snapshotItem(
  item: vscode.InlineCompletionItem,
): CompletionTestItemSnapshot {
  return {
    insertText: itemText(item),
    ...(item.command ? { command: item.command.command } : {}),
    ...(item.uri ? { uri: item.uri.toString() } : {}),
    ...(item.range ? { range: rangeSnapshot(item.range) } : {}),
    ...(item.showRange ? { showRange: rangeSnapshot(item.showRange) } : {}),
    ...(item.isInlineEdit === undefined
      ? {}
      : { isInlineEdit: item.isInlineEdit }),
    ...(item.showInlineEditMenu === undefined
      ? {}
      : { showInlineEditMenu: item.showInlineEditMenu }),
    ...(item.jumpToPosition
      ? { jumpToPosition: positionSnapshot(item.jumpToPosition) }
      : {}),
    ...(item.displayLocation
      ? {
          displayLocation: {
            range: rangeSnapshot(item.displayLocation.range),
            kind: item.displayLocation.kind,
            label: item.displayLocation.label,
          },
        }
      : {}),
    ...(item.correlationId ? { correlationId: item.correlationId } : {}),
  };
}

function readInteger(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isInteger(candidate)
    ? candidate
    : undefined;
}

function readLifecycleAction(
  value: unknown,
): CompletionTestLifecycleAction | undefined {
  switch (value) {
    case "show":
    case "partial":
    case "accept":
    case "reject":
    case "ignored":
    case "listDispose":
      return value;
    default:
      return undefined;
  }
}

function listDisposeReason(
  value: unknown,
): vscode.InlineCompletionsDisposeReason {
  switch (value) {
    case "empty":
      return { kind: vscode.InlineCompletionsDisposeReasonKind.Empty };
    case "tokenCancellation":
      return {
        kind: vscode.InlineCompletionsDisposeReasonKind.TokenCancellation,
      };
    case "lostRace":
      return { kind: vscode.InlineCompletionsDisposeReasonKind.LostRace };
    case "notTaken":
      return { kind: vscode.InlineCompletionsDisposeReasonKind.NotTaken };
    default:
      return { kind: vscode.InlineCompletionsDisposeReasonKind.Other };
  }
}

/**
 * Non-production bridge for Extension Host tests. Every session is produced by
 * the real CompletionManager before callbacks are replayed against it.
 */
export class CompletionTestHarness implements vscode.Disposable {
  private readonly sessions = new Map<number, CompletionTestSession>();
  private readonly changes: vscode.InlineCompletionChangeHint[] = [];
  private readonly lifecycleEvents: CompletionTestLifecycleEvent[] = [];
  private readonly cancellableSources = new Map<
    string,
    vscode.CancellationTokenSource
  >();
  private readonly changeSubscription: vscode.Disposable;
  private readonly originalProvideInlineCompletionItems: CompletionManager["provideInlineCompletionItems"];
  private readonly originalHandleDidShowCompletionItem: CompletionManager["handleDidShowCompletionItem"];
  private readonly originalHandleDidPartiallyAcceptCompletionItem: CompletionManager["handleDidPartiallyAcceptCompletionItem"];
  private readonly originalHandleEndOfLifetime: CompletionManager["handleEndOfLifetime"];
  private readonly originalHandleListEndOfLifetime: CompletionManager["handleListEndOfLifetime"];
  private itemRoutes = new WeakMap<
    vscode.InlineCompletionItem,
    CompletionTestItemRoute
  >();
  private listSessions = new WeakMap<
    vscode.InlineCompletionList,
    CompletionTestSession
  >();
  private nextSessionId = 1;
  private lastSessionId: number | undefined;
  private harnessProvideDepth = 0;
  private harnessLifecycleDepth = 0;
  private generation = 0;

  constructor(private readonly manager: CompletionManager) {
    this.originalProvideInlineCompletionItems =
      manager.provideInlineCompletionItems.bind(manager);
    this.originalHandleDidShowCompletionItem =
      manager.handleDidShowCompletionItem.bind(manager);
    this.originalHandleDidPartiallyAcceptCompletionItem =
      manager.handleDidPartiallyAcceptCompletionItem.bind(manager);
    this.originalHandleEndOfLifetime =
      manager.handleEndOfLifetime.bind(manager);
    this.originalHandleListEndOfLifetime =
      manager.handleListEndOfLifetime.bind(manager);

    manager.provideInlineCompletionItems = async (
      document,
      position,
      context,
      token,
    ) => {
      const generation = this.generation;
      const origin: CompletionTestInvocationOrigin =
        this.harnessProvideDepth > 0 ? "harness" : "vscode";
      const list = await this.originalProvideInlineCompletionItems(
        document,
        position,
        context,
        token,
      );
      if (generation === this.generation) {
        this.recordSession(list, document, context, origin);
      }
      return list;
    };
    manager.handleDidShowCompletionItem = (item, updatedInsertText) => {
      const route = this.itemRoutes.get(item);
      this.originalHandleDidShowCompletionItem(item, updatedInsertText);
      this.recordItemLifecycle("show", route, { updatedInsertText });
    };
    manager.handleDidPartiallyAcceptCompletionItem = (item, info) => {
      const route = this.itemRoutes.get(item);
      this.originalHandleDidPartiallyAcceptCompletionItem(item, info);
      this.recordItemLifecycle("partial", route, {
        acceptedLength: typeof info === "number" ? info : info.acceptedLength,
      });
    };
    manager.handleEndOfLifetime = (item, reason) => {
      const route = this.itemRoutes.get(item);
      const supersededRoute =
        reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Ignored &&
        reason.supersededBy
          ? this.itemRoutes.get(reason.supersededBy)
          : undefined;
      this.originalHandleEndOfLifetime(item, reason);
      switch (reason.kind) {
        case vscode.InlineCompletionEndOfLifeReasonKind.Accepted:
          this.recordItemLifecycle("accept", route);
          break;
        case vscode.InlineCompletionEndOfLifeReasonKind.Rejected:
          this.recordItemLifecycle("reject", route);
          break;
        case vscode.InlineCompletionEndOfLifeReasonKind.Ignored:
          this.recordItemLifecycle("ignored", route, {
            userTypingDisagreed: reason.userTypingDisagreed,
            ...(supersededRoute
              ? { supersededSessionId: supersededRoute.session.id }
              : {}),
          });
          break;
      }
    };
    manager.handleListEndOfLifetime = (list, reason) => {
      const session = this.listSessions.get(list);
      this.originalHandleListEndOfLifetime(list, reason);
      if (session) {
        this.lifecycleEvents.push({
          action: "listDispose",
          sessionId: session.id,
          origin: this.lifecycleOrigin(),
          disposeReason: reason.kind,
        });
      }
    };

    this.changeSubscription = manager.onDidChange((hint) => {
      this.changes.push(hint ?? {});
    });
  }

  async provide(rawOptions?: unknown): Promise<CompletionTestProvideResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return { sessionId: 0, items: [] };
    }
    const options = isRecord(rawOptions) ? rawOptions : {};
    const cancellationKey =
      typeof options.cancellationKey === "string" &&
      options.cancellationKey.length > 0
        ? options.cancellationKey
        : undefined;
    const changeIndex = readInteger(options, "changeIndex");
    const triggerKind =
      options.trigger === "automatic"
        ? vscode.InlineCompletionTriggerKind.Automatic
        : vscode.InlineCompletionTriggerKind.Invoke;
    const now = Date.now();
    const source = new vscode.CancellationTokenSource();
    if (cancellationKey) {
      this.cancellableSources.get(cancellationKey)?.cancel();
      this.cancellableSources.set(cancellationKey, source);
    }
    this.harnessProvideDepth += 1;
    try {
      const changeHint =
        changeIndex === undefined ? undefined : this.changes[changeIndex];
      const list = await this.manager.provideInlineCompletionItems(
        editor.document,
        editor.selection.active,
        {
          triggerKind,
          selectedCompletionInfo: undefined,
          requestUuid:
            typeof options.requestUuid === "string"
              ? options.requestUuid
              : `completion-e2e-test-${this.nextSessionId}`,
          requestIssuedDateTime: now,
          earliestShownDateTime: now,
          ...(changeHint ? { changeHint } : {}),
        },
        source.token,
      );
      const session = this.listSessions.get(list);
      if (!session) {
        throw new Error("Completion test harness did not observe its request.");
      }
      return {
        sessionId: session.id,
        items: session.items.map(snapshotItem),
      };
    } finally {
      this.harnessProvideDepth -= 1;
      if (
        cancellationKey &&
        this.cancellableSources.get(cancellationKey) === source
      ) {
        this.cancellableSources.delete(cancellationKey);
      }
      source.dispose();
    }
  }

  async provideTexts(rawOptions?: unknown): Promise<readonly string[]> {
    const result = await this.provide(rawOptions);
    return result.items.map((item) => item.insertText);
  }

  cancelProvide(cancellationKey: unknown): boolean {
    if (typeof cancellationKey !== "string") {
      return false;
    }
    const source = this.cancellableSources.get(cancellationKey);
    if (!source) {
      return false;
    }
    source.cancel();
    return true;
  }

  dispatchLifecycle(rawEvent: unknown): boolean {
    if (!isRecord(rawEvent)) {
      return false;
    }
    const action = readLifecycleAction(rawEvent.action);
    const sessionId = readInteger(rawEvent, "sessionId") ?? this.lastSessionId;
    if (!action || sessionId === undefined) {
      return false;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    if (action === "listDispose") {
      this.harnessLifecycleDepth += 1;
      try {
        this.manager.handleListEndOfLifetime(
          session.list,
          listDisposeReason(rawEvent.reason),
        );
      } finally {
        this.harnessLifecycleDepth -= 1;
      }
      return true;
    }

    const itemIndex = readInteger(rawEvent, "itemIndex") ?? 0;
    const item = session.items[itemIndex];
    if (!item) {
      return false;
    }
    this.harnessLifecycleDepth += 1;
    try {
      switch (action) {
        case "show":
          this.manager.handleDidShowCompletionItem(
            item,
            typeof rawEvent.updatedInsertText === "string"
              ? rawEvent.updatedInsertText
              : itemText(item),
          );
          break;
        case "partial":
          this.manager.handleDidPartiallyAcceptCompletionItem(item, {
            kind: vscode.PartialAcceptTriggerKind.Word,
            acceptedLength:
              typeof rawEvent.acceptedLength === "number"
                ? rawEvent.acceptedLength
                : 1,
          });
          break;
        case "accept":
          this.manager.handleEndOfLifetime(item, {
            kind: vscode.InlineCompletionEndOfLifeReasonKind.Accepted,
          });
          break;
        case "reject":
          this.manager.handleEndOfLifetime(item, {
            kind: vscode.InlineCompletionEndOfLifeReasonKind.Rejected,
          });
          break;
        case "ignored": {
          const supersededSessionId = readInteger(
            rawEvent,
            "supersededSessionId",
          );
          const supersededItemIndex =
            readInteger(rawEvent, "supersededItemIndex") ?? 0;
          const supersededBy =
            supersededSessionId === undefined
              ? undefined
              : this.sessions.get(supersededSessionId)?.items[
                  supersededItemIndex
                ];
          this.manager.handleEndOfLifetime(item, {
            kind: vscode.InlineCompletionEndOfLifeReasonKind.Ignored,
            ...(supersededBy ? { supersededBy } : {}),
            userTypingDisagreed: rawEvent.userTypingDisagreed === true,
          });
          break;
        }
      }
    } finally {
      this.harnessLifecycleDepth -= 1;
    }
    return true;
  }

  getState(): CompletionTestHarnessState {
    return {
      sessionIds: [...this.sessions.keys()],
      ...(this.lastSessionId === undefined
        ? {}
        : { lastSessionId: this.lastSessionId }),
      requests: [...this.sessions.values()].map((session) => ({
        sessionId: session.id,
        origin: session.origin,
        documentUri: session.documentUri,
        triggerKind: session.triggerKind,
        requestUuid: session.requestUuid,
        itemCount: session.items.length,
        items: session.items.map(snapshotItem),
      })),
      changes: this.changes.map((hint, index) => ({
        index,
        ...("data" in hint ? { data: hint.data } : {}),
      })),
      lifecycleEvents: [...this.lifecycleEvents],
    };
  }

  clear(): void {
    this.generation += 1;
    for (const source of this.cancellableSources.values()) {
      source.cancel();
    }
    this.cancellableSources.clear();
    this.sessions.clear();
    this.changes.length = 0;
    this.lifecycleEvents.length = 0;
    this.lastSessionId = undefined;
    this.itemRoutes = new WeakMap();
    this.listSessions = new WeakMap();
  }

  dispose(): void {
    this.manager.provideInlineCompletionItems =
      this.originalProvideInlineCompletionItems;
    this.manager.handleDidShowCompletionItem =
      this.originalHandleDidShowCompletionItem;
    this.manager.handleDidPartiallyAcceptCompletionItem =
      this.originalHandleDidPartiallyAcceptCompletionItem;
    this.manager.handleEndOfLifetime = this.originalHandleEndOfLifetime;
    this.manager.handleListEndOfLifetime = this.originalHandleListEndOfLifetime;
    this.changeSubscription.dispose();
    this.clear();
  }

  private recordSession(
    list: vscode.InlineCompletionList,
    document: vscode.TextDocument,
    context: vscode.InlineCompletionContext,
    origin: CompletionTestInvocationOrigin,
  ): CompletionTestSession {
    const existing = this.listSessions.get(list);
    if (existing) {
      return existing;
    }
    const session: CompletionTestSession = {
      id: this.nextSessionId++,
      list,
      items: [...list.items],
      origin,
      documentUri: document.uri.toString(),
      triggerKind: context.triggerKind,
      requestUuid: context.requestUuid,
    };
    this.sessions.set(session.id, session);
    this.listSessions.set(list, session);
    session.items.forEach((item, itemIndex) => {
      this.itemRoutes.set(item, { session, itemIndex });
    });
    this.lastSessionId = session.id;
    return session;
  }

  private lifecycleOrigin(): CompletionTestInvocationOrigin {
    return this.harnessLifecycleDepth > 0 ? "harness" : "vscode";
  }

  private recordItemLifecycle(
    action: Exclude<CompletionTestLifecycleAction, "listDispose">,
    route: CompletionTestItemRoute | undefined,
    details: Omit<
      CompletionTestLifecycleEvent,
      "action" | "sessionId" | "origin" | "itemIndex"
    > = {},
  ): void {
    if (!route) {
      return;
    }
    this.lifecycleEvents.push({
      action,
      sessionId: route.session.id,
      origin: this.lifecycleOrigin(),
      itemIndex: route.itemIndex,
      ...details,
    });
  }
}
