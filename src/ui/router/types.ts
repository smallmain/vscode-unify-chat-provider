import type { ConfigStore } from '../../config-store';
import type { ProviderType } from '../../client/definitions';
import { ProviderConfig, ModelConfig, TimeoutConfig } from '../../types';
import type { RetryConfig } from '../../utils';
import type { WellKnownProviderConfig } from '../../well-known/providers';
import type { OfficialModelsFetchState } from '../../official-models-manager';
import type { SecretStore } from '../../secret';
import type { EventedUriHandler } from '../../uri-handler';
import type { ProviderFormDraft } from '../form-utils';

export interface UiContext {
  store: ConfigStore;
  secretStore: SecretStore;
  uriHandler?: EventedUriHandler;
}

export interface ProviderListRoute {
  kind: 'providerList';
}

export interface ProviderFormRoute {
  kind: 'providerForm';
  mode?: 'full' | 'settings';
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
  provider: WellKnownProviderConfig;
  draft: ProviderFormDraft;
}

export interface WellKnownProviderAuthRoute {
  kind: 'wellKnownProviderAuth';
  provider: WellKnownProviderConfig;
  draft: ProviderFormDraft;
}

export interface ModelListRoute {
  kind: 'modelList';
  invocation: 'addProvider' | 'addFromWellKnownProvider' | 'providerEdit';
  models: ModelConfig[];
  providerLabel: string;
  /** Unique session ID for draft state management */
  draftSessionId?: string;
  officialModelsData?: {
    models: ModelConfig[];
    state: OfficialModelsFetchState | undefined;
  };
  requireAtLeastOne?: boolean;
  draft?: ProviderFormDraft;
  existing?: ProviderConfig;
  originalName?: string;
  confirmDiscardOnBack?: boolean;
  onSave?: () => Promise<'saved' | 'invalid' | 'cancelled'>;
  afterSave?: 'pop' | 'popToRoot';
}

export interface ModelFormRoute {
  kind: 'modelForm';
  mode?: 'full' | 'import';
  providerLabel?: string;
  providerType?: ProviderType;
  model?: ModelConfig;
  models: ModelConfig[];
  initialConfig?: Partial<ModelConfig>;
  originalId?: string;
  draft?: ModelConfig;
}

export interface ModelViewRoute {
  kind: 'modelView';
  providerLabel?: string;
  providerType?: ProviderType;
  model: ModelConfig;
}

export interface ModelSelectionRoute {
  kind: 'modelSelection';
  title: string;
  existingModels: ModelConfig[];
  fetchModels: () => Promise<ModelConfig[]>;
}

export interface TimeoutFormRoute {
  kind: 'timeoutForm';
  timeout: TimeoutConfig;
  retry: RetryConfig;
  draft: ProviderFormDraft;
}

export interface ImportProvidersRoute {
  kind: 'importProviders';
}

export interface ProviderDraftFormRoute {
  kind: 'providerDraftForm';
  draft: ProviderFormDraft;
  original: ProviderFormDraft;
}

export interface ImportProviderConfigArrayRoute {
  kind: 'importProviderConfigArray';
  configs: Partial<ProviderConfig>[];
  drafts?: ProviderFormDraft[];
  selectedIds?: Set<number>;
  editingEntryId?: number;
}

export interface ImportModelConfigArrayRoute {
  kind: 'importModelConfigArray';
  models: ModelConfig[];
  /** Existing models to check conflicts against and append into on completion. */
  targetModels: ModelConfig[];
  providerLabel: string;
  providerType?: ProviderType;
  selectedIds?: Set<number>;
  editingEntryId?: number;
}

export type UiRoute =
  | ProviderListRoute
  | ProviderFormRoute
  | WellKnownProviderListRoute
  | WellKnownProviderNameRoute
  | WellKnownProviderAuthRoute
  | ModelListRoute
  | ModelFormRoute
  | ModelViewRoute
  | ModelSelectionRoute
  | TimeoutFormRoute
  | ImportProvidersRoute
  | ProviderDraftFormRoute
  | ImportProviderConfigArrayRoute
  | ImportModelConfigArrayRoute;

export type ProviderDraftFormResult =
  | { kind: 'saved'; draft: ProviderFormDraft }
  | { kind: 'cancelled' };

export type ModelFormResult =
  | { kind: 'saved'; model: ModelConfig; originalId?: string }
  | { kind: 'deleted'; modelId: string }
  | { kind: 'cancelled' };

export type UiResume =
  | { kind: 'modelFormResult'; result: ModelFormResult }
  | { kind: 'modelSelectionResult'; models: ModelConfig[] }
  | { kind: 'providerDraftFormResult'; result: ProviderDraftFormResult };

export type UiNavAction =
  | { kind: 'stay' }
  | { kind: 'push'; route: UiRoute }
  | { kind: 'replace'; route: UiRoute }
  | { kind: 'pop'; resume?: UiResume }
  | { kind: 'popToRoot'; resume?: UiResume }
  | { kind: 'exit' };
