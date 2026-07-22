export type NesRaceSource = 'llm' | 'diagnostics';

export type NesRaceCancelReason =
  | 'lost-race'
  | 'deadline'
  | 'parent-cancellation';

export interface NesRaceSubscription {
  dispose(): void;
}

export interface NesRaceCancellationSignal {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): NesRaceSubscription;
}

export interface NesRaceClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface NesRaceBranch<T> {
  readonly result: Promise<T | undefined>;
  cancel(reason: NesRaceCancelReason): void;
}

export type NesDiagnosticsRaceResult<TLlm, TDiagnostics> =
  | {
      readonly kind: 'winner';
      readonly source: 'llm';
      readonly value: TLlm;
    }
  | {
      readonly kind: 'winner';
      readonly source: 'diagnostics';
      readonly value: TDiagnostics;
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'failed';
      readonly source: NesRaceSource;
      readonly error: unknown;
    };

export interface NesDiagnosticsRaceInput<TLlm, TDiagnostics> {
  readonly llm: NesRaceBranch<TLlm>;
  readonly diagnostics?: NesRaceBranch<TDiagnostics>;
  readonly isLlmResult: (value: TLlm | undefined) => value is TLlm;
  readonly isDiagnosticsResult: (
    value: TDiagnostics | undefined,
  ) => value is TDiagnostics;
  readonly requestIssuedAtMs: number;
  readonly diagnosticsDeadlineMs: number;
  readonly cancellation?: NesRaceCancellationSignal;
  readonly clock?: NesRaceClock;
}

const systemClock: NesRaceClock = {
  now: () => Date.now(),
  sleep: (delayMs) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }),
};

type BranchEvent<TLlm, TDiagnostics> =
  | {
      readonly kind: 'fulfilled';
      readonly source: 'llm';
      readonly value: TLlm | undefined;
    }
  | {
      readonly kind: 'fulfilled';
      readonly source: 'diagnostics';
      readonly value: TDiagnostics | undefined;
    }
  | {
      readonly kind: 'rejected';
      readonly source: NesRaceSource;
      readonly error: unknown;
    };

interface RaceState<TLlm, TDiagnostics> {
  readonly input: NesDiagnosticsRaceInput<TLlm, TDiagnostics>;
  readonly clock: NesRaceClock;
  readonly cancelledSources: Set<NesRaceSource>;
  readonly llmEvent: Promise<BranchEvent<TLlm, TDiagnostics>>;
  readonly diagnosticsEvent?: Promise<BranchEvent<TLlm, TDiagnostics>>;
}

const cancellationMarker = Symbol('nes-race-cancelled');

type CancellationRaceResult<T> = T | typeof cancellationMarker;

function isCancellationMarker<T>(
  value: CancellationRaceResult<T>,
): value is typeof cancellationMarker {
  return value === cancellationMarker;
}

function raceCancellation<T>(
  promise: Promise<T>,
  cancellation: NesRaceCancellationSignal | undefined,
): Promise<CancellationRaceResult<T>> {
  if (!cancellation) {
    return promise;
  }
  if (cancellation.isCancellationRequested) {
    return Promise.resolve(cancellationMarker);
  }
  return new Promise<CancellationRaceResult<T>>((resolve, reject) => {
    let finished = false;
    let subscription: NesRaceSubscription | undefined;
    subscription = cancellation.onCancellationRequested(() => {
      if (finished) {
        return;
      }
      finished = true;
      subscription?.dispose();
      resolve(cancellationMarker);
    });
    if (finished) {
      subscription.dispose();
    }
    promise.then(
      (value) => {
        if (finished) {
          return;
        }
        finished = true;
        subscription?.dispose();
        resolve(value);
      },
      (error: unknown) => {
        if (finished) {
          return;
        }
        finished = true;
        subscription?.dispose();
        reject(error);
      },
    );
  });
}

function observeLlm<TLlm, TDiagnostics>(
  branch: NesRaceBranch<TLlm>,
): Promise<BranchEvent<TLlm, TDiagnostics>> {
  return branch.result.then(
    (value) => ({ kind: 'fulfilled', source: 'llm', value }),
    (error: unknown) => ({ kind: 'rejected', source: 'llm', error }),
  );
}

