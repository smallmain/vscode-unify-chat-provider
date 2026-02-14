import { createAuthProvider } from '../auth';
import type { AuthTokenInfo } from '../auth/types';
import {
  balanceManager,
  createBalanceProvider,
  type BalanceProviderState,
} from '../balance';
import { ConfigStore } from '../config-store';
import { deepClone, stableStringify } from '../config-ops';
import { t } from '../i18n';
import { type SecretStore } from '../secret';
import type { ProviderConfig } from '../types';
import {
  ensureDraftSessionId,
  normalizeProviderDraft,
  type ProviderFormDraft,
} from './form-utils';

const DRAFT_AUTO_REFRESH_INTERVAL_MS = 60_000;
const DRAFT_SESSION_TTL_MS = 15 * 60_000;

type DraftBalanceSession = {
  signature: string;
  state: BalanceProviderState;
  lastAccessAt: number;
};

const draftBalanceSessions = new Map<string, DraftBalanceSession>();

function resolveDraftProviderConfig(
  draft: ProviderFormDraft,
): ProviderConfig | undefined {
  try {
    return normalizeProviderDraft(draft);
  } catch {
    return undefined;
  }
}

function canReuseSavedBalanceState(
  savedProvider: ProviderConfig,
  draftProvider: ProviderConfig | undefined,
): boolean {
  if (!draftProvider) {
    return false;
  }

  return (
    savedProvider.type === draftProvider.type &&
    savedProvider.baseUrl === draftProvider.baseUrl &&
    stableStringify(savedProvider.auth) === stableStringify(draftProvider.auth) &&
    stableStringify(savedProvider.balanceProvider) ===
      stableStringify(draftProvider.balanceProvider)
  );
}

function buildDraftBalanceSignature(draft: ProviderFormDraft): string {
  return stableStringify({
    type: draft.type ?? '',
    baseUrl: draft.baseUrl ?? '',
    auth: draft.auth,
    balanceProvider: draft.balanceProvider,
  });
}

function pruneDraftBalanceSessions(now: number): void {
  for (const [sessionId, session] of draftBalanceSessions) {
    if (now - session.lastAccessAt > DRAFT_SESSION_TTL_MS) {
      draftBalanceSessions.delete(sessionId);
    }
  }
}

function ensureDraftBalanceSession(
  sessionId: string,
  signature: string,
): DraftBalanceSession {
  const now = Date.now();
  pruneDraftBalanceSessions(now);

  const existing = draftBalanceSessions.get(sessionId);
  if (existing && existing.signature === signature) {
    existing.lastAccessAt = now;
    return existing;
  }

  const next: DraftBalanceSession = {
    signature,
    state: {
      isRefreshing: false,
      pendingTrailing: false,
    },
    lastAccessAt: now,
  };
  draftBalanceSessions.set(sessionId, next);
  return next;
}

function shouldAutoRefreshDraftState(state: BalanceProviderState): boolean {
  if (state.isRefreshing) {
    return false;
  }

  if (!state.snapshot && !state.lastError) {
    return true;
  }

  if (state.lastAttemptAt === undefined) {
    return true;
  }

  return Date.now() - state.lastAttemptAt >= DRAFT_AUTO_REFRESH_INTERVAL_MS;
}

function toAuthTokenInfo(
  credential: { value: string; tokenType?: string; expiresAt?: number } | undefined,
): AuthTokenInfo {
  if (!credential?.value) {
    return { kind: 'none' };
  }

  return {
    kind: 'token',
    token: credential.value,
    tokenType: credential.tokenType,
    expiresAt: credential.expiresAt,
  };
}

