import type * as vscode from "vscode";
import { LinkedCancellationTokenSource } from "./cancellation";
import { DEFAULT_COMPLETION_STRATEGY } from "./configuration";
import type {
  CompletionAlgorithmResult,
  CompletionAlgorithmEntry,
  CompletionStrategy,
} from "./types";

const DEFAULT_MAIN_FIRST_TIMEOUT_MS = 500;

export interface CompletionScheduleRequest {
  provider: CompletionAlgorithmEntry;
  run(
    token: vscode.CancellationToken,
  ): Promise<CompletionAlgorithmResult | undefined>;
}

export interface CompletionSchedulerCallbacks {
  onMissingMainProvider?(providerId: string): void;
  onProviderError?(providerId: string, error: unknown): void;
  onDiscardedItems?(
    providerId: string,
    items: readonly vscode.InlineCompletionItem[],
    reason: "lost-race" | "not-taken" | "duplicate",
  ): void;
}

interface SettledResult {
  providerId: string;
  result?: CompletionAlgorithmResult;
}

function getInsertText(item: vscode.InlineCompletionItem): string {
  const insertText: unknown = Reflect.get(item, "insertText");
  if (typeof insertText === "string") return insertText;
  if (typeof insertText !== "object" || insertText === null) return "";
  const value = Reflect.get(insertText, "value");
  return typeof value === "string" ? value : "";
}

function getRangeKey(range: vscode.Range | undefined): string {
  if (!range) {
    return "";
  }
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(":");
}

function getUriKey(item: vscode.InlineCompletionItem): string {
  return item.uri?.toString() ?? "";
}

export function mergeCompletionItems(
  results: readonly CompletionAlgorithmResult[],
): vscode.InlineCompletionItem[] {
  const items: vscode.InlineCompletionItem[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    for (const item of result.items) {
      const key = [
        getUriKey(item),
        getInsertText(item),
        getRangeKey(item.range),
      ].join("\u0000");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(item);
    }
  }

  return items;
}

function cloneDefaultStrategy(): CompletionStrategy {
  return {
    mode: DEFAULT_COMPLETION_STRATEGY.mode,
    disableVSCodeBuiltinCompletion:
      DEFAULT_COMPLETION_STRATEGY.disableVSCodeBuiltinCompletion,
    stopWhen: { ...DEFAULT_COMPLETION_STRATEGY.stopWhen },
  };
}

function resolveStrategy(
  requests: readonly CompletionScheduleRequest[],
  strategy: CompletionStrategy,
  callbacks: CompletionSchedulerCallbacks,
): CompletionStrategy {
  if (strategy.mode !== "main-first") {
    return strategy;
  }
  const mainProvider = strategy.mainProvider;
  if (
    !mainProvider ||
    !requests.some((request) => request.provider.id === mainProvider)
  ) {
    callbacks.onMissingMainProvider?.(mainProvider ?? "");
    return cloneDefaultStrategy();
  }
  return strategy;
}

function createStateWaiter(): {
  notify(): void;
  wait(timeoutMs?: number): Promise<void>;
} {
  let resolveWaiter: (() => void) | undefined;

  return {
    notify(): void {
      resolveWaiter?.();
      resolveWaiter = undefined;
    },
    wait(timeoutMs?: number): Promise<void> {
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (timer) {
            clearTimeout(timer);
          }
          if (resolveWaiter === finish) {
            resolveWaiter = undefined;
          }
          resolve();
        };
        resolveWaiter = finish;
        if (timeoutMs !== undefined) {
          timer = setTimeout(finish, Math.max(0, timeoutMs));
        }
      });
    },
  };
}

function millisecondsUntil(deadlines: readonly number[]): number | undefined {
  if (deadlines.length === 0) {
    return undefined;
  }
  return Math.max(0, Math.min(...deadlines) - Date.now());
}

