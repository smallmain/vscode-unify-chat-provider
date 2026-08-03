import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConfigStore } from '../config-store';
import type { SecretStore } from '../secret';
import { mainInstance } from '../main-instance';

interface CodexSessionTestInput {
  providerName: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  email: string;
}

interface AuthStateDigest {
  method: 'openai-codex';
  bindingId: string;
  revision: number;
  hasCredential: boolean;
  credentialDigest?: string;
  accountDigest?: string;
  sessionDigest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${key}.`);
  }
  return value;
}

function parseCodexSessionTestInput(value: unknown): CodexSessionTestInput {
  if (!isRecord(value)) throw new Error('Invalid Codex test session input.');
  return {
    providerName: requireNonEmptyString(value, 'providerName'),
    accessToken: requireNonEmptyString(value, 'accessToken'),
    refreshToken: requireNonEmptyString(value, 'refreshToken'),
    accountId: requireNonEmptyString(value, 'accountId'),
    email: requireNonEmptyString(value, 'email'),
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function getCodexStateDigest(options: {
  configStore: ConfigStore;
  secretStore: SecretStore;
  providerName: string;
}): Promise<AuthStateDigest> {
  const provider = options.configStore.getProvider(options.providerName);
  if (!provider || provider.auth?.method !== 'openai-codex') {
    throw new Error('Expected a configured Codex provider.');
  }
  const descriptor = {
    providerName: provider.name,
    providerType: provider.type,
    baseUrl: provider.baseUrl,
    useRawBaseUrl: provider.useRawBaseUrl,
  };
  const runtime = options.secretStore.hydrateSessionAuth(
    descriptor,
    provider.auth,
  );
  const token = runtime.token
    ? await options.secretStore.getOAuth2Token(runtime.token)
    : undefined;
  const context = options.secretStore.getLocalAuthContext(
    descriptor,
    provider.auth,
  );
  const envelope = options.secretStore.getLocalAuthEnvelope(
    provider.auth.bindingId,
  );
  return {
    method: 'openai-codex',
    bindingId: provider.auth.bindingId,
    revision: envelope?.revision ?? 0,
    hasCredential: token !== undefined,
    ...(token ? { credentialDigest: digest(token.accessToken) } : {}),
    ...(context?.method === 'openai-codex' && context.accountId
      ? { accountDigest: digest(context.accountId) }
      : {}),
    ...(context ? { sessionDigest: digest(context.sessionId) } : {}),
  };
}

export function registerAuthTestCommands(options: {
  context: vscode.ExtensionContext;
  configStore: ConfigStore;
  secretStore: SecretStore;
}): void {
  options.context.subscriptions.push(
    vscode.commands.registerCommand(
      'unifyChatProvider.auth.test.setCodexSession',
      async (value: unknown) => {
        if (!mainInstance.isLeader() || !mainInstance.isReady()) {
          throw new Error('Auth test session writes require the ready Leader.');
        }
        const input = parseCodexSessionTestInput(value);
        const provider = options.configStore.getProvider(input.providerName);
        const auth = provider?.auth;
        if (!provider || auth?.method !== 'openai-codex') {
          throw new Error('Expected a configured Codex provider.');
        }
        return await mainInstance.runLeaderMutation(async () => {
          await options.secretStore.persistSessionAuth(
            {
              providerName: provider.name,
              providerType: provider.type,
              baseUrl: provider.baseUrl,
              useRawBaseUrl: provider.useRawBaseUrl,
            },
            {
              ...auth,
              token: JSON.stringify({
                accessToken: input.accessToken,
                refreshToken: input.refreshToken,
                tokenType: 'Bearer',
                expiresAt: 4_102_444_800_000,
              }),
              accountId: input.accountId,
              email: input.email,
            },
            {
              reason: 'login',
              emptyToken: 'clear',
              binding: 'existing-or-random',
            },
          );
          return await getCodexStateDigest({
            configStore: options.configStore,
            secretStore: options.secretStore,
            providerName: input.providerName,
          });
        });
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.auth.test.getStateDigest',
      async (providerName: unknown) => {
        if (typeof providerName !== 'string' || providerName.trim() === '') {
          throw new Error('Invalid provider name.');
        }
        return await getCodexStateDigest({
          configStore: options.configStore,
          secretStore: options.secretStore,
          providerName,
        });
      },
    ),
  );
}
