import * as vscode from 'vscode';
import {
  createSecretRef,
  isLegacySecretRef,
  isSecretRef,
  isSessionSecretRef,
  extractUuidFromRef,
  buildApiKeyStorageKey,
  buildOAuth2TokenStorageKey,
  buildOAuth2ClientSecretStorageKey,
  SECRET_STORAGE_PREFIX,
  SECRET_KEY_PREFIXES,
  DEVICE_STATE_STORAGE_PREFIX,
  ORPHAN_SECRET_RETENTION_MS,
  buildRefFromUuid,
  extractUuidFromStorageKey,
} from './constants';
import type { OAuth2TokenData } from '../auth/types';
import type {
  AuthContext,
  SessionAuthConfig,
  SessionAuthMethod,
  SessionAuthRuntimeConfig,
} from '../auth/types';
import {
  buildLocalAuthRef,
  computeStaticAuthFingerprint,
  createAuthBindingId,
  deriveLegacyAuthBindingId,
  extractBindingIdFromLocalAuthRef,
  isValidAuthBindingId,
  LOCAL_AUTH_STATE_KEY_PREFIX,
  localAuthStateDeviceKey,
  MAX_LOCAL_AUTH_SNAPSHOTS,
  parseLocalAuthStateEnvelopeJson,
  parseOAuth2TokenData,
  stripSessionAuthState,
  stableAuthStateStringify,
  type AuthBindingDescriptor,
  type LocalAuthSessionSnapshotV1,
  type LocalAuthStateEnvelopeV1,
} from '../auth/local-auth-state';
import { authLog } from '../logger';
import { randomUUID } from 'node:crypto';

/**
 * API key storage status
 */
export type ApiKeyStorageStatus =
  | { kind: 'unset' }
  | { kind: 'plain'; apiKey: string }
  | { kind: 'secret'; ref: string; apiKey: string }
  | { kind: 'missing-secret'; ref: string };

export type LocalAuthStateChangeReason =
  | 'login'
  | 'refresh'
  | 'context'
  | 'logout'
  | 'import'
  | 'migration';

export interface LocalAuthStateChange {
  providerName: string;
  bindingId: string;
  method: SessionAuthMethod;
  revision: number;
  reason: LocalAuthStateChangeReason;
}

interface LocalAuthTarget {
  bindingId: string;
  fingerprint: string;
}

interface PersistSessionAuthOptions {
  reason: LocalAuthStateChangeReason;
  emptyToken: 'clear' | 'preserve';
  binding: 'existing-or-random' | 'legacy-deterministic';
  guard?: LocalAuthCommitGuard;
  assertSourceCurrent?: () => void;
}

export interface LocalAuthSessionTransaction {
  readonly auth: SessionAuthConfig;
  commit(): void;
  rollback(): Promise<void>;
}

interface SessionAuthPersistenceOutcome {
  auth: SessionAuthConfig;
  bindingId: string;
  previous?: LocalAuthStateEnvelopeV1;
  committedRevision?: number;
  change?: LocalAuthStateChange;
}

export interface LocalAuthCommitGuard {
  staticConfigFingerprint: string;
  epoch: number;
  sessionId?: string;
  revision: number;
}

export const LOCAL_AUTH_STATE_CONFLICT_MESSAGE =
  'Authentication state changed while this operation was in progress. Please try again.';

export class LocalAuthStateConflictError extends Error {
  constructor() {
    super(LOCAL_AUTH_STATE_CONFLICT_MESSAGE);
    this.name = 'LocalAuthStateConflictError';
  }
}

export function isLocalAuthStateConflictError(
  value: unknown,
): value is Error {
  return (
    value instanceof Error &&
    value.message === LOCAL_AUTH_STATE_CONFLICT_MESSAGE
  );
}

export interface ActiveLocalAuthFingerprint {
  providerName: string;
  bindingId: string;
  method: SessionAuthMethod;
  fingerprint: string;
}

export interface LegacyOAuth2TokenCandidate {
  ref: string;
  token: OAuth2TokenData;
}

export interface LegacyOAuth2ClientSecretCandidate {
  ref: string;
  secret: string;
}

/**
 * Unified secret storage for all extension secrets.
 * Handles API keys, OAuth2 tokens, and OAuth2 client secrets.
 */
export class SecretStore {
  private readonly authStates = new Map<string, LocalAuthStateEnvelopeV1>();
  private readonly localRefTargets = new Map<string, LocalAuthTarget>();
  private readonly tokenAliases = new Map<string, LocalAuthTarget>();
  private readonly clientSecretAliases = new Map<string, LocalAuthTarget>();
  private readonly transientOAuth2Tokens = new Map<
    string,
    OAuth2TokenData | null
  >();
  private readonly transientOAuth2ClientSecrets = new Map<
    string,
    string | null
  >();
  private readonly pendingTokens = new Map<string, OAuth2TokenData | null>();
  private readonly pendingClientSecrets = new Map<string, string | null>();
  private readonly authWriteTails = new Map<string, Promise<void>>();
  private readonly authRevisionFloors = new Map<string, number>();
  private authStatesInitialized = false;
  private readonly authStateEmitter = new vscode.EventEmitter<LocalAuthStateChange>();
  readonly onDidChangeLocalAuthState = this.authStateEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async initializeLocalAuthState(): Promise<void> {
    if (this.authStatesInitialized) return;
    const keys = await this.getAllKeys();
    const storagePrefix = `${DEVICE_STATE_STORAGE_PREFIX}${LOCAL_AUTH_STATE_KEY_PREFIX}`;
    for (const key of keys) {
      if (!key.startsWith(storagePrefix)) continue;
      const bindingId = key.slice(storagePrefix.length);
      if (!isValidAuthBindingId(bindingId)) continue;
      const raw = await this.getDeviceState(localAuthStateDeviceKey(bindingId));
      if (!raw) continue;
      const envelope = parseLocalAuthStateEnvelopeJson(raw);
      if (!envelope || envelope.bindingId !== bindingId) {
        authLog.warn('secret-store', `Ignoring invalid local auth state for ${bindingId}`);
        continue;
      }
      if (envelope.revision < this.getAuthRevisionFloor(bindingId)) continue;
      this.authStates.set(bindingId, envelope);
      this.rememberAuthRevision(bindingId, envelope.revision);
    }
    this.authStatesInitialized = true;
  }

  private async ensureLocalAuthStateInitialized(): Promise<void> {
    if (!this.authStatesInitialized) {
      await this.initializeLocalAuthState();
    }
  }

  async reloadLocalAuthState(bindingId: string): Promise<void> {
    if (!isValidAuthBindingId(bindingId)) return;
    await this.ensureLocalAuthStateInitialized();
    await this.enqueueAuthWrite(bindingId, async () => {
      const raw = await this.getDeviceState(localAuthStateDeviceKey(bindingId));
      if (!raw) {
        this.removeCachedAuthEnvelope(bindingId);
        return;
      }
      const envelope = parseLocalAuthStateEnvelopeJson(raw);
      if (envelope?.bindingId === bindingId) {
        const revisionFloor = this.getAuthRevisionFloor(bindingId);
        if (envelope.revision < revisionFloor) {
          if (
            (this.authStates.get(bindingId)?.revision ?? 0) < revisionFloor
          ) {
            this.removeCachedAuthEnvelope(bindingId);
          }
          return;
        }
        this.authStates.set(bindingId, envelope);
        this.rememberAuthRevision(bindingId, envelope.revision);
        return;
      }
      this.removeCachedAuthEnvelope(bindingId);
      authLog.warn('secret-store', `Ignoring invalid local auth state for ${bindingId}`);
    });
  }

