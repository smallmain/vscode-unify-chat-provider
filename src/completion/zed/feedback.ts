import type {
  ZedBufferChangeEvent,
  ZedEditPredictionRecentFile,
  ZedEditPredictionRejection,
  ZedEditPredictionRejectReason,
  ZedSettledEditPredictionBody,
  ZedSettledEditPredictionSampleData,
} from '../../client/zed/types';
import { computeKeptRate } from './metrics';
import type { ZedFeedbackTransport } from './session-port';

const REJECT_DEBOUNCE_MS = 15_000;
const REJECT_MAX_BATCH = 100;
const REJECT_EAGER_THRESHOLD = REJECT_MAX_BATCH / 2;
const SETTLED_QUIESCENCE_MS = 10_000;
const SETTLED_TTL_MS = 5 * 60_000;
const SETTLED_MAX_REGION_BYTES = 4 * 1_024;
const SETTLED_MAX_BATCH = 32;
const SETTLED_MAX_FUTURE_EVENTS = 4;
const SETTLED_MAX_NAVIGATION_HISTORY = 20;

export interface ZedPredictionCapture {
  readonly editableRegionBeforePrediction: string;
  readonly predictedEditableRegion: string;
  readonly readSettledEditableRegion: () => string | undefined;
  readonly dispose?: () => void;
}

interface MutableSampleData extends ZedSettledEditPredictionSampleData {
  future_edit_history_events?: ZedBufferChangeEvent[];
  navigation_history?: ZedEditPredictionRecentFile[];
}

function cloneSampleData(
  value: ZedSettledEditPredictionSampleData,
): MutableSampleData {
  return {
    ...value,
    ...(value.buffer_diagnostics === undefined
      ? {}
      : { buffer_diagnostics: [...value.buffer_diagnostics] }),
    ...(value.editable_context === undefined
      ? {}
      : { editable_context: [...value.editable_context] }),
    ...(value.future_edit_history_events === undefined
      ? {}
      : {
          future_edit_history_events: [...value.future_edit_history_events],
        }),
    ...(value.navigation_history === undefined
      ? {}
      : { navigation_history: [...value.navigation_history] }),
  };
}

interface TrackedPrediction {
  readonly requestId: string;
  readonly modelVersion?: string;
  readonly startedAt: number;
  readonly responseLatency: number;
  readonly transport: ZedFeedbackTransport;
  readonly canCollectData: boolean;
  readonly isInOpenSourceRepo: boolean;
  sampleData?: MutableSampleData;
  capture?: ZedPredictionCapture;
  terminal: boolean;
  settled: boolean;
  lastEditAt: number;
  settledTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
}

const tracked = new Map<string, TrackedPrediction>();
const pendingRejections = new Map<
  ZedFeedbackTransport,
  ZedEditPredictionRejection[]
>();
const rejectionTimers = new Map<ZedFeedbackTransport, NodeJS.Timeout>();
const rejectionFlushes = new Set<ZedFeedbackTransport>();
const pendingSettled = new Map<
  ZedFeedbackTransport,
  ZedSettledEditPredictionBody[]
>();
const settledTimers = new Map<ZedFeedbackTransport, NodeJS.Timeout>();

type ZedFeedbackOperation = 'accept' | 'reject' | 'settled';

function feedbackErrorSummary(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const name = error instanceof Error ? error.name : 'Error';
  const status = Reflect.get(error, 'status');
  return typeof status === 'number' ? `${name}, HTTP ${status}` : name;
}

function reportFeedbackFailure(
  operation: ZedFeedbackOperation,
  error: unknown,
): void {
  console.warn(
    `[unify-chat-provider] Zed ${operation} feedback failed (${feedbackErrorSummary(error)}).`,
  );
}

function ignoreFailure(
  operation: ZedFeedbackOperation,
  promise: Promise<void>,
): void {
  void promise.catch((error: unknown) => {
    reportFeedbackFailure(operation, error);
  });
}

function scheduleRejectionFlush(transport: ZedFeedbackTransport): void {
  if (rejectionTimers.has(transport) || rejectionFlushes.has(transport)) return;
  rejectionTimers.set(
    transport,
    setTimeout(() => {
      rejectionTimers.delete(transport);
      void flushRejections(transport);
    }, REJECT_DEBOUNCE_MS),
  );
}

async function flushRejections(transport: ZedFeedbackTransport): Promise<void> {
  if (rejectionFlushes.has(transport)) return;
  const pending = pendingRejections.get(transport) ?? [];
  if (pending.length === 0) return;
  rejectionFlushes.add(transport);
  const count = Math.min(pending.length, REJECT_MAX_BATCH);
  const start = pending.length - count;
  const batch = pending.slice(start);
  try {
    await transport.reject({ rejections: batch });
    const current = pendingRejections.get(transport);
    if (current) {
      current.splice(start, count);
      if (current.length === 0) pendingRejections.delete(transport);
    }
  } catch (error) {
    // Failed feedback remains queued and is retried with the next debounce.
    reportFeedbackFailure('reject', error);
  } finally {
    rejectionFlushes.delete(transport);
    if ((pendingRejections.get(transport)?.length ?? 0) > 0) {
      scheduleRejectionFlush(transport);
    }
  }
}

