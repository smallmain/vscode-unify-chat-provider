import { describe, expect, it, vi } from 'vitest';
import {
  COPILOT_BEHAVIOR_CONFIG,
  validateCopilotBehaviorConfig,
} from '../../src/chat-lib/core/behavior-config';
import {
  InlineEditTriggerState,
  type SelectionChangeEvent,
  type TriggerClock,
  type TriggerTimeout,
} from '../../src/chat-lib/core/nes/triggerer';

class FakeClock implements TriggerClock {
  private time = 100;
  private nextId = 1;
  private readonly callbacks = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): TriggerTimeout {
    const id = this.nextId++;
    this.callbacks.set(id, { at: this.time + delayMs, callback });
    return { dispose: () => this.callbacks.delete(id) };
  }

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const pending = [...this.callbacks.entries()]
        .filter(([, value]) => value.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!pending) {
        break;
      }
      const [id, value] = pending;
      this.callbacks.delete(id);
      this.time = value.at;
      value.callback();
    }
    this.time = target;
  }

  pendingCount(): number {
    return this.callbacks.size;
  }
}

function selection(
  uri: string,
  line: number,
  identity: object,
  overrides: Partial<SelectionChangeEvent> = {},
): SelectionChangeEvent {
  return {
    uri,
    scheme: 'file',
    documentIdentity: identity,
    isNotebookCell: false,
    selectionCount: 1,
    isEmpty: true,
    line,
    isTracked: true,
    ...overrides,
  };
}

describe('Copilot behavior config', () => {
  it('is complete and bound to the extracted commit', () => {
    expect(() => validateCopilotBehaviorConfig(COPILOT_BEHAVIOR_CONFIG)).not.toThrow();
    expect(COPILOT_BEHAVIOR_CONFIG.upstreamCommit).toHaveLength(40);
  });
});

