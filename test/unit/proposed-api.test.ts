import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  thinkingConstructor: undefined as unknown,
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
}));

vi.mock('vscode', () => {
  class LanguageModelChatMessage {
    static User(content: string): LanguageModelChatMessage {
      return new LanguageModelChatMessage(1, content);
    }

    constructor(
      readonly role: number,
      readonly content: string,
    ) {}
  }

  return {
    get LanguageModelThinkingPart(): unknown {
      return vscodeState.thinkingConstructor;
    },
    LanguageModelChatMessage,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    UIKind: { Desktop: 1, Web: 2 },
    env: {
      uiKind: 1,
      remoteName: undefined,
      appRoot: '/mock/vscode',
    },
    l10n: { t: (message: string, ...args: unknown[]) => {
      let result = message;
      args.forEach((value, index) => {
        result = result.replace(`{${index}}`, String(value));
      });
      return result;
    } },
  };
});

vi.mock('../../src/logger', () => ({ authLog: loggerMock }));
vi.mock('@vscode/sudo-prompt', () => ({ exec: vi.fn() }));

import * as vscode from 'vscode';
import {
  createProposedApiCapabilities,
  LANGUAGE_MODEL_THINKING_PART_PROPOSAL,
} from '../../src/proposed-api/capabilities';
import {
  parseDeclaredApiProposals,
  parseEnabledApiProposals,
  ProposedApiManifestError,
} from '../../src/proposed-api/manifest';
import {
  buildProductJsonElevatedCommand,
  createProductJsonEnvironment,
  createUpdatedProductRoot,
  inspectProductJson,
  isProductConfiguredForExtension,
  ProductJsonError,
  type ProductJsonEnvironment,
  writeProductJsonProposals,
} from '../../src/proposed-api/product-json';
import {
  createOutgoingLanguageModelMessages,
  mergeSystemInstructionsIntoUserMessage,
} from '../../src/proposed-api/system-message';
import {
  canUseLanguageModelThinkingPart,
  createLanguageModelThinkingPart,
  isLanguageModelThinkingPart,
} from '../../src/proposed-api/thinking';
import {
  buildProposedApiReminderDetail,
  createProposedApiReminderItems,
  hasProposedApiPurpose,
  isProposedApiReminderDue,
  PROPOSED_API_REMINDER_VERSION,
} from '../../src/proposed-api/reminder';

const proposals = [
  'languageModelSystem',
  'chatProvider',
  'inlineCompletionsAdditions',
  'contribSourceControlInputBoxMenu',
  'languageModelThinkingPart',
] as const;

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

function getProcessErrorValue(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, key)
    : undefined;
}

function getProcessErrorText(error: unknown, key: string): string | undefined {
  const value = getProcessErrorValue(error, key);
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : undefined;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ucp-proposed-api-'));
  temporaryDirectories.push(directory);
  return directory;
}

function decodeWindowsElevatedCommand(command: string): {
  readonly launcher: string;
  readonly elevatedCommand: string;
} {
  const encodedLauncher = command.slice(command.lastIndexOf(' ') + 1);
  const launcher = Buffer.from(encodedLauncher, 'base64').toString('utf16le');
  const elevatedCommand = launcher.match(
    /-ArgumentList '-NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)'/,
  )?.[1];
  if (!elevatedCommand) {
    throw new Error('Expected an encoded elevated PowerShell command.');
  }
  return { launcher, elevatedCommand };
}