function enqueueRejection(
  transport: ZedFeedbackTransport,
  rejection: ZedEditPredictionRejection,
): void {
  const pending = pendingRejections.get(transport) ?? [];
  pending.push(rejection);
  pendingRejections.set(transport, pending);
  if (pending.length >= REJECT_EAGER_THRESHOLD) {
    const timer = rejectionTimers.get(transport);
    if (timer) clearTimeout(timer);
    rejectionTimers.delete(transport);
    void flushRejections(transport);
  } else {
    scheduleRejectionFlush(transport);
  }
}

function scheduleSettledFlush(transport: ZedFeedbackTransport): void {
  if (settledTimers.has(transport)) return;
  settledTimers.set(
    transport,
    setTimeout(() => {
      settledTimers.delete(transport);
      const pending = pendingSettled.get(transport) ?? [];
      const batch = pending.splice(0, SETTLED_MAX_BATCH);
      if (pending.length === 0) pendingSettled.delete(transport);
      if (batch.length > 0) {
        ignoreFailure('settled', transport.settled({ predictions: batch }));
      }
      if (pending.length > 0) scheduleSettledFlush(transport);
    }, 0),
  );
}

function enqueueSettled(
  transport: ZedFeedbackTransport,
  prediction: ZedSettledEditPredictionBody,
): void {
  const pending = pendingSettled.get(transport) ?? [];
  pending.push(prediction);
  pendingSettled.set(transport, pending);
  scheduleSettledFlush(transport);
}

function settledBody(
  entry: TrackedPrediction,
  settledEditableRegion: string,
): ZedSettledEditPredictionBody {
  const capture = entry.capture;
  if (!capture) {
    throw new Error('A settled Zed prediction requires a capture.');
  }
  const metrics = computeKeptRate(
    capture.editableRegionBeforePrediction,
    capture.predictedEditableRegion,
    settledEditableRegion,
  );
  return {
    request_id: entry.requestId,
    ts_error_count_before_prediction: 0,
    ts_error_count_after_prediction: 0,
    can_collect_data: entry.canCollectData,
    is_in_open_source_repo: entry.isInOpenSourceRepo,
    ...(entry.canCollectData
      ? { settled_editable_region: settledEditableRegion }
      : {}),
    ...(entry.canCollectData && entry.sampleData !== undefined
      ? { sample_data: entry.sampleData }
      : {}),
    edit_bytes_candidate_new: metrics.candidateNew,
    edit_bytes_reference_new: metrics.referenceNew,
    edit_bytes_candidate_deleted: metrics.candidateDeleted,
    edit_bytes_reference_deleted: metrics.referenceDeleted,
    edit_bytes_kept: metrics.kept,
    edit_bytes_correctly_deleted: metrics.correctlyDeleted,
    edit_bytes_discarded: metrics.discarded,
    edit_bytes_context: metrics.context,
    edit_bytes_kept_rate: metrics.keptRate,
    edit_bytes_recall_rate: metrics.recallRate,
    example: null,
    ...(entry.modelVersion === undefined
      ? {}
      : { model_version: entry.modelVersion }),
    e2e_latency: entry.responseLatency,
  };
}

function disposeCapture(entry: TrackedPrediction): void {
  entry.capture?.dispose?.();
  entry.capture = undefined;
}

function scheduleSettled(entry: TrackedPrediction): void {
  if (entry.settled || entry.settledTimer) return;
  const dueAt = Math.min(
    entry.lastEditAt + SETTLED_QUIESCENCE_MS,
    entry.startedAt + SETTLED_TTL_MS,
  );
  entry.settledTimer = setTimeout(() => {
    entry.settledTimer = undefined;
    if (entry.settled || Date.now() - entry.startedAt >= SETTLED_TTL_MS) return;
    const quietFor = Date.now() - entry.lastEditAt;
    if (quietFor < SETTLED_QUIESCENCE_MS) {
      scheduleSettled(entry);
      return;
    }
    entry.settled = true;
    const settledEditableRegion = entry.capture?.readSettledEditableRegion();
    if (
      settledEditableRegion === undefined ||
      Buffer.byteLength(settledEditableRegion) > SETTLED_MAX_REGION_BYTES
    ) {
      disposeCapture(entry);
      return;
    }
    const body = settledBody(entry, settledEditableRegion);
    disposeCapture(entry);
    enqueueSettled(entry.transport, body);
  }, Math.max(0, dueAt - Date.now()));
}

