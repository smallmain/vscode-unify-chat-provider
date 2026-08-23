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

export function getAutoFetchOfficialModelsFilterItemIds(
  availableModelIds: readonly string[],
  configuredFilter: readonly string[] | undefined,
): string[] {
  return normalizeAutoFetchOfficialModelsFilter([
    ...availableModelIds,
    ...(configuredFilter ?? []),
  ]);
}

export function resolveAutoFetchOfficialModelsFilter(
  displayedModelIds: readonly string[],
  selectedModelIds: readonly string[],
  configuredFilter: readonly string[] | undefined,
): string[] | undefined {
  const normalizedSelectedIds =
    normalizeAutoFetchOfficialModelsFilter(selectedModelIds);
  if (configuredFilter !== undefined) return normalizedSelectedIds;

  const selectedIds = new Set(normalizedSelectedIds);
  const normalizedDisplayedIds =
    normalizeAutoFetchOfficialModelsFilter(displayedModelIds);
  const includesEveryDisplayedModel = normalizedDisplayedIds.every((modelId) =>
    selectedIds.has(modelId),
  );
  return includesEveryDisplayedModel ? undefined : normalizedSelectedIds;
}

export type AutoFetchOfficialModelsFilterChange =
  | { readonly kind: 'include-all' }
  | {
      readonly kind: 'selection';
      readonly displayedModelIds: readonly string[];
      readonly selectedModelIds: readonly string[];
    };

export function applyAutoFetchOfficialModelsFilterChange(
  configuredFilter: string[] | undefined,
  change: AutoFetchOfficialModelsFilterChange | undefined,
): string[] | undefined {
  if (change === undefined) return configuredFilter;
  if (change.kind === 'include-all') return undefined;

  return resolveAutoFetchOfficialModelsFilter(
    change.displayedModelIds,
    change.selectedModelIds,
    configuredFilter,
  );
}
