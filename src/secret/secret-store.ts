import * as vscode from 'vscode';
import {
  createSecretRef,
  isSecretRef,
  extractUuidFromRef,
  buildApiKeyStorageKey,
  buildOAuth2TokenStorageKey,
  buildOAuth2ClientSecretStorageKey,
  SECRET_STORAGE_PREFIX,
  SECRET_KEY_PREFIXES,
  DEVICE_STATE_STORAGE_PREFIX,
} from './constants';
import type { OAuth2TokenData } from '../auth/types';
import { authLog } from '../logger';

/**
 * API key storage status
 */
export type ApiKeyStorageStatus =
  | { kind: 'unset' }
  | { kind: 'plain'; apiKey: string }
  | { kind: 'secret'; ref: string; apiKey: string }
  | { kind: 'missing-secret'; ref: string };

/**
 * Unified secret storage for all extension secrets.
 * Handles API keys, OAuth2 tokens, and OAuth2 client secrets.
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Create a new secret reference.
   */
  createRef(): string {
    return createSecretRef();
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
      return JSON.parse(data) as OAuth2TokenData;
    } catch (error) {
      authLog.error('secret-store', `Failed to parse OAuth2 token data (key: ${key})`, error);
      return null;
    }
  }

  async setOAuth2Token(ref: string, token: OAuth2TokenData): Promise<void> {
    const key = buildOAuth2TokenStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 token secret reference: ${ref}`);
      throw new Error(`Invalid secret reference: ${ref}`);
    }
    authLog.verbose('secret-store', `Storing OAuth2 token (key: ${key})`);
    await this.secrets.store(key, JSON.stringify(token));
  }

  async deleteOAuth2Token(ref: string): Promise<void> {
    const key = buildOAuth2TokenStorageKey(ref);
    if (!key) {
      authLog.error('secret-store', `Invalid OAuth2 token secret reference for deletion: ${ref}`);
      return;
    }
    authLog.verbose('secret-store', `Deleting OAuth2 token (key: ${key})`);
    await this.secrets.delete(key);
  }

  async hasOAuth2Token(ref: string): Promise<boolean> {
    const token = await this.getOAuth2Token(ref);
    return token !== null;
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

  /**
   * Delete a secret by its storage key.
   */
  async deleteByKey(key: string): Promise<void> {
    await this.secrets.delete(key);
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