export function trackZedPrediction(input: {
  readonly requestId: string;
  readonly modelVersion?: string;
  readonly startedAt: number;
  readonly transport: ZedFeedbackTransport;
  readonly canCollectData?: boolean;
  readonly isInOpenSourceRepo?: boolean;
  readonly sampleData?: ZedSettledEditPredictionSampleData;
}): void {
  if (tracked.has(input.requestId)) return;
  const now = Date.now();
  const entry: TrackedPrediction = {
    ...input,
    ...(input.sampleData === undefined
      ? {}
      : { sampleData: cloneSampleData(input.sampleData) }),
    responseLatency: Math.max(0, now - input.startedAt),
    canCollectData: input.canCollectData === true,
    isInOpenSourceRepo: input.isInOpenSourceRepo === true,
    terminal: false,
    settled: false,
    lastEditAt: now,
  };
  entry.expiryTimer = setTimeout(() => {
    if (entry.settledTimer) clearTimeout(entry.settledTimer);
    disposeCapture(entry);
    tracked.delete(entry.requestId);
  }, SETTLED_TTL_MS);
  tracked.set(entry.requestId, entry);
  scheduleSettled(entry);
}

export function attachZedPredictionCapture(
  requestId: string,
  capture: ZedPredictionCapture,
): boolean {
  const entry = tracked.get(requestId);
  if (!entry || entry.settled) return false;
  entry.capture = capture;
  return true;
}

export function setZedPredictionSampleData(
  requestId: string,
  sampleData: ZedSettledEditPredictionSampleData,
): boolean {
  const entry = tracked.get(requestId);
  if (!entry || entry.settled || !entry.canCollectData) return false;
  entry.sampleData = cloneSampleData(sampleData);
  return true;
}

export function markZedPredictionCaptureEdited(requestId: string): boolean {
  const entry = tracked.get(requestId);
  if (!entry || entry.settled) return false;
  entry.lastEditAt = Date.now();
  if (entry.settledTimer) clearTimeout(entry.settledTimer);
  entry.settledTimer = undefined;
  scheduleSettled(entry);
  return true;
}

export function recordZedPredictionFutureEvent(
  requestId: string,
  event: ZedBufferChangeEvent,
): boolean {
  const entry = tracked.get(requestId);
  if (!entry || entry.settled || !entry.sampleData) return false;
  if (!event.in_open_source_repo) {
    entry.sampleData = undefined;
    return false;
  }
  entry.sampleData.edit_events_before_quiescence += 1;
  const events = entry.sampleData.future_edit_history_events ?? [];
  if (events.length < SETTLED_MAX_FUTURE_EVENTS) {
    events.push(event);
    entry.sampleData.future_edit_history_events = events;
  }
  return true;
}

export function recordZedPredictionNavigation(
  requestId: string,
  file: ZedEditPredictionRecentFile,
  isInOpenSourceRepo: boolean,
): boolean {
  const entry = tracked.get(requestId);
  if (!entry || entry.settled || !entry.sampleData) return false;
  if (!isInOpenSourceRepo) {
    entry.sampleData = undefined;
    return false;
  }
  const history = entry.sampleData.navigation_history ?? [];
  const existing = history.findIndex((value) => value.path === file.path);
  const previous = existing >= 0 ? history.splice(existing, 1)[0] : undefined;
  history.unshift({
    path: file.path,
    ...((file.cursor_position ?? previous?.cursor_position) === undefined
      ? {}
      : { cursor_position: file.cursor_position ?? previous?.cursor_position }),
  });
  if (history.length > SETTLED_MAX_NAVIGATION_HISTORY) {
    history.splice(SETTLED_MAX_NAVIGATION_HISTORY);
  }
  entry.sampleData.navigation_history = history;
  return true;
}

export function acceptZedPrediction(requestId: string): boolean {
  const entry = tracked.get(requestId);
  if (!entry || entry.terminal) return false;
  entry.terminal = true;
  ignoreFailure(
    'accept',
    entry.transport.accept({
      request_id: requestId,
      ...(entry.modelVersion === undefined
        ? {}
        : { model_version: entry.modelVersion }),
      e2e_latency_ms: Math.max(0, Date.now() - entry.startedAt),
    }),
  );
  return true;
}

export function rejectZedPrediction(
  requestId: string,
  reason: ZedEditPredictionRejectReason,
  wasShown: boolean,
): boolean {
  const entry = tracked.get(requestId);
  if (!entry || entry.terminal) return false;
  entry.terminal = true;
  enqueueRejection(entry.transport, {
    request_id: requestId,
    reason,
    was_shown: wasShown,
    ...(entry.modelVersion === undefined
      ? {}
      : { model_version: entry.modelVersion }),
    e2e_latency_ms: Math.max(0, Date.now() - entry.startedAt),
  });
  return true;
}

export function clearZedFeedbackForTests(): void {
  for (const entry of tracked.values()) {
    if (entry.settledTimer) clearTimeout(entry.settledTimer);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    disposeCapture(entry);
  }
  for (const timer of rejectionTimers.values()) clearTimeout(timer);
  for (const timer of settledTimers.values()) clearTimeout(timer);
  tracked.clear();
  pendingRejections.clear();
  pendingSettled.clear();
  rejectionTimers.clear();
  settledTimers.clear();
  rejectionFlushes.clear();
}

export const zedFeedbackTesting = {
  REJECT_DEBOUNCE_MS,
  REJECT_EAGER_THRESHOLD,
  SETTLED_QUIESCENCE_MS,
  SETTLED_TTL_MS,
  SETTLED_MAX_REGION_BYTES,
};
