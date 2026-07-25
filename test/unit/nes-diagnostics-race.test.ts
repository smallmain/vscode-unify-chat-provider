import { describe, expect, it } from 'vitest';
import {
  raceNesDiagnostics,
  type NesRaceBranch,
  type NesRaceCancellationSignal,
  type NesRaceCancelReason,
  type NesRaceClock,
  type NesRaceSubscription,
} from '../../src/chat-lib/core/nes/diagnostics-race';

interface Suggestion {
  readonly id: string;
  readonly hasEdit: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value): void {
      if (!resolvePromise) {
        throw new Error('Deferred promise cannot resolve.');
      }
      resolvePromise(value);
    },
    reject(error): void {
      if (!rejectPromise) {
        throw new Error('Deferred promise cannot reject.');
      }
      rejectPromise(error);
    },
  };
}

interface ControlledBranch extends NesRaceBranch<Suggestion> {
  readonly completion: Deferred<Suggestion | undefined>;
  readonly cancellations: NesRaceCancelReason[];
}

function controlledBranch(): ControlledBranch {
  const completion = deferred<Suggestion | undefined>();
  const cancellations: NesRaceCancelReason[] = [];
  return {
    completion,
    cancellations,
    result: completion.promise,
    cancel: (reason) => cancellations.push(reason),
  };
}

interface Sleeper {
  readonly wakeAt: number;
  readonly resolve: () => void;
}

class ManualClock implements NesRaceClock {
  private currentTime = 0;
  private readonly sleepers: Sleeper[] = [];

  now(): number {
    return this.currentTime;
  }

  sleep(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepers.push({ wakeAt: this.currentTime + delayMs, resolve });
    });
  }

  advance(delayMs: number): void {
    this.currentTime += delayMs;
    const ready = this.sleepers.filter(
      (sleeper) => sleeper.wakeAt <= this.currentTime,
    );
    for (const sleeper of ready) {
      this.sleepers.splice(this.sleepers.indexOf(sleeper), 1);
      sleeper.resolve();
    }
  }
}

