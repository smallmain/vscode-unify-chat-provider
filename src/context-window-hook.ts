/**
 * Context Window Hook - Inject usage data into VS Code's context window widget
 *
 * Problem:
 * VS Code's `LanguageModelChatProvider` API does NOT include any mechanism to
 * report token usage data. When Copilot Chat uses a third-party model from this
 * extension, it gets response text but no usage data, so the indicator always
 * shows "ModelName · 0".
 *
 * Root cause:
 * Even when we inject usage via `$handleProgressChunk`, Copilot's agent handler
 * later sends its OWN `stream.usage({0, 0})` call, which overwrites our values.
 *
 * Solution — three-part hook:
 *
 * 1. **Proxy capture** (`Map.prototype.set` patch):
 *    Temporarily patch Map.set, create a disposable chat participant, and
 *    intercept `_agents.set(handle, agent)` to grab `agent._proxy` — the RPC
 *    proxy to `MainThreadChatAgents2`.
 *
 * 2. **Proxy interception** (monkey-patch `proxy.$handleProgressChunk`):
 *    Replace the cached RPC stub on the proxy. For any request that went
 *    through our model provider, replace all `{kind:'usage'}` chunks with our
 *    real token counts. This neutralises Copilot's later `usage(0)` call.
 *
 * 3. **Request tracking** (`Set.prototype.add/delete` patches):
 *    Detect `InFlightChatRequest` objects so we can clean up request-bound
 *    state when VS Code retires an internal request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as vscode from 'vscode';
import {
  CONFIG_NAMESPACE,
  DEFAULT_FIX001_CONTEXT_INDICATOR_DISPLAY,
  FIX001_CONTEXT_INDICATOR_DISPLAY_CONFIG_KEY,
} from './config-store';
import type { ProviderUsage } from './logger';

// ---------- Type stubs for VS Code internals ----------

type HandleProgressChunkFn = (
  requestId: string,
  chunks: unknown[],
) => Promise<void>;

type CapturedProxy = {
  proxyTarget: Record<string, unknown>;
  originalHandleProgressChunk: HandleProgressChunkFn;
};

type SetAddFn = typeof Set.prototype.add;
type SetDeleteFn = typeof Set.prototype.delete;

// ---------- Module-level state ----------

/** The raw (unpatched) RPC stub for $handleProgressChunk. */
let originalHandleProgressChunk: HandleProgressChunkFn | null = null;

/** The RPC proxy object whose $handleProgressChunk we patch. */
let proxyTarget: Record<string, unknown> | null = null;

/** requestId → true for currently in-flight chat agent requests. */
const inFlightRequestIds = new Map<string, true>();

/** Local request logger ID → VS Code internal requestId. */
const localToVsCodeRequestIds = new Map<string, string>();

/** VS Code internal requestId → local request logger ID. */
const vsCodeToLocalRequestIds = new Map<string, string>();

/**
 * requestId → real usage for requests that went through our model.
 * Cleaned up when the in-flight request is removed.
 */
const pendingUsage = new Map<
  string,
  { promptTokens: number; completionTokens: number }
>();

/**
 * Local request logger ID → usage reported before we have observed a progress
 * chunk and therefore before we know the VS Code internal requestId.
 */
const pendingUsageByLocalRequestId = new Map<
  string,
  { promptTokens: number; completionTokens: number }
>();

const requestContextStorage = new AsyncLocalStorage<string>();
const queuedProgressLocalRequestIds: string[] = [];
const queuedProgressLocalRequestIdSet = new Set<string>();

let patchedHandleProgressChunk: HandleProgressChunkFn | null = null;
let originalSetAdd: SetAddFn | null = null;
let originalSetDelete: SetDeleteFn | null = null;
let patchedSetAdd: SetAddFn | null = null;
let patchedSetDelete: SetDeleteFn | null = null;
let requestTrackingInstalled = false;
let hookInstalled = false;
let initializationGeneration = 0;

function isContextIndicatorDisplayFixEnabled(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const inspection = config.inspect<unknown>(
    FIX001_CONTEXT_INDICATOR_DISPLAY_CONFIG_KEY,
  );
  const enabled = inspection?.globalValue;
  return typeof enabled === 'boolean'
    ? enabled
    : DEFAULT_FIX001_CONTEXT_INDICATOR_DISPLAY;
}