async function resolveDraftCredential(options: {
  draft: ProviderFormDraft;
  secretStore: SecretStore;
  originalName?: string;
}): Promise<AuthTokenInfo | undefined> {
  const auth = options.draft.auth;
  if (!auth || auth.method === 'none') {
    return { kind: 'none' };
  }

  const providerLabel =
    options.draft.name?.trim() || options.originalName || t('Provider');
  const providerId = options.originalName ?? ensureDraftSessionId(options.draft);

  const authProvider = createAuthProvider(
    {
      providerId,
      providerLabel,
      secretStore: options.secretStore,
    },
    deepClone(auth),
  );

  if (!authProvider) {
    return undefined;
  }

  try {
    const credential = await authProvider.getCredential();
    return toAuthTokenInfo(credential);
  } finally {
    authProvider.dispose?.();
  }
}

async function refreshDraftBalanceState(options: {
  state: BalanceProviderState;
  balanceProvider: NonNullable<ReturnType<typeof createBalanceProvider>>;
  draftProvider: ProviderConfig | undefined;
  draft: ProviderFormDraft;
  secretStore: SecretStore;
  originalName?: string;
}): Promise<void> {
  const state = options.state;
  const provider = options.draftProvider;

  if (!provider) {
    state.lastAttemptAt = Date.now();
    state.lastError = t('Please configure Name, API Format, and API Base URL first.');
    return;
  }

  state.isRefreshing = true;
  state.lastAttemptAt = Date.now();

  try {
    const credential = await resolveDraftCredential({
      draft: options.draft,
      secretStore: options.secretStore,
      originalName: options.originalName,
    });
    const result = await options.balanceProvider.refresh({
      provider,
      credential,
    });

    if (result.success && result.snapshot) {
      state.snapshot = result.snapshot;
      state.lastError = undefined;
      state.lastRefreshAt = Date.now();
      return;
    }

    state.lastError = result.error ?? t('Balance refresh failed.');
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    state.isRefreshing = false;
  }
}

export async function resolveBalanceFieldDetail(options: {
  draft: ProviderFormDraft;
  store: ConfigStore;
  secretStore: SecretStore;
  originalName?: string;
}): Promise<string | undefined> {
  const balanceProviderConfig = options.draft.balanceProvider;
  if (!balanceProviderConfig || balanceProviderConfig.method === 'none') {
    return undefined;
  }

  const providerName = options.draft.name?.trim();
  const savedProvider = providerName
    ? options.store.getProvider(providerName)
    : undefined;
  const draftProvider = resolveDraftProviderConfig(options.draft);

  if (
    savedProvider &&
    canReuseSavedBalanceState(savedProvider, draftProvider)
  ) {
    const state = balanceManager.getProviderState(savedProvider.name);
    if (!state?.snapshot && !state?.lastError && !state?.isRefreshing) {
      await balanceManager.forceRefresh(savedProvider.name);
    }
    return balanceManager.getProviderFieldDetail(savedProvider);
  }

  const draftSessionId = ensureDraftSessionId(options.draft);
  const providerLabel =
    options.draft.name?.trim() || options.originalName || t('Provider');
  const providerId = options.originalName ?? draftSessionId;

  const balanceProvider = createBalanceProvider(
    {
      providerId,
      providerLabel,
      secretStore: options.secretStore,
      authManager: undefined,
      storeSecretsInSettings: options.store.storeApiKeyInSettings,
      persistBalanceConfig: async () => {},
    },
    deepClone(balanceProviderConfig),
  );

  if (!balanceProvider?.getFieldDetail) {
    balanceProvider?.dispose?.();
    return t('Not refreshed yet');
  }

  try {
    const signature = buildDraftBalanceSignature(options.draft);
    const session = ensureDraftBalanceSession(draftSessionId, signature);

    if (shouldAutoRefreshDraftState(session.state)) {
      await refreshDraftBalanceState({
        state: session.state,
        balanceProvider,
        draftProvider,
        draft: options.draft,
        secretStore: options.secretStore,
        originalName: options.originalName,
      });
    }

    return await balanceProvider.getFieldDetail(session.state);
  } finally {
    balanceProvider.dispose?.();
  }
}