  private getAuthRevisionFloor(bindingId: string): number {
    return Math.max(
      this.authRevisionFloors.get(bindingId) ?? 0,
      this.authStates.get(bindingId)?.revision ?? 0,
    );
  }

  private rememberAuthRevision(bindingId: string, revision: number): void {
    const current = this.authRevisionFloors.get(bindingId) ?? 0;
    if (revision > current) this.authRevisionFloors.set(bindingId, revision);
  }

  private async refreshAuthRevisionFloor(bindingId: string): Promise<number> {
    const raw = await this.getDeviceState(localAuthStateDeviceKey(bindingId));
    const envelope = raw ? parseLocalAuthStateEnvelopeJson(raw) : null;
    if (envelope?.bindingId === bindingId) {
      const current = this.authStates.get(bindingId);
      if (!current || envelope.revision > current.revision) {
        this.authStates.set(bindingId, envelope);
      }
      this.rememberAuthRevision(bindingId, envelope.revision);
    } else if (raw) {
      authLog.warn(
        'secret-store',
        `Ignoring invalid local auth state for ${bindingId}`,
      );
    }
    return this.getAuthRevisionFloor(bindingId);
  }

  private removeCachedAuthEnvelope(bindingId: string): void {
    const envelope = this.authStates.get(bindingId);
    if (envelope) this.rememberAuthRevision(bindingId, envelope.revision);
    this.authStates.delete(bindingId);
  }

  private clearCachedAuthReferences(bindingId: string): void {
    for (const [ref, target] of this.localRefTargets) {
      if (target.bindingId === bindingId) this.localRefTargets.delete(ref);
    }
    for (const [ref, target] of this.tokenAliases) {
      if (target.bindingId === bindingId) this.tokenAliases.delete(ref);
    }
    for (const [ref, target] of this.clientSecretAliases) {
      if (target.bindingId === bindingId) this.clientSecretAliases.delete(ref);
    }
    for (const pendingKey of this.pendingTokens.keys()) {
      if (pendingKey.startsWith(`${bindingId}:`)) {
        this.pendingTokens.delete(pendingKey);
      }
    }
    for (const pendingKey of this.pendingClientSecrets.keys()) {
      if (pendingKey.startsWith(`${bindingId}:`)) {
        this.pendingClientSecrets.delete(pendingKey);
      }
    }
  }

  private targetKey(target: LocalAuthTarget): string {
    return `${target.bindingId}:${target.fingerprint}`;
  }

  private snapshotForTarget(
    target: LocalAuthTarget,
  ): LocalAuthSessionSnapshotV1 | undefined {
    return this.authStates
      .get(target.bindingId)
      ?.snapshots.find(
        (snapshot) => snapshot.staticConfigFingerprint === target.fingerprint,
      );
  }

  private resolveTokenTarget(ref: string): LocalAuthTarget | undefined {
    return this.localRefTargets.get(ref) ?? this.tokenAliases.get(ref);
  }

  private resolveClientSecretTarget(ref: string): LocalAuthTarget | undefined {
    return this.localRefTargets.get(ref) ?? this.clientSecretAliases.get(ref);
  }

  private replaceAlias(
    aliases: Map<string, LocalAuthTarget>,
    ref: string,
    target: LocalAuthTarget,
  ): void {
    const targetKey = this.targetKey(target);
    for (const [existingRef, existingTarget] of aliases) {
      if (
        existingRef !== ref &&
        this.targetKey(existingTarget) === targetKey
      ) {
        aliases.delete(existingRef);
      }
    }
    aliases.set(ref, target);
  }

  private registerLocalTarget(target: LocalAuthTarget): string {
    const ref = buildLocalAuthRef(target.bindingId, target.fingerprint);
    this.localRefTargets.set(ref, target);
    return ref;
  }

  private ensureBinding(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
    mode: PersistSessionAuthOptions['binding'],
  ): SessionAuthRuntimeConfig {
    const bindingId = isValidAuthBindingId(auth.bindingId)
      ? auth.bindingId
      : mode === 'legacy-deterministic'
        ? deriveLegacyAuthBindingId(descriptor, auth)
        : createAuthBindingId();
    return { ...auth, bindingId };
  }

  hydrateSessionAuth(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ): SessionAuthRuntimeConfig {
    const bound = this.ensureBinding(descriptor, auth, 'legacy-deterministic');
    const fingerprint = computeStaticAuthFingerprint(descriptor, bound);
    const target = { bindingId: bound.bindingId, fingerprint };
    const targetKey = this.targetKey(target);
    const snapshot = this.snapshotForTarget(target);
    const ref = this.registerLocalTarget(target);
    const tokenRef = bound.token?.trim();
    const clientSecretRef =
      bound.method === 'oauth2' && bound.oauth.grantType !== 'device_code'
        ? bound.oauth.clientSecret?.trim()
        : undefined;
    const hasPendingRuntime =
      this.pendingTokens.has(targetKey) ||
      this.pendingClientSecrets.has(targetKey) ||
      (tokenRef !== undefined && this.transientOAuth2Tokens.has(tokenRef)) ||
      (clientSecretRef !== undefined &&
        this.transientOAuth2ClientSecrets.has(clientSecretRef));
    if (hasPendingRuntime) return bound;

    const base = stripSessionAuthState(bound);
    if (!snapshot) return base;

    const identityId = snapshot.sessionId;
    const token = snapshot.token ? ref : undefined;
    const context = snapshot.authContext;
    switch (base.method) {
      case 'oauth2': {
        const oauth = (() => {
          if (base.oauth.grantType === 'authorization_code') {
            return {
              ...base.oauth,
              clientSecret: snapshot.clientSecret ? ref : undefined,
            };
          }
          if (base.oauth.grantType === 'client_credentials') {
            return {
              ...base.oauth,
              clientSecret: snapshot.clientSecret ? ref : undefined,
            };
          }
          return base.oauth;
        })();
        return { ...base, identityId, token, oauth };
      }
      case 'antigravity-oauth':
        return {
          ...base,
          identityId,
          token,
          ...(context?.method === base.method
            ? {
                projectId: context.projectId,
                managedProjectId: context.managedProjectId,
                tier: context.tier,
                tierId: context.tierId,
                email: context.email,
              }
            : {}),
        };
      case 'google-gemini-oauth':
        return {
          ...base,
          identityId,
          token,
          ...(context?.method === base.method
            ? {
                projectId: context.projectId,
                managedProjectId: context.managedProjectId,
                tier: context.tier,
                tierId: context.tierId,
                email: context.email,
              }
            : {}),
        };
      case 'openai-codex':
        return {
          ...base,
          identityId,
          token,
          ...(context?.method === base.method
            ? { accountId: context.accountId, email: context.email }
            : {}),
        };
      case 'claude-code':
      case 'xai-grok-oauth':
        return {
          ...base,
          identityId,
          token,
          ...(context?.method === base.method ? { email: context.email } : {}),
        };
      case 'github-copilot':
        return { ...base, identityId, token };
      case 'zed':
        return {
          ...base,
          identityId,
          token,
          ...(context?.method === 'zed'
            ? {
                organizationId: context.organizationId,
                dataCollection: context.dataCollectionAllowed && context.dataCollection,
                dataCollectionAllowed: context.dataCollectionAllowed,
                email: context.email,
              }
            : {
                dataCollection: false,
                dataCollectionAllowed: false,
              }),
        };
    }
  }

