import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompletionAlgorithm,
  CompletionAlgorithmContext,
  CompletionAlgorithmDefinition,
  CompletionAlgorithmResult,
  CompletionConfiguration,
  CompletionModelReference,
  CompletionModelResolver,
} from "../../src/completion/types";
import { INTERNAL_COMPLETION_VENDOR } from "../../src/completion/types";
import { createVsCodeModelId } from "../../src/model-id-utils";

const mock = vi.hoisted(() => ({
  configuration: {
    enabled: true,
    providers: [],
    strategy: { mode: "all", stopWhen: { type: "firstUsable", graceMs: 0 } },
  } as CompletionConfiguration,
  configurationListeners: new Set<
    (event: vscode.ConfigurationChangeEvent) => void
  >(),
  chatModelListeners: new Set<() => void>(),
  registrations: 0,
  registrationDisposals: 0,
  registrationMetadata: [] as vscode.InlineCompletionItemProviderMetadata[],
}));

vi.mock("../../src/completion/vscode-configuration", () => ({
  readCompletionConfiguration: () => ({
    configuration: mock.configuration,
    issues: [],
  }),
  affectsCompletionConfiguration: () => true,
}));

vi.mock("../../src/logger", () => ({
  authLog: { error: () => undefined },
}));

vi.mock("vscode", () => {
  class Disposable {
    private active = true;
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      if (!this.active) return;
      this.active = false;
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void): vscode.Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
    fire(event: T): void {
      for (const listener of [...this.listeners]) listener(event);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class InlineCompletionList {
    constructor(readonly items: vscode.InlineCompletionItem[]) {}
  }

  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Uri {
    static parse(value: string): Uri {
      return new Uri(value);
    }
    constructor(private readonly value: string) {}
    toString(): string {
      return this.value;
    }
  }

  return {
    Disposable,
    EventEmitter,
    InlineCompletionList,
    Position,
    Uri,
    l10n: { t: (message: string) => message },
    env: { language: "en" },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    window: {
      showWarningMessage: async () => undefined,
      createOutputChannel: () => ({
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        dispose: () => undefined,
      }),
    },
    workspace: {
      asRelativePath: (uri: { toString(): string }) =>
        uri.toString().replace(/^file:\/\/\//, ""),
      onDidChangeConfiguration: (
        listener: (event: vscode.ConfigurationChangeEvent) => void,
      ) => {
        mock.configurationListeners.add(listener);
        return new Disposable(() =>
          mock.configurationListeners.delete(listener),
        );
      },
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
    },
    lm: {
      onDidChangeChatModels: (listener: () => void) => {
        mock.chatModelListeners.add(listener);
        return new Disposable(() => mock.chatModelListeners.delete(listener));
      },
    },
    languages: {
      registerInlineCompletionItemProvider: (
        _selector: vscode.DocumentSelector,
        _provider: vscode.InlineCompletionItemProvider,
        metadata: vscode.InlineCompletionItemProviderMetadata,
      ) => {
        mock.registrations += 1;
        mock.registrationMetadata.push({
          ...metadata,
          ...(metadata.excludes ? { excludes: [...metadata.excludes] } : {}),
        });
        return new Disposable(() => {
          mock.registrationDisposals += 1;
        });
      },
    },
  };
});

import * as vscodeApi from "vscode";
import { CompletionManager } from "../../src/completion/manager";
import { CompletionAlgorithmRegistry } from "../../src/completion/registry";
import {
  arbitrateJointCompletions,
  type JointDisposeReason,
} from "../../src/chat-lib/core/joint";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      if (!resolvePromise)
        throw new Error("Deferred promise is not initialized.");
      resolvePromise(value);
    },
  };
}

