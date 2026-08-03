import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileSystem = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  targetPath: '',
  directWritePrefix: '',
  stagingPrefix: '',
  directWriteErrorCode: undefined as string | undefined,
  changeBeforeFirstHashCheck: false,
  targetReadCount: 0,
}));

const elevation = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  replacement: undefined as Buffer | undefined,
  calls: [] as string[],
}));

const windowsElevation = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  stderr: '',
  diagnostic: undefined as string | undefined,
  replacement: undefined as Buffer | undefined,
  calls: [] as Array<{
    executable: string;
    args: string[];
    options: unknown;
  }>,
}));

function codedError(code: string, message = code): Error {
  const error = new Error(message);
  Reflect.set(error, 'code', code);
  return error;
}

vi.mock('vscode', () => ({
  UIKind: { Desktop: 1, Web: 2 },
}));

vi.mock('node:fs/promises', () => ({
  chmod: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ mode: 0o100644 })),
  readFile: vi.fn(async (path: string) => {
    if (path === fileSystem.targetPath) {
      fileSystem.targetReadCount += 1;
      if (
        fileSystem.changeBeforeFirstHashCheck &&
        fileSystem.targetReadCount === 2
      ) {
        fileSystem.files.set(
          path,
          Buffer.from(
            JSON.stringify({
              nameShort: 'Code',
              applicationName: 'code',
              concurrentChange: true,
            }),
          ),
        );
      }
    }
    const value = fileSystem.files.get(path);
    if (!value) throw codedError('ENOENT');
    return Buffer.from(value);
  }),
  writeFile: vi.fn(
    async (path: string, value: Uint8Array, options?: { flag?: string }) => {
      if (
        path.startsWith(fileSystem.directWritePrefix) &&
        fileSystem.directWriteErrorCode
      ) {
        throw codedError(fileSystem.directWriteErrorCode);
      }
      if (options?.flag === 'wx' && fileSystem.files.has(path)) {
        throw codedError('EEXIST');
      }
      fileSystem.files.set(path, Buffer.from(value));
    },
  ),
  rename: vi.fn(async (source: string, target: string) => {
    const value = fileSystem.files.get(source);
    if (!value) throw codedError('ENOENT');
    fileSystem.files.set(target, value);
    fileSystem.files.delete(source);
  }),
  unlink: vi.fn(async (path: string) => {
    if (!fileSystem.files.delete(path)) throw codedError('ENOENT');
  }),
}));

vi.mock('@vscode/sudo-prompt', () => ({
  exec: vi.fn(
    (
      command: string,
      _options: unknown,
      callback: (error?: Error) => void,
    ) => {
      elevation.calls.push(command);
      if (!elevation.error && elevation.replacement) {
        fileSystem.files.set(
          fileSystem.targetPath,
          Buffer.from(elevation.replacement),
        );
      }
      callback(elevation.error);
    },
  ),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      executable: string,
      args: string[],
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      windowsElevation.calls.push({ executable, args, options });
      if (!windowsElevation.error && windowsElevation.replacement) {
        fileSystem.files.set(
          fileSystem.targetPath,
          Buffer.from(windowsElevation.replacement),
        );
      }
      if (windowsElevation.error && windowsElevation.diagnostic) {
        const stagingPath = [...fileSystem.files.keys()].find(
          (path) =>
            path.startsWith(fileSystem.stagingPrefix) &&
            path.endsWith('.staged.json'),
        );
        if (stagingPath) {
          fileSystem.files.set(
            `${stagingPath}.elevated-error.txt`,
            Buffer.from(windowsElevation.diagnostic),
          );
        }
      }
      callback(
        windowsElevation.error ?? null,
        '',
        windowsElevation.stderr,
      );
    },
  ),
}));

import * as vscode from 'vscode';
import {
  createUpdatedProductRoot,
  ProductJsonError,
  type ProductJsonEnvironment,
  writeProductJsonProposals,
} from '../../src/proposed-api/product-json';

const proposals = [
  'languageModelSystem',
  'chatProvider',
  'inlineCompletionsAdditions',
  'contribSourceControlInputBoxMenu',
  'languageModelThinkingPart',
] as const;

const appRoot = resolve('mock-app');
const globalStoragePath = resolve('mock-storage');

const environment: ProductJsonEnvironment = {
  uiKind: vscode.UIKind.Desktop,
  remoteName: undefined,
  appRoot,
  extensionId: 'SmallMain.vscode-unify-chat-provider',
  globalStoragePath,
  platform: 'linux',
};

const windowsEnvironment: ProductJsonEnvironment = {
  ...environment,
  platform: 'win32',
};

function serialized(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
}

