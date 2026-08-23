import type { ModelConfig, ProviderConfig } from './types';

export function normalizeAutoFetchOfficialModelsFilter(
  value: readonly string[],
): string[];
export function normalizeAutoFetchOfficialModelsFilter(
  value: unknown,
): string[] | undefined;
export function normalizeAutoFetchOfficialModelsFilter(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const modelId = item.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

export function filterAutoFetchedOfficialModels(
  provider: Pick<ProviderConfig, 'autoFetchOfficialModelsFilter'>,
  models: readonly ModelConfig[],
): ModelConfig[] {
  const filter = provider.autoFetchOfficialModelsFilter;
  if (filter === undefined) return [...models];

  const includedIds = new Set(filter);
  return models.filter((model) => includedIds.has(model.id));
}

export function resolveAutoFetchOfficialModelsFilter(
  availableModelIds: readonly string[],
  selectedModelIds: readonly string[],
): string[] | undefined {
  const normalizedSelectedIds =
    normalizeAutoFetchOfficialModelsFilter(selectedModelIds);
  const selectedIds = new Set(normalizedSelectedIds);
  const includesEveryAvailableModel =
    availableModelIds.length > 0 &&
    availableModelIds.every((modelId) => selectedIds.has(modelId));
  return includesEveryAvailableModel ? undefined : normalizedSelectedIds;
}