class FakeAlgorithm implements CompletionAlgorithm {
  readonly changeEmitter = new vscodeApi.EventEmitter<{
    readonly reason: string;
  }>();
  readonly onDidChange = this.changeEmitter.event;
  readonly shown: vscode.InlineCompletionItem[] = [];
  readonly partial: vscode.InlineCompletionItem[] = [];
  readonly ended: vscode.InlineCompletionItem[] = [];
  readonly lists: vscode.InlineCompletionList[] = [];
  readonly discarded: vscode.InlineCompletionItem[] = [];
  readonly tracked: Array<{
    readonly list: vscode.InlineCompletionList;
    readonly items: readonly vscode.InlineCompletionItem[];
  }> = [];
  readonly optionUpdates: unknown[] = [];
  readonly monitorActions: string[] = [];
  eagerness: unknown;
  disposed = false;
  listenerActive = true;
  cacheActive = true;
  tokenActive = true;
  catalogChanges = 0;
  environmentChanges: string[] = [];
  provideCalls = 0;
  handleDidChangeChatModels: (() => void) | undefined;
  handleEnvironmentChange: ((reason: string) => void) | undefined;
  nextResult: Promise<CompletionAlgorithmResult | undefined> | undefined;

  constructor(
    readonly context: CompletionAlgorithmContext,
    supportsCatalogChanges = false,
    supportsEnvironmentChanges = false,
  ) {
    this.eagerness =
      typeof context.options === "object" && context.options !== null
        ? Reflect.get(context.options, "eagerness")
        : undefined;
    if (supportsCatalogChanges) {
      this.handleDidChangeChatModels = () => {
        this.catalogChanges += 1;
      };
    }
    if (supportsEnvironmentChanges) {
      this.handleEnvironmentChange = (reason) => {
        this.environmentChanges.push(reason);
        this.changeEmitter.fire({ reason });
      };
    }
  }

  updateOptions(normalizedOptions: unknown): boolean {
    this.optionUpdates.push(normalizedOptions);
    this.eagerness =
      typeof normalizedOptions === "object" && normalizedOptions !== null
        ? Reflect.get(normalizedOptions, "eagerness")
        : undefined;
    return true;
  }

  getDebugState(): unknown {
    return { eagerness: this.eagerness, monitorActions: this.monitorActions };
  }

  provideInlineCompletions(): Promise<CompletionAlgorithmResult | undefined> {
    this.provideCalls += 1;
    if (this.nextResult) return this.nextResult;
    const item = { insertText: `${this.context.entry.id}-item` };
    return Promise.resolve({
      providerId: this.context.entry.id,
      items: [item],
    });
  }

  handleDidShowCompletionItem(item: vscode.InlineCompletionItem): void {
    this.shown.push(item);
  }

  handleDidPartiallyAcceptCompletionItem(
    item: vscode.InlineCompletionItem,
  ): void {
    this.partial.push(item);
  }

  handleEndOfLifetime(item: vscode.InlineCompletionItem): void {
    this.ended.push(item);
  }

  handleListEndOfLifetime(list: vscode.InlineCompletionList): void {
    this.lists.push(list);
  }

  handleDiscardedCompletionItems(
    items: readonly vscode.InlineCompletionItem[],
  ): void {
    this.discarded.push(...items);
  }

  trackCompletionList(
    list: vscode.InlineCompletionList,
    items: readonly vscode.InlineCompletionItem[],
  ): void {
    this.tracked.push({ list, items: [...items] });
  }

  dispose(): void {
    this.disposed = true;
    this.listenerActive = false;
    this.cacheActive = false;
    this.tokenActive = false;
    this.changeEmitter.dispose();
  }
}

class JointAlgorithm implements CompletionAlgorithm {
  readonly fim = deferred<
    { readonly items: readonly vscode.InlineCompletionItem[] } | undefined
  >();
  readonly nes = deferred<
    { readonly items: readonly vscode.InlineCompletionItem[] } | undefined
  >();
  readonly fimCancellations: JointDisposeReason[] = [];
  readonly nesCancellations: JointDisposeReason[] = [];
  readonly shown: vscode.InlineCompletionItem[] = [];
  disposed = false;

  constructor(private readonly providerId: string) {}