function resetFixture(): Record<string, unknown> {
  const original = {
    nameShort: 'Code',
    applicationName: 'code',
    stableField: true,
  };
  fileSystem.targetPath = join(appRoot, 'product.json');
  fileSystem.directWritePrefix = join(appRoot, '.product.json.');
  fileSystem.stagingPrefix = join(globalStoragePath, 'product.');
  fileSystem.files.clear();
  fileSystem.files.set(fileSystem.targetPath, serialized(original));
  fileSystem.directWriteErrorCode = undefined;
  fileSystem.changeBeforeFirstHashCheck = false;
  fileSystem.targetReadCount = 0;
  elevation.error = undefined;
  elevation.replacement = serialized(
    createUpdatedProductRoot(
      original,
      environment.extensionId,
      proposals,
    ),
  );
  elevation.calls.length = 0;
  windowsElevation.error = undefined;
  windowsElevation.stderr = '';
  windowsElevation.diagnostic = undefined;
  windowsElevation.replacement = Buffer.from(elevation.replacement);
  windowsElevation.calls.length = 0;
  return original;
}

beforeEach(() => {
  resetFixture();
});

describe('product.json permission and race handling', () => {
  it('elevates only after a normal write receives EACCES', async () => {
    fileSystem.directWriteErrorCode = 'EACCES';
    const result = await writeProductJsonProposals(environment, proposals);
    expect(result.changed).toBe(true);
    expect(result.elevated).toBe(true);
    expect(elevation.calls).toHaveLength(1);
    expect(elevation.calls[0]).toContain('base64 -d');
    expect(elevation.calls[0]).not.toMatch(/[$`"]/);
  });

  it('uses the direct PowerShell UAC launcher instead of sudo-prompt on Windows', async () => {
    fileSystem.directWriteErrorCode = 'EACCES';
    const result = await writeProductJsonProposals(
      windowsEnvironment,
      proposals,
    );
    expect(result).toMatchObject({ changed: true, elevated: true });
    expect(elevation.calls).toHaveLength(0);
    expect(windowsElevation.calls).toHaveLength(1);
    expect(windowsElevation.calls[0]?.executable).toBe('powershell.exe');
    expect(windowsElevation.calls[0]?.args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    expect(windowsElevation.calls[0]?.args[3]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('treats administrator cancellation as a normal cancelled result', async () => {
    fileSystem.directWriteErrorCode = 'EPERM';
    elevation.error = new Error('User did not grant permission.');
    await expect(
      writeProductJsonProposals(environment, proposals),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(elevation.calls).toHaveLength(1);
  });

  it('does not request elevation for a read-only filesystem', async () => {
    fileSystem.directWriteErrorCode = 'EROFS';
    await expect(
      writeProductJsonProposals(environment, proposals),
    ).rejects.toMatchObject({ code: 'read-only' });
    expect(elevation.calls).toHaveLength(0);
  });

  it('aborts before writing when the target hash changes', async () => {
    fileSystem.changeBeforeFirstHashCheck = true;
    await expect(
      writeProductJsonProposals(environment, proposals),
    ).rejects.toMatchObject({ code: 'concurrent-change' });
    expect(elevation.calls).toHaveLength(0);
  });

  it('maps an elevated hash mismatch exit to a concurrent change', async () => {
    fileSystem.directWriteErrorCode = 'EACCES';
    elevation.error = codedError('73');
    await expect(
      writeProductJsonProposals(environment, proposals),
    ).rejects.toMatchObject({ code: 'concurrent-change' });
  });

  it('maps Windows UAC cancellation without relying on localized text', async () => {
    fileSystem.directWriteErrorCode = 'EACCES';
    windowsElevation.error = codedError('72', 'launcher failed');
    await expect(
      writeProductJsonProposals(windowsEnvironment, proposals),
    ).rejects.toMatchObject({
      code: 'cancelled',
      targetPath: fileSystem.targetPath,
      exitCode: 72,
    });
  });

  it('reports the Windows target, exit code, and elevated diagnostic', async () => {
    fileSystem.directWriteErrorCode = 'EACCES';
    windowsElevation.error = codedError('74', 'launcher failed');
    windowsElevation.diagnostic =
      'Copy-Item: Access to product.json was denied (EACCES).';
    const operation = writeProductJsonProposals(
      windowsEnvironment,
      proposals,
    );
    await expect(operation).rejects.toMatchObject({
      code: 'write-failed',
      targetPath: fileSystem.targetPath,
      exitCode: 74,
      stderr: 'Copy-Item: Access to product.json was denied (EACCES).',
    });
    await expect(operation).rejects.toThrow(
      JSON.stringify(fileSystem.targetPath),
    );
    expect(
      [...fileSystem.files.keys()].some((path) =>
        path.endsWith('.elevated-error.txt'),
      ),
    ).toBe(false);
  });

  it('exposes typed product errors for callers', () => {
    const error = new ProductJsonError('write-failed', 'failed');
    expect(error.name).toBe('ProductJsonError');
    expect(error.code).toBe('write-failed');
  });
});
