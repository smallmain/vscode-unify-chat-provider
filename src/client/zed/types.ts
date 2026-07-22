import type { ModelConfig, ProviderConfig } from '../../types';

export const ZED_CLOUD_CLIENT_VERSION = '1.13.0';

export type ZedUpstreamProvider =
  | 'anthropic'
  | 'open_ai'
  | 'google'
  | 'x_ai';

export interface ZedLongLivedCredential {
  userId: string;
  accessToken: string;
}

export interface ZedOrganization {
  id: string;
  name: string;
  isPersonal: boolean;
  editPrediction: {
    isEnabled: boolean;
    isFeedbackEnabled: boolean;
  };
}

export interface ZedAuthenticatedUser {
  id: string;
  username: string;
  name?: string;
  email?: string;
  organizations: ZedOrganization[];
  defaultOrganizationId?: string;
}

export interface ZedSupportedEffortLevel {
  name: string;
  value: string;
  isDefault: boolean;
}

export interface ZedCloudModel {
  provider: ZedUpstreamProvider;
  id: string;
  displayName: string;
  isLatest: boolean;
  maxTokenCount: number;
  maxTokenCountInMaxMode?: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsDisablingThinking: boolean;
  supportsFastMode: boolean;
  supportsServerSideCompaction: boolean;
  supportedEffortLevels: ZedSupportedEffortLevel[];
  supportsStreamingTools: boolean;
  supportsParallelToolCalls: boolean;
  isDisabled: boolean;
  disabledReason?: string;
}

export interface ZedModelRoute {
  organizationId: string;
  modelId: string;
  upstreamProvider: ZedUpstreamProvider;
}

export interface ZedModelDiscoveryResult {
  models: ModelConfig[];
  routes: ZedModelRoute[];
  organizationId: string;
}

export interface ZedProviderIdentity {
  key: string;
  providerName: string;
  baseUrl: string;
  authIdentityId?: string;
}

export interface ZedPredictEditsV3Response {
  requestId: string;
  output: string;
  editableRange: { start: number; end: number };
  modelVersion?: string;
  cursorOffset?: number;
}

export interface ZedPredictEditsV4Response {
  requestId: string;
  patch: string;
  modelVersion?: string;
}

export type ZedPredictEditsTrigger =
  | 'explicit'
  | 'buffer_edit'
  | 'prediction_accepted'
  | 'prediction_partially_accepted'
  | 'provider_changed'
  | 'user_info_changed'
  | 'settings_changed'
  | 'other';

export interface ZedPreparedPredictEditsRequest {
  readonly endpoint: string;
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly requestId: string;
}

export interface ZedPredictEditsRequestOptions {
  trigger: ZedPredictEditsTrigger;
  preferredExperiment?: string;
  requestId?: string;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  /** Observes the final semantic request immediately before transport. */
  onRequestPrepared?: (request: ZedPreparedPredictEditsRequest) => void;
  /** Fires immediately before the first HTTP request is handed to fetch. */
  onRequestDispatched?: () => void;
}

export interface ZedAcceptEditPredictionBody {
  request_id: string;
  model_version?: string;
  e2e_latency_ms?: number;
}

export type ZedEditPredictionRejectReason =
  | 'canceled'
  | 'empty'
  | 'interpolated_empty'
  | 'interpolate_failed'
  | 'patch_apply_failed'
  | 'replaced'
  | 'current_preferred'
  | 'discarded'
  | 'rejected';

export interface ZedEditPredictionRejection {
  request_id: string;
  reason: ZedEditPredictionRejectReason;
  was_shown: boolean;
  model_version?: string;
  e2e_latency_ms?: number;
}

export interface ZedRejectEditPredictionsBody {
  rejections: ZedEditPredictionRejection[];
}

export interface ZedByteRange {
  start: number;
  end: number;
}

export interface ZedBufferChangeEvent {
  event: 'BufferChange';
  path: string;
  old_path: string;
  diff: string;
  old_range: ZedByteRange;
  new_range: ZedByteRange;
  predicted: boolean;
  in_open_source_repo: boolean;
}

export interface ZedActiveBufferDiagnostic {
  severity: number | null;
  message: string;
  snippet: string;
  snippet_buffer_row_range: ZedByteRange;
  diagnostic_range_in_snippet: ZedByteRange;
}

export interface ZedRelatedExcerpt {
  row_range: ZedByteRange;
  text: string;
  order: number;
  context_source: 'current_file' | 'edit_history' | 'lsp';
}

export interface ZedRelatedFile {
  path: string;
  max_row: number;
  excerpts: ZedRelatedExcerpt[];
  in_open_source_repo: boolean;
}

export interface ZedEditPredictionRecentFile {
  path: string;
  cursor_position?: number;
}

export interface ZedSettledEditPredictionSampleData {
  repository_url: string | null;
  revision: string | null;
  uncommitted_diff?: string;
  editable_path: string;
  editable_offset_range: ZedByteRange;
  buffer_diagnostics?: ZedActiveBufferDiagnostic[];
  editable_context?: ZedRelatedFile[];
  future_edit_history_events?: ZedBufferChangeEvent[];
  navigation_history?: ZedEditPredictionRecentFile[];
  edit_events_before_quiescence: number;
  next_edit_cursor_offset?: number;
}

export interface ZedSettledEditPredictionBody {
  request_id: string;
  settled_editable_region?: string;
  ts_error_count_before_prediction: number;
  ts_error_count_after_prediction: number;
  can_collect_data: boolean;
  is_in_open_source_repo: boolean;
  sample_data?: ZedSettledEditPredictionSampleData;
  edit_bytes_candidate_new: number;
  edit_bytes_reference_new: number;
  edit_bytes_candidate_deleted: number;
  edit_bytes_reference_deleted: number;
  edit_bytes_kept: number;
  edit_bytes_correctly_deleted: number;
  edit_bytes_discarded: number;
  edit_bytes_context: number;
  edit_bytes_kept_rate: number;
  edit_bytes_recall_rate: number;
  example: unknown | null;
  model_version?: string;
  e2e_latency: number;
}

export interface ZedSubmitSettledBatchBody {
  predictions: ZedSettledEditPredictionBody[];
}

export interface ZedCompletionBody {
  thread_id?: string;
  prompt_id?: string;
  provider: ZedUpstreamProvider;
  model: string;
  provider_request: Record<string, unknown>;
}

export type ZedCompletionStatus =
  | { kind: 'queued'; position: number }
  | { kind: 'started' }
  | {
      kind: 'failed';
      code: string;
      message: string;
      requestId: string;
      retryAfter?: number;
    }
  | { kind: 'stream_ended' }
  | { kind: 'unknown' };

export type ZedCompletionEnvelope<T> =
  | { kind: 'status'; status: ZedCompletionStatus }
  | { kind: 'event'; event: T };

export type ZedChatChunk =
  | { kind: 'text'; text: string }
  | {
      kind: 'thinking';
      text: string;
      id?: string;
      metadata?: Record<string, unknown>;
    }
  | { kind: 'tool_call'; callId: string; name: string; input: object }
  | { kind: 'status'; status: ZedCompletionStatus };

export type ZedFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function isZedProviderConfig(
  provider: ProviderConfig,
): provider is ProviderConfig & { auth?: { method: 'zed' } } {
  return String(provider.type) === 'zed';
}