  async provideInlineCompletions(
    input: Parameters<CompletionAlgorithm["provideInlineCompletions"]>[0],
    token: vscode.CancellationToken,
  ): Promise<CompletionAlgorithmResult | undefined> {
    const result = await arbitrateJointCompletions({
      documentUri: input.document.uri.toString(),
      documentVersion: input.document.version,
      documentText: input.document.getText(),
      fim: {
        start: () => ({
          result: this.fim.promise,
          cancel: (reason) => this.fimCancellations.push(reason),
        }),
      },
      nes: {
        start: () => ({
          result: this.nes.promise,
          cancel: (reason) => this.nesCancellations.push(reason),
        }),
      },
      fimSemantics: {
        getEdit: () => ({ start: 0, end: 0, newText: "joint" }),
        isVisible: () => true,
      },
      nesSemantics: {
        getEdit: () => ({ start: 0, end: 0, newText: "joint" }),
        isVisible: () => true,
      },
      cancellation: {
        get isCancellationRequested() {
          return token.isCancellationRequested;
        },
        onCancellationRequested: (listener) =>
          token.onCancellationRequested(listener),
      },
      clock: {
        now: Date.now,
        sleep: (delayMs) =>
          new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
      },
    });
    return result.kind === "result"
      ? { providerId: this.providerId, items: [...result.list.items] }
      : undefined;
  }

  handleDidShowCompletionItem(item: vscode.InlineCompletionItem): void {
    this.shown.push(item);
  }

  dispose(): void {
    this.disposed = true;
  }
}

function definition(
  instances: FakeAlgorithm[],
  getModelReferences?: (
    options: unknown,
  ) => readonly CompletionModelReference[],
  supportsCatalogChanges = false,
  supportsEnvironmentChanges = false,
): CompletionAlgorithmDefinition {
  return {
    id: "simple",
    label: "Fake",
    ...(getModelReferences ? { getModelReferences } : {}),
    normalizeOptions: (raw) => ({ ok: true, value: raw ?? {} }),
    create: (context) => {
      const algorithm = new FakeAlgorithm(
        context,
        supportsCatalogChanges,
        supportsEnvironmentChanges,
      );
      instances.push(algorithm);
      return algorithm;
    },
  };
}

const resolver = {
  resolveCompletionModel: async () => {
    throw new Error("Model resolution is not used by fake algorithms.");
  },
};

function modelReferences(
  options: unknown,
): readonly CompletionModelReference[] {
  if (typeof options !== "object" || options === null) {
    return [];
  }
  const model = Reflect.get(options, "model");
  if (typeof model !== "object" || model === null) {
    return [];
  }
  const vendor = Reflect.get(model, "vendor");
  const id = Reflect.get(model, "id");
  return typeof vendor === "string" && typeof id === "string"
    ? [{ vendor, id }]
    : [];
}

function fireConfigurationChange(section: string): void {
  const event: vscode.ConfigurationChangeEvent = {
    affectsConfiguration: (candidate) => candidate === section,
  };
  for (const listener of [...mock.configurationListeners]) {
    listener(event);
  }
}

function fireChatModelsChange(): void {
  for (const listener of [...mock.chatModelListeners]) {
    listener();
  }
}

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function identityWithoutEagerness(options: unknown): unknown {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    return options;
  }
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => key !== "eagerness"),
  );
}

function input(): {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  readonly context: vscode.InlineCompletionContext;
} {
  return {
    document: {
      uri: vscodeApi.Uri.parse("file:///workspace/main.ts"),
      languageId: "typescript",
      version: 1,
      getText: () => "const value = 1;",
    } as vscode.TextDocument,
    position: new vscodeApi.Position(0, 0),
    context: { triggerKind: 0 } as vscode.InlineCompletionContext,
  };
}

function acceptedReason(): vscode.InlineCompletionEndOfLifeReason {
  return { kind: 0 } as vscode.InlineCompletionEndOfLifeReason;
}

function listReason(): vscode.InlineCompletionsDisposeReason {
  return { kind: 0 } as vscode.InlineCompletionsDisposeReason;
}

beforeEach(() => {
  mock.configuration = {
    enabled: true,
    providers: [],
    strategy: { mode: "all", stopWhen: { type: "firstUsable", graceMs: 0 } },
  };
  mock.configurationListeners.clear();
  mock.chatModelListeners.clear();
  mock.registrations = 0;
  mock.registrationDisposals = 0;
  mock.registrationMetadata.length = 0;
});

