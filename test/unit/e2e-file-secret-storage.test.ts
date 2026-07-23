import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}

    dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return { Disposable, EventEmitter };
});

import { E2EFileSecretStorage } from '../../src/secret/e2e-file-secret-storage';

const temporaryDirectories = new Set<string>();

async function createStoragePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ucp-e2e-secrets-'));
  temporaryDirectories.add(directory);
  return path.join(directory, 'secrets.json');
}

afterEach(async () => {
  await Promise.all(
    Array.from(temporaryDirectories, (directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('E2EFileSecretStorage', () => {
  it('persists serialized mutations across instances and emits key-only events', async () => {
    const filePath = await createStoragePath();
    const storage = new E2EFileSecretStorage(filePath);
    const changedKeys: string[] = [];
    storage.onDidChange(({ key }) => changedKeys.push(key));

    await Promise.all([
      storage.store('second', 'secret-b'),
      storage.store('first', 'secret-a'),
    ]);
    expect(await storage.keys()).toEqual(['first', 'second']);
    expect(await storage.get('first')).toBe('secret-a');
    await storage.delete('second');
    expect(changedKeys).toEqual(['second', 'first', 'second']);

    const persisted: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted).toEqual({ first: 'secret-a' });
    expect(await readdir(path.dirname(filePath))).toEqual(['secrets.json']);

    const restartedStorage = new E2EFileSecretStorage(filePath);
    expect(await restartedStorage.keys()).toEqual(['first']);
    expect(await restartedStorage.get('first')).toBe('secret-a');

    storage.dispose();
    restartedStorage.dispose();
  });

  it.each([
    { name: 'array root', contents: '[]' },
    { name: 'non-string value', contents: '{"key":1}' },
    { name: 'invalid syntax', contents: 'not-json' },
  ])('rejects malformed storage JSON with $name', async ({ contents }) => {
    const filePath = await createStoragePath();
    await writeFile(filePath, contents, 'utf8');
    const storage = new E2EFileSecretStorage(filePath);

    await expect(storage.keys()).rejects.toThrow(
      'Invalid E2E secret storage JSON',
    );
    storage.dispose();
  });
});
