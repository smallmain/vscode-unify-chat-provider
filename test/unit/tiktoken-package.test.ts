import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { get_encoding } from 'tiktoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(__filename);
const sourceRoot = dirname(require.resolve('tiktoken'));
const runtimeFiles = [
  'package.json',
  'README.md',
  'tiktoken.cjs',
  'tiktoken_bg.cjs',
  'tiktoken_bg.wasm',
] as const;
const encodingNames = [
  'o200k_base',
  'cl100k_base',
  'p50k_base',
  'p50k_edit',
  'r50k_base',
  'gpt2',
] as const;

interface PackagedEncoding {
  encode(text: string): Uint32Array;
  decode(tokens: Uint32Array): Uint8Array;
  free(): void;
}

interface PackagedTiktoken {
  get_encoding(name: string): PackagedEncoding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPackagedTiktoken(value: unknown): value is PackagedTiktoken {
  return isRecord(value) && typeof value.get_encoding === 'function';
}

describe('packaged tiktoken runtime', () => {
  let temporaryRoot: string;
  let packaged: PackagedTiktoken;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'ucp-tiktoken-'));
    const packageRoot = join(temporaryRoot, 'node_modules', 'tiktoken');
    await mkdir(packageRoot, { recursive: true });
    await Promise.all(
      runtimeFiles.map((file) =>
        copyFile(join(sourceRoot, file), join(packageRoot, file)),
      ),
    );

    const isolatedRequire = createRequire(join(temporaryRoot, 'loader.cjs'));
    const loaded: unknown = isolatedRequire('tiktoken');
    if (!isPackagedTiktoken(loaded)) {
      throw new Error('The minimal tiktoken package has invalid exports.');
    }
    packaged = loaded;
  });

  afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  for (const name of encodingNames) {
    it(`loads ${name} without optional package entries`, () => {
      const fullEncoding = get_encoding(name);
      const packagedEncoding = packaged.get_encoding(name);
      const input = 'function completion(value: string): string { return value; }';
      try {
        const expected = fullEncoding.encode(input);
        const actual = packagedEncoding.encode(input);
        expect(Array.from(actual)).toEqual(Array.from(expected));
        expect(new TextDecoder().decode(packagedEncoding.decode(actual))).toBe(
          input,
        );
      } finally {
        fullEncoding.free();
        packagedEncoding.free();
      }
    });
  }
});
