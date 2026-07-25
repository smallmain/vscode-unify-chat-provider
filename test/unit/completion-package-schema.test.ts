import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPLETION_DISABLED_GLOBS } from '../../src/completion/disabled-globs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function loadCompletionSchemas(): readonly Record<string, unknown>[] {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  const contributes = requireRecord(
    requireRecord(manifest, 'package').contributes,
    'contributes',
  );
  const configuration = requireRecord(
    contributes.configuration,
    'contributes.configuration',
  );
  const configurationProperties = requireRecord(
    configuration.properties,
    'contributes.configuration.properties',
  );
  const endpoints = requireRecord(
    configurationProperties['unifyChatProvider.endpoints'],
    'unifyChatProvider.endpoints',
  );
  const providerProperties = requireRecord(
    requireRecord(endpoints.items, 'endpoints.items').properties,
    'endpoints.items.properties',
  );
  const providerCompletion = requireRecord(
    providerProperties.completion,
    'provider.completion',
  );
  const models = requireRecord(providerProperties.models, 'provider.models');
  const modelVariants = requireArray(
    requireRecord(models.items, 'provider.models.items').oneOf,
    'provider.models.items.oneOf',
  );
  const modelProperties = requireRecord(
    requireRecord(modelVariants[1], 'model object variant').properties,
    'model properties',
  );
  const modelCompletion = requireRecord(
    modelProperties.completion,
    'model.completion',
  );
  return [providerCompletion, modelCompletion];
}

function loadProviderTypeSchema(): Record<string, unknown> {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  const contributes = requireRecord(
    requireRecord(manifest, 'package').contributes,
    'contributes',
  );
  const configuration = requireRecord(
    contributes.configuration,
    'contributes.configuration',
  );
  const configurationProperties = requireRecord(
    configuration.properties,
    'contributes.configuration.properties',
  );
  const endpoints = requireRecord(
    configurationProperties['unifyChatProvider.endpoints'],
    'unifyChatProvider.endpoints',
  );
  const providerProperties = requireRecord(
    requireRecord(endpoints.items, 'endpoints.items').properties,
    'endpoints.items.properties',
  );
  return requireRecord(providerProperties.type, 'provider.type');
}

function loadCompletionAlgorithmEnum(): unknown[] {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  const contributes = requireRecord(
    requireRecord(manifest, 'package').contributes,
    'contributes',
  );
  const configuration = requireRecord(
    contributes.configuration,
    'contributes.configuration',
  );
  const configurationProperties = requireRecord(
    configuration.properties,
    'contributes.configuration.properties',
  );
  const providers = requireRecord(
    configurationProperties['unifyChatProvider.completion.providers'],
    'unifyChatProvider.completion.providers',
  );
  const providerProperties = requireRecord(
    requireRecord(providers.items, 'completion.providers.items').properties,
    'completion.providers.items.properties',
  );
  return requireArray(
    requireRecord(providerProperties.algorithm, 'algorithm').enum,
    'algorithm.enum',
  );
}

function loadCompletionStrategySchema(): Record<string, unknown> {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  const contributes = requireRecord(
    requireRecord(manifest, 'package').contributes,
    'contributes',
  );
  const configuration = requireRecord(
    contributes.configuration,
    'contributes.configuration',
  );
  const configurationProperties = requireRecord(
    configuration.properties,
    'contributes.configuration.properties',
  );
  return requireRecord(
    configurationProperties['unifyChatProvider.completion.strategy'],
    'unifyChatProvider.completion.strategy',
  );
}

describe('completion package schemas', () => {
  it('keeps provider type IDs and descriptions closed and aligned', () => {
    const type = loadProviderTypeSchema();
    const values = requireArray(type.enum, 'provider.type.enum');
    const descriptions = requireArray(
      type.enumDescriptions,
      'provider.type.enumDescriptions',
    );
    expect(values).toContain('zed');
    expect(values).not.toContain('inception');
    expect(values).not.toContain('mistral');
    expect(descriptions).toHaveLength(values.length);
  });

  it('accepts only the current completion algorithm IDs', () => {
    expect(loadCompletionAlgorithmEnum()).toEqual([
      'simple',
      'copilot-replica',
      'zed',
      'inception',
      'mistral',
    ]);
  });

  it('defaults to disabling VS Code built-in completion without requiring the new field', () => {
    const strategy = loadCompletionStrategySchema();
    const defaultValue = requireRecord(strategy.default, 'strategy.default');
    const properties = requireRecord(strategy.properties, 'strategy.properties');
    const disableVSCodeBuiltinCompletion = requireRecord(
      properties.disableVSCodeBuiltinCompletion,
      'strategy.properties.disableVSCodeBuiltinCompletion',
    );
    const disabledGlobs = requireRecord(
      properties.disabledGlobs,
      'strategy.properties.disabledGlobs',
    );

    expect(defaultValue.disableVSCodeBuiltinCompletion).toBe(true);
    expect(defaultValue.disabledGlobs).toEqual([
      ...DEFAULT_COMPLETION_DISABLED_GLOBS,
    ]);
    expect(disableVSCodeBuiltinCompletion).toEqual({
      type: 'boolean',
      default: true,
    });
    expect(requireArray(strategy.required, 'strategy.required')).not.toContain(
      'disableVSCodeBuiltinCompletion',
    );
    expect(disabledGlobs).toMatchObject({
      type: 'array',
      uniqueItems: true,
      default: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
    });
    expect(requireRecord(disabledGlobs.items, 'disabledGlobs.items')).toEqual({
      type: 'string',
      minLength: 1,
    });
    expect(requireArray(strategy.required, 'strategy.required')).not.toContain(
      'disabledGlobs',
    );
  });

  it('defines the same strict schema at provider and model levels', () => {
    for (const schema of loadCompletionSchemas()) {
      expect(schema.additionalProperties).toBe(false);
      expect(Object.hasOwn(schema, 'default')).toBe(false);

      const properties = requireRecord(schema.properties, 'completion.properties');
      expect(Object.keys(properties)).toEqual([
        'transport',
        'baseUrl',
        'templates',
      ]);

      const transport = requireRecord(properties.transport, 'transport');
      expect(transport.enum).toEqual(['auto', 'native', 'compatible']);
      expect(Object.hasOwn(transport, 'default')).toBe(false);

      const baseUrl = requireRecord(properties.baseUrl, 'baseUrl');
      expect(baseUrl.type).toBe('string');
      expect(Object.hasOwn(baseUrl, 'default')).toBe(false);

      const templates = requireRecord(properties.templates, 'templates');
      const variants = requireArray(templates.oneOf, 'templates.oneOf');
      expect(requireRecord(variants[0], 'all variant').enum).toEqual(['all']);
      const arrayVariant = requireRecord(variants[1], 'array variant');
      expect(arrayVariant.type).toBe('array');
      expect(arrayVariant.uniqueItems).toBe(true);
      expect(Object.hasOwn(arrayVariant, 'minItems')).toBe(false);
      expect(requireRecord(arrayVariant.items, 'template items').enum).toEqual([
        'fim',
        'codegemma',
        'copilot-replica-nes',
        'zeta1',
        'zeta2',
        'zeta2.1',
        'zeta3-internal',
        'mercury-edit-2',
        'codestral',
      ]);
      expect(Object.hasOwn(templates, 'default')).toBe(false);
    }
  });
});