export async function scheduleCompletionProviders(
  requests: readonly CompletionScheduleRequest[],
  configuredStrategy: CompletionStrategy,
  parentToken: vscode.CancellationToken,
  callbacks: CompletionSchedulerCallbacks = {},
): Promise<vscode.InlineCompletionItem[]> {
  if (requests.length === 0 || parentToken.isCancellationRequested) {
    return [];
  }

  const strategy = resolveStrategy(requests, configuredStrategy, callbacks);
  const startedAt = Date.now();
  const stateWaiter = createStateWaiter();
  const sources = new Map<string, LinkedCancellationTokenSource>();
  const settledProviderIds = new Set<string>();
  const settledResults: SettledResult[] = [];
  let startedCount = 0;
  let graceDeadline: number | undefined;
  let returned = false;

  const parentSubscription = parentToken.onCancellationRequested(() => {
    stateWaiter.notify();
  });

  const startRequest = (request: CompletionScheduleRequest): void => {
    if (sources.has(request.provider.id)) {
      return;
    }
    const source = new LinkedCancellationTokenSource(parentToken);
    sources.set(request.provider.id, source);
    startedCount += 1;

    void Promise.resolve()
      .then(() => request.run(source.token))
      .then((result) => {
        if (returned && result?.items.length) {
          callbacks.onDiscardedItems?.(
            request.provider.id,
            result.items,
            "lost-race",
          );
        } else {
          settledResults.push({ providerId: request.provider.id, result });
        }
      })
      .catch((error: unknown) => {
        if (!source.token.isCancellationRequested) {
          callbacks.onProviderError?.(request.provider.id, error);
        }
        settledResults.push({ providerId: request.provider.id });
      })
      .finally(() => {
        settledProviderIds.add(request.provider.id);
        source.dispose();
        stateWaiter.notify();
      });
  };

  const startAll = (): void => {
    for (const request of requests) {
      startRequest(request);
    }
  };

  const getUsableResults = (mainOnly: boolean): CompletionAlgorithmResult[] =>
    settledResults
      .filter(
        (entry) =>
          entry.result &&
          entry.result.items.length > 0 &&
          (!mainOnly || entry.providerId === strategy.mainProvider),
      )
      .map((entry) => entry.result)
      .filter(
        (result): result is CompletionAlgorithmResult => result !== undefined,
      );

  const cancelOutstanding = (): void => {
    for (const [providerId, source] of sources) {
      if (!settledProviderIds.has(providerId)) {
        source.cancel();
      }
    }
  };

  const finish = (
    usableResults: readonly CompletionAlgorithmResult[],
  ): vscode.InlineCompletionItem[] => {
    returned = true;
    cancelOutstanding();
    const mergedItems = mergeCompletionItems(usableResults);
    const selectedItems = new Set(mergedItems);
    const usable = new Set(usableResults);
    for (const settled of settledResults) {
      const result = settled.result;
      if (!result || result.items.length === 0) {
        continue;
      }
      if (!usable.has(result)) {
        callbacks.onDiscardedItems?.(
          settled.providerId,
          result.items,
          "not-taken",
        );
        continue;
      }
      const duplicates = result.items.filter(
        (item) => !selectedItems.has(item),
      );
      if (duplicates.length > 0) {
        callbacks.onDiscardedItems?.(
          settled.providerId,
          duplicates,
          "duplicate",
        );
      }
    }
    return mergedItems;
  };

  const mainRequest =
    strategy.mode === "main-first"
      ? requests.find(
          (request) => request.provider.id === strategy.mainProvider,
        )
      : undefined;
  const parallelMainFirst =
    strategy.mode === "main-first" && (strategy.parallelRequestOthers ?? false);
  const mainFirstDeadline =
    strategy.mode === "main-first"
      ? startedAt +
        (strategy.mainFirstTimeoutMs ?? DEFAULT_MAIN_FIRST_TIMEOUT_MS)
      : undefined;

  if (mainRequest && !parallelMainFirst) {
    startRequest(mainRequest);
  } else {
    startAll();
  }

  try {
    while (true) {
      if (parentToken.isCancellationRequested) {
        return finish([]);
      }

      const now = Date.now();
      const mainProviderId = strategy.mainProvider;
      const mainSettled =
        mainProviderId !== undefined && settledProviderIds.has(mainProviderId);
      const mainResultUsable = getUsableResults(true).length > 0;

      if (parallelMainFirst && mainSettled && mainResultUsable) {
        return finish(getUsableResults(true));
      }

      if (mainRequest && !parallelMainFirst && startedCount === 1) {
        if (mainSettled && mainResultUsable) {
          return finish(getUsableResults(true));
        }
        if (
          strategy.stopWhen.type === "deadline" &&
          now >= startedAt + strategy.stopWhen.timeoutMs
        ) {
          return finish(getUsableResults(true));
        }
        if (
          mainSettled ||
          (mainFirstDeadline !== undefined && now >= mainFirstDeadline)
        ) {
          for (const request of requests) {
            if (request.provider.id !== mainRequest.provider.id) {
              startRequest(request);
            }
          }
        } else {
          const mainWaitDeadlines =
            mainFirstDeadline === undefined ? [] : [mainFirstDeadline];
          if (strategy.stopWhen.type === "deadline") {
            mainWaitDeadlines.push(startedAt + strategy.stopWhen.timeoutMs);
          }
          await stateWaiter.wait(millisecondsUntil(mainWaitDeadlines));
          continue;
        }
      }

      const mainGateOpen =
        !parallelMainFirst ||
        mainSettled ||
        mainFirstDeadline === undefined ||
        now >= mainFirstDeadline;
      const usableResults = getUsableResults(
        parallelMainFirst && !mainGateOpen,
      );
      const items = mergeCompletionItems(usableResults);

      switch (strategy.stopWhen.type) {
        case "firstUsable":
          if (items.length > 0) {
            const graceMs = strategy.stopWhen.graceMs ?? 0;
            graceDeadline ??= now + graceMs;
            if (now >= graceDeadline) {
              return finish(usableResults);
            }
          }
          break;
        case "enoughResults":
          if (items.length >= strategy.stopWhen.minItems) {
            const graceMs = strategy.stopWhen.graceMs ?? 0;
            graceDeadline ??= now + graceMs;
            if (now >= graceDeadline) {
              return finish(usableResults);
            }
          }
          break;
        case "deadline":
          if (now >= startedAt + strategy.stopWhen.timeoutMs) {
            return finish(usableResults);
          }
          break;
        case "allSettled":
          if (
            startedCount === requests.length &&
            settledProviderIds.size === requests.length &&
            mainGateOpen
          ) {
            return finish(getUsableResults(false));
          }
          break;
      }

      if (
        startedCount === requests.length &&
        settledProviderIds.size === requests.length &&
        mainGateOpen
      ) {
        return finish(getUsableResults(false));
      }

      const deadlines: number[] = [];
      if (graceDeadline !== undefined) {
        deadlines.push(graceDeadline);
      }
      if (
        strategy.stopWhen.type === "deadline" &&
        startedAt + strategy.stopWhen.timeoutMs > now
      ) {
        deadlines.push(startedAt + strategy.stopWhen.timeoutMs);
      }
      if (
        parallelMainFirst &&
        mainFirstDeadline !== undefined &&
        mainFirstDeadline > now
      ) {
        deadlines.push(mainFirstDeadline);
      }

      await stateWaiter.wait(millisecondsUntil(deadlines));
    }
  } finally {
    parentSubscription.dispose();
    if (!returned) {
      cancelOutstanding();
    }
    for (const source of sources.values()) {
      source.dispose();
    }
  }
}
