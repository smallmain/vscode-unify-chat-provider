import * as vscode from "vscode";
import { t } from "../i18n";
import { authLog } from "../logger";
import { completionAlgorithmRegistry } from "./definitions";
import { matchesCompletionDisabledGlob } from "./disabled-globs";
import { CompletionNotifier } from "./notifier";
import type { CompletionAlgorithmRegistry } from "./registry";
import { scheduleCompletionProviders } from "./scheduler";
import type {
  CompletionAlgorithm,
  CompletionAlgorithmEntry,
  CompletionAlgorithmInput,
  CompletionModelResolver,
} from "./types";
import {
  createRoutedCompletionChange,
  readRoutedCompletionChange,
} from "./change-hint";
import {
  affectsCompletionConfiguration,
  readCompletionConfiguration,
} from "./vscode-configuration";
import type { CompletionConfigurationIssue } from "./configuration";

const INLINE_COMPLETION_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file" },
  { scheme: "untitled" },
  { scheme: "vscode-notebook-cell" },
];

const VSCODE_BUILTIN_COMPLETION_GROUPS = [
  "completions",
  "nes",
  "github.copilot",
] as const;

function createInlineCompletionMetadata(
  disableVSCodeBuiltinCompletion: boolean,
): vscode.InlineCompletionItemProviderMetadata {
  return {
    groupId: "unify-chat-provider",
    displayName: "Unify Chat Provider",
    ...(disableVSCodeBuiltinCompletion
      ? { excludes: [...VSCODE_BUILTIN_COMPLETION_GROUPS] }
      : {}),
  };
}

interface RuntimeEntry {
  key: string;
  optionsKey: string;
  usesLanguageModels: boolean;
  instanceId: number;
  generation: number;
  active: boolean;
  algorithm: CompletionAlgorithm;
  changeSubscription?: vscode.Disposable;
}

interface RuntimeRoute {
  readonly providerId: string;
  readonly generation: number;
  readonly entry: RuntimeEntry;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableSerialize(Reflect.get(value, key))}`,
    )
    .join(",")}}`;
}

function formatConfigurationIssue(
  issue: CompletionConfigurationIssue,
): string {
  switch (issue.code) {
    case "entry-not-object":
      return t(
        "Completion algorithm entry at index {0} must be an object.",
        issue.index,
      );
    case "entry-missing-id":
      return t(
        "Completion algorithm entry at index {0} must have a non-empty id.",
        issue.index,
      );
    case "entry-unknown-algorithm":
      return t(
        "Completion algorithm entry \"{0}\" has an unknown algorithm.",
        issue.id,
      );
    case "entry-invalid-options":
      return t(
        "Completion algorithm entry \"{0}\" options must be an object.",
        issue.id,
      );
    case "stop-when-invalid":
      return t(
        "Completion strategy stopWhen is invalid; using firstUsable.",
      );
    case "deadline-invalid":
      return t(
        "Completion strategy deadline requires a non-negative timeoutMs; using firstUsable.",
      );
    case "enough-results-invalid":
      return t(
        "Completion strategy enoughResults requires a positive minItems; using firstUsable.",
      );
    case "unknown-stop-condition":
      return t(
        "Unknown completion stop condition \"{0}\"; using firstUsable.",
        issue.value,
      );
    case "strategy-not-object":
      return t("Completion strategy must be an object; using defaults.");
    case "unknown-strategy-mode":
      return t(
        "Unknown completion strategy mode \"{0}\"; using all.",
        issue.value,
      );
    case "disabled-globs-invalid":
      return "Completion strategy disabledGlobs must contain non-empty strings; invalid values were ignored.";
    case "duplicate-entry-id":
      return t(
        "Completion algorithm entry id \"{0}\" is duplicated.",
        issue.id,
      );
    case "providers-not-array":
      return t("Completion providers must be an array.");
  }
}

export interface CompletionManagerState {
  registered: boolean;
  enabled: boolean;
  providerCount: number;
  providerIds: string[];
  excludedProviderGroups: string[];
  runtimeCount: number;
  runtimeInstances: Record<string, number>;
}