function observeDiagnostics<TLlm, TDiagnostics>(
  branch: NesRaceBranch<TDiagnostics>,
): Promise<BranchEvent<TLlm, TDiagnostics>> {
  return branch.result.then(
    (value) => ({ kind: 'fulfilled', source: 'diagnostics', value }),
    (error: unknown) => ({ kind: 'rejected', source: 'diagnostics', error }),
  );
}

function createState<TLlm, TDiagnostics>(
  input: NesDiagnosticsRaceInput<TLlm, TDiagnostics>,
): RaceState<TLlm, TDiagnostics> {
  const clock = input.clock ?? systemClock;
  return {
    input,
    clock,
    cancelledSources: new Set<NesRaceSource>(),
    llmEvent: observeLlm<TLlm, TDiagnostics>(input.llm),
    ...(input.diagnostics
      ? {
          diagnosticsEvent: observeDiagnostics<TLlm, TDiagnostics>(
            input.diagnostics,
          ),
        }
      : {}),
  };
}

function cancelBranch<TLlm, TDiagnostics>(
  state: RaceState<TLlm, TDiagnostics>,
  source: NesRaceSource,
  reason: NesRaceCancelReason,
): void {
  if (state.cancelledSources.has(source)) {
    return;
  }
  const branch = source === 'llm' ? state.input.llm : state.input.diagnostics;
  if (!branch) {
    return;
  }
  state.cancelledSources.add(source);
  branch.cancel(reason);
}

function finish<TLlm, TDiagnostics>(
  outcome:
    | { readonly kind: 'winner'; readonly source: 'llm'; readonly value: TLlm }
    | {
        readonly kind: 'winner';
        readonly source: 'diagnostics';
        readonly value: TDiagnostics;
      }
    | { readonly kind: 'empty' }
    | { readonly kind: 'cancelled' }
    | {
        readonly kind: 'failed';
        readonly source: NesRaceSource;
        readonly error: unknown;
      },
): NesDiagnosticsRaceResult<TLlm, TDiagnostics> {
  return outcome;
}

function cancelForParent<TLlm, TDiagnostics>(
  state: RaceState<TLlm, TDiagnostics>,
): NesDiagnosticsRaceResult<TLlm, TDiagnostics> {
  cancelBranch(state, 'llm', 'parent-cancellation');
  cancelBranch(state, 'diagnostics', 'parent-cancellation');
  return finish<TLlm, TDiagnostics>({ kind: 'cancelled' });
}

async function firstFulfilled<TLlm, TDiagnostics>(
  state: RaceState<TLlm, TDiagnostics>,
): Promise<
  | { readonly kind: 'event'; readonly event: BranchEvent<TLlm, TDiagnostics> }
  | { readonly kind: 'cancelled' }
> {
  let waitForLlm = true;
  let waitForDiagnostics = state.diagnosticsEvent !== undefined;
  let lastRejection: BranchEvent<TLlm, TDiagnostics> | undefined;
  while (waitForLlm || waitForDiagnostics) {
    const active: Promise<BranchEvent<TLlm, TDiagnostics>>[] = [];
    if (waitForLlm) {
      active.push(state.llmEvent);
    }
    if (waitForDiagnostics && state.diagnosticsEvent) {
      active.push(state.diagnosticsEvent);
    }
    const event = await raceCancellation(
      Promise.race(active),
      state.input.cancellation,
    );
    if (isCancellationMarker(event)) {
      return { kind: 'cancelled' };
    }
    if (event.source === 'llm') {
      waitForLlm = false;
    } else {
      waitForDiagnostics = false;
    }
    if (event.kind === 'fulfilled') {
      return { kind: 'event', event };
    }
    lastRejection = event;
  }
  return {
    kind: 'event',
    event:
      lastRejection ?? {
        kind: 'rejected',
        source: 'llm',
        error: new Error('NES race completed without a branch result.'),
      },
  };
}

async function awaitEvent<TLlm, TDiagnostics>(
  state: RaceState<TLlm, TDiagnostics>,
  eventPromise: Promise<BranchEvent<TLlm, TDiagnostics>>,
): Promise<
  | { readonly kind: 'event'; readonly event: BranchEvent<TLlm, TDiagnostics> }
  | { readonly kind: 'cancelled' }
> {
  const event = await raceCancellation(
    eventPromise,
    state.input.cancellation,
  );
  return isCancellationMarker(event)
    ? { kind: 'cancelled' }
    : { kind: 'event', event };
}

