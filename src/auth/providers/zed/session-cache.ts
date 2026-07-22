import { randomUUID } from 'node:crypto';
import type { SecretStore } from '../../../secret/secret-store';
import { ZedCloudClient } from '../../../client/zed/cloud-client';
import type {
  ZedAuthenticatedUser,
  ZedLongLivedCredential,
  ZedOrganization,
} from '../../../client/zed/types';

const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const SYSTEM_ID_STATE_KEY = 'zed-system-id-v1';

const systemIdPromises = new WeakMap<SecretStore, Promise<string>>();

export interface ZedAccountSnapshot {
  readonly user: ZedAuthenticatedUser;
  readonly organization: ZedOrganization;
  readonly configuredOrganizationChanged: boolean;
}

export async function getZedSystemId(secretStore: SecretStore): Promise<string> {
  const existing = systemIdPromises.get(secretStore);
  if (existing) return existing;

  const pending = (async () => {
    const stored = (await secretStore.getDeviceState(SYSTEM_ID_STATE_KEY))?.trim();
    if (stored) return stored;

    const generated = randomUUID();
    await secretStore.setDeviceState(SYSTEM_ID_STATE_KEY, generated);
    return (await secretStore.getDeviceState(SYSTEM_ID_STATE_KEY))?.trim() || generated;
  })().catch((error: unknown) => {
    systemIdPromises.delete(secretStore);
    throw error;
  });
  systemIdPromises.set(secretStore, pending);
  return pending;
}

export class ZedAuthSessionCache {
  private readonly client: ZedCloudClient;
  private user?: ZedAuthenticatedUser;
  private organization?: ZedOrganization;
  private accountLoadedAt = 0;
  private serverOrganizationSynced = false;
  private llmToken?: { organizationId: string; value: string };
  private llmTokenPromise?: Promise<string>;
  private llmTokenGeneration = 0;

  constructor(
    readonly baseUrl: string,
    private readonly credential: ZedLongLivedCredential,
    private readonly systemId: string,
  ) {
    this.client = new ZedCloudClient(baseUrl);
  }

  matches(baseUrl: string, credential: ZedLongLivedCredential): boolean {
    return (
      this.baseUrl === baseUrl &&
      this.credential.userId === credential.userId &&
      this.credential.accessToken === credential.accessToken
    );
  }

  private resolveOrganization(
    user: ZedAuthenticatedUser,
    configuredOrganizationId: string | undefined,
  ): ZedOrganization {
    const configured = user.organizations.find(
      (organization) => organization.id === configuredOrganizationId,
    );
    const fallback =
      user.organizations.find(
        (organization) => organization.id === user.defaultOrganizationId,
      ) ?? user.organizations[0];
    const organization = configured ?? fallback;
    if (!organization) {
      throw new Error('The Zed account does not belong to an organization.');
    }
    return organization;
  }

  private accountIsFresh(): boolean {
    return (
      this.user !== undefined &&
      Date.now() - this.accountLoadedAt < ACCOUNT_CACHE_TTL_MS
    );
  }

  async ensureAccount(
    configuredOrganizationId: string | undefined,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<ZedAccountSnapshot> {
    const user =
      !options.force && this.accountIsFresh() && this.user
        ? this.user
        : await this.client.getAuthenticatedUser(
            this.credential,
            this.systemId,
            options.signal,
          );
    const organization = this.resolveOrganization(user, configuredOrganizationId);
    const previousOrganizationId = this.organization?.id;
    if (
      !this.serverOrganizationSynced ||
      previousOrganizationId !== organization.id
    ) {
      await this.client.updateSystemSettings(
        this.credential,
        organization.id,
        this.systemId,
      );
      this.serverOrganizationSynced = true;
    }
    if (previousOrganizationId && previousOrganizationId !== organization.id) {
      this.invalidateLlmToken();
    }
    this.user = user;
    this.organization = organization;
    this.accountLoadedAt = Date.now();
    return {
      user,
      organization,
      configuredOrganizationChanged:
        organization.id !== configuredOrganizationId,
    };
  }

  async selectOrganization(
    organizationId: string,
    configuredOrganizationId: string | undefined,
  ): Promise<ZedAccountSnapshot> {
    const snapshot = await this.ensureAccount(configuredOrganizationId);
    const organization = snapshot.user.organizations.find(
      (candidate) => candidate.id === organizationId,
    );
    if (!organization) {
      throw new Error(`Unknown Zed organization: ${organizationId}`);
    }
    if (this.organization?.id !== organization.id) {
      await this.client.updateSystemSettings(
        this.credential,
        organization.id,
        this.systemId,
      );
      this.invalidateLlmToken();
      this.organization = organization;
      this.serverOrganizationSynced = true;
    }
    return {
      user: snapshot.user,
      organization,
      configuredOrganizationChanged: organization.id !== configuredOrganizationId,
    };
  }

  async getLlmToken(
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.llmToken?.organizationId === organizationId) {
      return this.llmToken.value;
    }
    if (!signal && this.llmTokenPromise) return this.llmTokenPromise;

    const generation = this.llmTokenGeneration;
    const load = async (): Promise<string> => {
      const value = await this.client.createLlmToken(
        this.credential,
        organizationId,
        this.systemId,
        signal,
      );
      if (generation === this.llmTokenGeneration) {
        this.llmToken = { organizationId, value };
      }
      return value;
    };
    if (signal) return load();

    let pending: Promise<string>;
    pending = load().finally(() => {
      if (this.llmTokenPromise === pending) this.llmTokenPromise = undefined;
    });
    this.llmTokenPromise = pending;
    return pending;
  }

  async refreshLlmToken(
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.invalidateLlmToken();
    return this.getLlmToken(organizationId, signal);
  }

  invalidateLlmToken(): void {
    this.llmTokenGeneration += 1;
    this.llmToken = undefined;
    this.llmTokenPromise = undefined;
  }

  clear(): void {
    this.invalidateLlmToken();
    this.user = undefined;
    this.organization = undefined;
    this.accountLoadedAt = 0;
    this.serverOrganizationSynced = false;
  }
}
