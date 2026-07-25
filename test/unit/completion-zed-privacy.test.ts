import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZED_LICENSE_EXAMPLES } from '../fixtures/zed-license-examples';

const files = vi.hoisted(() => new Map<string, string>());
const directories = vi.hoisted(() => new Set<string>());

vi.mock('vscode', () => {
  class Uri {
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;

    constructor(private readonly value: string) {
      const parsed = new URL(value);
      this.scheme = parsed.protocol.slice(0, -1);
      this.path = parsed.pathname;
      this.fsPath = decodeURIComponent(parsed.pathname);
    }

    static parse(value: string): Uri {
      return new Uri(value);
    }

    static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri(
        `${base.toString().replace(/\/$/, '')}/${parts
          .map((part) => part.replace(/^\/+|\/+$/g, ''))
          .join('/')}`,
      );
    }

    toString(): string {
      return this.value;
    }
  }

  const root = new Uri('file:///workspace');
  return {
    Uri,
    FileType: { Unknown: 0, File: 1, Directory: 2 },
    workspace: {
      getWorkspaceFolder: (uri: Uri) =>
        uri.path === '/workspace' || uri.path.startsWith('/workspace/')
          ? { uri: root, name: 'workspace', index: 0 }
          : undefined,
      fs: {
        readFile: async (uri: Uri) => {
          const content = files.get(uri.toString());
          if (content === undefined) throw new Error('missing');
          return new TextEncoder().encode(content);
        },
        readDirectory: async (uri: Uri) => {
          const prefix = `${uri.toString().replace(/\/$/, '')}/`;
          const entries = new Map<string, number>();
          for (const file of files.keys()) {
            if (!file.startsWith(prefix)) continue;
            const relative = file.slice(prefix.length);
            if (!relative.includes('/')) entries.set(relative, 1);
          }
          for (const directory of directories) {
            if (!directory.startsWith(prefix)) continue;
            const relative = directory.slice(prefix.length);
            if (!relative.includes('/')) entries.set(relative, 2);
          }
          return [...entries];
        },
        stat: async (uri: Uri) => {
          const content = files.get(uri.toString());
          if (content !== undefined) {
            return {
              type: 1,
              ctime: 0,
              mtime: 0,
              size: new TextEncoder().encode(content).length,
            };
          }
          if (directories.has(uri.toString())) {
            return { type: 2, ctime: 0, mtime: 0, size: 0 };
          }
          throw new Error('missing');
        },
      },
    },
  };
});

import {
  evaluateZedDataCollection,
  isZedFileEligibleForDataCollection,
  NO_ZED_DATA_COLLECTION,
  zedPrivacyTesting,
} from '../../src/completion/zed/privacy';
import type { ZetaCompletionRequest } from '../../src/completion/model/requests';

const request: ZetaCompletionRequest & { readonly kind: 'zeta2.1' } = {
  kind: 'zeta2.1',
  document: {
    uri: 'file:///workspace/src/main.ts',
    path: 'src/main.ts',
    languageId: 'typescript',
    version: 1,
    text: 'const value = 1;',
    cursorOffset: 14,
  },
  trigger: 'explicit',
  editHistory: [
    {
      uri: 'file:///workspace/src/old.ts',
      path: 'src/old.ts',
      oldText: 'old',
      newText: 'new',
    },
  ],
  contexts: [
    {
      uri: 'file:///workspace/src/context.ts',
      path: 'src/context.ts',
      content: 'context',
    },
  ],
  diagnostics: [],
  options: {},
};

let resetRealpath: (() => void) | undefined;

beforeEach(() => {
  resetRealpath?.();
  resetRealpath = zedPrivacyTesting.setRealpathForTests(async (value) => value);
  files.clear();
  directories.clear();
  directories.add('file:///workspace/.git');
  files.set('file:///workspace/LICENSE', ZED_LICENSE_EXAMPLES['mit-ex0.txt']);
  files.set('file:///workspace/src/main.ts', 'const value = 1;');
  files.set('file:///workspace/src/old.ts', 'new');
  files.set('file:///workspace/src/context.ts', 'context');
  files.set(
    'file:///workspace/.git/config',
    '[remote "origin"]\nurl = https://user:secret@github.com/org/repo.git\n',
  );
});

afterEach(() => {
  resetRealpath?.();
  resetRealpath = undefined;
});

