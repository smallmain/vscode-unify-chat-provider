import { describe, expect, it } from 'vitest';
import {
  resolveAntigravityModelForRequest,
  type Gemini3ThinkingLevel,
} from '../../src/client/google/antigravity-model-resolver';

describe('Antigravity model resolver', () => {
  const gemini31ProRoutes: Array<[Gemini3ThinkingLevel, string]> = [
    ['high', 'gemini-pro-agent'],
    ['medium', 'gemini-pro-agent'],
    ['low', 'gemini-3.1-pro-low'],
  ];

  it.each(gemini31ProRoutes)(
    'routes Gemini 3.1 Pro %s through %s',
    (thinkingLevel, requestModelId) => {
      expect(
        resolveAntigravityModelForRequest(
          'gemini-3.1-pro',
          thinkingLevel,
          true,
        ),
      ).toEqual({
        requestModelId,
        gemini3ThinkingLevel: thinkingLevel,
      });
    },
  );

  it('normalizes legacy Gemini 3.1 Pro tier IDs', () => {
    expect(
      resolveAntigravityModelForRequest('gemini-3.1-pro-high'),
    ).toEqual({
      requestModelId: 'gemini-pro-agent',
      gemini3ThinkingLevel: 'high',
    });
    expect(
      resolveAntigravityModelForRequest('gemini-3.1-pro-low'),
    ).toEqual({
      requestModelId: 'gemini-3.1-pro-low',
      gemini3ThinkingLevel: 'low',
    });
  });

  it('normalizes Gemini 3.1 Pro preview aliases', () => {
    expect(
      resolveAntigravityModelForRequest(
        'gemini-3.1-pro-preview-customtools',
        'high',
      ),
    ).toEqual({
      requestModelId: 'gemini-pro-agent',
      gemini3ThinkingLevel: 'high',
    });
  });

  it('preserves legacy Gemini 3 Pro tier routing', () => {
    expect(
      resolveAntigravityModelForRequest('gemini-3-pro', 'high'),
    ).toEqual({
      requestModelId: 'gemini-3-pro-high',
      gemini3ThinkingLevel: 'high',
    });
  });

  it('does not rewrite Gemini image model IDs', () => {
    expect(
      resolveAntigravityModelForRequest('gemini-3.1-pro-image', 'high'),
    ).toEqual({
      requestModelId: 'gemini-3.1-pro-image',
      gemini3ThinkingLevel: 'high',
    });
  });
});