class ManualCancellation implements NesRaceCancellationSignal {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  onCancellationRequested(listener: () => void): NesRaceSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function suggestion(id: string, hasEdit: boolean): Suggestion {
  return { id, hasEdit };
}

function isResult(
  value: Suggestion | undefined,
): value is Suggestion {
  return value?.hasEdit === true;
}

function startRace(
  clock: ManualClock,
  llm: ControlledBranch,
  diagnostics: ControlledBranch | undefined,
  cancellation?: ManualCancellation,
  requestIssuedAtMs = 0,
) {
  return raceNesDiagnostics({
    llm,
    ...(diagnostics ? { diagnostics } : {}),
    isLlmResult: isResult,
    isDiagnosticsResult: isResult,
    requestIssuedAtMs,
    diagnosticsDeadlineMs: 1_250,
    clock,
    ...(cancellation ? { cancellation } : {}),
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('NES LLM/diagnostics race', () => {
  it('returns an LLM result immediately and cancels diagnostics once', async () => {
    const clock = new ManualClock();
    const cancellation = new ManualCancellation();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    const resultPromise = startRace(
      clock,
      llm,
      diagnostics,
      cancellation,
    );

    clock.advance(100);
    llm.completion.resolve(suggestion('llm', true));
    const result = await resultPromise;
    cancellation.cancel();

    expect(result.kind).toBe('winner');
    expect(result.kind === 'winner' ? result.source : undefined).toBe('llm');
    expect(diagnostics.cancellations).toEqual(['lost-race']);
    expect(llm.cancellations).toEqual([]);
  });

  it('returns a diagnostics result while leaving LLM work detached', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    const resultPromise = startRace(clock, llm, diagnostics);

    clock.advance(80);
    diagnostics.completion.resolve(suggestion('diagnostics', true));
    const result = await resultPromise;

    expect(result.kind).toBe('winner');
    expect(result.kind === 'winner' ? result.source : undefined).toBe(
      'diagnostics',
    );
    expect(llm.cancellations).toEqual([]);
    expect(diagnostics.cancellations).toEqual([]);
  });

  it('waits only the remainder of 1250ms after an empty LLM result', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    let completed = false;
    const resultPromise = startRace(clock, llm, diagnostics).then((result) => {
      completed = true;
      return result;
    });

    clock.advance(1_000);
    llm.completion.resolve(suggestion('llm-empty', false));
    await flushPromises();
    clock.advance(249);
    await flushPromises();
    expect(completed).toBe(false);

    diagnostics.completion.resolve(suggestion('diagnostics', true));
    const result = await resultPromise;

    expect(result.kind).toBe('winner');
    expect(result.kind === 'winner' ? result.source : undefined).toBe(
      'diagnostics',
    );
  });

  it('waits for LLM without the diagnostics deadline after diagnostics is empty', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    let completed = false;
    const resultPromise = startRace(clock, llm, diagnostics).then((result) => {
      completed = true;
      return result;
    });

    clock.advance(100);
    diagnostics.completion.resolve(suggestion('diagnostics-empty', false));
    await flushPromises();
    clock.advance(2_000);
    await flushPromises();
    expect(completed).toBe(false);

    llm.completion.resolve(suggestion('llm', true));
    const result = await resultPromise;

    expect(result.kind).toBe('winner');
    expect(result.kind === 'winner' ? result.source : undefined).toBe('llm');
  });

  it('returns empty only after both branches return empty', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    let completed = false;
    const resultPromise = startRace(clock, llm, diagnostics).then((result) => {
      completed = true;
      return result;
    });

    clock.advance(50);
    diagnostics.completion.resolve(suggestion('diagnostics-empty', false));
    await flushPromises();
    expect(completed).toBe(false);
    clock.advance(350);
    llm.completion.resolve(suggestion('llm-empty', false));
    const result = await resultPromise;

    expect(result.kind).toBe('empty');
  });

  it('times out diagnostics at the original request deadline', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    let completed = false;
    const resultPromise = startRace(clock, llm, diagnostics).then((result) => {
      completed = true;
      return result;
    });

    clock.advance(1_000);
    llm.completion.resolve(suggestion('llm-empty', false));
    await flushPromises();
    clock.advance(249);
    await flushPromises();
    expect(completed).toBe(false);
    clock.advance(1);
    const result = await resultPromise;

    expect(result.kind).toBe('empty');
    expect(diagnostics.cancellations).toEqual(['deadline']);
  });

  it('clamps the wait to 1250ms when request time is in the future', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    const resultPromise = startRace(
      clock,
      llm,
      diagnostics,
      undefined,
      5_000,
    );

    llm.completion.resolve(suggestion('llm-empty', false));
    await flushPromises();
    clock.advance(1_250);
    const result = await resultPromise;

    expect(result.kind).toBe('empty');
    expect(diagnostics.cancellations).toEqual(['deadline']);
  });

  it('cancels both branches exactly once when the parent is cancelled', async () => {
    const clock = new ManualClock();
    const cancellation = new ManualCancellation();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    const resultPromise = startRace(
      clock,
      llm,
      diagnostics,
      cancellation,
    );

    clock.advance(50);
    cancellation.cancel();
    cancellation.cancel();
    const result = await resultPromise;

    expect(result.kind).toBe('cancelled');
    expect(llm.cancellations).toEqual(['parent-cancellation']);
    expect(diagnostics.cancellations).toEqual(['parent-cancellation']);
  });

  it('ignores one branch rejection when the other branch has a result', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const diagnostics = controlledBranch();
    const resultPromise = startRace(clock, llm, diagnostics);

    diagnostics.completion.reject(new Error('diagnostics failed'));
    await flushPromises();
    clock.advance(20);
    llm.completion.resolve(suggestion('llm', true));
    const result = await resultPromise;

    expect(result.kind).toBe('winner');
    expect(result.kind === 'winner' ? result.source : undefined).toBe('llm');
  });

  it('returns an empty LLM result immediately when diagnostics is disabled', async () => {
    const clock = new ManualClock();
    const llm = controlledBranch();
    const resultPromise = startRace(clock, llm, undefined);

    clock.advance(30);
    llm.completion.resolve(suggestion('llm-empty', false));
    const result = await resultPromise;

    expect(result.kind).toBe('empty');
  });
});