describe("CompletionManager runtime registry", () => {
  it("returns before invoking an algorithm for a disabled file glob", async () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([definition(instances)]);
    mock.configuration.providers = [{ id: "one", algorithm: "simple" }];
    mock.configuration.strategy = {
      mode: "all",
      disabledGlobs: ["**/*.ts"],
      stopWhen: { type: "firstUsable", graceMs: 0 },
    };

    const manager = new CompletionManager(resolver, registry);
    const completionInput = input();
    const list = await manager.provideInlineCompletionItems(
      completionInput.document,
      completionInput.position,
      completionInput.context,
      cancellationToken(),
    );

    expect(list.items).toEqual([]);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.provideCalls).toBe(0);
    manager.dispose();
  });

  it("re-registers metadata only when the built-in completion exclusion changes", () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([definition(instances)]);
    mock.configuration.providers = [{ id: "one", algorithm: "simple" }];

    const manager = new CompletionManager(resolver, registry);
    const runtimeId = manager.getState().runtimeInstances.one;

    expect(mock.registrations).toBe(1);
    expect(mock.registrationDisposals).toBe(0);
    expect(mock.registrationMetadata).toEqual([
      {
        groupId: "unify-chat-provider",
        displayName: "Unify Chat Provider",
        excludes: ["completions", "nes", "github.copilot"],
      },
    ]);
    expect(manager.getState().excludedProviderGroups).toEqual([
      "completions",
      "nes",
      "github.copilot",
    ]);

    mock.configuration.strategy = {
      ...mock.configuration.strategy,
      disableVSCodeBuiltinCompletion: false,
    };
    fireConfigurationChange("unifyChatProvider.completion.strategy");

    expect(mock.registrations).toBe(2);
    expect(mock.registrationDisposals).toBe(1);
    expect(mock.registrationMetadata[1]).toEqual({
      groupId: "unify-chat-provider",
      displayName: "Unify Chat Provider",
    });
    expect(mock.registrationMetadata[1]).not.toHaveProperty("excludes");
    expect(manager.getState().excludedProviderGroups).toEqual([]);
    expect(manager.getState().runtimeInstances.one).toBe(runtimeId);
    expect(instances).toHaveLength(1);

    mock.configuration.strategy = {
      ...mock.configuration.strategy,
      stopWhen: { type: "allSettled" },
    };
    fireConfigurationChange("unifyChatProvider.completion.strategy");

    expect(mock.registrations).toBe(2);
    expect(mock.registrationDisposals).toBe(1);
    expect(manager.getState().runtimeInstances.one).toBe(runtimeId);
    expect(instances).toHaveLength(1);

    mock.configuration.strategy = {
      ...mock.configuration.strategy,
      disableVSCodeBuiltinCompletion: true,
    };
    fireConfigurationChange("unifyChatProvider.completion.strategy");

    expect(mock.registrations).toBe(3);
    expect(mock.registrationDisposals).toBe(2);
    expect(mock.registrationMetadata[2]?.excludes).toEqual([
      "completions",
      "nes",
      "github.copilot",
    ]);
    expect(manager.getState().runtimeInstances.one).toBe(runtimeId);
    expect(instances).toHaveLength(1);

    manager.dispose();
    expect(mock.registrationDisposals).toBe(3);
  });

  it("routes Zed provider, settings, and catalog refresh reasons", () => {
    const instances: FakeAlgorithm[] = [];
    const zedDefinition: CompletionAlgorithmDefinition = {
      id: "zed",
      label: "Zed fake",
      getModelReferences: modelReferences,
      normalizeOptions: (raw) => ({ ok: true, value: raw ?? {} }),
      create: (context) => {
        const algorithm = new FakeAlgorithm(context, true, true);
        instances.push(algorithm);
        return algorithm;
      },
    };
    const registry = new CompletionAlgorithmRegistry([zedDefinition]);
    mock.configuration.providers = [
      {
        id: "zed-main",
        algorithm: "zed",
        options: { model: { vendor: "test", id: "zeta-cloud" } },
      },
    ];
    const manager = new CompletionManager(resolver, registry);
    const changes: unknown[] = [];
    const subscription = manager.onDidChange((change) => changes.push(change));
    const expectReason = (reason: string): void => {
      expect(changes.at(-1)).toEqual({
        data: {
          kind: "unify-chat-provider.completion-change",
          providerId: "zed-main",
          change: { reason },
        },
      });
    };

    fireConfigurationChange("unifyChatProvider.endpoints");
    expectReason("provider-changed");
    fireConfigurationChange("unifyChatProvider.completion.providers");
    expectReason("provider-changed");
    fireConfigurationChange("unifyChatProvider.completion.strategy");
    expectReason("settings-changed");
    fireChatModelsChange();
    expectReason("provider-changed");

    subscription.dispose();
    manager.dispose();
  });

  it("keeps Copilot eagerness scoped to each configured provider", () => {
    const instances: FakeAlgorithm[] = [];
    const copilotDefinition: CompletionAlgorithmDefinition = {
      id: "copilot-replica",
      label: "Copilot fake",
      getRuntimeIdentity: identityWithoutEagerness,
      normalizeOptions: (raw) => ({ ok: true, value: raw ?? {} }),
      create: (context) => {
        const algorithm = new FakeAlgorithm(context);
        instances.push(algorithm);
        return algorithm;
      },
    };
    const registry = new CompletionAlgorithmRegistry([copilotDefinition]);
    mock.configuration.providers = [
      {
        id: "first",
        algorithm: "copilot-replica",
        options: {
          enableFIM: false,
          enableNES: true,
          eagerness: "low",
          nesModel: { vendor: "test", id: "nes-a" },
          untouched: "first-value",
        },
      },
      {
        id: "second",
        algorithm: "copilot-replica",
        options: {
          enableFIM: false,
          enableNES: true,
          eagerness: "high",
          nesModel: { vendor: "test", id: "nes-b" },
          untouched: "second-value",
        },
      },
      { id: "other", algorithm: "simple", options: { untouched: "other" } },
    ];
    const manager = new CompletionManager(resolver, registry);
    expect("providerOptions" in manager).toBe(false);
    expect("onDidChangeProviderOptions" in manager).toBe(false);
    expect("setProviderOptionValue" in manager).toBe(false);
    expect(instances.map((instance) => instance.eagerness)).toEqual([
      "low",
      "high",
    ]);
    const firstRuntimeIds = manager.getState().runtimeInstances;
    instances[0].monitorActions.push("accepted");

    mock.configuration = {
      ...mock.configuration,
      providers: mock.configuration.providers.map((provider) =>
        provider.id === "first"
          ? {
              ...provider,
              options: { ...provider.options, eagerness: "medium" },
            }
          : provider,
      ),
    };
    fireConfigurationChange("unifyChatProvider.completion.providers");

    expect(manager.getState().runtimeInstances).toEqual(firstRuntimeIds);
    expect(instances).toHaveLength(2);
    expect(instances.every((instance) => !instance.disposed)).toBe(true);
    expect(instances[0].monitorActions).toEqual(["accepted"]);
    expect(instances[0].optionUpdates.at(-1)).toMatchObject({
      eagerness: "medium",
    });
    expect(instances[1].optionUpdates).toEqual([]);
    expect(manager.getRuntimeDebugState("first")).toEqual({
      eagerness: "medium",
      monitorActions: ["accepted"],
    });
    expect(manager.getRuntimeDebugState("second")).toEqual({
      eagerness: "high",
      monitorActions: [],
    });
    manager.dispose();
  });

  it("keeps another item from a provider routable when only its duplicate is discarded", async () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([definition(instances)]);
    mock.configuration.providers = [
      { id: "first", algorithm: "simple" },
      { id: "second", algorithm: "simple" },
    ];
    mock.configuration.strategy = {
      mode: "all",
      stopWhen: { type: "allSettled" },
    };
    const manager = new CompletionManager(resolver, registry);
    const firstDuplicate = { insertText: "same" };
    const secondDuplicate = { insertText: "same" };
    const retained = { insertText: "unique" };
    instances[0].nextResult = Promise.resolve({
      providerId: "first",
      items: [firstDuplicate],
    });
    instances[1].nextResult = Promise.resolve({
      providerId: "second",
      items: [secondDuplicate, retained],
    });
    const request = input();

    const list = await manager.provideInlineCompletionItems(
      request.document,
      request.position,
      request.context,
      cancellationToken(),
    );

    expect(list.items).toEqual([firstDuplicate, retained]);
    expect(instances[1].discarded).toEqual([secondDuplicate]);
    expect(instances[1].tracked).toEqual([{ list, items: [retained] }]);
    manager.handleDidShowCompletionItem(retained, "unique");
    manager.handleEndOfLifetime(retained, acceptedReason());
    manager.handleListEndOfLifetime(list, listReason());
    expect(instances[1].shown).toEqual([retained]);
    expect(instances[1].ended).toEqual([retained]);
    expect(instances[1].lists).toEqual([list]);
    manager.dispose();
  });

  it("reuses stable runtimes, rebuilds only changed providers, and releases removed or disabled runtimes", () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([definition(instances)]);
    mock.configuration.providers = [
      { id: "one", algorithm: "simple", options: { revision: 1 } },
    ];
    const manager = new CompletionManager(resolver, registry);
    const firstId = manager.getState().runtimeInstances.one;
    manager.refreshRegistration();
    expect(instances).toHaveLength(1);
    expect(manager.getState().runtimeInstances.one).toBe(firstId);

    mock.configuration.providers = [
      { id: "one", algorithm: "simple", options: { revision: 2 } },
      { id: "two", algorithm: "simple", options: { revision: 1 } },
    ];
    manager.refreshRegistration();
    expect(instances).toHaveLength(3);
    expect(instances[0]).toMatchObject({
      disposed: true,
      listenerActive: false,
      cacheActive: false,
      tokenActive: false,
    });
    const secondOneId = manager.getState().runtimeInstances.one;
    const firstTwoId = manager.getState().runtimeInstances.two;
    expect(secondOneId).not.toBe(firstId);

    mock.configuration.providers = [
      { id: "two", algorithm: "simple", options: { revision: 1 } },
    ];
    manager.refreshRegistration();
    expect(instances[1].disposed).toBe(true);
    expect(instances[2].disposed).toBe(false);
    expect(manager.getState().runtimeInstances.two).toBe(firstTwoId);

    mock.configuration.enabled = false;
    manager.refreshRegistration();
    expect(instances[2].disposed).toBe(true);
    expect(manager.getState().runtimeCount).toBe(0);
    expect(mock.registrationDisposals).toBe(1);
    manager.dispose();
  });

  it("rebuilds only runtimes whose referenced endpoint model changed", () => {
    const instances: FakeAlgorithm[] = [];
    const fingerprints = new Map([
      ["test/a", "a:1"],
      ["test/b", "b:1"],
      ["test/unrelated", "unrelated:1"],
    ]);
    const modelResolver: CompletionModelResolver = {
      ...resolver,
      getConfigurationFingerprint: (reference) =>
        fingerprints.get(`${reference.vendor}/${reference.id}`) ?? "missing",
    };
    const registry = new CompletionAlgorithmRegistry([
      definition(instances, modelReferences),
    ]);
    mock.configuration.providers = [
      {
        id: "one",
        algorithm: "simple",
        options: { model: { vendor: "test", id: "a" } },
      },
      {
        id: "two",
        algorithm: "simple",
        options: { model: { vendor: "test", id: "b" } },
      },
    ];
    const manager = new CompletionManager(modelResolver, registry);
    const firstOneId = manager.getState().runtimeInstances.one;
    const firstTwoId = manager.getState().runtimeInstances.two;

    fingerprints.set("test/a", "a:2");
    fireConfigurationChange("unifyChatProvider.endpoints");
    expect(manager.getState().runtimeInstances.one).not.toBe(firstOneId);
    expect(manager.getState().runtimeInstances.two).toBe(firstTwoId);
    expect(instances).toHaveLength(3);
    expect(instances[0].disposed).toBe(true);
    expect(instances[1].disposed).toBe(false);

    fingerprints.set("test/unrelated", "unrelated:2");
    fireConfigurationChange("unifyChatProvider.endpoints");
    expect(instances).toHaveLength(3);
    expect(manager.getState().runtimeInstances.two).toBe(firstTwoId);

    fingerprints.set("test/b", "b:2");
    fireConfigurationChange("unifyChatProvider.endpoints");
    expect(manager.getState().runtimeInstances.two).not.toBe(firstTwoId);
    expect(instances).toHaveLength(4);
    expect(instances[1].disposed).toBe(true);
    manager.dispose();
  });

  it("refreshes only runtimes that reference the changed auth provider", () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([
      definition(instances, modelReferences, false, true),
    ]);
    mock.configuration.providers = [
      {
        id: "one",
        algorithm: "simple",
        options: {
          model: {
            vendor: INTERNAL_COMPLETION_VENDOR,
            id: createVsCodeModelId("provider-a", "model"),
          },
        },
      },
      {
        id: "two",
        algorithm: "simple",
        options: {
          model: {
            vendor: INTERNAL_COMPLETION_VENDOR,
            id: createVsCodeModelId("provider-b", "model"),
          },
        },
      },
    ];
    const manager = new CompletionManager(resolver, registry);

    manager.handleAuthStateChange("provider-a");
    manager.handleAuthStateChange("unrelated");

    expect(instances[0].environmentChanges).toEqual(["auth-changed"]);
    expect(instances[1].environmentChanges).toEqual([]);
    manager.dispose();
  });

  it("notifies catalog-aware model runtimes in place without dropping active state", async () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([
      definition(instances, modelReferences, true),
    ]);
    mock.configuration.providers = [
      {
        id: "model-backed",
        algorithm: "simple",
        options: { model: { vendor: "test", id: "controlled" } },
      },
      { id: "model-free", algorithm: "simple", options: {} },
    ];
    const manager = new CompletionManager(resolver, registry);
    const modelBackedId = manager.getState().runtimeInstances["model-backed"];
    const modelFreeId = manager.getState().runtimeInstances["model-free"];
    const pendingResult = deferred<CompletionAlgorithmResult | undefined>();
    instances[0].nextResult = pendingResult.promise;
    const request = input();
    const pending = manager.provideInlineCompletionItems(
      request.document,
      request.position,
      request.context,
      cancellationToken(),
    );
    await Promise.resolve();

    fireChatModelsChange();

    expect(manager.getState().runtimeInstances["model-backed"]).toBe(
      modelBackedId,
    );
    expect(manager.getState().runtimeInstances["model-free"]).toBe(modelFreeId);
    expect(instances).toHaveLength(2);
    expect(instances[0].catalogChanges).toBe(1);
    expect(instances[0].disposed).toBe(false);
    expect(instances[0].listenerActive).toBe(true);
    expect(instances[0].cacheActive).toBe(true);
    expect(instances[0].tokenActive).toBe(true);
    expect(instances[1].disposed).toBe(false);
    pendingResult.resolve({
      providerId: "model-backed",
      items: [{ insertText: "catalog-survivor" }],
    });
    const pendingItems = (await pending).items.map((item) => item.insertText);
    expect(pendingItems).toHaveLength(2);
    expect(pendingItems).toEqual(
      expect.arrayContaining(["catalog-survivor", "model-free-item"]),
    );
    expect(mock.chatModelListeners.size).toBe(1);

    manager.dispose();
    expect(mock.chatModelListeners.size).toBe(0);
  });

  it("rebuilds legacy model-backed runtimes without a catalog-change hook", () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([
      definition(instances, modelReferences),
    ]);
    mock.configuration.providers = [
      {
        id: "legacy-model-backed",
        algorithm: "simple",
        options: { model: { vendor: "test", id: "controlled" } },
      },
    ];
    const manager = new CompletionManager(resolver, registry);
    const firstId = manager.getState().runtimeInstances["legacy-model-backed"];

    fireChatModelsChange();

    expect(manager.getState().runtimeInstances["legacy-model-backed"]).not.toBe(
      firstId,
    );
    expect(instances).toHaveLength(2);
    expect(instances[0].disposed).toBe(true);
    expect(instances[1].disposed).toBe(false);
    manager.dispose();
  });

  it("drops late results and ignores item/list lifecycle from an inactive generation", async () => {
    const instances: FakeAlgorithm[] = [];
    const registry = new CompletionAlgorithmRegistry([definition(instances)]);
    mock.configuration.providers = [
      { id: "one", algorithm: "simple", options: { revision: 1 } },
    ];
    const manager = new CompletionManager(resolver, registry);
    const request = input();
    const firstList = await manager.provideInlineCompletionItems(
      request.document,
      request.position,
      request.context,
      cancellationToken(),
    );
    const oldItem = firstList.items[0];
    const oldRuntime = instances[0];

    mock.configuration.providers = [
      { id: "one", algorithm: "simple", options: { revision: 2 } },
    ];
    manager.refreshRegistration();
    manager.handleDidShowCompletionItem(oldItem, "updated");
    manager.handleDidPartiallyAcceptCompletionItem(oldItem, 1);
    manager.handleEndOfLifetime(oldItem, acceptedReason());
    manager.handleListEndOfLifetime(firstList, listReason());
    expect(oldRuntime.shown).toHaveLength(0);
    expect(oldRuntime.partial).toHaveLength(0);
    expect(oldRuntime.ended).toHaveLength(0);
    expect(oldRuntime.lists).toHaveLength(0);

    const late = deferred<CompletionAlgorithmResult | undefined>();
    instances[1].nextResult = late.promise;
    const pending = manager.provideInlineCompletionItems(
      request.document,
      request.position,
      request.context,
      cancellationToken(),
    );
    await Promise.resolve();
    mock.configuration.providers = [
      { id: "one", algorithm: "simple", options: { revision: 3 } },
    ];
    manager.refreshRegistration();
    const lateItem = { insertText: "late" };
    late.resolve({ providerId: "one", items: [lateItem] });
    const lateList = await pending;
    expect(lateList.items).toEqual([]);
    manager.handleDidShowCompletionItem(lateItem, "late");
    expect(instances[1].shown).toHaveLength(0);

    const currentList = await manager.provideInlineCompletionItems(
      request.document,
      request.position,
      request.context,
      cancellationToken(),
    );
    const currentItem = currentList.items[0];
    manager.handleDidShowCompletionItem(currentItem, "current");
    manager.handleDidPartiallyAcceptCompletionItem(currentItem, 1);
    manager.handleEndOfLifetime(currentItem, acceptedReason());
    manager.handleEndOfLifetime(currentItem, acceptedReason());
    manager.handleListEndOfLifetime(currentList, listReason());
    manager.handleListEndOfLifetime(currentList, listReason());
    expect(instances[2].shown).toEqual([currentItem]);
    expect(instances[2].partial).toEqual([currentItem]);
    expect(instances[2].ended).toEqual([currentItem]);
    expect(instances[2].lists).toEqual([currentList]);
    manager.dispose();
  });

  it("coordinates global provider cancellation with Copilot internal joint branches once", async () => {
    const fallbackInstances: FakeAlgorithm[] = [];
    const jointInstances: JointAlgorithm[] = [];
    const jointDefinition: CompletionAlgorithmDefinition = {
      id: "copilot-replica",
      label: "Joint",
      normalizeOptions: (raw) => ({ ok: true, value: raw ?? {} }),
      create: (context) => {
        const algorithm = new JointAlgorithm(context.entry.id);
        jointInstances.push(algorithm);
        return algorithm;
      },
    };
    const registry = new CompletionAlgorithmRegistry([
      definition(fallbackInstances),
      jointDefinition,
    ]);
    mock.configuration.providers = [
      { id: "copilot", algorithm: "copilot-replica" },
      { id: "fallback", algorithm: "simple" },
    ];
    const manager = new CompletionManager(resolver, registry);
    const request = input();
    const list = await manager.provideInlineCompletionItems(
      request.document,
      request.position,
      request.context,
      cancellationToken(),
    );
    expect(list.items.map((item) => item.insertText)).toEqual([
      "fallback-item",
    ]);
    const joint = jointInstances[0];
    expect(joint.fimCancellations).toEqual(["token-cancellation"]);
    expect(joint.nesCancellations).toEqual(["token-cancellation"]);

    const lateFim = { insertText: "late-fim" };
    const lateNes = { insertText: "late-nes" };
    joint.fim.resolve({ items: [lateFim] });
    joint.nes.resolve({ items: [lateNes] });
    await Promise.resolve();
    await Promise.resolve();
    manager.handleDidShowCompletionItem(lateFim, "late");
    manager.handleDidShowCompletionItem(lateNes, "late");
    expect(joint.shown).toHaveLength(0);

    const selected = list.items[0];
    manager.handleDidShowCompletionItem(selected, "shown");
    manager.handleDidShowCompletionItem(selected, "shown-again");
    manager.handleEndOfLifetime(selected, acceptedReason());
    manager.handleEndOfLifetime(selected, acceptedReason());
    expect(fallbackInstances[0].shown).toEqual([selected, selected]);
    expect(fallbackInstances[0].ended).toEqual([selected]);
    manager.dispose();
    expect(joint.disposed).toBe(true);
  });
});
