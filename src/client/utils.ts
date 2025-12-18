import { getBaseModelId } from '../model-id-utils';
import { ModelConfig, ProviderConfig } from '../types';
import { FeatureId, FEATURES, PROVIDER_TYPES } from './definitions';
import { ApiProvider } from './interface';
import { ProviderPattern } from './types';

export function createProvider(provider: ProviderConfig): ApiProvider {
  const definition = PROVIDER_TYPES[provider.type];
  if (!definition) {
    throw new Error(`Unsupported provider type: ${provider.type}`);
  }
  return new definition.class(provider);
}

/**
 * Match a URL against a provider pattern.
 * @param url The URL to match
 * @param pattern The pattern to match against (string with wildcards or RegExp)
 * @returns true if the URL matches the pattern
 */
export function matchProvider(url: string, pattern: ProviderPattern): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(url);
  }

  const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const wildcardToRegExp = (value: string): RegExp => {
    const regexBody = escapeRegExp(value).replace(/\\\*/g, '.*');
    return new RegExp(`^${regexBody}$`);
  };

  const parseUrlLike = (input: string): URL | undefined => {
    try {
      return new URL(input);
    } catch {
      try {
        return new URL(`https://${input}`);
      } catch {
        return undefined;
      }
    }
  };

  const parsedUrl = parseUrlLike(url);
  if (!parsedUrl) {
    return false;
  }

  // Parse string pattern: [protocol?]host[path?]
  const protocolMatch = pattern.match(/^(https?:\/\/)(.*)$/i);
  const rawProtocol = protocolMatch?.[1]?.toLowerCase();
  const requiredProtocol =
    rawProtocol === 'http://'
      ? 'http:'
      : rawProtocol === 'https://'
      ? 'https:'
      : undefined;

  const rest = protocolMatch ? protocolMatch[2] : pattern;
  const slashIndex = rest.indexOf('/');
  const hostPattern = (slashIndex === -1 ? rest : rest.slice(0, slashIndex))
    .trim()
    .toLowerCase();
  const pathPattern = slashIndex === -1 ? undefined : rest.slice(slashIndex);

  // 1) Protocol
  if (requiredProtocol && parsedUrl.protocol !== requiredProtocol) {
    return false;
  }

  // 2) Host (and optional port)
  const hostname = parsedUrl.hostname.toLowerCase();
  const hostWithPort = parsedUrl.port
    ? `${hostname}:${parsedUrl.port}`
    : hostname;

  const hostPatternHasWildcard = hostPattern.includes('*');
  const hostPatternIncludesPort = hostPattern.includes(':');

  const hostTarget = hostPatternIncludesPort ? hostWithPort : hostname;

  const hostMatches = hostPatternHasWildcard
    ? wildcardToRegExp(hostPattern).test(hostTarget)
    : hostPatternIncludesPort
    ? hostWithPort === hostPattern
    : hostname === hostPattern;

  if (!hostMatches) {
    return false;
  }

  // 3) Path
  if (!pathPattern) {
    // Host-only patterns match subpaths.
    return true;
  }

  const urlPath = parsedUrl.pathname;
  if (!pathPattern.includes('*')) {
    return urlPath === pathPattern;
  }

  return wildcardToRegExp(pathPattern).test(urlPath);
}

export function matchModelId(id: string, patterns: string[]): boolean {
  return patterns.some((v) => id.includes(v));
}

export function matchModelFamily(family: string, patterns: string[]): boolean {
  return patterns.some((v) => family.includes(v));
}

/**
 * Check if a feature is supported by a specific model and provider.
 * @param featureId The feature ID to check
 * @param model The model configuration
 * @param provider The provider configuration
 * @returns true if the feature is supported
 */
export function isFeatureSupported(
  featureId: FeatureId,
  provider: ProviderConfig,
  model: ModelConfig,
): boolean {
  const feature = FEATURES[featureId];
  if (!feature) {
    return false;
  }

  const {
    supportedModels,
    supportedFamilys,
    customCheckers,
    supportedProviders,
  } = feature;

  // Check custom checkers first - if any returns true, feature is supported
  if (customCheckers?.some((checker) => checker(model, provider))) {
    return true;
  }

  // Check supported providers
  if (
    supportedProviders?.some((pattern) =>
      matchProvider(provider.baseUrl, pattern),
    )
  ) {
    return true;
  }

  // Check supported models
  const baseId = getBaseModelId(model.id);
  if (supportedModels && matchModelId(baseId, supportedModels)) {
    return true;
  }

  // Check supported families
  const family = model.family ?? baseId;
  if (supportedFamilys && matchModelFamily(family, supportedFamilys)) {
    return true;
  }

  return false;
}
