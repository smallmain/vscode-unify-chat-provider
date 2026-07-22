import { createServer, type Server } from 'node:http';
import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto';
import * as vscode from 'vscode';
import type { ZedLongLivedCredential } from '../../../client/zed/types';
import { buildZedUrl, resolveZedBaseUrls } from '../../../client/zed/urls';

const CALLBACK_TIMEOUT_MS = 100_000;

function encodeBase64UrlWithPadding(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeBase64Url(value: string): Buffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  return Buffer.from(`${base64}${'='.repeat(padding)}`, 'base64');
}

function decryptAccessToken(privateKey: KeyObject, encrypted: string): string {
  const ciphertext = decodeBase64Url(encrypted);
  const decrypt = (padding: number, oaepHash?: string): Buffer =>
    privateDecrypt({ key: privateKey, padding, oaepHash }, ciphertext);
  let plaintext: Buffer;
  try {
    plaintext = decrypt(constants.RSA_PKCS1_OAEP_PADDING, 'sha256');
  } catch {
    plaintext = decrypt(constants.RSA_PKCS1_PADDING);
  }
  return plaintext.toString('utf8');
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Zed sign-in callback did not bind to a TCP port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export interface ZedNativeSignInOptions {
  baseUrl: string;
  systemId?: string;
  timeoutMs?: number;
  openExternal?: (uri: vscode.Uri) => Thenable<boolean>;
}

export async function performZedNativeSignIn(
  options: ZedNativeSignInOptions,
): Promise<ZedLongLivedCredential> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicKeyDer = publicKey.export({ type: 'pkcs1', format: 'der' });
  const encodedPublicKey = encodeBase64UrlWithPadding(publicKeyDer);
  const baseUrls = resolveZedBaseUrls(options.baseUrl);

  let settle:
    | {
        resolve: (credential: ZedLongLivedCredential) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const credentialPromise = new Promise<ZedLongLivedCredential>(
    (resolve, reject) => {
      settle = { resolve, reject };
    },
  );

  const server = createServer((request, response) => {
    try {
      const callback = new URL(request.url ?? '/', 'http://127.0.0.1');
      const userId = callback.searchParams.get('user_id')?.trim();
      const encryptedToken = callback.searchParams.get('access_token')?.trim();
      if (!userId || !encryptedToken) {
        response.statusCode = 400;
        response.end('Invalid Zed sign-in callback.');
        settle?.reject(new Error('Invalid Zed sign-in callback.'));
        settle = undefined;
        return;
      }
      const accessToken = decryptAccessToken(privateKey, encryptedToken);
      response.statusCode = 302;
      response.setHeader(
        'Location',
        buildZedUrl(baseUrls.web, '/native_app_signin_succeeded'),
      );
      response.end();
      settle?.resolve({ userId, accessToken });
      settle = undefined;
    } catch (error) {
      response.statusCode = 400;
      response.end('Unable to complete Zed sign-in.');
      settle?.reject(error instanceof Error ? error : new Error(String(error)));
      settle = undefined;
    }
  });

  const port = await listen(server);
  const signInUrl = new URL(buildZedUrl(baseUrls.web, '/native_app_signin'));
  signInUrl.searchParams.set('native_app_port', String(port));
  signInUrl.searchParams.set('native_app_public_key', encodedPublicKey);
  if (options.systemId) signInUrl.searchParams.set('system_id', options.systemId);

  const timeout = setTimeout(() => {
    settle?.reject(new Error('Timed out waiting for the Zed sign-in callback.'));
    settle = undefined;
  }, options.timeoutMs ?? CALLBACK_TIMEOUT_MS);

  try {
    const opened = await (options.openExternal ?? vscode.env.openExternal)(
      vscode.Uri.parse(signInUrl.toString()),
    );
    if (!opened) throw new Error('Unable to open the Zed sign-in page.');
    return await credentialPromise;
  } finally {
    clearTimeout(timeout);
    settle = undefined;
    await close(server);
  }
}
