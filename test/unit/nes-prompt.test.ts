import { describe, expect, it } from 'vitest';
import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
  validateCopilotBehaviorConfig,
} from '../../src/chat-lib/core/behavior-config';
import {
  buildOfficialNesPrompt,
  determineNesLanguageContextOptions,
} from '../../src/chat-lib/core/nes/prompt';
import {
  countNesLineTokens,
  countNesTokens,
} from '../../src/chat-lib/core/nes/tokenizer';
import type {
  NesDocumentContext,
  NesPromptContext,
} from '../../src/chat-lib/core/nes/types';

function document(
  relativePath: string,
  text: string,
  overrides: Partial<NesDocumentContext> = {},
): NesDocumentContext {
  return {
    uri: `file:///workspace/${relativePath}`,
    path: `/workspace/${relativePath}`,
    relativePath,
    languageId: 'typescript',
    version: 1,
    text,
    workspaceRoot: '/workspace',
    ...overrides,
  };
}

function context(): NesPromptContext {
  const current = document('src/main.ts', 'alpha\nbeta\ncharlie');
  return {
    current,
    cursorOffset: 'alpha\nbe'.length,
    selectedCompletionText: 'suggestWidgetText',
    recentDocuments: [
      document('src/viewed.ts', 'export const viewed = true;', {
        lastViewedAt: 100,
        visibleRanges: [{ start: 0, end: 27 }],
      }),
    ],
    editHistory: [
      {
        uri: current.uri,
        path: current.relativePath ?? current.path,
        languageId: current.languageId,
        before: 'alpha\nold\ncharlie',
        after: current.text,
        timestamp: 10,
      },
    ],
    diagnostics: [
      {
        message: 'beta is unused',
        severity: 'warning',
        startLine: 1,
        endLine: 1,
        source: 'ts',
        code: '6133',
      },
    ],
    languageContext: {
      symbols: [
        {
          name: 'Widget',
          detail: 'class',
          kind: 'Class',
          startLine: 0,
          endLine: 2,
        },
      ],
    },
    gitDiff: 'diff --git a/generated b/generated',
  };
}

function withPromptConfig(
  overrides: Partial<CopilotBehaviorConfig['prompt']>,
): CopilotBehaviorConfig {
  return {
    ...COPILOT_BEHAVIOR_CONFIG,
    prompt: { ...COPILOT_BEHAVIOR_CONFIG.prompt, ...overrides },
  };
}

describe('Xtab prompt configuration and budgeting', () => {
  it('uses the upstream floor(characters / 4) approximation', () => {
    expect(countNesTokens('')).toBe(0);
    expect(countNesTokens('abc')).toBe(0);
    expect(countNesTokens('abcd')).toBe(1);
    expect(countNesTokens('123456789')).toBe(2);
    expect(countNesLineTokens(['abc', '12345'])).toBe(3);
  });

  it('keeps disabled context out of the production-default prompt', () => {
    const result = buildOfficialNesPrompt(
      context(),
      'copilotNesXtab',
    );
    expect(result.messages.user).not.toContain('src/viewed.ts');
    expect(result.messages.user).not.toContain('beta is unused');
    expect(result.messages.user).not.toContain('Widget: class');
    expect(result.messages.user).not.toContain('diff --git');
    expect(result.messages.user).not.toContain('suggestWidgetText');
    expect(result.messages.user).toContain('<|code_to_edit|>');
    expect(result.messages.user).toContain('be<|cursor|>ta');
    expect(result.messages.user).toContain('--- /workspace/src/main.ts');
  });

  it('matches diagnostics enable-all language-context precedence', () => {
    expect(
      determineNesLanguageContextOptions(
        'typescript',
        COPILOT_BEHAVIOR_CONFIG,
      ),
    ).toEqual({ enabled: false, maxTokens: 2_000, traitPosition: 'before' });
    const enabled: CopilotBehaviorConfig = {
      ...COPILOT_BEHAVIOR_CONFIG,
      diagnosticsContextProvider: {
        enabled: true,
        enabledLanguages: { typescript: true },
      },
    };
    expect(determineNesLanguageContextOptions('typescript', enabled).enabled)
      .toBe(true);
    expect(buildOfficialNesPrompt(context(), 'copilotNesXtab', enabled).messages.user)
      .toContain('Widget: class');

    const explicitDisabled: CopilotBehaviorConfig = {
      ...enabled,
      prompt: {
        ...enabled.prompt,
        languageContextEnabledLanguages: { typescript: false },
      },
    };
    expect(
      determineNesLanguageContextOptions('typescript', explicitDisabled).enabled,
    ).toBe(false);
  });

  it('enables viewed files, lint formatting, language traits, and line numbers only through frozen options', () => {
    const config = withPromptConfig({
      recentFilesIncludeViewed: true,
      recentFilesLineNumbers: 'withoutSpaceAfter',
      languageContextEnabled: true,
      languageContextTraitPosition: 'before',
      currentFileLineNumbers: 'withoutSpaceAfter',
      lintOptions: {
        tagName: 'linter',
        warnings: 'yes',
        showCode: 'yesWithSurroundingLines',
        maxLints: 5,
        maxLineDistance: 10,
        nRecentFiles: 0,
      },
    });
    const result = buildOfficialNesPrompt(context(), 'xtab275', config);
    expect(result.messages.user).toContain('/workspace/src/viewed.ts');
    expect(result.messages.user).toContain('0|export const viewed = true;');
    expect(result.messages.user).toContain(
      '1:0 - warning TS6133: beta is unused',
    );
    expect(result.messages.user).toContain('0|alpha\n1|beta\n2|charlie');
    expect(result.messages.user.indexOf('Widget: class')).toBeLessThan(
      result.messages.user.indexOf('```'),
    );
  });

  it('validates global budget conservation before constructing a prompt', () => {
    const invalid = withPromptConfig({
      globalBudget: {
        totalTokens: 100,
        order: ['recentlyViewedDocuments', 'recentlyViewedDocuments'],
        shares: {
          currentFile: 0.2,
          recentlyViewedDocuments: 0.2,
          languageContext: 0.2,
          neighborFiles: 0.2,
          diffHistory: 0.2,
        },
      },
    });
    expect(() => validateCopilotBehaviorConfig(invalid)).toThrow(
      'duplicate part',
    );
  });
});