function createEnvironment(
  appRoot: string,
  globalStoragePath: string,
  overrides: Partial<ProductJsonEnvironment> = {},
): ProductJsonEnvironment {
  return {
    uiKind: vscode.UIKind.Desktop,
    remoteName: undefined,
    appRoot,
    extensionId: 'SmallMain.vscode-unify-chat-provider',
    globalStoragePath,
    platform: process.platform,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

beforeEach(() => {
  vscodeState.thinkingConstructor = undefined;
  loggerMock.warn.mockClear();
});

describe('Proposed API manifest and capabilities', () => {
  it('preserves the declared order and rejects malformed declarations', () => {
    expect(parseDeclaredApiProposals({ enabledApiProposals: proposals })).toEqual(
      proposals,
    );
    for (const value of [
      {},
      { enabledApiProposals: 'languageModelSystem' },
      { enabledApiProposals: [''] },
      { enabledApiProposals: ['chatProvider', 'chatProvider'] },
    ]) {
      expect(() => parseDeclaredApiProposals(value)).toThrow(
        ProposedApiManifestError,
      );
    }
  });

  it('treats malformed effective lists as empty and deduplicates valid lists', () => {
    expect(parseEnabledApiProposals({})).toEqual([]);
    expect(
      parseEnabledApiProposals({ enabledApiProposals: 'chatProvider' }),
    ).toEqual([]);
    expect(
      parseEnabledApiProposals({
        enabledApiProposals: ['chatProvider', 'chatProvider'],
      }),
    ).toEqual(['chatProvider']);
  });

  it('uses the effective list for gates and only special-cases thinking', () => {
    const capabilities = createProposedApiCapabilities(
      { declared: proposals, enabled: ['chatProvider'] },
      { canUseLanguageModelThinkingPart: () => true },
    );
    expect(capabilities.enabled).toEqual(['chatProvider']);
    expect(capabilities.missing).toEqual([
      'languageModelSystem',
      'inlineCompletionsAdditions',
      'contribSourceControlInputBoxMenu',
      'languageModelThinkingPart',
    ]);
    expect(capabilities.isProposedCanUse('chatProvider')).toBe(true);
    expect(capabilities.isProposedCanUse('languageModelSystem')).toBe(false);
    expect(
      capabilities.isProposedCanUse(LANGUAGE_MODEL_THINKING_PART_PROPOSAL),
    ).toBe(true);
    expect(capabilities.isProposedCanUse('unknownProposal')).toBe(false);
  });

  it('keeps the reminder version independent and covers every manifest item', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    );
    const declared = parseDeclaredApiProposals(manifest);
    expect(PROPOSED_API_REMINDER_VERSION).toBe(1);
    expect(isProposedApiReminderDue(0)).toBe(true);
    expect(isProposedApiReminderDue(1)).toBe(false);
    expect(isProposedApiReminderDue(1, 2)).toBe(true);
    expect(declared).toEqual(proposals);
    expect(declared.every(hasProposedApiPurpose)).toBe(true);
  });

  it('shows concise proposal impacts without runtime status details', () => {
    const capabilities = createProposedApiCapabilities(
      { declared: proposals, enabled: [] },
      { canUseLanguageModelThinkingPart: () => true },
    );
    const detail = buildProposedApiReminderDetail(capabilities);

    expect(detail).toContain('This extension uses the following Proposed APIs:');
    expect(detail).toContain(
      '- inlineCompletionsAdditions: Disabling it makes code completion unavailable.',
    );
    expect(detail).toContain(
      'Do you agree to enable the features above by modifying product.json',
    );
    expect(detail).toContain(
      'permission is required)?\nThe extension will still work without them',
    );
    expect(detail).not.toContain('After a successful change');
    expect(detail).not.toContain('Current status');
    expect(detail).not.toContain('Currently missing');
    expect(detail).not.toContain('available at runtime');
  });

  it('uses exactly three actions with Enable as default and Later as close', () => {
    const items = createProposedApiReminderItems();

    expect(items.map((item) => item.title)).toEqual([
      'Enable',
      'Never Remind Again',
      'Later',
    ]);
    expect(items[0]?.isCloseAffordance).not.toBe(true);
    expect(items.filter((item) => item.isCloseAffordance)).toEqual([items[2]]);
  });
});

describe('Proposed API fallbacks', () => {
  it('merges pending System instructions into the first following User message', () => {
    expect(
      mergeSystemInstructionsIntoUserMessage(['first', 'second'], 'request'),
    ).toBe(
      '[System instructions]\nfirst\n\nsecond\n[End system instructions]\n\nrequest',
    );
    const messages = createOutgoingLanguageModelMessages(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'first user' },
        { role: 'user', content: 'second user' },
      ],
      false,
    );
    expect(messages.map((message) => message.role)).toEqual([1, 1]);
    expect(messages.map((message) => message.content)).toEqual([
      '[System instructions]\nsystem\n[End system instructions]\n\nfirst user',
      'second user',
    ]);
  });

  it('keeps real System messages when the proposal is available', () => {
    const messages = createOutgoingLanguageModelMessages(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ],
      true,
    );
    expect(messages.map((message) => message.role)).toEqual([3, 1]);
    expect(messages.map((message) => message.content)).toEqual([
      'system',
      'user',
    ]);
  });

  it('never constructs or tests against a missing thinking constructor', () => {
    expect(canUseLanguageModelThinkingPart()).toBe(false);
    expect(isLanguageModelThinkingPart({ value: 'private reasoning' })).toBe(
      false,
    );
    expect(createLanguageModelThinkingPart('private reasoning')).toBeUndefined();
    expect(createLanguageModelThinkingPart('again')).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it('constructs and recognizes thinking parts when the runtime provides it', () => {
    class ThinkingPart {
      constructor(
        readonly value: string | string[],
        readonly id?: string,
        readonly metadata?: object,
      ) {}
    }
    vscodeState.thinkingConstructor = ThinkingPart;
    const part = createLanguageModelThinkingPart('reasoning', 'id', {
      signature: 'sig',
    });
    expect(part).toBeInstanceOf(ThinkingPart);
    expect(isLanguageModelThinkingPart(part)).toBe(true);
  });
});