describe('InlineEditTriggerState', () => {
  it('fires the first two selection changes immediately and debounces later ones', () => {
    const clock = new FakeClock();
    const emit = vi.fn();
    const document = {};
    let uuid = 0;
    const state = new InlineEditTriggerState(
      COPILOT_BEHAVIOR_CONFIG.trigger,
      emit,
      clock,
      () => `id-${++uuid}`,
    );
    state.recordProviderTrigger();
    state.handleDocumentChange({
      uri: 'file:///a.ts',
      scheme: 'file',
      documentIdentity: document,
      reason: 'other',
      isTracked: true,
    });

    state.handleSelectionChange(selection('file:///a.ts', 1, document));
    state.handleSelectionChange(selection('file:///a.ts', 2, document));
    state.handleSelectionChange(selection('file:///a.ts', 3, document));
    state.handleSelectionChange(selection('file:///a.ts', 4, document));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(clock.pendingCount()).toBe(1);
    clock.advance(COPILOT_BEHAVIOR_CONFIG.trigger.selectionDebounceMs);
    expect(emit.mock.calls.map(([change]) => change)).toEqual([
      { reason: 'selectionChange', uuid: 'id-1' },
      { reason: 'selectionChange', uuid: 'id-2' },
      { reason: 'selectionChange', uuid: 'id-3' },
    ]);
  });

  it('enforces same-line and rejection cooldowns', () => {
    const clock = new FakeClock();
    const emit = vi.fn();
    const document = {};
    const state = new InlineEditTriggerState(
      COPILOT_BEHAVIOR_CONFIG.trigger,
      emit,
      clock,
    );
    state.recordProviderTrigger();
    state.handleDocumentChange({
      uri: 'file:///a.ts',
      scheme: 'file',
      documentIdentity: document,
      reason: 'other',
      isTracked: true,
    });
    state.handleSelectionChange(selection('file:///a.ts', 5, document));
    state.handleSelectionChange(selection('file:///a.ts', 5, document));
    expect(emit).toHaveBeenCalledTimes(1);

    state.recordOutcome('rejected');
    state.handleSelectionChange(selection('file:///a.ts', 6, document));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(state.getState().trackedDocuments).toBe(0);

    clock.advance(COPILOT_BEHAVIOR_CONFIG.trigger.rejectionCooldownMs);
    state.handleDocumentChange({
      uri: 'file:///a.ts',
      scheme: 'file',
      documentIdentity: document,
      reason: 'other',
      isTracked: true,
    });
    state.handleSelectionChange(selection('file:///a.ts', 6, document));
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('requires an accepted recent NES before a document-switch trigger', () => {
    const clock = new FakeClock();
    const emit = vi.fn();
    const state = new InlineEditTriggerState(
      COPILOT_BEHAVIOR_CONFIG.trigger,
      emit,
      clock,
    );
    const first = {};
    const second = {};
    state.handleDocumentChange({
      uri: 'file:///a.ts',
      scheme: 'file',
      documentIdentity: first,
      reason: 'other',
      isTracked: true,
    });
    state.recordProviderTrigger();
    state.handleSelectionChange(selection('file:///b.ts', 0, second));
    expect(emit).not.toHaveBeenCalled();

    state.recordOutcome('accepted');
    state.handleSelectionChange(selection('file:///c.ts', 0, {}));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'activeDocumentSwitch' }),
    );
  });

  it('updates the document-switch window for untracked edits without tracking them', () => {
    const clock = new FakeClock();
    const emit = vi.fn();
    const state = new InlineEditTriggerState(
      COPILOT_BEHAVIOR_CONFIG.trigger,
      emit,
      clock,
    );
    state.recordProviderTrigger();
    state.recordOutcome('accepted');
    clock.advance(1);

    state.handleDocumentChange({
      uri: 'git:/ignored.ts',
      scheme: 'git',
      documentIdentity: {},
      reason: 'other',
      isTracked: false,
    });

    expect(state.getState().trackedDocuments).toBe(0);
    state.handleSelectionChange(selection('file:///target.ts', 0, {}));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'activeDocumentSwitch' }),
    );
  });

  it('bypasses same-line cooldown when moving between notebook cells', () => {
    const clock = new FakeClock();
    const emit = vi.fn();
    const firstCell = {};
    const secondCell = {};
    const state = new InlineEditTriggerState(
      COPILOT_BEHAVIOR_CONFIG.trigger,
      emit,
      clock,
    );
    state.recordProviderTrigger();
    state.handleDocumentChange({
      uri: 'vscode-notebook-cell:///book/one',
      scheme: 'vscode-notebook-cell',
      documentIdentity: firstCell,
      reason: 'other',
      isTracked: true,
    });
    state.handleSelectionChange(
      selection('vscode-notebook-cell:///book/one', 2, firstCell, {
        scheme: 'vscode-notebook-cell',
        isNotebookCell: true,
      }),
    );
    state.handleSelectionChange(
      selection('vscode-notebook-cell:///book/one', 2, secondCell, {
        scheme: 'vscode-notebook-cell',
        isNotebookCell: true,
      }),
    );
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('ignores undo, invalid selections, output documents, and pending timers after disposal', () => {
    const clock = new FakeClock();
    const emit = vi.fn();
    const document = {};
    const state = new InlineEditTriggerState(
      COPILOT_BEHAVIOR_CONFIG.trigger,
      emit,
      clock,
    );
    state.recordProviderTrigger();
    state.handleDocumentChange({
      uri: 'file:///a.ts',
      scheme: 'file',
      documentIdentity: document,
      reason: 'undo',
      isTracked: true,
    });
    state.handleSelectionChange(selection('file:///a.ts', 0, document));
    state.handleSelectionChange(
      selection('file:///a.ts', 0, document, { selectionCount: 2 }),
    );
    state.handleSelectionChange(
      selection('output:///log', 0, document, { scheme: 'output' }),
    );
    expect(emit).not.toHaveBeenCalled();

    state.handleDocumentChange({
      uri: 'file:///a.ts',
      scheme: 'file',
      documentIdentity: document,
      reason: 'other',
      isTracked: true,
    });
    state.handleSelectionChange(selection('file:///a.ts', 1, document));
    state.handleSelectionChange(selection('file:///a.ts', 2, document));
    state.handleSelectionChange(selection('file:///a.ts', 3, document));
    expect(clock.pendingCount()).toBe(1);
    state.dispose();
    expect(clock.pendingCount()).toBe(0);
    clock.advance(COPILOT_BEHAVIOR_CONFIG.trigger.selectionDebounceMs);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
