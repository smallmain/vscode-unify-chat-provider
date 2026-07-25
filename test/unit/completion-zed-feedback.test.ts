import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptZedPrediction,
  attachZedPredictionCapture,
  clearZedFeedbackForTests,
  markZedPredictionCaptureEdited,
  recordZedPredictionFutureEvent,
  rejectZedPrediction,
  trackZedPrediction,
} from '../../src/completion/zed/feedback';
import type { ZedFeedbackTransport } from '../../src/completion/zed/session-port';
import type {
  ZedAcceptEditPredictionBody,
  ZedRejectEditPredictionsBody,
  ZedSubmitSettledBatchBody,
} from '../../src/client/zed/types';

function transport() {
  const accept = vi.fn(async (_body: ZedAcceptEditPredictionBody) => undefined);
  const reject = vi.fn(
    async (_body: ZedRejectEditPredictionsBody) => undefined,
  );
  const settled = vi.fn(async (_body: ZedSubmitSettledBatchBody) => undefined);
  return {
    value: { accept, reject, settled } satisfies ZedFeedbackTransport,
    accept,
    reject,
    settled,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  clearZedFeedbackForTests();
  vi.useRealTimers();
});

describe('Zed edit-prediction feedback', () => {
  it('batches rejects and keeps each terminal exactly once', async () => {
    const target = transport();
    for (const requestId of ['one', 'two']) {
      trackZedPrediction({
        requestId,
        startedAt: 500,
        transport: target.value,
      });
    }
    expect(rejectZedPrediction('one', 'rejected', true)).toBe(true);
    expect(rejectZedPrediction('one', 'discarded', false)).toBe(false);
    expect(rejectZedPrediction('two', 'current_preferred', false)).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(target.reject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(target.reject).toHaveBeenCalledOnce();
    expect(target.reject).toHaveBeenCalledWith({
      rejections: [
        expect.objectContaining({
          request_id: 'one',
          reason: 'rejected',
          was_shown: true,
        }),
        expect.objectContaining({
          request_id: 'two',
          reason: 'current_preferred',
          was_shown: false,
        }),
      ],
    });
    expect(target.accept).not.toHaveBeenCalled();
  });

  it('records credential-safe warnings for best-effort feedback failures', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secretError = Object.assign(new Error('Bearer should-not-appear'), {
      status: 503,
    });
    const failed = {
      accept: vi.fn(async () => Promise.reject(secretError)),
      reject: vi.fn(async () => Promise.reject(secretError)),
      settled: vi.fn(async () => Promise.reject(secretError)),
    } satisfies ZedFeedbackTransport;

    trackZedPrediction({
      requestId: 'failed-accept',
      startedAt: 500,
      transport: failed,
    });
    expect(acceptZedPrediction('failed-accept')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    trackZedPrediction({
      requestId: 'failed-reject',
      startedAt: 500,
      transport: failed,
    });
    expect(rejectZedPrediction('failed-reject', 'rejected', true)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);

    trackZedPrediction({
      requestId: 'failed-settled',
      startedAt: Date.now(),
      transport: failed,
    });
    expect(
      attachZedPredictionCapture('failed-settled', {
        editableRegionBeforePrediction: 'old',
        predictedEditableRegion: 'new',
        readSettledEditableRegion: () => 'new',
      }),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(10_001);

    const output = warning.mock.calls.flat().join('\n');
    expect(output).toContain('Zed accept feedback failed (Error, HTTP 503)');
    expect(output).toContain('Zed reject feedback failed (Error, HTTP 503)');
    expect(output).toContain('Zed settled feedback failed (Error, HTTP 503)');
    expect(output).not.toContain('should-not-appear');
    warning.mockRestore();
  });

  it('sends accept independently and settles after ten quiet seconds with metrics', async () => {
    const target = transport();
    trackZedPrediction({
      requestId: 'private',
      startedAt: 500,
      transport: target.value,
    });
    trackZedPrediction({
      requestId: 'public',
      modelVersion: 'v4',
      startedAt: 500,
      transport: target.value,
      canCollectData: true,
      isInOpenSourceRepo: true,
      sampleData: {
        repository_url: 'https://example.com/repo.git',
        revision: null,
        editable_path: 'src/main.ts',
        editable_offset_range: { start: 0, end: 3 },
        edit_events_before_quiescence: 0,
      },
    });
    let privateRegion = 'old';
    let publicRegion = 'new';
    expect(
      attachZedPredictionCapture('private', {
        editableRegionBeforePrediction: 'old',
        predictedEditableRegion: 'new',
        readSettledEditableRegion: () => privateRegion,
      }),
    ).toBe(true);
    expect(
      attachZedPredictionCapture('public', {
        editableRegionBeforePrediction: 'old',
        predictedEditableRegion: 'new',
        readSettledEditableRegion: () => publicRegion,
      }),
    ).toBe(true);
    expect(acceptZedPrediction('private')).toBe(true);
    expect(acceptZedPrediction('private')).toBe(false);
    expect(target.accept).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(9_000);
    privateRegion = 'new';
    publicRegion = 'new';
    expect(markZedPredictionCaptureEdited('private')).toBe(true);
    expect(markZedPredictionCaptureEdited('public')).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(target.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(target.settled).toHaveBeenCalledOnce();
    const body = target.settled.mock.calls[0]?.[0];
    expect(body?.predictions).toHaveLength(2);
    expect(body?.predictions[0]).toMatchObject({
      request_id: 'private',
      can_collect_data: false,
      is_in_open_source_repo: false,
      example: null,
      edit_bytes_kept_rate: 1,
      edit_bytes_recall_rate: 1,
    });
    expect(body?.predictions[0]).not.toHaveProperty('settled_editable_region');
    expect(body?.predictions[1]).toMatchObject({
      request_id: 'public',
      can_collect_data: true,
      is_in_open_source_repo: true,
      settled_editable_region: 'new',
      sample_data: {
        repository_url: 'https://example.com/repo.git',
        revision: null,
        editable_path: 'src/main.ts',
        editable_offset_range: { start: 0, end: 3 },
        edit_events_before_quiescence: 0,
      },
      model_version: 'v4',
    });
    expect(markZedPredictionCaptureEdited('public')).toBe(false);
  });

  it('keeps in-flight appended rejections and retries them in a later batch', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstFlush = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const target = transport();
    target.reject.mockImplementationOnce(async () => {
      await firstFlush;
      return undefined;
    });
    for (let index = 0; index < 50; index += 1) {
      const requestId = `initial-${index}`;
      trackZedPrediction({ requestId, startedAt: 500, transport: target.value });
      rejectZedPrediction(requestId, 'discarded', false);
    }
    await Promise.resolve();
    expect(target.reject).toHaveBeenCalledOnce();

    trackZedPrediction({
      requestId: 'appended',
      startedAt: 500,
      transport: target.value,
    });
    rejectZedPrediction('appended', 'rejected', true);
    releaseFirst?.();
    await firstFlush;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(target.reject).toHaveBeenCalledTimes(2);
    expect(target.reject.mock.calls[1]?.[0]).toEqual({
      rejections: [
        expect.objectContaining({ request_id: 'appended' }),
      ],
    });
  });

  it('collects at most four future events while retaining the total count', async () => {
    const target = transport();
    const dispose = vi.fn();
    trackZedPrediction({
      requestId: 'sampled',
      startedAt: 500,
      transport: target.value,
      canCollectData: true,
      isInOpenSourceRepo: true,
      sampleData: {
        repository_url: null,
        revision: null,
        editable_path: 'src/main.ts',
        editable_offset_range: { start: 0, end: 3 },
        edit_events_before_quiescence: 0,
      },
    });
    attachZedPredictionCapture('sampled', {
      editableRegionBeforePrediction: 'old',
      predictedEditableRegion: 'new',
      readSettledEditableRegion: () => 'new',
      dispose,
    });
    for (let index = 0; index < 5; index += 1) {
      expect(
        recordZedPredictionFutureEvent('sampled', {
          event: 'BufferChange',
          path: `src/${index}.ts`,
          old_path: `src/${index}.ts`,
          diff: '@@ -1 +1 @@\n-old\n+new\n',
          old_range: { start: 0, end: 3 },
          new_range: { start: 0, end: 3 },
          predicted: false,
          in_open_source_repo: true,
        }),
      ).toBe(true);
    }

    await vi.advanceTimersByTimeAsync(10_001);
    const sample = target.settled.mock.calls[0]?.[0].predictions[0]?.sample_data;
    expect(sample?.edit_events_before_quiescence).toBe(5);
    expect(sample?.future_edit_history_events).toHaveLength(4);
    expect(dispose).toHaveBeenCalledOnce();
    expect(markZedPredictionCaptureEdited('sampled')).toBe(false);
  });

  it('omits all source-bearing fields when collection is disabled', async () => {
    const target = transport();
    trackZedPrediction({
      requestId: 'opt-out',
      startedAt: 500,
      transport: target.value,
      canCollectData: false,
      isInOpenSourceRepo: true,
      sampleData: {
        repository_url: null,
        revision: null,
        editable_path: 'secret.ts',
        editable_offset_range: { start: 0, end: 6 },
        editable_context: [
          {
            path: 'secret.ts',
            max_row: 0,
            excerpts: [
              {
                row_range: { start: 0, end: 0 },
                text: 'secret',
                order: 0,
                context_source: 'current_file',
              },
            ],
            in_open_source_repo: true,
          },
        ],
        edit_events_before_quiescence: 0,
      },
    });
    attachZedPredictionCapture('opt-out', {
      editableRegionBeforePrediction: 'secret',
      predictedEditableRegion: 'public',
      readSettledEditableRegion: () => 'public',
    });
    await vi.advanceTimersByTimeAsync(10_001);

    const prediction = target.settled.mock.calls[0]?.[0].predictions[0];
    expect(prediction).not.toHaveProperty('settled_editable_region');
    expect(prediction).not.toHaveProperty('sample_data');
    expect(JSON.stringify(prediction)).not.toContain('secret');
    expect(JSON.stringify(prediction)).not.toContain('public');
  });

  it('flushes rejects immediately at fifty and drops oversized settled regions', async () => {
    const target = transport();
    for (let index = 0; index < 50; index += 1) {
      const requestId = `reject-${index}`;
      trackZedPrediction({
        requestId,
        startedAt: 500,
        transport: target.value,
      });
      rejectZedPrediction(requestId, 'discarded', false);
    }
    await Promise.resolve();
    expect(target.reject).toHaveBeenCalledOnce();
    expect(target.reject.mock.calls[0]?.[0].rejections).toHaveLength(50);

    trackZedPrediction({
      requestId: 'large',
      startedAt: 500,
      transport: target.value,
      canCollectData: true,
    });
    attachZedPredictionCapture('large', {
      editableRegionBeforePrediction: '',
      predictedEditableRegion: 'x',
      readSettledEditableRegion: () => 'x'.repeat(4_097),
    });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(target.settled).not.toHaveBeenCalled();
  });
});