describe('product.json Proposed API configuration', () => {
  it('replaces only this extension entry and removes case-insensitive duplicates', () => {
    const original = {
      nameShort: 'Code',
      applicationName: 'code',
      stableField: { preserved: true },
      extensionEnabledApiProposals: {
        'other.extension': ['otherProposal'],
        'smallmain.vscode-unify-chat-provider': ['oldProposal'],
        'SmallMain.VSCode-Unify-Chat-Provider': ['duplicateProposal'],
      },
    };
    const updated = createUpdatedProductRoot(
      original,
      'SmallMain.vscode-unify-chat-provider',
      proposals,
    );
    expect(updated['stableField']).toEqual({ preserved: true });
    expect(updated['extensionEnabledApiProposals']).toEqual({
      'other.extension': ['otherProposal'],
      'SmallMain.vscode-unify-chat-provider': proposals,
    });
    expect(
      isProductConfiguredForExtension(
        updated,
        'smallmain.vscode-unify-chat-provider',
        proposals,
      ),
    ).toBe(true);
  });

  it('backs up, writes, verifies, and then becomes a no-op in a fixture', async () => {
    const appRoot = await createTemporaryDirectory();
    const globalStorage = await createTemporaryDirectory();
    const productPath = join(appRoot, 'product.json');
    const original = {
      nameShort: 'Code',
      applicationName: 'code',
      stableField: ['preserve', 1],
      extensionEnabledApiProposals: {
        'other.extension': ['otherProposal'],
      },
    };
    const originalText = `${JSON.stringify(original, undefined, 2)}\n`;
    await writeFile(productPath, originalText);
    const environment = createEnvironment(appRoot, globalStorage);

    expect((await inspectProductJson(environment, proposals)).configured).toBe(
      false,
    );
    const result = await writeProductJsonProposals(environment, proposals);
    expect(result.changed).toBe(true);
    expect(result.elevated).toBe(false);
    expect(result.backupPath).toBeDefined();
    if (!result.backupPath) throw new Error('Expected a product.json backup.');
    expect(await readFile(result.backupPath, 'utf8')).toBe(originalText);

    const written: unknown = JSON.parse(await readFile(productPath, 'utf8'));
    expect(written).toEqual({
      ...original,
      extensionEnabledApiProposals: {
        'other.extension': ['otherProposal'],
        'SmallMain.vscode-unify-chat-provider': proposals,
      },
    });
    expect((await inspectProductJson(environment, proposals)).configured).toBe(
      true,
    );
    expect(await writeProductJsonProposals(environment, proposals)).toMatchObject(
      { changed: false, configured: true, elevated: false },
    );
  });

  it('rejects remote and Web hosts before reading any product file', async () => {
    const appRoot = await createTemporaryDirectory();
    const storage = await createTemporaryDirectory();
    await expect(
      inspectProductJson(
        createEnvironment(appRoot, storage, { remoteName: 'ssh-remote' }),
        proposals,
      ),
    ).rejects.toMatchObject({ code: 'unsupported-remote' });
    await expect(
      inspectProductJson(
        createEnvironment(appRoot, storage, { uiKind: vscode.UIKind.Web }),
        proposals,
      ),
    ).rejects.toMatchObject({ code: 'unsupported-web' });
  });

  it('rejects an invalid product marker and proposal map', () => {
    expect(() =>
      createUpdatedProductRoot(
        { nameShort: 'Code' },
        'SmallMain.vscode-unify-chat-provider',
        proposals,
      ),
    ).toThrow(ProductJsonError);
    expect(() =>
      createUpdatedProductRoot(
        {
          nameShort: 'Code',
          applicationName: 'code',
          extensionEnabledApiProposals: [],
        },
        'SmallMain.vscode-unify-chat-provider',
        proposals,
      ),
    ).toThrow(ProductJsonError);
  });

  it('uses a direct encoded UAC launcher and rejects unsafe elevated paths', () => {
    const environment = createEnvironment('C:\\Code', 'C:\\Storage', {
      platform: 'win32',
    });
    const command = buildProductJsonElevatedCommand(
      environment,
      "C:\\Storage\\stage's.json",
      'C:\\Code\\product.json',
      0o644,
      'a'.repeat(64),
    );
    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /,
    );
    const { launcher, elevatedCommand } =
      decodeWindowsElevatedCommand(command);
    expect(launcher).toContain('Start-Process');
    expect(launcher).toContain('-Verb RunAs -Wait -PassThru');
    expect(launcher).toContain('exit 72');
    expect(launcher).not.toContain('{;');
    const elevatedScript = Buffer.from(elevatedCommand, 'base64').toString(
      'utf16le',
    );
    expect(elevatedScript).toContain('Copy-Item -LiteralPath');
    expect(elevatedScript).toContain("'C:\\Storage\\stage''s.json'");
    expect(elevatedScript).toContain(
      '[System.Security.Cryptography.SHA256]::Create()',
    );
    expect(elevatedScript).not.toContain('Get-FileHash');
    expect(elevatedScript).toContain(
      '[System.IO.File]::Replace(',
    );
    expect(elevatedScript).toContain('$null, $true)');
    expect(elevatedScript).toContain('exit 73');
    expect(elevatedScript).toContain('exit 74');
    expect(elevatedScript).not.toContain('{;');
    expect(elevatedScript).toMatch(/\nexit 0$/);
    expect(() =>
      buildProductJsonElevatedCommand(
        environment,
        ['C:\\unsafe', 'path'].join('\n'),
        'C:\\Code\\product.json',
        0o644,
        'a'.repeat(64),
      ),
    ).toThrow(ProductJsonError);
  });

  it('executes the generated product replacement script with Windows PowerShell', async () => {
    if (process.platform !== 'win32') return;
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, "stage file's.json");
    const targetPath = join(directory, 'product.json');
    const original = Buffer.from('original product');
    const replacement = Buffer.from('replacement product');
    await Promise.all([
      writeFile(sourcePath, replacement),
      writeFile(targetPath, original),
    ]);
    const command = buildProductJsonElevatedCommand(
      createEnvironment(directory, directory, { platform: 'win32' }),
      sourcePath,
      targetPath,
      0o644,
      createHash('sha256').update(original).digest('hex'),
    );
    const { elevatedCommand } = decodeWindowsElevatedCommand(command);
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      elevatedCommand,
    ];

    try {
      await execFileAsync('powershell.exe', args);
    } catch (error) {
      let diagnostic = '';
      try {
        diagnostic = await readFile(
          `${sourcePath}.elevated-error.txt`,
          'utf8',
        );
      } catch {
        // The elevated script may fail before it can create diagnostics.
      }
      const currentTarget = await readFile(targetPath);
      const exitCode = getProcessErrorValue(error, 'code');
      const stderr = getProcessErrorText(error, 'stderr')?.trim();
      const stdout = getProcessErrorText(error, 'stdout')?.trim();
      throw new Error(
        [
          `PowerShell replacement failed with exit code ${String(exitCode)}.`,
          `Target state: ${currentTarget.equals(replacement) ? 'replacement' : 'original-or-other'}.`,
          diagnostic.trim() ? `Diagnostic: ${diagnostic.trim()}` : undefined,
          stderr ? `stderr: ${stderr}` : undefined,
          stdout ? `stdout: ${stdout}` : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join('\n')
          .slice(0, 8_000),
      );
    }
    expect(await readFile(targetPath)).toEqual(replacement);
    await expect(execFileAsync('powershell.exe', args)).rejects.toMatchObject({
      code: 73,
    });
    expect(await readFile(targetPath)).toEqual(replacement);
  });

  it('survives the double-quoted shell used by sudo-prompt on POSIX', async () => {
    if (process.platform === 'win32') return;
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, "stage file's.json");
    const targetPath = join(directory, 'product.json');
    const original = Buffer.from('original product');
    const replacement = Buffer.from('replacement product');
    await Promise.all([
      writeFile(sourcePath, replacement),
      writeFile(targetPath, original),
    ]);
    const command = buildProductJsonElevatedCommand(
      createEnvironment(directory, directory, { platform: 'linux' }),
      sourcePath,
      targetPath,
      0o644,
      createHash('sha256').update(original).digest('hex'),
    );
    expect(command).not.toMatch(/[$`"]/);
    const encodedScript = command.match(
      /printf %s ([A-Za-z0-9+/=]+) \|/,
    )?.[1];
    expect(encodedScript).toBeDefined();
    if (!encodedScript) {
      throw new Error('Expected an encoded POSIX replacement script.');
    }
    expect(Buffer.from(encodedScript, 'base64').toString('utf8')).toContain(
      'current_hash=$(sha256sum',
    );

    const sudoPromptCommand = `/bin/bash -c "echo SUDOPROMPT; ${command.replaceAll(
      '"',
      '\\"',
    )}"`;
    await execFileAsync('/bin/sh', ['-c', sudoPromptCommand]);
    expect(await readFile(targetPath)).toEqual(replacement);
    await expect(
      execFileAsync('/bin/sh', ['-c', sudoPromptCommand]),
    ).rejects.toMatchObject({ code: 73 });
    expect(await readFile(targetPath)).toEqual(replacement);
  });

  it('derives the runtime environment without using the package version', () => {
    const environment = createProductJsonEnvironment({
      extension: { id: 'publisher.extension' },
      globalStorageUri: { fsPath: '/tmp/ucp-storage' },
    });
    expect(environment.extensionId).toBe('publisher.extension');
    expect(environment).not.toHaveProperty('extensionVersion');
  });
});
