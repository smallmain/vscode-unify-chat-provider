import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredSecrets(contents: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Invalid E2E secret storage JSON');
  }

  if (!isUnknownRecord(parsed)) {
    throw new Error('Invalid E2E secret storage JSON');
  }

  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error('Invalid E2E secret storage JSON');
    }
    values.set(key, value);
  }
  return values;
}

/**
 * Test-only SecretStorage implementation for Extension Host restart tests.
 */
export class E2EFileSecretStorage
  implements vscode.SecretStorage, vscode.Disposable
{
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  readonly onDidChange = this.changeEmitter.event;

  private values: Map<string, string> | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) {
      throw new Error('E2E secret storage path must be absolute');
    }
  }

  keys(): Promise<string[]> {
    return this.runExclusive(async () => {
      const values = await this.load();
      return Array.from(values.keys()).sort();
    });
  }

  get(key: string): Promise<string | undefined> {
    return this.runExclusive(async () => (await this.load()).get(key));
  }

  store(key: string, value: string): Promise<void> {
    return this.runExclusive(async () => {
      const next = new Map(await this.load());
      next.set(key, value);
      await this.persist(next);
      this.values = next;
      this.changeEmitter.fire({ key });
    });
  }

  delete(key: string): Promise<void> {
    return this.runExclusive(async () => {
      const current = await this.load();
      if (!current.has(key)) return;

      const next = new Map(current);
      next.delete(key);
      await this.persist(next);
      this.values = next;
      this.changeEmitter.fire({ key });
    });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<Map<string, string>> {
    if (this.values) return this.values;

    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        this.values = new Map();
        return this.values;
      }
      throw error;
    }

    this.values = parseStoredSecrets(contents);
    return this.values;
  }

  private async persist(values: ReadonlyMap<string, string>): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryFile = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const serialized = `${JSON.stringify(
      Object.fromEntries(
        Array.from(values.entries()).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      undefined,
      2,
    )}\n`;

    try {
      await writeFile(temporaryFile, serialized, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryFile, this.filePath);
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