export class CompletionManager
  implements vscode.InlineCompletionItemProvider, vscode.Disposable
{
  private registration: vscode.Disposable | undefined;
  private registeredDisableVSCodeBuiltinCompletion: boolean | undefined;
  private readonly configurationSubscription: vscode.Disposable;
  private readonly chatModelsSubscription: vscode.Disposable;
  private readonly notifier = new CompletionNotifier();
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.InlineCompletionChangeHint | void>();
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly itemSources = new WeakMap<
    vscode.InlineCompletionItem,
    RuntimeRoute
  >();
  private readonly listSources = new WeakMap<
    vscode.InlineCompletionList,
    RuntimeRoute[]
  >();
  private disposed = false;
  private nextRuntimeInstanceId = 1;

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly modelResolver: CompletionModelResolver,
    private readonly algorithms: CompletionAlgorithmRegistry = completionAlgorithmRegistry,
  ) {
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration("unifyChatProvider.endpoints")) {
          this.refreshRegistration();
          this.notifyEnvironmentChange("provider-changed");
        } else if (affectsCompletionConfiguration(event)) {
          this.refreshRegistration();
          this.notifyEnvironmentChange(
            event.affectsConfiguration(
              "unifyChatProvider.completion.providers",
            )
              ? "provider-changed"
              : "settings-changed",
          );
        }
      },
    );
    this.chatModelsSubscription = vscode.lm.onDidChangeChatModels(() => {
      this.invalidateLanguageModelRuntimes();
      this.notifyEnvironmentChange("provider-changed");
    });
    this.refreshRegistration();
  }

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList> {
    const result = readCompletionConfiguration();
    const configuration = result.configuration;
    if (!configuration.enabled || configuration.providers.length === 0) {
      return Promise.resolve(new vscode.InlineCompletionList([]));
    }

    this.reportConfigurationIssues(result.issues);
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    if (
      matchesCompletionDisabledGlob(
        relativePath,
        configuration.strategy.disabledGlobs ?? [],
      )
    ) {
      return Promise.resolve(new vscode.InlineCompletionList([]));
    }
    this.syncRuntimes(configuration.providers);
    const input: CompletionAlgorithmInput = { document, position, context };
    const routedProviderId = readRoutedCompletionChange(context)?.providerId;
    const providers = routedProviderId
      ? configuration.providers.filter(
          (provider) => provider.id === routedProviderId,
        )
      : configuration.providers;

    if (providers.length === 0) {
      return Promise.resolve(new vscode.InlineCompletionList([]));
    }

    return scheduleCompletionProviders(
      providers.map((provider) => ({
        provider,
        run: async (providerToken) => {
          const entry = this.runtimes.get(provider.id);
          if (!entry || !this.isRuntimeActive(provider.id, entry)) {
            return undefined;
          }
          const algorithmResult =
            await entry.algorithm.provideInlineCompletions(
              input,
              providerToken,
            );
          if (!this.isRuntimeActive(provider.id, entry)) {
            return undefined;
          }
          const route = this.routeFor(provider.id, entry);
          for (const item of algorithmResult?.items ?? []) {
            this.itemSources.set(item, route);
          }
          return algorithmResult;
        },
      })),
      routedProviderId
        ? { mode: "all", stopWhen: { type: "firstUsable", graceMs: 0 } }
        : configuration.strategy,
      token,
      {
        onMissingMainProvider: (providerId) => {
          this.notifier.warn(
            `main-provider:${providerId}`,
            providerId
              ? t(
                  "Main completion provider \"{0}\" does not exist; using the default strategy.",
                  providerId,
                )
              : t(
                  "The main completion provider is not configured; using the default strategy.",
                ),
          );
        },
        onProviderError: (providerId, error) => {
          authLog.error(
            `completion:${providerId}`,
            "Completion provider request failed",
            error,
          );
        },
        onDiscardedItems: (_providerId, items, reason) => {
          const itemsByRoute = new Map<
            RuntimeRoute,
            vscode.InlineCompletionItem[]
          >();
          for (const item of items) {
            const route = this.itemSources.get(item);
            if (!route || !this.isRouteActive(route)) {
              this.itemSources.delete(item);
              continue;
            }
            const routeItems = itemsByRoute.get(route) ?? [];
            routeItems.push(item);
            itemsByRoute.set(route, routeItems);
            this.itemSources.delete(item);
          }
          for (const [route, routeItems] of itemsByRoute) {
            route.entry.algorithm.handleDiscardedCompletionItems?.(
              routeItems,
              reason,
            );
          }
        },
      },
    ).then((items) => {
      const list = new vscode.InlineCompletionList(items);
      const sources = new Set<RuntimeRoute>();
      const itemsBySource = new Map<
        RuntimeRoute,
        vscode.InlineCompletionItem[]
      >();
      for (const item of items) {
        const source = this.itemSources.get(item);
        if (source && this.isRouteActive(source)) {
          sources.add(source);
          const sourceItems = itemsBySource.get(source) ?? [];
          sourceItems.push(item);
          itemsBySource.set(source, sourceItems);
        }
      }
      for (const [source, sourceItems] of itemsBySource) {
        source.entry.algorithm.trackCompletionList?.(list, sourceItems);
      }
      this.listSources.set(list, [...sources]);
      return list;
    });
  }

  handleDidShowCompletionItem(
    item: vscode.InlineCompletionItem,
    updatedInsertText: string,
  ): void {
    const route = this.itemSources.get(item);
    if (!route || !this.isRouteActive(route)) {
      this.itemSources.delete(item);
      return;
    }
    route.entry.algorithm.handleDidShowCompletionItem?.(
      item,
      updatedInsertText,
    );
  }

  handleDidPartiallyAcceptCompletionItem(
    item: vscode.InlineCompletionItem,
    info: vscode.PartialAcceptInfo | number,
  ): void {
    const route = this.itemSources.get(item);
    if (!route || !this.isRouteActive(route)) {
      this.itemSources.delete(item);
      return;
    }
    route.entry.algorithm.handleDidPartiallyAcceptCompletionItem?.(item, info);
  }

  handleEndOfLifetime(
    item: vscode.InlineCompletionItem,
    reason: vscode.InlineCompletionEndOfLifeReason,
  ): void {
    const route = this.itemSources.get(item);
    if (route && this.isRouteActive(route)) {
      route.entry.algorithm.handleEndOfLifetime?.(item, reason);
    }
    this.itemSources.delete(item);
  }

  handleListEndOfLifetime(
    list: vscode.InlineCompletionList,
    reason: vscode.InlineCompletionsDisposeReason,
  ): void {
    for (const route of this.listSources.get(list) ?? []) {
      if (this.isRouteActive(route)) {
        route.entry.algorithm.handleListEndOfLifetime?.(list, reason);
      }
    }
    this.listSources.delete(list);
  }

  getState(): CompletionManagerState {
    const { configuration } = readCompletionConfiguration();
    const disableVSCodeBuiltinCompletion =
      configuration.strategy.disableVSCodeBuiltinCompletion !== false;
    return {
      registered: this.registration !== undefined,
      enabled: configuration.enabled,
      providerCount: configuration.providers.length,
      providerIds: configuration.providers.map((provider) => provider.id),
      excludedProviderGroups: disableVSCodeBuiltinCompletion
        ? [...VSCODE_BUILTIN_COMPLETION_GROUPS]
        : [],
      runtimeCount: this.runtimes.size,
      runtimeInstances: Object.fromEntries(
        [...this.runtimes].map(([providerId, entry]) => [
          providerId,
          entry.instanceId,
        ]),
      ),
    };
  }

  getRuntimeDebugState(providerId: string): unknown {
    return this.runtimes.get(providerId)?.algorithm.getDebugState?.();
  }

  refreshRegistration(forceRuntimes = false): void {
    if (this.disposed) {
      return;
    }
    const result = readCompletionConfiguration();
    const shouldRegister =
      result.configuration.enabled && result.configuration.providers.length > 0;
    const disableVSCodeBuiltinCompletion =
      result.configuration.strategy.disableVSCodeBuiltinCompletion !== false;
    this.syncRuntimes(
      result.configuration.enabled ? result.configuration.providers : [],
      forceRuntimes,
    );

    if (
      this.registration &&
      (!shouldRegister ||
        this.registeredDisableVSCodeBuiltinCompletion !==
          disableVSCodeBuiltinCompletion)
    ) {
      this.registration.dispose();
      this.registration = undefined;
      this.registeredDisableVSCodeBuiltinCompletion = undefined;
    }

    if (shouldRegister && !this.registration) {
      this.registration = vscode.languages.registerInlineCompletionItemProvider(
        INLINE_COMPLETION_SELECTOR,
        this,
        createInlineCompletionMetadata(disableVSCodeBuiltinCompletion),
      );
      this.registeredDisableVSCodeBuiltinCompletion =
        disableVSCodeBuiltinCompletion;
    }

    if (result.configuration.enabled) {
      this.reportConfigurationIssues(result.issues);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.registration?.dispose();
    this.registration = undefined;
    this.registeredDisableVSCodeBuiltinCompletion = undefined;
    this.configurationSubscription.dispose();
    this.chatModelsSubscription.dispose();
    this.disposeAllRuntimes();
    this.changeEmitter.dispose();
  }

  private reportConfigurationIssues(
    issues: readonly CompletionConfigurationIssue[],
  ): void {
    for (const issue of issues) {
      this.notifier.warn(
        `configuration:${stableSerialize(issue)}`,
        formatConfigurationIssue(issue),
      );
    }
  }

  private syncRuntimes(
    providers: readonly CompletionAlgorithmEntry[],
    force = false,
  ): void {
    const activeIds = new Set(providers.map((provider) => provider.id));
    for (const [providerId, entry] of this.runtimes) {
      if (force || !activeIds.has(providerId)) {
        this.disposeRuntime(providerId, entry);
      }
    }

    for (const provider of providers) {
      const definition = this.algorithms.get(provider.algorithm);
      if (!definition) {
        this.notifier.warn(
          `algorithm:${provider.algorithm}`,
          t(
            "Completion provider \"{0}\" uses an unavailable algorithm.",
            provider.id,
          ),
        );
        continue;
      }
      const normalizedOptions = definition.normalizeOptions(provider.options);
      if (!normalizedOptions.ok) {
        this.notifier.warn(
          `options:${provider.id}:${normalizedOptions.error}`,
          t(
            "Completion provider \"{0}\" is misconfigured: {1}",
            provider.id,
            normalizedOptions.error,
          ),
        );
        const current = this.runtimes.get(provider.id);
        if (current) {
          this.disposeRuntime(provider.id, current);
        }
        continue;
      }
      const modelFingerprints = (
        definition.getModelReferences?.(normalizedOptions.value) ?? []
      ).map((reference) => ({
        reference,
        fingerprint:
          this.modelResolver.getConfigurationFingerprint?.(reference) ??
          stableSerialize(reference),
      }));
      const optionsKey = stableSerialize(normalizedOptions.value);
      const runtimeIdentity = definition.getRuntimeIdentity
        ? definition.getRuntimeIdentity(normalizedOptions.value)
        : normalizedOptions.value;
      const key = `${provider.algorithm}:${stableSerialize({
        options: runtimeIdentity,
        models: modelFingerprints,
      })}`;
      const current = this.runtimes.get(provider.id);
      if (current?.key === key) {
        if (current.optionsKey === optionsKey) {
          continue;
        }
        if (current.algorithm.updateOptions?.(normalizedOptions.value)) {
          current.optionsKey = optionsKey;
          continue;
        }
      }
      if (current) {
        this.disposeRuntime(provider.id, current);
      }
      const algorithm = definition.create({
        entry: provider,
        options: normalizedOptions.value,
        modelResolver: this.modelResolver,
        reportConfigurationError: (errorKey, message) => {
          this.notifier.warn(`provider:${provider.id}:${errorKey}`, message);
        },
        reportRuntimeError: (source, message, error) => {
          authLog.error(
            `completion:${provider.id}:${source}`,
            message,
            error,
          );
        },
      });
      const instanceId = this.nextRuntimeInstanceId++;
      const entry: RuntimeEntry = {
        key,
        optionsKey,
        usesLanguageModels: modelFingerprints.length > 0,
        instanceId,
        generation: instanceId,
        active: true,
        algorithm,
      };
      this.runtimes.set(provider.id, entry);
      entry.changeSubscription = algorithm.onDidChange?.((change) => {
        if (!this.isRuntimeActive(provider.id, entry)) {
          return;
        }
        const data = createRoutedCompletionChange(provider.id, change);
        this.changeEmitter.fire({ data });
      });
    }
  }

  private disposeRuntime(providerId: string, entry: RuntimeEntry): void {
    entry.active = false;
    entry.changeSubscription?.dispose();
    try {
      entry.algorithm.dispose?.();
    } catch (error) {
      authLog.error(
        `completion:${providerId}`,
        "Completion runtime disposal failed",
        error,
      );
    }
    if (this.runtimes.get(providerId) === entry) {
      this.runtimes.delete(providerId);
    }
  }

  private notifyEnvironmentChange(
    reason: "provider-changed" | "settings-changed",
  ): void {
    if (this.disposed) return;
    for (const [providerId, entry] of this.runtimes) {
      if (!this.isRuntimeActive(providerId, entry)) {
        continue;
      }
      try {
        entry.algorithm.handleEnvironmentChange?.(reason);
      } catch (error) {
        authLog.error(
          `completion:${providerId}`,
          "Completion runtime environment refresh failed",
          error,
        );
      }
    }
  }

  private routeFor(providerId: string, entry: RuntimeEntry): RuntimeRoute {
    return {
      providerId,
      generation: entry.generation,
      entry,
    };
  }

  private isRuntimeActive(providerId: string, entry: RuntimeEntry): boolean {
    return (
      !this.disposed && entry.active && this.runtimes.get(providerId) === entry
    );
  }

  private isRouteActive(route: RuntimeRoute): boolean {
    return (
      route.entry.generation === route.generation &&
      this.isRuntimeActive(route.providerId, route.entry)
    );
  }

  private disposeAllRuntimes(): void {
    for (const [providerId, entry] of [...this.runtimes]) {
      this.disposeRuntime(providerId, entry);
    }
  }

  private invalidateLanguageModelRuntimes(): void {
    if (this.disposed) return;
    for (const [providerId, entry] of [...this.runtimes]) {
      if (!entry.usesLanguageModels) {
        continue;
      }
      const handleCatalogChange =
        entry.algorithm.handleDidChangeChatModels?.bind(entry.algorithm);
      if (handleCatalogChange) {
        try {
          handleCatalogChange();
          continue;
        } catch (error) {
          authLog.error(
            `completion:${providerId}`,
            "Completion runtime model-catalog refresh failed",
            error,
          );
        }
      }
      this.disposeRuntime(providerId, entry);
    }
    this.refreshRegistration();
  }
}