function createUsageChunk(usage: {
  promptTokens: number;
  completionTokens: number;
}): {
  kind: 'usage';
  promptTokens: number;
  completionTokens: number;
} {
  return {
    kind: 'usage',
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
}

function queueProgressBinding(localRequestId: string): void {
  if (
    localToVsCodeRequestIds.has(localRequestId) ||
    queuedProgressLocalRequestIdSet.has(localRequestId)
  ) {
    return;
  }

  queuedProgressLocalRequestIds.push(localRequestId);
  queuedProgressLocalRequestIdSet.add(localRequestId);
}

function discardQueuedProgressBinding(localRequestId: string): void {
  queuedProgressLocalRequestIdSet.delete(localRequestId);
}

function takeQueuedProgressBinding(): string | undefined {
  while (queuedProgressLocalRequestIds.length > 0) {
    const localRequestId = queuedProgressLocalRequestIds.shift();
    if (!localRequestId) {
      continue;
    }
    if (!queuedProgressLocalRequestIdSet.delete(localRequestId)) {
      continue;
    }
    if (!localToVsCodeRequestIds.has(localRequestId)) {
      return localRequestId;
    }
  }

  return undefined;
}

function injectUsageChunk(
  requestId: string,
  usage: { promptTokens: number; completionTokens: number },
): void {
  if (!proxyTarget || !originalHandleProgressChunk) {
    return;
  }

  originalHandleProgressChunk
    .call(proxyTarget, requestId, [createUsageChunk(usage)])
    .catch(() => {
      // silently ignore
    });
}

function bindLocalRequestToVsCodeRequest(
  localRequestId: string,
  requestId: string,
): void {
  discardQueuedProgressBinding(localRequestId);

  const previousRequestId = localToVsCodeRequestIds.get(localRequestId);
  if (previousRequestId && previousRequestId !== requestId) {
    vsCodeToLocalRequestIds.delete(previousRequestId);
    pendingUsage.delete(previousRequestId);
  }

  const previousLocalRequestId = vsCodeToLocalRequestIds.get(requestId);
  if (previousLocalRequestId && previousLocalRequestId !== localRequestId) {
    localToVsCodeRequestIds.delete(previousLocalRequestId);
    pendingUsageByLocalRequestId.delete(previousLocalRequestId);
  }

  localToVsCodeRequestIds.set(localRequestId, requestId);
  vsCodeToLocalRequestIds.set(requestId, localRequestId);

  const pendingLocalUsage = pendingUsageByLocalRequestId.get(localRequestId);
  if (pendingLocalUsage) {
    pendingUsage.set(requestId, pendingLocalUsage);
    pendingUsageByLocalRequestId.delete(localRequestId);
    injectUsageChunk(requestId, pendingLocalUsage);
  }
}

function cleanupVsCodeRequest(requestId: string): void {
  inFlightRequestIds.delete(requestId);
  pendingUsage.delete(requestId);

  const localRequestId = vsCodeToLocalRequestIds.get(requestId);
  if (!localRequestId) {
    return;
  }

  vsCodeToLocalRequestIds.delete(requestId);
  const mappedRequestId = localToVsCodeRequestIds.get(localRequestId);
  if (mappedRequestId === requestId) {
    localToVsCodeRequestIds.delete(localRequestId);
  }
}

// ---------- 1. Proxy capture via Map.prototype.set ----------

async function captureProxy(): Promise<CapturedProxy | null> {
  const originalMapSet = Map.prototype.set;
  const probeId = `_ucp_probe_${Date.now()}`;
  let found = false;
  let capturedProxyTarget: Record<string, unknown> | null = null;
  let capturedHandleProgressChunk: HandleProgressChunkFn | null = null;

  Map.prototype.set = function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    if (!found && typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      const candidate = v._proxy as Record<string, unknown> | undefined;
      if (
        candidate &&
        typeof candidate.$handleProgressChunk === 'function' &&
        (v.id === probeId || v.label === probeId || v.name === probeId)
      ) {
        capturedProxyTarget = candidate;
        capturedHandleProgressChunk =
          candidate.$handleProgressChunk as HandleProgressChunkFn;
        found = true;
      }
    }
    return originalMapSet.call(this, key, value);
  };

  let temp: vscode.ChatParticipant | undefined;
  try {
    temp = vscode.chat.createChatParticipant(probeId, () => Promise.resolve());
    // Some host implementations may defer internal chat registration.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } catch {
    // silently abort
  } finally {
    if (temp) {
      temp.dispose();
    }
    Map.prototype.set = originalMapSet;
  }

  if (!found || !capturedProxyTarget || !capturedHandleProgressChunk) {
    return null;
  }

  return {
    proxyTarget: capturedProxyTarget,
    originalHandleProgressChunk: capturedHandleProgressChunk,
  };
}

// ---------- 2. Proxy interception ----------

