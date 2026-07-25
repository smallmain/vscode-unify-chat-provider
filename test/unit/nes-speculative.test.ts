import { describe, expect, it, vi } from 'vitest';
import {
  canReuseNesPendingSpeculative,
  NesSpeculativeState,
  resolveNesSpeculativeEditWindowLines,
} from '../../src/chat-lib/core/nes/speculative';

function pending(value: string, cancel: (reason: string) => void) {
  return {
    documentUri: 'file:///main.ts',
    postEditContent: 'fooBar();',
    trajectoryPrefix: 'foo',
    trajectorySuffix: '();',
    trajectoryNewText: 'Bar',
    value,
    cancel,
  };
}

describe('NesSpeculativeState', () => {
  it('gates pending reuse on token, text, URI, and cursor window', () => {
    const input = {
      documentUri: 'file:///main.ts',
      documentText: 'post-edit',
      cursorOffset: 5,
      pendingDocumentUri: 'file:///main.ts',
      pendingDocumentText: 'post-edit',
      pendingEditWindow: { startOffset: 2, endOffset: 8 },
      pendingCancellationRequested: false,
    } as const;
    expect(canReuseNesPendingSpeculative(input)).toBe(true);
    expect(
      canReuseNesPendingSpeculative({
        ...input,
        pendingCancellationRequested: true,
      }),
    ).toBe(false);
    expect(
      canReuseNesPendingSpeculative({ ...input, cursorOffset: 9 }),
    ).toBe(false);
  });

  it('matches official speculative edit-window expansion modes', () => {
    expect(resolveNesSpeculativeEditWindowLines('off', 40, true, true)).toBe(
      undefined,
    );
    expect(
      resolveNesSpeculativeEditWindowLines('always', 40, false, false),
    ).toBe(40);
    expect(
      resolveNesSpeculativeEditWindowLines('smart', 40, false, false),
    ).toBeUndefined();
    expect(
      resolveNesSpeculativeEditWindowLines('smart', 40, true, false),
    ).toBe(40);
    expect(
      resolveNesSpeculativeEditWindowLines('smart', 40, false, true),
    ).toBe(40);
  });

  it('keeps scheduled and pending ownership separate', () => {
    const state = new NesSpeculativeState<string, string>();
    state.schedule({ originRequestId: 'origin', suggestion: 'shown' });
    state.setPending(pending('request', vi.fn()));
    expect(state.getState()).toMatchObject({ scheduled: true, pending: true });
    expect(state.consumeScheduled('other')).toBeUndefined();
    expect(state.consumeScheduled('origin')?.suggestion).toBe('shown');
    expect(state.consumePending('file:///main.ts', 'fooBar();')).toBe('request');
    expect(state.getState()).toMatchObject({
      scheduled: false,
      pending: false,
      consumed: 1,
    });
  });

  it('retains type-through trajectories and cancels divergence', () => {
    const cancel = vi.fn();
    const state = new NesSpeculativeState<string, string>();
    state.setPending(pending('request', cancel));
    state.onDocumentChanged('file:///main.ts', 'fooB();');
    state.onDocumentChanged('file:///main.ts', 'fooBa();');
    expect(cancel).not.toHaveBeenCalled();
    state.onDocumentChanged('file:///main.ts', 'fooBx();');
    expect(cancel).toHaveBeenCalledWith('trajectoryMiddle');
    expect(state.getState()).toMatchObject({
      pending: false,
      lastCancelReason: 'trajectoryMiddle',
    });
  });

  it('deduplicates a matching pending request and replaces mismatches', () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const state = new NesSpeculativeState<string, string>();
    state.setPending(pending('first', firstCancel));
    state.setPending(pending('first', firstCancel));
    expect(firstCancel).not.toHaveBeenCalled();
    state.setPending(pending('second', secondCancel));
    expect(firstCancel).toHaveBeenCalledWith('replaced');
    state.cancelIfMismatch('file:///other.ts', 'text');
    expect(secondCancel).toHaveBeenCalledWith('superseded');
  });

  it('clears a scheduled cross-file request when its target closes', () => {
    const state = new NesSpeculativeState<string, string>();
    state.schedule({
      originRequestId: 'origin',
      documentUri: 'file:///target.ts',
      suggestion: 'shown',
    });
    state.onDocumentClosed('file:///target.ts');
    expect(state.getState().scheduled).toBe(false);
  });
});
