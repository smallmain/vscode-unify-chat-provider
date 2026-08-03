import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
}));

vi.mock('../../src/client/utils', () => ({
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
}));

import { WELL_KNOWN_MODELS } from '../../src/well-known/models';
import { WELL_KNOWN_PROVIDERS } from '../../src/well-known/providers';

function getFeatureBlock(source: string, featureId: string): string {
  const marker = `[FeatureId.${featureId}]: {`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Feature ${featureId} was not found`);
  }

  const rest = source.slice(start);
  const end = rest.indexOf('\n  },\n  [FeatureId.');
  return end < 0 ? rest : rest.slice(0, end);
}

describe('Claude Opus 5 catalog support', () => {
  const model = WELL_KNOWN_MODELS.find(
    (candidate) => candidate.id === 'claude-opus-5',
  );

  it('declares the official model limits and default thinking behavior', () => {
    expect(model).toMatchObject({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      maxInputTokens: 1000000,
      maxOutputTokens: 128000,
      stream: true,
      thinking: {
        type: 'auto',
        effort: 'high',
        summary: 'auto',
      },
      capabilities: {
        toolCalling: true,
        imageInput: true,
        editTools: 'multi-find-replace',
      },
    });
  });

  it('exposes every supported effort level with high as the default', () => {
    const effortTemplate = model?.presetTemplates?.find(
      (template) => template.id === 'reasoningEffort',
    );

    expect(effortTemplate?.default).toBe('high');
    expect(effortTemplate?.presets.map((preset) => preset.id)).toEqual([
      'max',
      'xhigh',
      'high',
      'medium',
      'low',
    ]);
  });

  it.each(['Anthropic', 'Claude Code'])(
    'is available from the %s built-in provider',
    (providerName) => {
      const provider = WELL_KNOWN_PROVIDERS.find(
        (candidate) => candidate.name === providerName,
      );

      expect(provider?.models).toContain('claude-opus-5');
    },
  );

  it('enables supported thinking features without making thinking mandatory', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/client/definitions.ts'),
      'utf8',
    );

    expect(
      getFeatureBlock(source, 'AnthropicInterleavedThinking'),
    ).not.toContain("'claude-opus-5'");
    expect(getFeatureBlock(source, 'AnthropicXHighEffort')).toContain(
      "'claude-opus-5'",
    );
    expect(
      getFeatureBlock(source, 'OpenRouterUseClaudeAdaptiveVerbosity'),
    ).toContain("'claude-opus-5'");
    expect(
      getFeatureBlock(source, 'AnthropicAlwaysOnAdaptiveThinking'),
    ).not.toContain("'claude-opus-5'");
  });

  it('enables the mid-conversation tool changes beta', () => {
    const definitionsSource = readFileSync(
      resolve(process.cwd(), 'src/client/definitions.ts'),
      'utf8',
    );
    const clientSource = readFileSync(
      resolve(process.cwd(), 'src/client/anthropic/client.ts'),
      'utf8',
    );

    expect(
      getFeatureBlock(
        definitionsSource,
        'AnthropicMidConversationToolChanges',
      ),
    ).toContain("'claude-opus-5'");
    expect(clientSource).toContain(
      "betaFeatures.add('mid-conversation-tool-changes-2026-07-01')",
    );
  });
});