/**
 * Replace the cached `$handleProgressChunk` stub on the proxy object.
 * Every subsequent call — including Copilot's batched stream calls —
 * will go through our wrapper, which replaces `{kind:'usage'}` chunks
 * for requests we served with the real token counts.
 */
function patchProxy(captured: CapturedProxy): void {
  if (hookInstalled) {
    return;
  }

  const target = captured.proxyTarget;
  const original = captured.originalHandleProgressChunk;
  const patched: HandleProgressChunkFn = function (
    requestId: string,
    chunks: unknown[],
  ): Promise<void> {
    let localRequestId = requestContextStorage.getStore();
    if (!localRequestId && !vsCodeToLocalRequestIds.has(requestId)) {
      localRequestId = takeQueuedProgressBinding();
    }
    if (localRequestId) {
      bindLocalRequestToVsCodeRequest(localRequestId, requestId);
    }

    const stored = pendingUsage.get(requestId);
    if (stored) {
      for (let i = 0; i < chunks.length; i++) {
        const raw = chunks[i];
        const chunk = (
          Array.isArray(raw) ? raw[0] : raw
        ) as Record<string, unknown> | undefined;
        if (chunk && chunk.kind === 'usage') {
          chunk.promptTokens = stored.promptTokens;
          chunk.completionTokens = stored.completionTokens;
        }
      }
    }
    return original.call(target, requestId, chunks);
  };

  proxyTarget = target;
  originalHandleProgressChunk = original;
  patchedHandleProgressChunk = patched;
  target.$handleProgressChunk = patched;
  hookInstalled = true;
}

function unpatchProxy(): void {
  if (
    proxyTarget &&
    originalHandleProgressChunk &&
    patchedHandleProgressChunk &&
    proxyTarget.$handleProgressChunk === patchedHandleProgressChunk
  ) {
    proxyTarget.$handleProgressChunk = originalHandleProgressChunk;
  }

  patchedHandleProgressChunk = null;
  originalHandleProgressChunk = null;
  proxyTarget = null;
  hookInstalled = false;
}

// ---------- 3. In-flight request tracking ----------

function installRequestTracking(): void {
  if (requestTrackingInstalled) {
    return;
  }

  const capturedOriginalAdd = Set.prototype.add;
  const capturedOriginalDelete = Set.prototype.delete;

  const nextPatchedAdd: SetAddFn = function <T>(
    this: Set<T>,
    value: T,
  ): Set<T> {
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      if (typeof v.requestId === 'string' && 'extRequest' in v) {
        inFlightRequestIds.set(v.requestId, true);
      }
    }
    return capturedOriginalAdd.call(this, value);
  };

  const nextPatchedDelete: SetDeleteFn = function <T>(
    this: Set<T>,
    value: T,
  ): boolean {
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      if (typeof v.requestId === 'string' && 'extRequest' in v) {
        cleanupVsCodeRequest(v.requestId);
      }
    }
    return capturedOriginalDelete.call(this, value);
  };

  originalSetAdd = capturedOriginalAdd;
  originalSetDelete = capturedOriginalDelete;
  patchedSetAdd = nextPatchedAdd;
  patchedSetDelete = nextPatchedDelete;
  Set.prototype.add = nextPatchedAdd;
  Set.prototype.delete = nextPatchedDelete;
  requestTrackingInstalled = true;
}

function uninstallRequestTracking(): void {
  if (patchedSetAdd && originalSetAdd && Set.prototype.add === patchedSetAdd) {
    Set.prototype.add = originalSetAdd;
  }
  if (
    patchedSetDelete &&
    originalSetDelete &&
    Set.prototype.delete === patchedSetDelete
  ) {
    Set.prototype.delete = originalSetDelete;
  }

  patchedSetAdd = null;
  patchedSetDelete = null;
  originalSetAdd = null;
  originalSetDelete = null;
  requestTrackingInstalled = false;
}

// ---------- Usage normalisation ----------