async function awaitDiagnosticsUntilDeadline<TLlm, TDiagnostics>(
  state: RaceState<TLlm, TDiagnostics>,
): Promise<
  | { readonly kind: 'event'; readonly event: BranchEvent<TLlm, TDiagnostics> }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'cancelled' }
> {
  if (!state.diagnosticsEvent) {
    return { kind: 'deadline' };
  }
  const elapsed = state.clock.now() - state.input.requestIssuedAtMs;
  const remaining = Math.min(
    state.input.diagnosticsDeadlineMs,
    Math.max(0, state.input.diagnosticsDeadlineMs - elapsed),
  );
  if (remaining === 0) {
    return { kind: 'deadline' };
  }
  const outcome = await raceCancellation(
    Promise.race([
      state.diagnosticsEvent.then((event) => ({
        kind: 'event' as const,
        event,
      })),
      state.clock.sleep(remaining).then(() => ({ kind: 'deadline' as const })),
    ]),
    state.input.cancellation,
  );
  if (isCancellationMarker(outcome)) {
    return { kind: 'cancelled' };
  }
  return outcome;
}

function failure<TLlm, TDiagnostics>(
  event: Extract<BranchEvent<TLlm, TDiagnostics>, { readonly kind: 'rejected' }>,
): NesDiagnosticsRaceResult<TLlm, TDiagnostics> {
  return finish<TLlm, TDiagnostics>({
    kind: 'failed',
    source: event.source,
    error: event.error,
  });
}

export async function raceNesDiagnostics<TLlm, TDiagnostics>(
  input: NesDiagnosticsRaceInput<TLlm, TDiagnostics>,
): Promise<NesDiagnosticsRaceResult<TLlm, TDiagnostics>> {
  const state = createState(input);
  if (input.cancellation?.isCancellationRequested) {
    return cancelForParent(state);
  }

  const first = await firstFulfilled(state);
  if (first.kind === 'cancelled') {
    return cancelForParent(state);
  }
  if (first.event.kind === 'rejected') {
    return failure(first.event);
  }

  if (first.event.source === 'llm') {
    if (input.isLlmResult(first.event.value)) {
      cancelBranch(state, 'diagnostics', 'lost-race');
      return finish<TLlm, TDiagnostics>({
        kind: 'winner',
        source: 'llm',
        value: first.event.value,
      });
    }
    if (!state.diagnosticsEvent) {
      return finish<TLlm, TDiagnostics>({ kind: 'empty' });
    }
    const diagnostics = await awaitDiagnosticsUntilDeadline(state);
    if (diagnostics.kind === 'cancelled') {
      return cancelForParent(state);
    }
    if (diagnostics.kind === 'deadline') {
      cancelBranch(state, 'diagnostics', 'deadline');
      return finish<TLlm, TDiagnostics>({ kind: 'empty' });
    }
    if (diagnostics.event.kind === 'rejected') {
      return failure(diagnostics.event);
    }
    if (diagnostics.event.source !== 'diagnostics') {
      return finish<TLlm, TDiagnostics>({
        kind: 'failed',
        source: diagnostics.event.source,
        error: new Error('Expected the diagnostics branch to settle.'),
      });
    }
    if (input.isDiagnosticsResult(diagnostics.event.value)) {
      return finish<TLlm, TDiagnostics>({
        kind: 'winner',
        source: 'diagnostics',
        value: diagnostics.event.value,
      });
    }
    return finish<TLlm, TDiagnostics>({ kind: 'empty' });
  }

  if (input.isDiagnosticsResult(first.event.value)) {
    return finish<TLlm, TDiagnostics>({
      kind: 'winner',
      source: 'diagnostics',
      value: first.event.value,
    });
  }

  const llm = await awaitEvent(state, state.llmEvent);
  if (llm.kind === 'cancelled') {
    return cancelForParent(state);
  }
  if (llm.event.kind === 'rejected') {
    return failure(llm.event);
  }
  if (llm.event.source !== 'llm') {
    return finish<TLlm, TDiagnostics>({
      kind: 'failed',
      source: llm.event.source,
      error: new Error('Expected the LLM branch to settle.'),
    });
  }
  if (input.isLlmResult(llm.event.value)) {
    cancelBranch(state, 'diagnostics', 'lost-race');
    return finish<TLlm, TDiagnostics>({
      kind: 'winner',
      source: 'llm',
      value: llm.event.value,
    });
  }
  return finish<TLlm, TDiagnostics>({ kind: 'empty' });
}
