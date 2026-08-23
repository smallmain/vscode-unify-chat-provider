import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_AVAILABLE_MODEL_IDS,
  resolveAntigravityModelForRequest,
  type Gemini3ThinkingLevel,
} from '../../src/client/google/antigravity-model-resolver';

describe('Antigravity model resolver', () => {
  it('lists the current supported Gemini Flash models newest first', () => {
    expect(ANTIGRAVITY_AVAILABLE_MODEL_IDS[0]).toBe('gemini-3.7-flash');
    expect(ANTIGRAVITY_AVAILABLE_MODEL_IDS).toContain('gemini-3.5-flash');
    expect(ANTIGRAVITY_AVAILABLE_MODEL_IDS).toContain('gemini-3.6-flash');
    expect(ANTIGRAVITY_AVAILABLE_MODEL_IDS).toContain('gemini-3.7-flash');
  });

  const gemini37FlashRoutes: Array<
    [Gemini3ThinkingLevel, string, Gemini3ThinkingLevel]
  > = [
    ['minimal', 'gemini-3.7-flash-low', 'low'],
    ['low', 'gemini-3.7-flash-low', 'low'],
    ['medium', 'gemini-3.7-flash-medium', 'medium'],
    ['high', 'gemini-3.7-flash-high', 'high'],
  ];

  it.each(gemini37FlashRoutes)(
    'routes Gemini 3.7 Flash %s through %s',
    (thinkingLevel, requestModelId, resolvedThinkingLevel) => {
      expect(
        resolveAntigravityModelForRequest(
          'gemini-3.7-flash',
          thinkingLevel,
          true,
        ),
      ).toEqual({
        requestModelId,
        gemini3ThinkingLevel: resolvedThinkingLevel,
      });
    },
  );

  const gemini36FlashRoutes: Array<
    [Gemini3ThinkingLevel, string, Gemini3ThinkingLevel]
  > = [
    ['minimal', 'gemini-3.6-flash-low', 'low'],
    ['low', 'gemini-3.6-flash-low', 'low'],
    ['medium', 'gemini-3.6-flash-medium', 'medium'],
    ['high', 'gemini-3.6-flash-high', 'high'],
  ];

  it.each(gemini36FlashRoutes)(
    'routes Gemini 3.6 Flash %s through %s',
    (thinkingLevel, requestModelId, resolvedThinkingLevel) => {
      expect(
        resolveAntigravityModelForRequest(
          'gemini-3.6-flash',
          thinkingLevel,
          true,
        ),
      ).toEqual({
        requestModelId,
        gemini3ThinkingLevel: resolvedThinkingLevel,
      });
    },
  );

  it('routes a manually added bare Gemini 3.6 Flash model', () => {
    expect(resolveAntigravityModelForRequest('gemini-3.6-flash')).toEqual({
      requestModelId: 'gemini-3.6-flash-high',
      gemini3ThinkingLevel: 'high',
    });
  });

  const gemini35FlashRoutes: Array<
    [Gemini3ThinkingLevel, string, Gemini3ThinkingLevel]
  > = [
    ['minimal', 'gemini-3.5-flash-extra-low', 'low'],
    ['low', 'gemini-3.5-flash-extra-low', 'low'],
    ['medium', 'gemini-3.5-flash-low', 'medium'],
    ['high', 'gemini-3-flash-agent', 'high'],
  ];

  it.each(gemini35FlashRoutes)(
    'routes Gemini 3.5 Flash %s through %s',
    (thinkingLevel, requestModelId, resolvedThinkingLevel) => {
      expect(
        resolveAntigravityModelForRequest(
          'gemini-3.5-flash',
          thinkingLevel,
          true,
        ),
      ).toEqual({
        requestModelId,
        gemini3ThinkingLevel: resolvedThinkingLevel,
      });
    },
  );

  it.each([
    ['gemini-3.5-flash-extra-low', 'low'],
    ['gemini-3.5-flash-low', 'medium'],
    ['gemini-3-flash-agent', 'high'],
  ] as const)(
    'preserves the Gemini 3.5 wire model %s as the %s route',
    (requestModelId, gemini3ThinkingLevel) => {
      const resolved = resolveAntigravityModelForRequest(requestModelId);

      expect(resolved).toEqual({
        requestModelId,
        gemini3ThinkingLevel,
      });
      expect(
        resolveAntigravityModelForRequest(
          resolved.requestModelId,
          resolved.gemini3ThinkingLevel,
          true,
        ),
      ).toEqual(resolved);
    },
  );

  it('uses the routed tier encoded in a Gemini 3.6 model ID', () => {
    expect(
      resolveAntigravityModelForRequest('gemini-3.6-flash-medium'),
    ).toEqual({
      requestModelId: 'gemini-3.6-flash-medium',
      gemini3ThinkingLevel: 'medium',
    });
  });

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