export function normalizeUsage(
  usage: ProviderUsage,
): { promptTokens: number; completionTokens: number } | null {
  try {
    // OpenAI Responses
    if (
      'input_tokens' in usage &&
      'output_tokens' in usage &&
      'input_tokens_details' in usage &&
      'total_tokens' in usage
    ) {
      return {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
      };
    }
    // Anthropic
    if (
      'input_tokens' in usage &&
      'output_tokens' in usage &&
      !('input_tokens_details' in usage) &&
      !('total_tokens' in usage) &&
      !('promptTokenCount' in usage)
    ) {
      return {
        promptTokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        completionTokens: usage.output_tokens ?? 0,
      };
    }
    // OpenAI
    if ('prompt_tokens' in usage && 'completion_tokens' in usage) {
      return {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      };
    }
    // Google
    if ('promptTokenCount' in usage) {
      const u = usage as {
        promptTokenCount: number;
        candidatesTokenCount?: number;
      };
      return {
        promptTokens: u.promptTokenCount ?? 0,
        completionTokens: u.candidatesTokenCount ?? 0,
      };
    }
    // Ollama
    if ('prompt_eval_count' in usage) {
      const u = usage as {
        prompt_eval_count: number;
        eval_count: number;
      };
      return {
        promptTokens: u.prompt_eval_count ?? 0,
        completionTokens: u.eval_count ?? 0,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

// ---------- Public API ----------

/**
 * Report usage for the current chat request.
 *
 * 1. Stores the real token counts keyed by requestId.
 * 2. Sends a direct `$handleProgressChunk` injection (which goes through
 *    our proxy patch and is guaranteed to carry correct values).
 * 3. Any later `stream.usage()` from Copilot also goes through our patch
 *    and gets its zeros replaced with our real counts.
 */
export function reportUsageToContextWindow(usage: ProviderUsage): boolean {
  const localRequestId = requestContextStorage.getStore();
  if (!localRequestId) {
    return false;
  }

  return reportUsageToContextWindowForRequest(localRequestId, usage);
}

export function reportUsageToContextWindowForRequest(
  localRequestId: string,
  usage: ProviderUsage,
): boolean {
  if (!isContextIndicatorDisplayFixEnabled()) {
    return false;
  }

  const normalized = normalizeUsage(usage);
  if (
    !normalized ||
    (normalized.promptTokens === 0 && normalized.completionTokens === 0)
  ) {
    return false;
  }

  if (!proxyTarget || !originalHandleProgressChunk) {
    return false;
  }

  const requestId = localToVsCodeRequestIds.get(localRequestId);
  if (!requestId) {
    pendingUsageByLocalRequestId.set(localRequestId, normalized);
    return false;
  }

  pendingUsage.set(requestId, normalized);
  injectUsageChunk(requestId, normalized);
  return true;
}

export function withContextWindowRequest<T>(
  localRequestId: string,
  fn: () => T,
): T {
  return requestContextStorage.run(localRequestId, fn);
}

export function reportProgressWithContextWindowRequest(
  localRequestId: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
  part: vscode.LanguageModelResponsePart2,
): void {
  queueProgressBinding(localRequestId);
  withContextWindowRequest(localRequestId, () => {
    progress.report(part);
  });
}

export function clearContextWindowRequest(localRequestId: string): void {
  discardQueuedProgressBinding(localRequestId);
  pendingUsageByLocalRequestId.delete(localRequestId);
}

export function disposeContextWindowHook(): boolean {
  const hadState =
    hookInstalled ||
    requestTrackingInstalled ||
    inFlightRequestIds.size > 0 ||
    pendingUsage.size > 0 ||
    pendingUsageByLocalRequestId.size > 0 ||
    localToVsCodeRequestIds.size > 0 ||
    vsCodeToLocalRequestIds.size > 0 ||
    queuedProgressLocalRequestIdSet.size > 0;

  initializationGeneration += 1;
  unpatchProxy();
  uninstallRequestTracking();
  inFlightRequestIds.clear();
  pendingUsage.clear();
  pendingUsageByLocalRequestId.clear();
  localToVsCodeRequestIds.clear();
  vsCodeToLocalRequestIds.clear();
  queuedProgressLocalRequestIds.length = 0;
  queuedProgressLocalRequestIdSet.clear();

  return hadState;
}

/**
 * Initialize the context window hook.
 * Should be called early in extension activation.
 */
export async function initializeContextWindowHook(): Promise<boolean> {
  if (!isContextIndicatorDisplayFixEnabled()) {
    return false;
  }

  if (hookInstalled) {
    return true;
  }

  const generation = ++initializationGeneration;

  // 1. Track in-flight requests (must be first).
  installRequestTracking();

  // 2. Capture the MainThreadChatAgents2 proxy.
  const captured = await captureProxy();

  if (
    generation !== initializationGeneration ||
    !isContextIndicatorDisplayFixEnabled()
  ) {
    return false;
  }

  // 3. Patch the proxy to intercept usage chunks.
  if (captured) {
    patchProxy(captured);
    console.log(
      '[ContextWindowHook] Proxy captured and patched successfully',
    );
  } else {
    uninstallRequestTracking();
    inFlightRequestIds.clear();
    pendingUsage.clear();
    console.log(
      '[ContextWindowHook] Failed to capture proxy — usage injection disabled',
    );
  }

  return captured !== null;
}
