import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { CopilotWorkspaceContext } from '../../src/completion/copilot/workspace';
import { coreContextFromWorkspace } from '../support/copilot-fim';

describe('Copilot FIM workspace context', () => {
  it('disables plaintext, markdown, and SCM input by default with explicit overrides', async () => {
    const { isCopilotLanguageEnabled } =
      await import('../../src/completion/copilot/fim-runtime-utils');

    expect(isCopilotLanguageEnabled('typescript')).toBe(true);
    expect(isCopilotLanguageEnabled('plaintext')).toBe(false);
    expect(isCopilotLanguageEnabled('markdown')).toBe(false);
    expect(isCopilotLanguageEnabled('scminput')).toBe(false);
    expect(isCopilotLanguageEnabled('markdown', { markdown: true })).toBe(true);
    expect(isCopilotLanguageEnabled('typescript', { '*': false })).toBe(false);
  });

  it('builds the official selected-completion proposed edit at the original document position', async () => {
    const { selectedCompletionProposedEdits } =
      await import('../../src/completion/copilot/fim-runtime-utils');
    const text = 'const ab = 1;';
    const offsetAt = (position: vscode.Position): number => position.character;
    const document = {
      getText: () => text,
      offsetAt,
    } as vscode.TextDocument;
    const range = {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 8 },
    } as vscode.Range;

    expect(
      selectedCompletionProposedEdits(
        document,
        { line: 0, character: 8 } as vscode.Position,
        { text: 'alpha', range },
      ),
    ).toEqual([
      {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 8 },
        },
        newText: 'alpha',
        positionAfterEdit: { line: 0, character: 11 },
        source: 'selectedCompletionInfo',
      },
    ]);
    expect(
      selectedCompletionProposedEdits(
        document,
        { line: 0, character: 8 } as vscode.Position,
        { text: 'call()', range },
      ),
    ).toBeUndefined();
  });

  it('starts recent-edit tracking lazily and emits later edits after 500ms', async () => {
    const current = {
      uri: 'file:///workspace/current.ts',
      path: '/workspace/current.ts',
      relativePath: 'current.ts',
      scheme: 'file',
      languageId: 'typescript',
      version: 1,
      text: 'const current = true;',
      visibleRanges: [],
      lastViewedAt: 3,
      lastEditedAt: 3,
    } as const;
    const document = (name: string, viewedAt: number) => ({
      ...current,
      uri: `file:///workspace/${name}`,
      path: `/workspace/${name}`,
      relativePath: name,
      text: `export const ${name.replace('.ts', '')} = true;`,
      lastViewedAt: viewedAt,
    });
    const edit = (
      name: string,
      timestamp: number,
    ): CopilotWorkspaceContext['editHistory'][number] => ({
      uri: `file:///workspace/${name}`,
      path: name,
      relativePath: name,
      languageId: 'typescript',
      before: `old ${name}`,
      after: `new ${name}`,
      timestamp,
      reason: 'other',
      changes: [],
    });
    const preStart = edit('pre-start.ts', 1);
    const base = {
      current,
      ignored: false,
      recentDocuments: [
        document('recent.ts', 4),
        document('newest.ts', 3),
        document('older.ts', 2),
        document('pre-start.ts', 1),
      ],
      editHistory: [preStart],
      neighborSnippets: [],
      diagnostics: [],
      promptDiagnostics: [],
      languageContext: { items: [], diagnostics: [], symbols: [] },
    } satisfies CopilotWorkspaceContext;
    const { FimWorkspaceContextAdapter } =
      await import('../../src/completion/copilot/fim-runtime-utils');
    const adapter = new FimWorkspaceContextAdapter();

    const first = adapter.adapt(base, 1);
    expect(first.recentEdits).toEqual([]);

    const afterStart = {
      ...base,
      editHistory: [edit('newest.ts', 3), edit('older.ts', 2), preStart],
    } satisfies CopilotWorkspaceContext;
    expect(adapter.adapt(afterStart, 3).recentEdits).toEqual([]);
    expect(adapter.adapt(afterStart, 501).recentEdits).toEqual([]);

    const result = adapter.adapt(afterStart, 503);
    expect(result.recentEdits?.map((entry) => entry.path)).toEqual([
      'older.ts',
      'newest.ts',
    ]);
    expect(result.recentEdits).toMatchObject([
      { startLine: 0, endLine: 0 },
      { startLine: 0, endLine: 0 },
    ]);
    expect(result.recentEdits?.map((entry) => entry.path)).not.toContain(
      'pre-start.ts',
    );
    expect(result.similarFiles?.map((entry) => entry.path)).toEqual([
      'recent.ts',
      'newest.ts',
      'older.ts',
      'pre-start.ts',
    ]);
  });

  it('hides tracked edits once their source is closed, unavailable, or ignored', async () => {
    const current = {
      uri: 'file:///workspace/current.ts',
      path: '/workspace/current.ts',
      relativePath: 'current.ts',
      scheme: 'file',
      languageId: 'typescript',
      version: 1,
      text: 'const current = true;',
      visibleRanges: [],
      lastViewedAt: 3,
      lastEditedAt: 3,
    } as const;
    const source = {
      ...current,
      uri: 'file:///workspace/source.ts',
      path: '/workspace/source.ts',
      relativePath: 'source.ts',
      text: 'export const source = true;',
      lastViewedAt: 2,
    };
    const base = {
      current,
      ignored: false,
      recentDocuments: [source],
      editHistory: [],
      neighborSnippets: [],
      diagnostics: [],
      promptDiagnostics: [],
      languageContext: { items: [], diagnostics: [], symbols: [] },
    } satisfies CopilotWorkspaceContext;
    const { FimWorkspaceContextAdapter } =
      await import('../../src/completion/copilot/fim-runtime-utils');
    const adapter = new FimWorkspaceContextAdapter();
    adapter.adapt(base, 0);
    const edited = {
      ...base,
      editHistory: [
        {
          uri: source.uri,
          path: source.path,
          relativePath: source.relativePath,
          languageId: source.languageId,
          before: 'export const source = false;',
          after: source.text,
          timestamp: 1,
          reason: 'other' as const,
          changes: [],
        },
      ],
    } satisfies CopilotWorkspaceContext;

    expect(adapter.adapt(edited, 501).recentEdits).toHaveLength(1);
    expect(
      adapter.adapt({ ...edited, recentDocuments: [] }, 502).recentEdits,
    ).toEqual([]);
  });

  it('maps provider traits and snippets while deduplicating OpenTab and neighbor sources', async () => {
    const current = {
      uri: 'file:///workspace/src/current.ts',
      path: '/workspace/src/current.ts',
      relativePath: 'src/current.ts',
      scheme: 'file',
      languageId: 'typescript',
      version: 1,
      text: 'function current() { return sharedValue; }',
      visibleRanges: [],
      lastViewedAt: 100,
      lastEditedAt: 100,
    } as const;
    const workspace = {
      current,
      ignored: false,
      recentDocuments: [
        {
          ...current,
          uri: 'file:///workspace/src/provider.ts',
          path: '/workspace/src/provider.ts',
          relativePath: 'src/provider.ts',
          text: 'export const providerOpenTab = sharedValue;',
          lastViewedAt: 90,
        },
        {
          ...current,
          uri: 'file:///workspace/src/open-only.ts',
          path: '/workspace/src/open-only.ts',
          relativePath: 'src/open-only.ts',
          text: 'export const openOnly = sharedValue;',
          lastViewedAt: 80,
        },
      ],
      editHistory: [],
      diagnostics: [],
      promptDiagnostics: [],
      neighborSnippets: [
        {
          uri: 'file:///workspace/src/provider.ts',
          path: 'src/provider.ts',
          snippet: 'duplicate provider neighbor',
          startLine: 0,
          score: 1,
          source: 'open-tab',
        },
        {
          uri: 'file:///workspace/src/neighbor-only.ts',
          path: 'src/neighbor-only.ts',
          snippet: 'export const neighborOnly = sharedValue;',
          startLine: 0,
          score: 0.9,
          source: 'related-provider',
        },
      ],
      languageContext: {
        items: [
          { kind: 'trait', name: 'Framework', value: 'Vitest' },
          {
            kind: 'snippet',
            uri: 'file:///workspace/src/provider.ts',
            path: 'src/provider.ts',
            value: 'export const targetedProvider = sharedValue;',
          },
        ],
        symbols: [],
      },
    } satisfies CopilotWorkspaceContext;
    const result = coreContextFromWorkspace(workspace);

    expect(result.traits).toEqual([{ name: 'Framework', value: 'Vitest' }]);
    expect(result.codeSnippets).toEqual([
      {
        path: 'src/provider.ts',
        value: 'export const targetedProvider = sharedValue;',
      },
    ]);
    expect(result.similarFiles?.map((file) => file.path)).toEqual([
      'src/open-only.ts',
      'src/neighbor-only.ts',
    ]);
  });

  it('orders OpenTab candidates by access time and applies the 200k aggregate cap', async () => {
    const current = {
      uri: 'file:///workspace/current.ts',
      path: '/workspace/current.ts',
      relativePath: 'current.ts',
      scheme: 'file',
      languageId: 'typescript',
      version: 1,
      text: 'current',
      visibleRanges: [],
      lastViewedAt: 100,
      lastEditedAt: 100,
    } as const;
    const document = (
      name: string,
      lastViewedAt: number,
      overrides: Partial<CopilotWorkspaceContext['current']> = {},
    ): CopilotWorkspaceContext['current'] => ({
      ...current,
      uri: `file:///workspace/${name}`,
      path: `/workspace/${name}`,
      relativePath: name,
      text: name,
      lastViewedAt,
      lastEditedAt: lastViewedAt,
      ...overrides,
    });
    const recentDocuments = [
      document('old.ts', 1),
      document('new.tsx', 30, { languageId: 'typescriptreact' }),
      document('wrong.js', 40, { languageId: 'javascript' }),
      document('untitled.ts', 50, {
        uri: 'untitled:untitled.ts',
        scheme: 'untitled',
      }),
      document('too-large.ts', 60, { text: 'x'.repeat(200_001) }),
      document('almost-full.ts', 20, { text: 'a'.repeat(199_987) }),
      document('does-not-fit.ts', 19, { text: '1234567' }),
      document('fills-cap.ts', 18, { text: '123456' }),
      ...Array.from({ length: 25 }, (_value, index) =>
        document(`later-${index}.ts`, -index),
      ),
    ];
    const workspace = {
      current,
      ignored: false,
      recentDocuments,
      editHistory: [],
      diagnostics: [],
      promptDiagnostics: [],
      neighborSnippets: [],
      languageContext: { items: [], symbols: [] },
    } satisfies CopilotWorkspaceContext;
    const result = coreContextFromWorkspace(workspace);

    expect(result.similarFiles?.map((file) => file.path)).toEqual([
      'new.tsx',
      'almost-full.ts',
      'fills-cap.ts',
    ]);
    expect(
      result.similarFiles?.some((file) => file.path === 'too-large.ts'),
    ).toBe(false);
  });

  it('keeps the 20 newest OpenTabs and appends related candidates afterwards', async () => {
    const current = {
      uri: 'file:///workspace/current.ts',
      path: '/workspace/current.ts',
      relativePath: 'current.ts',
      scheme: 'file',
      languageId: 'typescript',
      version: 1,
      text: 'current',
      visibleRanges: [],
      lastViewedAt: 100,
      lastEditedAt: 100,
    } as const;
    const oldest = {
      ...current,
      uri: 'file:///workspace/oldest-relevant.ts',
      path: '/workspace/oldest-relevant.ts',
      relativePath: 'oldest-relevant.ts',
      text: 'high lexical relevance must not change access ordering',
      lastViewedAt: 0,
    };
    const recentDocuments = [
      oldest,
      ...Array.from({ length: 20 }, (_value, index) => ({
        ...current,
        uri: `file:///workspace/recent-${index}.ts`,
        path: `/workspace/recent-${index}.ts`,
        relativePath: `recent-${index}.ts`,
        text: `recent ${index}`,
        lastViewedAt: index + 1,
      })),
    ];
    const workspace = {
      current,
      ignored: false,
      recentDocuments,
      editHistory: [],
      diagnostics: [],
      promptDiagnostics: [],
      neighborSnippets: [
        {
          uri: 'file:///workspace/related.ts',
          path: 'related.ts',
          snippet: 'related context',
          startLine: 0,
          score: 1,
          source: 'related-provider',
        },
        {
          uri: oldest.uri,
          path: oldest.relativePath,
          snippet: oldest.text,
          startLine: 0,
          score: 0.99,
          source: 'open-tab',
        },
      ],
      languageContext: { items: [], symbols: [] },
    } satisfies CopilotWorkspaceContext;
    expect(
      coreContextFromWorkspace(workspace).similarFiles?.map(
        (file) => file.path,
      ),
    ).toEqual([
      ...Array.from(
        { length: 20 },
        (_value, index) => `recent-${19 - index}.ts`,
      ),
      'related.ts',
    ]);
  });

  it('limits C++ OpenTabs to 20 before core related-file matching', async () => {
    const recentDocuments = Array.from({ length: 25 }, (_value, index) => ({
      uri: `file:///workspace/${index}.ts`,
      path: `/workspace/${index}.ts`,
      relativePath: `${index}.ts`,
      scheme: 'file',
      languageId: 'cpp',
      version: 1,
      text: String(index),
      visibleRanges: [],
      lastViewedAt: index,
      lastEditedAt: index,
    }));
    const workspace = {
      current: {
        ...recentDocuments[0],
        uri: 'file:///workspace/current.ts',
        path: '/workspace/current.ts',
        relativePath: 'current.ts',
      },
      ignored: false,
      recentDocuments,
      editHistory: [],
      diagnostics: [],
      promptDiagnostics: [],
      neighborSnippets: [],
      languageContext: { items: [], symbols: [] },
    } satisfies CopilotWorkspaceContext;
    expect(
      coreContextFromWorkspace(workspace).similarFiles?.map(
        (file) => file.path,
      ),
    ).toEqual(
      Array.from({ length: 20 }, (_value, index) => `${24 - index}.ts`),
    );
  });

  it('preserves the diagnostic start column in the FIM prompt context', async () => {
    const workspace = {
      current: {
        uri: 'file:///workspace/current.ts',
        path: '/workspace/current.ts',
        relativePath: 'current.ts',
        scheme: 'file',
        languageId: 'typescript',
        version: 1,
        text: 'current',
        visibleRanges: [],
        lastViewedAt: 1,
        lastEditedAt: 1,
      },
      ignored: false,
      recentDocuments: [],
      editHistory: [],
      diagnostics: [
        {
          uri: 'file:///workspace/current.ts',
          path: '/workspace/current.ts',
          message: 'column-sensitive',
          severity: 'error',
          startLine: 3,
          startCharacter: 7,
          endLine: 3,
          endCharacter: 9,
        },
      ],
      promptDiagnostics: [],
      neighborSnippets: [],
      languageContext: { items: [], symbols: [] },
    } satisfies CopilotWorkspaceContext;
    expect(
      coreContextFromWorkspace(workspace, {
        defaultDiagnostics: {
          warnings: 'no',
          maxLineDistance: 10,
          maxDiagnostics: 5,
        },
      }).diagnostics,
    ).toEqual([expect.objectContaining({ line: 3, character: 7 })]);
  });

  it('keeps default diagnostics disabled without a treatment and filters enabled diagnostics by severity, distance, and count', async () => {
    const current = {
      uri: 'file:///workspace/current.ts',
      path: '/workspace/current.ts',
      relativePath: 'current.ts',
      scheme: 'file',
      languageId: 'typescript',
      version: 1,
      text: Array.from({ length: 12 }, (_, index) => `line ${index}`).join(
        '\n',
      ),
      visibleRanges: [],
      lastViewedAt: 1,
      lastEditedAt: 1,
    } as const;
    const diagnostic = (
      message: string,
      severity: 'error' | 'warning' | 'information' | 'hint',
      line: number,
    ) => ({
      uri: current.uri,
      path: current.path,
      message,
      severity,
      startLine: line,
      startCharacter: 0,
      endLine: line,
      endCharacter: 1,
    });
    const workspace = {
      current,
      ignored: false,
      recentDocuments: [],
      editHistory: [],
      diagnostics: [
        diagnostic('nearest warning', 'warning', 5),
        diagnostic('near error', 'error', 6),
        diagnostic('second error', 'error', 3),
        diagnostic('far error', 'error', 11),
        diagnostic('information', 'information', 5),
      ],
      promptDiagnostics: [],
      neighborSnippets: [],
      languageContext: { items: [], symbols: [] },
    } satisfies CopilotWorkspaceContext;
    const cursorOffset = current.text.indexOf('line 5');

    expect(
      coreContextFromWorkspace(workspace, { cursorOffset }).diagnostics,
    ).toEqual([]);
    expect(
      coreContextFromWorkspace(workspace, {
        cursorOffset,
        defaultDiagnostics: {
          warnings: 'yes',
          maxLineDistance: 3,
          maxDiagnostics: 2,
        },
      }).diagnostics?.map((entry) => entry.message),
    ).toEqual(['nearest warning', 'near error']);
    expect(
      coreContextFromWorkspace(workspace, {
        cursorOffset,
        defaultDiagnostics: {
          warnings: 'yesIfNoErrors',
          maxLineDistance: 3,
          maxDiagnostics: 5,
        },
      }).diagnostics?.map((entry) => entry.message),
    ).toEqual(['near error', 'second error']);
  });

  it('lets provider diagnostic bags override defaults for the same URI and deduplicates them', async () => {
    const providerDiagnostic = {
      uri: 'file:///workspace/current.ts',
      path: '/workspace/current.ts',
      message: 'provider diagnostic',
      severity: 'warning' as const,
      startLine: 0,
      startCharacter: 2,
      endLine: 0,
      endCharacter: 4,
      importance: 80,
    };
    const workspace = {
      current: {
        uri: 'file:///workspace/current.ts',
        path: '/workspace/current.ts',
        relativePath: 'current.ts',
        scheme: 'file',
        languageId: 'typescript',
        version: 1,
        text: 'current',
        visibleRanges: [],
        lastViewedAt: 1,
        lastEditedAt: 1,
      },
      ignored: false,
      recentDocuments: [],
      editHistory: [],
      diagnostics: [
        {
          ...providerDiagnostic,
          message: 'default diagnostic',
          severity: 'error' as const,
          importance: undefined,
        },
      ],
      promptDiagnostics: [],
      neighborSnippets: [],
      languageContext: {
        items: [],
        symbols: [],
        diagnostics: [providerDiagnostic, providerDiagnostic],
      },
    } satisfies CopilotWorkspaceContext;

    expect(
      coreContextFromWorkspace(workspace, {
        defaultDiagnostics: {
          warnings: 'yes',
          maxLineDistance: 10,
          maxDiagnostics: 5,
        },
      }).diagnostics,
    ).toEqual([
      expect.objectContaining({
        message: 'provider diagnostic',
        importance: 80,
      }),
    ]);
  });

  it('retains out-of-workspace context content without exposing paths or URIs', async () => {
    const current = {
      uri: 'file:///workspace/current.ts',
      path: '/workspace/current.ts',
      relativePath: 'current.ts',
      scheme: 'file',
      languageId: 'typescript',
      version: 1,
      text: 'const current = true;',
      visibleRanges: [],
      lastViewedAt: 10,
      lastEditedAt: 10,
    } as const;
    const outside = (
      name: string,
      languageId = 'typescript',
    ): CopilotWorkspaceContext['current'] => ({
      ...current,
      uri: `file:///private/outside/${name}`,
      path: `/private/outside/${name}`,
      relativePath: undefined,
      languageId,
      text: `export const ${name.replace('.ts', '')} = true;`,
    });
    const open = outside('open.ts');
    const related = outside('related.ts', 'javascript');
    const language = outside('language.ts');
    const editedDocument = outside('edited.ts', 'javascript');
    const diagnosticUri = 'file:///private/outside/diagnostic.ts';
    const base = {
      current,
      ignored: false,
      recentDocuments: [open, related, language, editedDocument],
      editHistory: [],
      diagnostics: [],
      promptDiagnostics: [],
      neighborSnippets: [
        {
          uri: related.uri,
          path: 'related.ts',
          snippet: 'export const relatedNeighbor = true;',
          startLine: 0,
          score: 1,
          source: 'related-provider' as const,
        },
      ],
      languageContext: {
        items: [
          {
            kind: 'snippet' as const,
            uri: language.uri,
            path: '/private/outside/language.ts',
            value: 'export const languageSnippet = true;',
          },
        ],
        symbols: [],
        diagnostics: [
          {
            uri: diagnosticUri,
            path: '/private/outside/diagnostic.ts',
            message: 'outside diagnostic content',
            severity: 'warning' as const,
            startLine: 0,
            startCharacter: 1,
            endLine: 0,
            endCharacter: 2,
          },
        ],
      },
    } satisfies CopilotWorkspaceContext;
    const { FimWorkspaceContextAdapter } =
      await import('../../src/completion/copilot/fim-runtime-utils');
    const adapter = new FimWorkspaceContextAdapter();
    adapter.adapt(base, 0);
    const edited = {
      ...base,
      editHistory: [
        {
          uri: editedDocument.uri,
          path: editedDocument.path,
          relativePath: undefined,
          languageId: editedDocument.languageId,
          before: 'export const edited = false;',
          after: editedDocument.text,
          timestamp: 1,
          reason: 'other' as const,
          changes: [],
        },
      ],
    } satisfies CopilotWorkspaceContext;
    adapter.adapt(edited, 1);
    const result = adapter.adapt(edited, 501);

    expect(result.similarFiles?.map((file) => file.path)).toEqual(['', '']);
    expect(result.similarFiles?.map((file) => file.content)).toEqual([
      open.text,
      'export const relatedNeighbor = true;',
    ]);
    expect(result.codeSnippets).toEqual([
      { path: '', value: 'export const languageSnippet = true;' },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        path: '',
        message: 'outside diagnostic content',
      }),
    ]);
    expect(result.recentEdits).toHaveLength(1);
    expect(result.recentEdits?.[0].path).toBe('');
    expect(result.recentEdits?.[0].summary).toContain(
      'export const edited = true;',
    );

    const wireVisibleText = [
      ...(result.similarFiles ?? []).map((file) => file.content),
      ...(result.codeSnippets ?? []).map((snippet) => snippet.value),
      ...(result.diagnostics ?? []).map((diagnostic) => diagnostic.message),
      ...(result.recentEdits ?? []).map((edit) => edit.summary),
    ].join('\n');
    expect(wireVisibleText).not.toContain('/private/outside');
    expect(wireVisibleText).not.toContain('file:///private/outside');
  });
});
