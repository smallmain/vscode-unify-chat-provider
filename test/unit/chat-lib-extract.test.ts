import { describe, expect, it } from 'vitest';
import {
  externalPackageName,
  findBoundaryRule,
  planChatLibSnapshotPath,
  resolveRelativeImportCandidates,
  rewriteChatLibSnapshotSource,
} from '../../scripts/chat-lib-extract-utils';

describe('chat-lib extraction planning', () => {
  it('maps Copilot source paths into the committed snapshot tree', () => {
    expect(
      planChatLibSnapshotPath(
        'extensions/copilot/src/extension/xtab/common/tags.ts',
      ),
    ).toBe('src/chat-lib/upstream/extension/xtab/common/tags.ts');
    expect(() =>
      planChatLibSnapshotPath('src/unrelated.ts'),
    ).toThrow(/outside/);
    expect(
      planChatLibSnapshotPath('extensions/copilot/package.json'),
    ).toBe('src/chat-lib/upstream/_extension/package.json');
  });

  it('resolves generated pseudo-extension modules and package names', () => {
    expect(
      resolveRelativeImportCandidates(
        'extensions/copilot/src/platform/notebook/common/notebook.ts',
        './alternativeContentProvider.text',
      ),
    ).toContain(
      'extensions/copilot/src/platform/notebook/common/alternativeContentProvider.text.ts',
    );
    expect(externalPackageName('@vscode/prompt-tsx/render')).toBe(
      '@vscode/prompt-tsx',
    );
    expect(externalPackageName('yaml/browser')).toBe('yaml');
  });

  it('records host service replacements as explicit boundaries', () => {
    expect(
      findBoundaryRule(
        'extensions/copilot/src/platform/authentication/common/authentication.ts',
      )?.id,
    ).toBe('configured-model-auth');
    expect(
      findBoundaryRule(
        'extensions/copilot/src/extension/xtab/common/promptCrafting.ts',
      ),
    ).toBeUndefined();
  });

  it('plans TypeScript candidates for relative imports', () => {
    expect(
      resolveRelativeImportCandidates(
        'extensions/copilot/src/lib/node/chatLibMain.ts',
        '../../extension/xtab/common/tags',
      )[0],
    ).toBe('extensions/copilot/src/extension/xtab/common/tags.ts');
  });

  it('normalizes line endings and records exact source provenance', () => {
    expect(
      rewriteChatLibSnapshotSource(
        'export const value = true;\r\n',
        'extensions/copilot/src/example.ts',
        'abc123',
      ),
    ).toBe(
      '// Generated from microsoft/vscode@abc123: extensions/copilot/src/example.ts\nexport const value = true;\n',
    );
  });
});