  private authContextFromRuntime(options: {
    auth: SessionAuthRuntimeConfig;
    bindingId: string;
    sessionId: string;
    revision: number;
  }): AuthContext | undefined {
    const common = {
      bindingId: options.bindingId,
      sessionId: options.sessionId,
      revision: options.revision,
    };
    switch (options.auth.method) {
      case 'oauth2':
      case 'github-copilot':
        return { method: options.auth.method, ...common };
      case 'antigravity-oauth':
      case 'google-gemini-oauth':
        return {
          method: options.auth.method,
          ...common,
          projectId: options.auth.projectId,
          managedProjectId: options.auth.managedProjectId,
          tier: options.auth.tier,
          tierId: options.auth.tierId,
          email: options.auth.email,
        };
      case 'openai-codex':
        return {
          method: options.auth.method,
          ...common,
          accountId: options.auth.accountId,
          email: options.auth.email,
        };
      case 'claude-code':
      case 'xai-grok-oauth':
        return {
          method: options.auth.method,
          ...common,
          email: options.auth.email,
        };
      case 'zed': {
        const organizationId = options.auth.organizationId?.trim();
        if (!organizationId) return undefined;
        const dataCollectionAllowed = options.auth.dataCollectionAllowed === true;
        return {
          method: options.auth.method,
          ...common,
          organizationId,
          dataCollectionAllowed,
          dataCollection:
            dataCollectionAllowed && options.auth.dataCollection === true,
          email: options.auth.email,
        };
      }
    }
  }

