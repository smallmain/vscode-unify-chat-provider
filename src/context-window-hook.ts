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
 *    Detect `InFlightChatRequest` objects to know the current `requestId`.
 */

import * as vscode from 'vscode';
import type { ProviderUsage } from './logger';

// ---------- Type stubs for VS Code internals ----------

type HandleProgressChunkFn = (
  requestId: string,
  chunks: unknown[],
) => Promise<void>;

// ---------- Module-level state ----------

/** The raw (unpatched) RPC stub for $handleProgressChunk. */
let originalHandleProgressChunk: HandleProgressChunkFn | null = null;

/** The RPC proxy object whose $handleProgressChunk we patch. */
let proxyTarget: Record<string, unknown> | null = null;

/** requestId → true for currently in-flight chat agent requests. */
const inFlightRequestIds = new Map<string, true>();

/**
 * requestId → real usage for requests that went through our model.
 * Cleaned up when the in-flight request is removed.
 */
const pendingUsage = new Map<
  string,
  { promptTokens: number; completionTokens: number }
>();

let initialized = false;

// ---------- 1. Proxy capture via Map.prototype.set ----------

async function captureProxy(): Promise<boolean> {
  const originalMapSet = Map.prototype.set;
  const probeId = `_ucp_probe_${Date.now()}`;
  let found = false;

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
        proxyTarget = candidate;
        originalHandleProgressChunk =
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

  return found;
}

// ---------- 2. Proxy interception ----------

/**
 * Replace the cached `$handleProgressChunk` stub on the proxy object.
 * Every subsequent call — including Copilot's batched stream calls —
 * will go through our wrapper, which replaces `{kind:'usage'}` chunks
 * for requests we served with the real token counts.
 */
function patchProxy(): void {
  if (!proxyTarget || !originalHandleProgressChunk) return;

  const original = originalHandleProgressChunk;

  proxyTarget.$handleProgressChunk = function (
    requestId: string,
    chunks: unknown[],
  ): Promise<void> {
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
    return original.call(proxyTarget, requestId, chunks);
  };
}

// ---------- 3. In-flight request tracking ----------

function installRequestTracking(): void {
  const originalAdd = Set.prototype.add;
  const originalDelete = Set.prototype.delete;

  Set.prototype.add = function (this: Set<unknown>, value: unknown) {
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      if (typeof v.requestId === 'string' && 'extRequest' in v) {
        inFlightRequestIds.set(v.requestId, true);
      }
    }
    return originalAdd.call(this, value);
  };

  Set.prototype.delete = function (
    this: Set<unknown>,
    value: unknown,
  ): boolean {
    if (typeof value === 'object' && value !== null) {
      const v = value as Record<string, unknown>;
      if (typeof v.requestId === 'string' && 'extRequest' in v) {
        inFlightRequestIds.delete(v.requestId);
        pendingUsage.delete(v.requestId);
      }
    }
    return originalDelete.call(this, value);
  };
}

// ---------- Usage normalisation ----------

export function normalizeUsage(
  usage: ProviderUsage,
): { promptTokens: number; completionTokens: number } | null {
  try {
    // Anthropic
    if (
      'input_tokens' in usage &&
      'output_tokens' in usage &&
      !('total_tokens' in usage) &&
      !('promptTokenCount' in usage)
    ) {
      const u = usage as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      return {
        promptTokens:
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0),
        completionTokens: u.output_tokens ?? 0,
      };
    }
    // OpenAI
    if ('prompt_tokens' in usage && 'completion_tokens' in usage) {
      const u = usage as {
        prompt_tokens: number;
        completion_tokens: number;
      };
      return {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
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

  // Find the current in-flight requestId.
  let requestId: string | null = null;
  for (const id of inFlightRequestIds.keys()) {
    requestId = id;
  }
  if (!requestId) {
    return false;
  }

  // Store for the proxy interceptor.
  pendingUsage.set(requestId, normalized);

  // Also send a direct injection (goes through our patched proxy).
  // This handles the case where Copilot never calls stream.usage().
  const usageChunk = {
    kind: 'usage' as const,
    promptTokens: normalized.promptTokens,
    completionTokens: normalized.completionTokens,
  };

  // Fire-and-forget; the patched proxy ensures correct values.
  (proxyTarget.$handleProgressChunk as HandleProgressChunkFn)(
    requestId,
    [usageChunk],
  ).catch(() => {
    // silently ignore
  });

  return true;
}

/**
 * Initialize the context window hook.
 * Should be called early in extension activation.
 */
export async function initializeContextWindowHook(): Promise<boolean> {
  if (initialized) return proxyTarget !== null;
  initialized = true;

  // 1. Track in-flight requests (must be first).
  installRequestTracking();

  // 2. Capture the MainThreadChatAgents2 proxy.
  const ok = await captureProxy();

  // 3. Patch the proxy to intercept usage chunks.
  if (ok) {
    patchProxy();
    console.log(
      '[ContextWindowHook] Proxy captured and patched successfully',
    );
  } else {
    console.log(
      '[ContextWindowHook] Failed to capture proxy — usage injection disabled',
    );
  }

  return ok;
}