describe('Zed license pattern parity', () => {
  it('accepts each locked eligible license fixture', () => {
    for (const text of Object.values(ZED_LICENSE_EXAMPLES)) {
      expect(zedPrivacyTesting.recognizesOpenSourceLicense(text)).toBe(true);
    }
  });

  it('rejects truncated, modified, and over-limit license content', () => {
    const mit = ZED_LICENSE_EXAMPLES['mit-ex0.txt'];
    expect(zedPrivacyTesting.recognizesOpenSourceLicense(mit.slice(0, -80))).toBe(
      false,
    );
    expect(
      zedPrivacyTesting.recognizesOpenSourceLicense(
        `${mit}\nThe terms are void if P equals NP.`,
      ),
    ).toBe(false);
    expect(zedPrivacyTesting.approximateMaxLength).toBeGreaterThan(
      new TextEncoder().encode(ZED_LICENSE_EXAMPLES['apache-2.0-ex0.txt']).length,
    );
  });
});

describe('Zed data collection eligibility', () => {
  it('rechecks future-edit files with the full local eligibility boundary', async () => {
    await expect(
      isZedFileEligibleForDataCollection(
        'file:///workspace/src/context.ts',
        'src/context.ts',
      ),
    ).resolves.toBe(true);
    await expect(
      isZedFileEligibleForDataCollection(
        'file:///workspace/.env.future',
        '.env.future',
      ),
    ).resolves.toBe(false);

    resetRealpath?.();
    resetRealpath = zedPrivacyTesting.setRealpathForTests(async (value) =>
      value.endsWith('/src/context.ts') ? '/outside/context.ts' : value,
    );
    await expect(
      isZedFileEligibleForDataCollection(
        'file:///workspace/src/context.ts',
        'src/context.ts',
      ),
    ).resolves.toBe(false);
  });

  it('reports open source independently from user and organization opt-in', async () => {
    await expect(
      evaluateZedDataCollection(request, {
        dataCollectionEnabled: false,
        dataCollectionAllowed: true,
      }),
    ).resolves.toEqual({
      canCollectData: false,
      isInOpenSourceRepo: true,
    });
    await expect(
      evaluateZedDataCollection(request, {
        dataCollectionEnabled: true,
        dataCollectionAllowed: false,
      }),
    ).resolves.toEqual({
      canCollectData: false,
      isInOpenSourceRepo: true,
    });
  });

  it('allows a licensed local worktree and sanitizes its optional repo URL', async () => {
    await expect(
      evaluateZedDataCollection(request, {
        dataCollectionEnabled: true,
        dataCollectionAllowed: true,
      }),
    ).resolves.toEqual({
      canCollectData: true,
      isInOpenSourceRepo: true,
      repoUrl: 'https://github.com/org/repo.git',
    });

    directories.delete('file:///workspace/.git');
    files.delete('file:///workspace/.git/config');
    await expect(
      evaluateZedDataCollection(request, {
        dataCollectionEnabled: true,
        dataCollectionAllowed: true,
      }),
    ).resolves.toEqual({
      canCollectData: true,
      isInOpenSourceRepo: true,
    });
  });

  it('rejects unsafe, private, and unlicensed request files', async () => {
    await expect(
      evaluateZedDataCollection(
        {
          ...request,
          contexts: [
            {
              uri: 'file:///secret.ts',
              path: '../secret.ts',
              content: 'secret',
            },
          ],
        },
        { dataCollectionEnabled: true, dataCollectionAllowed: true },
      ),
    ).resolves.toEqual(NO_ZED_DATA_COLLECTION);

    await expect(
      evaluateZedDataCollection(
        {
          ...request,
          document: {
            ...request.document,
            uri: 'file:///workspace/.env.local',
            path: '.env.local',
          },
        },
        { dataCollectionEnabled: true, dataCollectionAllowed: true },
      ),
    ).resolves.toEqual(NO_ZED_DATA_COLLECTION);

    files.delete('file:///workspace/src/context.ts');
    await expect(
      evaluateZedDataCollection(request, {
        dataCollectionEnabled: true,
        dataCollectionAllowed: true,
      }),
    ).resolves.toEqual(NO_ZED_DATA_COLLECTION);
    files.set('file:///workspace/src/context.ts', 'context');

    resetRealpath?.();
    resetRealpath = zedPrivacyTesting.setRealpathForTests(async (value) =>
      value.endsWith('/src/context.ts') ? '/outside/context.ts' : value,
    );
    await expect(
      evaluateZedDataCollection(request, {
        dataCollectionEnabled: true,
        dataCollectionAllowed: true,
      }),
    ).resolves.toEqual(NO_ZED_DATA_COLLECTION);

    files.delete('file:///workspace/LICENSE');
    await expect(
      evaluateZedDataCollection(request, {
        dataCollectionEnabled: true,
        dataCollectionAllowed: true,
      }),
    ).resolves.toEqual(NO_ZED_DATA_COLLECTION);
  });
});
