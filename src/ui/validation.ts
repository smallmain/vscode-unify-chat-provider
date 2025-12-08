import { ProviderType } from '../client';
import { ModelConfig, Mimic, SUPPORT_MIMIC } from '../client/interface';
import { ConfigStore } from '../config-store';
import { normalizeBaseUrlInput } from '../utils';

export function validateBaseUrl(url: string): string | null {
  if (!url.trim()) return 'API base URL is required';
  try {
    normalizeBaseUrlInput(url);
    return null;
  } catch {
    return 'Please enter a valid base URL';
  }
}

export function validatePositiveIntegerOrEmpty(s: string): string | null {
  if (!s) return null;
  const n = Number(s);
  if (Number.isNaN(n) || n <= 0) return 'Please enter a positive number';
  return null;
}

export function validateProviderNameUnique(
  name: string,
  store: ConfigStore,
  originalName?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Provider name is required';
  if (originalName && trimmed === originalName) return null;
  if (store.getProvider(trimmed))
    return 'A provider with this name already exists';
  return null;
}

export function validateModelIdUnique(
  id: string,
  models: ModelConfig[],
  originalId?: string,
): string | null {
  const trimmed = id.trim();
  if (!trimmed) return 'Model ID is required';
  if (originalId && trimmed === originalId) return null;
  if (models.some((m) => m.id === trimmed))
    return 'A model with this ID already exists';
  return null;
}

export interface ProviderFormData {
  type?: ProviderType;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  mimic?: Mimic;
  models: ModelConfig[];
}

export function validateProviderForm(
  data: ProviderFormData,
  store: ConfigStore,
  originalName?: string,
): string[] {
  const errors: string[] = [];
  if (!data.type) errors.push('API Format is required');

  const nameErr = data.name
    ? validateProviderNameUnique(data.name, store, originalName)
    : 'Provider name is required';
  if (nameErr) errors.push(nameErr);

  const urlErr = data.baseUrl
    ? validateBaseUrl(data.baseUrl)
    : 'API base URL is required';
  if (urlErr) errors.push(urlErr);

  if (data.mimic !== undefined) {
    if (!data.type) {
      errors.push('Select an API Format before choosing a mimic option');
    } else {
      const supported = SUPPORT_MIMIC[data.type] ?? [];
      if (!supported.includes(data.mimic)) {
        errors.push(
          'The selected mimic is not supported by this provider type',
        );
      }
    }
  }
  return errors;
}
