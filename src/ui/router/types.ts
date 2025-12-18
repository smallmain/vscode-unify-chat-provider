import type { ConfigStore } from '../../config-store';
import { ProviderConfig, ModelConfig } from '../../types';
import type { ProviderFormDraft } from '../form-utils';

export interface UiContext {
  store: ConfigStore;
}

export interface ProviderListRoute {
  kind: 'providerList';
}

export interface ProviderFormRoute {
  kind: 'providerForm';
  providerName?: string;
  initialConfig?: Partial<ProviderConfig>;
  existing?: ProviderConfig;
  originalName?: string;
  draft?: ProviderFormDraft;
}

export interface WellKnownProviderListRoute {
  kind: 'wellKnownProviderList';
}

export interface WellKnownProviderNameRoute {
  kind: 'wellKnownProviderName';
  provider: ProviderConfig;
  draft: ProviderFormDraft;
}

export interface WellKnownProviderApiKeyRoute {
  kind: 'wellKnownProviderApiKey';
  provider: ProviderConfig;
  draft: ProviderFormDraft;
}

export interface ModelListRoute {
  kind: 'modelList';
  models: ModelConfig[];
  providerLabel: string;
  requireAtLeastOne?: boolean;
  draft?: ProviderFormDraft;
  onSave?: () => Promise<'saved' | 'invalid'>;
  afterSave?: 'pop' | 'popToRoot';
}

export interface ModelFormRoute {
  kind: 'modelForm';
  model?: ModelConfig;
  models: ModelConfig[];
  initialConfig?: Partial<ModelConfig>;
  originalId?: string;
  draft?: ModelConfig;
}

export interface ModelSelectionRoute {
  kind: 'modelSelection';
  title: string;
  existingModels: ModelConfig[];
  fetchModels: () => Promise<ModelConfig[]>;
}

export type UiRoute =
  | ProviderListRoute
  | ProviderFormRoute
  | WellKnownProviderListRoute
  | WellKnownProviderNameRoute
  | WellKnownProviderApiKeyRoute
  | ModelListRoute
  | ModelFormRoute
  | ModelSelectionRoute;

export type ModelFormResult =
  | { kind: 'saved'; model: ModelConfig; originalId?: string }
  | { kind: 'deleted'; modelId: string }
  | { kind: 'cancelled' };

export type UiResume =
  | { kind: 'modelFormResult'; result: ModelFormResult }
  | { kind: 'modelSelectionResult'; models: ModelConfig[] };

export type UiNavAction =
  | { kind: 'stay' }
  | { kind: 'push'; route: UiRoute }
  | { kind: 'replace'; route: UiRoute }
  | { kind: 'pop'; resume?: UiResume }
  | { kind: 'popToRoot'; resume?: UiResume }
  | { kind: 'exit' };