  private async getLegacyOAuth2Token(ref: string): Promise<OAuth2TokenData | null> {
    if (this.transientOAuth2Tokens.has(ref)) {
      return this.transientOAuth2Tokens.get(ref) ?? null;
    }
    const key = buildOAuth2TokenStorageKey(ref);
    if (!key) return null;
    const raw = await this.secrets.get(key);
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      return parseOAuth2TokenData(value);
    } catch {
      return null;
    }
  }

  private async getLegacyOAuth2ClientSecret(ref: string): Promise<string | undefined> {
    if (this.transientOAuth2ClientSecrets.has(ref)) {
      return this.transientOAuth2ClientSecrets.get(ref) ?? undefined;
    }
    const key = buildOAuth2ClientSecretStorageKey(ref);
    return key ? await this.secrets.get(key) : undefined;
  }

  private async resolveRuntimeToken(
    auth: SessionAuthRuntimeConfig,
    target: LocalAuthTarget,
  ): Promise<{
    token: OAuth2TokenData | undefined;
    transientRef?: string;
    importedRef?: string;
    explicit: boolean;
  }> {
    const raw = auth.token?.trim();
    if (!raw) return { token: undefined, explicit: false };
    if (this.transientOAuth2Tokens.has(raw)) {
      return {
        token: this.transientOAuth2Tokens.get(raw) ?? undefined,
        transientRef: raw,
        explicit: true,
      };
    }
    const resolvedTarget = this.resolveTokenTarget(raw);
    if (resolvedTarget) {
      if (this.targetKey(resolvedTarget) !== this.targetKey(target)) {
        if (isLegacySecretRef(raw)) {
          return {
            token: (await this.getLegacyOAuth2Token(raw)) ?? undefined,
            importedRef: raw,
            explicit: true,
          };
        }
        return { token: undefined, explicit: false };
      }
      const pending = this.pendingTokens.get(this.targetKey(resolvedTarget));
      if (pending !== undefined) {
        return { token: pending ?? undefined, explicit: true };
      }
      return { token: this.snapshotForTarget(resolvedTarget)?.token, explicit: true };
    }
    if (isSessionSecretRef(raw)) {
      return {
        token: (await this.getLegacyOAuth2Token(raw)) ?? undefined,
        importedRef: raw,
        explicit: true,
      };
    }
    try {
      const value: unknown = JSON.parse(raw);
      return { token: parseOAuth2TokenData(value) ?? undefined, explicit: true };
    } catch {
      return { token: undefined, explicit: true };
    }
  }

  private async resolveRuntimeClientSecret(
    auth: SessionAuthRuntimeConfig,
    target: LocalAuthTarget,
  ): Promise<{ value: string | undefined; importedRef?: string; explicit: boolean }> {
    if (auth.method !== 'oauth2') {
      return { value: undefined, explicit: false };
    }
    const raw =
      auth.oauth.grantType === 'authorization_code'
        ? auth.oauth.clientSecret?.trim()
        : auth.oauth.grantType === 'client_credentials'
          ? auth.oauth.clientSecret?.trim()
          : undefined;
    if (!raw) return { value: undefined, explicit: false };
    const resolvedTarget = this.resolveClientSecretTarget(raw);
    if (resolvedTarget) {
      if (this.targetKey(resolvedTarget) !== this.targetKey(target)) {
        if (isLegacySecretRef(raw)) {
          return {
            value: await this.getLegacyOAuth2ClientSecret(raw),
            importedRef: raw,
            explicit: true,
          };
        }
        return { value: undefined, explicit: false };
      }
      const pending = this.pendingClientSecrets.get(this.targetKey(resolvedTarget));
      if (pending !== undefined) {
        return { value: pending ?? undefined, explicit: true };
      }
      return {
        value: this.snapshotForTarget(resolvedTarget)?.clientSecret,
        explicit: true,
      };
    }
    if (isSessionSecretRef(raw)) {
      return {
        value: await this.getLegacyOAuth2ClientSecret(raw),
        importedRef: raw,
        explicit: true,
      };
    }
    return { value: raw, explicit: true };
  }

  /**
   * Materialize a one-shot authenticated RPC intent without writing an auth
   * envelope. The returned object must never be persisted to settings.
   */
  async prepareSessionAuthCommitIntent(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ): Promise<SessionAuthRuntimeConfig> {
    await this.ensureLocalAuthStateInitialized();
    const bound = this.ensureBinding(descriptor, auth, 'existing-or-random');
    const target = {
      bindingId: bound.bindingId,
      fingerprint: computeStaticAuthFingerprint(descriptor, bound),
    };
    this.registerLocalTarget(target);
    const token = (await this.resolveRuntimeToken(bound, target)).token;
    const clientSecret = (await this.resolveRuntimeClientSecret(bound, target))
      .value;
    const materialized = {
      ...bound,
      token: token ? JSON.stringify(token) : undefined,
    };

    if (materialized.method !== 'oauth2') {
      return materialized;
    }

    switch (materialized.oauth.grantType) {
      case 'authorization_code':
        return {
          ...materialized,
          oauth: {
            ...materialized.oauth,
            clientSecret,
          },
        };
      case 'client_credentials':
        return {
          ...materialized,
          oauth: {
            ...materialized.oauth,
            clientSecret,
          },
        };
      case 'device_code':
        return materialized;
    }
  }

  clearPendingSessionAuth(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ): void {
    const bound = this.ensureBinding(descriptor, auth, 'existing-or-random');
    const target = {
      bindingId: bound.bindingId,
      fingerprint: computeStaticAuthFingerprint(descriptor, bound),
    };
    this.pendingTokens.delete(this.targetKey(target));
    this.pendingClientSecrets.delete(this.targetKey(target));
    const tokenRef = auth.token?.trim();
    if (tokenRef && isSessionSecretRef(tokenRef)) {
      this.replaceAlias(this.tokenAliases, tokenRef, target);
      this.transientOAuth2Tokens.delete(tokenRef);
    }
    if (auth.method === 'oauth2') {
      const clientSecretRef =
        auth.oauth.grantType === 'device_code'
          ? undefined
          : auth.oauth.clientSecret?.trim();
      if (clientSecretRef && isSessionSecretRef(clientSecretRef)) {
        this.replaceAlias(this.clientSecretAliases, clientSecretRef, target);
        this.transientOAuth2ClientSecrets.delete(clientSecretRef);
      }
    }
  }

  discardPendingSessionAuth(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ): void {
    const bound = this.ensureBinding(descriptor, auth, 'existing-or-random');
    const target = {
      bindingId: bound.bindingId,
      fingerprint: computeStaticAuthFingerprint(descriptor, bound),
    };
    this.pendingTokens.delete(this.targetKey(target));
    this.pendingClientSecrets.delete(this.targetKey(target));
    const tokenRef = auth.token?.trim();
    if (tokenRef) this.transientOAuth2Tokens.delete(tokenRef);
    if (auth.method === 'oauth2' && auth.oauth.grantType !== 'device_code') {
      const clientSecretRef = auth.oauth.clientSecret?.trim();
      if (clientSecretRef) {
        this.transientOAuth2ClientSecrets.delete(clientSecretRef);
      }
    }
  }

  discardDraftSessionAuth(
    auth: SessionAuthRuntimeConfig,
    preserve?: SessionAuthRuntimeConfig,
  ): void {
    const preserveRefs = new Set<string>();
    const preservedTokenRef = preserve?.token?.trim();
    if (preservedTokenRef) preserveRefs.add(preservedTokenRef);
    if (
      preserve?.method === 'oauth2' &&
      preserve.oauth.grantType !== 'device_code'
    ) {
      const preservedClientSecretRef = preserve.oauth.clientSecret?.trim();
      if (preservedClientSecretRef) preserveRefs.add(preservedClientSecretRef);
    }

    for (const key of this.pendingTokens.keys()) {
      if (key.startsWith(`${auth.bindingId}:`)) this.pendingTokens.delete(key);
    }
    for (const key of this.pendingClientSecrets.keys()) {
      if (key.startsWith(`${auth.bindingId}:`)) {
        this.pendingClientSecrets.delete(key);
      }
    }

    const tokenRef = auth.token?.trim();
    if (tokenRef && !preserveRefs.has(tokenRef)) {
      this.transientOAuth2Tokens.delete(tokenRef);
    }
    if (auth.method === 'oauth2' && auth.oauth.grantType !== 'device_code') {
      const clientSecretRef = auth.oauth.clientSecret?.trim();
      if (clientSecretRef && !preserveRefs.has(clientSecretRef)) {
        this.transientOAuth2ClientSecrets.delete(clientSecretRef);
      }
    }
  }

  private enqueueAuthWrite<T>(bindingId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.authWriteTails.get(bindingId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.authWriteTails.set(bindingId, tail);
    void tail.finally(() => {
      if (this.authWriteTails.get(bindingId) === tail) {
        this.authWriteTails.delete(bindingId);
      }
    });
    return result;
  }

  private rewriteContextRevisions(
    envelope: LocalAuthStateEnvelopeV1,
  ): LocalAuthStateEnvelopeV1 {
    return {
      ...envelope,
      snapshots: envelope.snapshots.map((snapshot) => ({
        ...snapshot,
        ...(snapshot.authContext
          ? {
              authContext: {
                ...snapshot.authContext,
                revision: envelope.revision,
              },
            }
          : {}),
      })),
    };
  }

  private cloneAuthEnvelope(
    envelope: LocalAuthStateEnvelopeV1,
  ): LocalAuthStateEnvelopeV1 {
    return {
      ...envelope,
      snapshots: envelope.snapshots.map((snapshot) => ({
        ...snapshot,
        ...(snapshot.token ? { token: { ...snapshot.token } } : {}),
        ...(snapshot.authContext
          ? { authContext: { ...snapshot.authContext } }
          : {}),
      })),
    };
  }

  private createAuthTombstone(
    bindingId: string,
    revision: number,
  ): LocalAuthStateEnvelopeV1 {
    return {
      version: 1,
      bindingId,
      revision,
      snapshots: [],
    };
  }

  private async writeAuthEnvelope(
    envelope: LocalAuthStateEnvelopeV1,
  ): Promise<void> {
    const raw = JSON.stringify(envelope);
    try {
      await this.setDeviceState(
        localAuthStateDeviceKey(envelope.bindingId),
        raw,
      );
    } catch (error) {
      // SecretStorage implementations may throw after the value was written.
      // Treat a verified write as committed so callers never roll forward on
      // restart after being told that the operation failed.
      const stored = await this.getDeviceState(
        localAuthStateDeviceKey(envelope.bindingId),
      );
      if (stored !== raw) throw error;
    }
  }

  private async storeAuthEnvelope(
    envelope: LocalAuthStateEnvelopeV1,
    assertSourceCurrent?: () => void,
  ): Promise<void> {
    const normalized = this.rewriteContextRevisions(envelope);
    const revisionFloor = await this.refreshAuthRevisionFloor(
      normalized.bindingId,
    );
    const previous = this.authStates.get(normalized.bindingId);
    if (normalized.revision < revisionFloor) {
      throw new LocalAuthStateConflictError();
    }
    await this.writeAuthEnvelope(normalized);
    try {
      assertSourceCurrent?.();
    } catch (error) {
      const rollbackRevision = normalized.revision + 1;
      const restored = this.rewriteContextRevisions(
        previous
          ? { ...previous, revision: rollbackRevision }
          : this.createAuthTombstone(
              normalized.bindingId,
              rollbackRevision,
            ),
      );
      await this.writeAuthEnvelope(restored);
      this.authStates.set(normalized.bindingId, restored);
      this.rememberAuthRevision(normalized.bindingId, rollbackRevision);
      throw error;
    }
    this.authStates.set(normalized.bindingId, normalized);
    this.rememberAuthRevision(normalized.bindingId, normalized.revision);
  }

  async persistSessionAuth(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
    options: PersistSessionAuthOptions,
  ): Promise<SessionAuthConfig> {
    const outcome = await this.persistSessionAuthWithOutcome(
      descriptor,
      auth,
      options,
    );
    if (outcome.change) this.authStateEmitter.fire(outcome.change);
    return outcome.auth;
  }

  async prepareSessionAuthTransaction(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
    options: PersistSessionAuthOptions,
  ): Promise<LocalAuthSessionTransaction> {
    const outcome = await this.persistSessionAuthWithOutcome(
      descriptor,
      auth,
      options,
    );
    let settled = false;
    return {
      auth: outcome.auth,
      commit: () => {
        if (settled) return;
        settled = true;
        if (
          outcome.change &&
          this.authStates.get(outcome.bindingId)?.revision ===
            outcome.committedRevision
        ) {
          this.authStateEmitter.fire(outcome.change);
        }
      },
      rollback: async () => {
        if (settled) return;
        try {
          if (outcome.committedRevision !== undefined) {
            await this.rollbackSessionAuthTransaction(
              descriptor,
              auth,
              outcome.previous,
              outcome.committedRevision,
            );
          }
        } finally {
          settled = true;
        }
      },
    };
  }

  private async persistSessionAuthWithOutcome(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
    options: PersistSessionAuthOptions,
  ): Promise<SessionAuthPersistenceOutcome> {
    await this.ensureLocalAuthStateInitialized();
    const bound = this.ensureBinding(descriptor, auth, options.binding);
    const fingerprint = computeStaticAuthFingerprint(descriptor, bound);
    const target = { bindingId: bound.bindingId, fingerprint };
    this.registerLocalTarget(target);

    return await this.enqueueAuthWrite(bound.bindingId, async () => {
      options.assertSourceCurrent?.();
      await this.refreshAuthRevisionFloor(bound.bindingId);
      const existingEnvelope = this.authStates.get(bound.bindingId);
      const previous = existingEnvelope
        ? this.cloneAuthEnvelope(existingEnvelope)
        : undefined;
      const existingSnapshot = existingEnvelope?.snapshots.find(
        (snapshot) => snapshot.staticConfigFingerprint === fingerprint,
      );
      const tokenResult = await this.resolveRuntimeToken(bound, target);
      const clientSecretResult = await this.resolveRuntimeClientSecret(bound, target);
      const token = tokenResult.explicit
        ? tokenResult.token
        : options.emptyToken === 'preserve'
          ? existingSnapshot?.token
          : undefined;
      const clientSecret = clientSecretResult.explicit
        ? clientSecretResult.value
        : existingSnapshot?.clientSecret;
      const tokenIsNewLogin =
        token !== undefined &&
        tokenResult.explicit &&
        (!existingSnapshot?.token ||
          (bound.identityId !== undefined &&
            bound.identityId.trim() !== '' &&
            bound.identityId !== existingSnapshot.sessionId) ||
          (tokenResult.importedRef !== undefined &&
            tokenResult.importedRef !==
              buildLocalAuthRef(bound.bindingId, fingerprint)));
      const guard = options.guard;
      const envelopeRevision = this.getAuthRevisionFloor(bound.bindingId);
      const matchingGuardSnapshot =
        guard?.staticConfigFingerprint === fingerprint;
      if (
        guard &&
        (guard.revision !== envelopeRevision ||
          (matchingGuardSnapshot &&
            (guard.epoch !== (existingSnapshot?.epoch ?? 0) ||
              guard.sessionId !== existingSnapshot?.sessionId)))
      ) {
        throw new LocalAuthStateConflictError();
      }
      const requestedSessionId = bound.identityId?.trim();
      const sessionId = token
        ? tokenIsNewLogin
          ? requestedSessionId || randomUUID()
          : requestedSessionId || existingSnapshot?.sessionId || randomUUID()
        : undefined;
      const revision = envelopeRevision + 1;
      const now = Math.max(Date.now(), existingSnapshot?.updatedAt ?? 0);
      const epoch = tokenIsNewLogin
        ? (existingSnapshot?.epoch ?? 0) + 1
        : existingSnapshot?.epoch ?? (token ? 1 : 0);
      const authContext =
        token && sessionId
          ? !tokenResult.explicit &&
            options.emptyToken === 'preserve' &&
            existingSnapshot?.authContext
            ? { ...existingSnapshot.authContext, revision }
            : this.authContextFromRuntime({
                auth: bound,
                bindingId: bound.bindingId,
                sessionId,
                revision,
              })
          : undefined;
      const nextSnapshot: LocalAuthSessionSnapshotV1 = {
        method: bound.method,
        staticConfigFingerprint: fingerprint,
        epoch,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(token === undefined ? {} : { token }),
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(authContext === undefined ? {} : { authContext }),
        createdAt: existingSnapshot?.createdAt ?? now,
        updatedAt: now,
      };
      const priorSnapshots =
        options.emptyToken === 'clear' && token === undefined
          ? []
          : existingEnvelope?.snapshots
              .filter(
                (snapshot) =>
                  snapshot.staticConfigFingerprint !== fingerprint,
              )
              .map((snapshot) => ({
                ...snapshot,
                orphanedAt:
                  snapshot.orphanedAt ?? Math.max(now, snapshot.updatedAt),
              }))
              .filter(
                (snapshot) =>
                  now - snapshot.orphanedAt < ORPHAN_SECRET_RETENTION_MS,
              ) ?? [];
      const nextEnvelope: LocalAuthStateEnvelopeV1 = {
        version: 1,
        bindingId: bound.bindingId,
        revision,
        snapshots: [nextSnapshot, ...priorSnapshots].slice(
          0,
          MAX_LOCAL_AUTH_SNAPSHOTS,
        ),
      };
      const currentComparable = existingEnvelope
        ? stableAuthStateStringify({
            ...existingEnvelope,
            revision: 0,
            snapshots: existingEnvelope.snapshots.map((snapshot) => ({
              ...snapshot,
              updatedAt: 0,
              authContext: snapshot.authContext
                ? { ...snapshot.authContext, revision: 0 }
                : undefined,
            })),
          })
        : undefined;
      const nextComparable = stableAuthStateStringify({
        ...nextEnvelope,
        revision: 0,
        snapshots: nextEnvelope.snapshots.map((snapshot) => ({
          ...snapshot,
          updatedAt: 0,
          authContext: snapshot.authContext
            ? { ...snapshot.authContext, revision: 0 }
            : undefined,
        })),
      });
      let change: LocalAuthStateChange | undefined;
      let committedRevision: number | undefined;
      if (currentComparable !== nextComparable) {
        const comparableContext = (context: AuthContext | undefined): string =>
          stableAuthStateStringify(
            context ? { ...context, revision: 0 } : undefined,
          );
        const effectiveReason: LocalAuthStateChangeReason = (() => {
          if (options.reason === 'migration' || options.reason === 'import') {
            return options.reason;
          }
          if (!existingSnapshot?.token && token) return 'login';
          if (existingSnapshot?.token && !token) return 'logout';
          if (
            comparableContext(existingSnapshot?.authContext) !==
            comparableContext(authContext)
          ) {
            return 'context';
          }
          if (
            stableAuthStateStringify(existingSnapshot?.token) !==
            stableAuthStateStringify(token)
          ) {
            return 'refresh';
          }
          return options.reason;
        })();
        options.assertSourceCurrent?.();
        await this.storeAuthEnvelope(
          nextEnvelope,
          options.assertSourceCurrent,
        );
        committedRevision = revision;
        change = {
          providerName: descriptor.providerName,
          bindingId: bound.bindingId,
          method: bound.method,
          revision,
          reason: effectiveReason,
        };
      }
      this.pendingTokens.delete(this.targetKey(target));
      this.pendingClientSecrets.delete(this.targetKey(target));
      if (tokenResult.importedRef) {
        this.replaceAlias(this.tokenAliases, tokenResult.importedRef, target);
        this.transientOAuth2Tokens.delete(tokenResult.importedRef);
      }
      if (tokenResult.transientRef) {
        this.replaceAlias(this.tokenAliases, tokenResult.transientRef, target);
        this.transientOAuth2Tokens.delete(tokenResult.transientRef);
      }
      if (clientSecretResult.importedRef) {
        this.replaceAlias(
          this.clientSecretAliases,
          clientSecretResult.importedRef,
          target,
        );
        this.transientOAuth2ClientSecrets.delete(
          clientSecretResult.importedRef,
        );
      }
      return {
        auth: stripSessionAuthState(bound),
        bindingId: bound.bindingId,
        ...(previous === undefined ? {} : { previous }),
        ...(committedRevision === undefined ? {} : { committedRevision }),
        ...(change === undefined ? {} : { change }),
      };
    });
  }

  async reconcileLocalAuthSnapshots(
    active: readonly ActiveLocalAuthFingerprint[],
    now = Date.now(),
    options: { pruneExpired?: boolean } = {},
  ): Promise<void> {
    await this.ensureLocalAuthStateInitialized();
    await this.refreshAuthStateForReconciliation(active);
    const activeByBinding = new Map<string, Set<string>>();
    for (const item of active) {
      const fingerprints = activeByBinding.get(item.bindingId) ?? new Set<string>();
      fingerprints.add(item.fingerprint);
      activeByBinding.set(item.bindingId, fingerprints);
    }

    const bindingIds = new Set([
      ...this.authStates.keys(),
      ...activeByBinding.keys(),
    ]);

    await Promise.all(
      Array.from(bindingIds).map(
        async (bindingId) => {
          await this.enqueueAuthWrite(bindingId, async () => {
            const envelope = this.authStates.get(bindingId);
            if (!envelope || envelope.snapshots.length === 0) return;
            const activeFingerprints = activeByBinding.get(bindingId);
            if (!activeFingerprints) {
              const latestSnapshotUpdate = envelope.snapshots.reduce(
                (latest, snapshot) => Math.max(latest, snapshot.updatedAt),
                0,
              );
              const orphanedAt =
                envelope.orphanedAt ?? Math.max(now, latestSnapshotUpdate);
              const snapshots = envelope.snapshots.map((snapshot) =>
                snapshot.orphanedAt === undefined
                  ? {
                      ...snapshot,
                      orphanedAt: Math.max(orphanedAt, snapshot.updatedAt),
                    }
                  : snapshot,
              );
              if (
                envelope.orphanedAt === undefined ||
                snapshots.some(
                  (snapshot, index) => snapshot !== envelope.snapshots[index],
                )
              ) {
                await this.storeAuthEnvelope({
                  ...envelope,
                  orphanedAt,
                  snapshots,
                });
              }
              return;
            }

            let changed = false;
            const snapshots: LocalAuthSessionSnapshotV1[] = [];
            for (const snapshot of envelope.snapshots) {
              if (activeFingerprints.has(snapshot.staticConfigFingerprint)) {
                if (snapshot.orphanedAt === undefined) {
                  snapshots.push(snapshot);
                } else {
                  const { orphanedAt: _, ...restored } = snapshot;
                  snapshots.push(restored);
                  changed = true;
                }
                continue;
              }

              const orphanedAt =
                Math.max(
                  snapshot.updatedAt,
                  snapshot.orphanedAt ?? envelope.orphanedAt ?? now,
                );
              if (
                options.pruneExpired !== false &&
                now - orphanedAt >= ORPHAN_SECRET_RETENTION_MS
              ) {
                changed = true;
                continue;
              }
              if (snapshot.orphanedAt === undefined) changed = true;
              snapshots.push({ ...snapshot, orphanedAt });
            }
            if (envelope.orphanedAt !== undefined) changed = true;
            if (changed) {
              const { orphanedAt: _, ...activeEnvelope } = envelope;
              await this.storeAuthEnvelope({ ...activeEnvelope, snapshots });
            }
          });
        },
      ),
    );
  }

  private async refreshAuthStateForReconciliation(
    active: readonly ActiveLocalAuthFingerprint[],
  ): Promise<void> {
    const storagePrefix =
      `${DEVICE_STATE_STORAGE_PREFIX}${LOCAL_AUTH_STATE_KEY_PREFIX}`;
    const bindingIds = new Set<string>([
      ...this.authStates.keys(),
      ...active.map((item) => item.bindingId),
    ]);
    for (const key of await this.getAllKeys()) {
      if (!key.startsWith(storagePrefix)) continue;
      const bindingId = key.slice(storagePrefix.length);
      if (isValidAuthBindingId(bindingId)) bindingIds.add(bindingId);
    }
    await Promise.all(
      Array.from(bindingIds, (bindingId) =>
        this.reloadLocalAuthState(bindingId),
      ),
    );
  }

  getLocalAuthContext(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ): AuthContext | undefined {
    const bound = this.ensureBinding(descriptor, auth, 'legacy-deterministic');
    const fingerprint = computeStaticAuthFingerprint(descriptor, bound);
    const context = this.snapshotForTarget({
      bindingId: bound.bindingId,
      fingerprint,
    })?.authContext;
    return context ? { ...context } : undefined;
  }

  getLocalAuthCredentialSnapshot(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ):
    | {
        token?: OAuth2TokenData;
        clientSecret?: string;
        authContext?: AuthContext;
        sessionId?: string;
      }
    | undefined {
    const bound = this.ensureBinding(descriptor, auth, 'legacy-deterministic');
    const fingerprint = computeStaticAuthFingerprint(descriptor, bound);
    const snapshot = this.snapshotForTarget({
      bindingId: bound.bindingId,
      fingerprint,
    });
    if (
      !snapshot ||
      (bound.identityId !== undefined &&
        bound.identityId !== snapshot.sessionId)
    ) {
      return undefined;
    }
    return {
      ...(snapshot.token ? { token: { ...snapshot.token } } : {}),
      ...(snapshot.clientSecret
        ? { clientSecret: snapshot.clientSecret }
        : {}),
      ...(snapshot.authContext
        ? { authContext: { ...snapshot.authContext } }
        : {}),
      ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    };
  }

  /**
   * Resolves the context paired with a credential, including a staged login
   * that has not yet been committed to the local envelope.
   */
  getAuthContextForCredential(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ): AuthContext | undefined {
    const bound = this.ensureBinding(descriptor, auth, 'legacy-deterministic');
    const fingerprint = computeStaticAuthFingerprint(descriptor, bound);
    const envelope = this.authStates.get(bound.bindingId);
    const snapshot = envelope?.snapshots.find(
      (candidate) => candidate.staticConfigFingerprint === fingerprint,
    );
    if (
      snapshot?.authContext &&
      (!bound.identityId || snapshot.sessionId === bound.identityId)
    ) {
      return { ...snapshot.authContext };
    }

    const sessionId = bound.identityId?.trim();
    if (!sessionId) return undefined;
    return this.authContextFromRuntime({
      auth: bound,
      bindingId: bound.bindingId,
      sessionId,
      revision: this.getAuthRevisionFloor(bound.bindingId) + 1,
    });
  }

  getLocalAuthCommitGuard(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
  ): LocalAuthCommitGuard {
    const bound = this.ensureBinding(descriptor, auth, 'legacy-deterministic');
    const fingerprint = computeStaticAuthFingerprint(descriptor, bound);
    const envelope = this.authStates.get(bound.bindingId);
    const snapshot = envelope?.snapshots.find(
      (candidate) => candidate.staticConfigFingerprint === fingerprint,
    );
    return {
      staticConfigFingerprint: fingerprint,
      epoch: snapshot?.epoch ?? 0,
      ...(snapshot?.sessionId === undefined
        ? {}
        : { sessionId: snapshot.sessionId }),
      revision: this.getAuthRevisionFloor(bound.bindingId),
    };
  }

  getLocalAuthEnvelope(bindingId: string): LocalAuthStateEnvelopeV1 | undefined {
    const envelope = this.authStates.get(bindingId);
    if (!envelope || envelope.snapshots.length === 0) return undefined;
    return this.cloneAuthEnvelope(envelope);
  }

  isLocalAuthTombstone(bindingId: string): boolean {
    const envelope = this.authStates.get(bindingId);
    return envelope !== undefined && envelope.snapshots.length === 0;
  }

  private async rollbackSessionAuthTransaction(
    descriptor: AuthBindingDescriptor,
    auth: SessionAuthRuntimeConfig,
    previous: LocalAuthStateEnvelopeV1 | undefined,
    expectedRevision: number,
  ): Promise<void> {
    const bound = this.ensureBinding(descriptor, auth, 'existing-or-random');
    await this.ensureLocalAuthStateInitialized();
    await this.enqueueAuthWrite(bound.bindingId, async () => {
      await this.refreshAuthRevisionFloor(bound.bindingId);
      if (
        this.authStates.get(bound.bindingId)?.revision !== expectedRevision
      ) {
        throw new LocalAuthStateConflictError();
      }
      const revision = this.getAuthRevisionFloor(bound.bindingId) + 1;
      await this.storeAuthEnvelope(
        previous
          ? { ...previous, revision }
          : this.createAuthTombstone(bound.bindingId, revision),
      );
    });
  }

  /**
   * Create a new secret reference.
   */
  createRef(): string {
    return createSecretRef();
  }

  /** Create an in-memory token reference for a pending Leader commit. */
  createTransientOAuth2TokenRef(): string {
    const ref = createSecretRef();
    this.transientOAuth2Tokens.set(ref, null);
    return ref;
  }

  /** Create an in-memory client-secret reference for a pending Leader commit. */
  createTransientOAuth2ClientSecretRef(): string {
    const ref = createSecretRef();
    this.transientOAuth2ClientSecrets.set(ref, null);
    return ref;
  }

  /**
   * Check if a value is a secret reference.
   */
  isRef(value: string): boolean {
    return isSecretRef(value);
  }

  /**
   * Extract UUID from a secret reference.
   */
  extractUuid(ref: string): string | null {
    return extractUuidFromRef(ref);
  }

  /**
   * Get API key value from a secret reference.
   */
  async getApiKey(ref: string): Promise<string | undefined> {
    const key = buildApiKeyStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid API key secret reference: ${ref}`);
      return undefined;
    }
    authLog.verbose('secret-store', `Getting API key (key: ${key})`);
    const value = await this.secrets.get(key);
    if (!value) {
      authLog.verbose('secret-store', `API key not found (key: ${key})`);
    }
    return value;
  }

  /**
   * Store API key value for a secret reference.
   */
  async setApiKey(ref: string, apiKey: string): Promise<void> {
    const key = buildApiKeyStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid API key secret reference: ${ref}`);
      throw new Error(`Invalid secret reference: ${ref}`);
    }
    authLog.verbose('secret-store', `Storing API key (key: ${key})`);
    await this.secrets.store(key, apiKey);
  }

  /**
   * Delete API key by reference.
   */
  async deleteApiKey(ref: string): Promise<void> {
    const key = buildApiKeyStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid API key secret reference for deletion: ${ref}`);
      return;
    }
    authLog.verbose('secret-store', `Deleting API key (key: ${key})`);
    await this.secrets.delete(key);
  }

  /**
   * Get API key value using legacy storage format (v2.x).
   * In v2.x, the secret reference itself was used as the storage key.
   */
  async getLegacyApiKey(ref: string): Promise<string | undefined> {
    return this.secrets.get(ref);
  }

  /**
   * Delete API key using legacy storage format (v2.x).
   */
  async deleteLegacyApiKey(ref: string): Promise<void> {
    await this.secrets.delete(ref);
  }

  /**
   * Get API key storage status from a raw config value.
   * This handles both plain text API keys and secret references.
   */
  async getApiKeyStatus(
    rawApiKey: string | undefined,
  ): Promise<ApiKeyStorageStatus> {
    const apiKey = rawApiKey?.trim() || undefined;
    if (!apiKey) {
      return { kind: 'unset' };
    }

    if (!isSecretRef(apiKey)) {
      return { kind: 'plain', apiKey };
    }

    const stored = await this.getApiKey(apiKey);
    if (stored) {
      return { kind: 'secret', ref: apiKey, apiKey: stored };
    }

    return { kind: 'missing-secret', ref: apiKey };
  }

  async getOAuth2Token(ref: string): Promise<OAuth2TokenData | null> {
    await this.ensureLocalAuthStateInitialized();
    if (this.transientOAuth2Tokens.has(ref)) {
      return this.transientOAuth2Tokens.get(ref) ?? null;
    }
    const target = this.resolveTokenTarget(ref);
    if (target) {
      const pending = this.pendingTokens.get(this.targetKey(target));
      return pending !== undefined
        ? pending
        : this.snapshotForTarget(target)?.token ?? null;
    }
    const localBindingId = extractBindingIdFromLocalAuthRef(ref);
    if (localBindingId) {
      return null;
    }
    const key = buildOAuth2TokenStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 token secret reference: ${ref}`);
      return null;
    }

    authLog.verbose('secret-store', `Getting OAuth2 token (key: ${key})`);
    const data = await this.secrets.get(key);
    if (!data) {
      authLog.verbose('secret-store', `OAuth2 token not found (key: ${key})`);
      return null;
    }

    try {
      const value: unknown = JSON.parse(data);
      return parseOAuth2TokenData(value);
    } catch (error) {
      authLog.error('secret-store', `Failed to parse OAuth2 token data (key: ${key})`, error);
      return null;
    }
  }

  async setOAuth2Token(ref: string, token: OAuth2TokenData): Promise<void> {
    await this.ensureLocalAuthStateInitialized();
    if (this.transientOAuth2Tokens.has(ref)) {
      this.transientOAuth2Tokens.set(ref, token);
      return;
    }
    const target = this.resolveTokenTarget(ref);
    if (target) {
      this.pendingTokens.set(this.targetKey(target), token);
      return;
    }
    const key = buildOAuth2TokenStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 token secret reference: ${ref}`);
      throw new Error(`Invalid secret reference: ${ref}`);
    }
    authLog.verbose('secret-store', `Storing OAuth2 token (key: ${key})`);
    await this.secrets.store(key, JSON.stringify(token));
  }

  async deleteOAuth2Token(ref: string): Promise<void> {
    await this.ensureLocalAuthStateInitialized();
    if (this.transientOAuth2Tokens.delete(ref)) {
      return;
    }
    const target = this.resolveTokenTarget(ref);
    if (target) {
      this.pendingTokens.set(this.targetKey(target), null);
      return;
    }
    const key = buildOAuth2TokenStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 token secret reference for deletion: ${ref}`);
      return;
    }
    authLog.verbose('secret-store', `Deleting OAuth2 token (key: ${key})`);
    await this.secrets.delete(key);
  }

  /** Discard an obsolete runtime ref after its envelope update has committed. */
  async discardOAuth2TokenRef(ref: string): Promise<void> {
    await this.ensureLocalAuthStateInitialized();
    if (this.transientOAuth2Tokens.delete(ref)) return;
    const aliasTarget = this.tokenAliases.get(ref);
    if (aliasTarget) {
      this.tokenAliases.delete(ref);
      this.pendingTokens.delete(this.targetKey(aliasTarget));
      return;
    }
    const localTarget = this.localRefTargets.get(ref);
    if (localTarget) {
      this.pendingTokens.delete(this.targetKey(localTarget));
      return;
    }
    const key = buildOAuth2TokenStorageKey(ref);
    if (key) await this.secrets.delete(key);
  }

  async hasOAuth2Token(ref: string): Promise<boolean> {
    const token = await this.getOAuth2Token(ref);
    return token !== null;
  }

  async listLegacyOAuth2TokenCandidates(
    excludedRefs: ReadonlySet<string> = new Set<string>(),
  ): Promise<LegacyOAuth2TokenCandidate[]> {
    const candidates: LegacyOAuth2TokenCandidate[] = [];
    for (const key of await this.getAllKeys()) {
      if (!key.startsWith(SECRET_KEY_PREFIXES.oauth2Token)) continue;
      const uuid = extractUuidFromStorageKey(key);
      if (!uuid) continue;
      const ref = buildRefFromUuid(uuid);
      if (excludedRefs.has(ref)) continue;
      const token = await this.getLegacyOAuth2Token(ref);
      if (token) candidates.push({ ref, token });
    }
    return candidates;
  }

  async listLegacyOAuth2ClientSecretCandidates(
    excludedRefs: ReadonlySet<string> = new Set<string>(),
  ): Promise<LegacyOAuth2ClientSecretCandidate[]> {
    const candidates: LegacyOAuth2ClientSecretCandidate[] = [];
    for (const key of await this.getAllKeys()) {
      if (!key.startsWith(SECRET_KEY_PREFIXES.oauth2ClientSecret)) continue;
      const uuid = extractUuidFromStorageKey(key);
      if (!uuid) continue;
      const ref = buildRefFromUuid(uuid);
      if (excludedRefs.has(ref)) continue;
      const secret = await this.getLegacyOAuth2ClientSecret(ref);
      if (secret) candidates.push({ ref, secret });
    }
    return candidates;
  }

  /**
   * Check if OAuth2 token is expired or about to expire.
   * @param token The token data
   * @param bufferMs Buffer time before actual expiration (default: 0)
   */
  isOAuth2TokenExpired(token: OAuth2TokenData, bufferMs: number = 0): boolean {
    if (!token.expiresAt) {
      return false;
    }
    return Date.now() >= token.expiresAt - bufferMs;
  }

  /**
   * Get OAuth2 client secret from a secret reference.
   */
  async getOAuth2ClientSecret(ref: string): Promise<string | undefined> {
    await this.ensureLocalAuthStateInitialized();
    if (this.transientOAuth2ClientSecrets.has(ref)) {
      return this.transientOAuth2ClientSecrets.get(ref) ?? undefined;
    }
    const target = this.resolveClientSecretTarget(ref);
    if (target) {
      const pending = this.pendingClientSecrets.get(this.targetKey(target));
      return pending !== undefined
        ? pending ?? undefined
        : this.snapshotForTarget(target)?.clientSecret;
    }
    const key = buildOAuth2ClientSecretStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 client secret reference: ${ref}`);
      return undefined;
    }
    authLog.verbose('secret-store', `Getting OAuth2 client secret (key: ${key})`);
    const value = await this.secrets.get(key);
    if (!value) {
      authLog.verbose('secret-store', `OAuth2 client secret not found (key: ${key})`);
    }
    return value;
  }

  /**
   * Store OAuth2 client secret for a secret reference.
   */
  async setOAuth2ClientSecret(ref: string, secret: string): Promise<void> {
    await this.ensureLocalAuthStateInitialized();
    if (this.transientOAuth2ClientSecrets.has(ref)) {
      this.transientOAuth2ClientSecrets.set(ref, secret);
      return;
    }
    const target = this.resolveClientSecretTarget(ref);
    if (target) {
      this.pendingClientSecrets.set(this.targetKey(target), secret);
      return;
    }
    const key = buildOAuth2ClientSecretStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 client secret reference: ${ref}`);
      throw new Error(`Invalid secret reference: ${ref}`);
    }
    authLog.verbose('secret-store', `Storing OAuth2 client secret (key: ${key})`);
    await this.secrets.store(key, secret);
  }

  /**
   * Delete OAuth2 client secret by reference.
   */
  async deleteOAuth2ClientSecret(ref: string): Promise<void> {
    await this.ensureLocalAuthStateInitialized();
    if (this.transientOAuth2ClientSecrets.delete(ref)) {
      return;
    }
    const target = this.resolveClientSecretTarget(ref);
    if (target) {
      this.pendingClientSecrets.set(this.targetKey(target), null);
      return;
    }
    const key = buildOAuth2ClientSecretStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 client secret reference for deletion: ${ref}`);
      return;
    }
    authLog.verbose('secret-store', `Deleting OAuth2 client secret (key: ${key})`);
    await this.secrets.delete(key);
  }

  /**
   * Get all SecretStorage keys owned by this extension.
   */
  async getAllKeys(): Promise<string[]> {
    const keys = await this.secrets.keys();
    return keys.filter((k) => k.startsWith(SECRET_STORAGE_PREFIX));
  }

  async getOwnedSecretByKey(key: string): Promise<string | undefined> {
    if (!key.startsWith(SECRET_STORAGE_PREFIX)) {
      throw new Error(`Invalid extension secret storage key: ${key}`);
    }
    return await this.secrets.get(key);
  }

  async restoreOwnedSecretByKey(key: string, value: string): Promise<void> {
    if (!key.startsWith(SECRET_STORAGE_PREFIX)) {
      throw new Error(`Invalid extension secret storage key: ${key}`);
    }
    const authStateStoragePrefix =
      `${DEVICE_STATE_STORAGE_PREFIX}${LOCAL_AUTH_STATE_KEY_PREFIX}`;
    if (!key.startsWith(authStateStoragePrefix)) {
      await this.secrets.store(key, value);
      return;
    }
    const bindingId = key.slice(authStateStoragePrefix.length);
    const envelope = parseLocalAuthStateEnvelopeJson(value);
    if (
      !isValidAuthBindingId(bindingId) ||
      !envelope ||
      envelope.bindingId !== bindingId
    ) {
      await this.secrets.store(key, value);
      if (isValidAuthBindingId(bindingId)) {
        await this.reloadLocalAuthState(bindingId);
      }
      return;
    }

    await this.ensureLocalAuthStateInitialized();
    await this.enqueueAuthWrite(bindingId, async () => {
      await this.refreshAuthRevisionFloor(bindingId);
      await this.storeAuthEnvelope({
        ...envelope,
        revision: this.getAuthRevisionFloor(bindingId) + 1,
      });
    });
  }

  /**
   * Delete a secret by its storage key.
   */
  async deleteByKey(key: string): Promise<void> {
    const authStateStoragePrefix =
      `${DEVICE_STATE_STORAGE_PREFIX}${LOCAL_AUTH_STATE_KEY_PREFIX}`;
    if (!key.startsWith(authStateStoragePrefix)) {
      await this.secrets.delete(key);
      return;
    }

    const bindingId = key.slice(authStateStoragePrefix.length);
    if (!isValidAuthBindingId(bindingId)) {
      await this.secrets.delete(key);
      return;
    }
    await this.ensureLocalAuthStateInitialized();
    await this.enqueueAuthWrite(bindingId, async () => {
      await this.refreshAuthRevisionFloor(bindingId);
      const tombstone = this.createAuthTombstone(
        bindingId,
        this.getAuthRevisionFloor(bindingId) + 1,
      );
      await this.storeAuthEnvelope(tombstone);
      this.clearCachedAuthReferences(bindingId);
    });
  }

  /**
   * Check if a storage key is an API key.
   */
  isApiKeyStorageKey(key: string): boolean {
    return key.startsWith(SECRET_KEY_PREFIXES.apiKey);
  }

  /**
   * Check if a storage key is an OAuth2 token.
   */
  isOAuth2TokenStorageKey(key: string): boolean {
    return key.startsWith(SECRET_KEY_PREFIXES.oauth2Token);
  }

  /**
   * Check if a storage key is an OAuth2 client secret.
   */
  isOAuth2ClientSecretStorageKey(key: string): boolean {
    return key.startsWith(SECRET_KEY_PREFIXES.oauth2ClientSecret);
  }

  async getDeviceState(key: string): Promise<string | undefined> {
    return this.secrets.get(this.deviceStateStorageKey(key));
  }

  async setDeviceState(key: string, value: string): Promise<void> {
    await this.secrets.store(this.deviceStateStorageKey(key), value);
  }

  async deleteDeviceState(key: string): Promise<void> {
    await this.secrets.delete(this.deviceStateStorageKey(key));
  }

  private deviceStateStorageKey(key: string): string {
    const normalized = key.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
      throw new Error(`Invalid device state key: ${key}`);
    }
    return `${DEVICE_STATE_STORAGE_PREFIX}${normalized}`;
  }
}
