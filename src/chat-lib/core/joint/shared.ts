import type {
  JointCancellationSignal,
  JointCancellationSubscription,
  JointClock,
  JointCompletionList,
  JointDisposeReason,
  JointItemSemantics,
  JointSource,
  JointStartedRequest,
} from "./types";

export const systemJointClock: JointClock = {
  now: () => Date.now(),
  sleep: (delayMs) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }),
};

export class BranchFailure {
  constructor(
    readonly source: JointSource,
    readonly error: unknown,
  ) {}
}

export interface ObservedRequest<TItem> {
  readonly source: JointSource;
  readonly request: JointStartedRequest<TItem>;
  result: Promise<JointCompletionList<TItem> | undefined>;
  settled: boolean;
  fulfilled: boolean;
  settledList: JointCompletionList<TItem> | undefined;
}

export function observeRequest<TItem>(
  source: JointSource,
  request: JointStartedRequest<TItem>,
): ObservedRequest<TItem> {
  const observed: ObservedRequest<TItem> = {
    source,
    request,
    result: Promise.resolve(undefined),
    settled: false,
    fulfilled: false,
    settledList: undefined,
  };
  const result = request.result.then(
    (list) => {
      observed.settled = true;
      observed.fulfilled = true;
      observed.settledList = list;
      return list;
    },
    (error: unknown) => {
      observed.settled = true;
      throw new BranchFailure(source, error);
    },
  );
  observed.result = result;
  void result.catch(() => undefined);
  return observed;
}

const cancelledMarker = Symbol("joint-cancelled");

export type CancellationRaceResult<T> = T | typeof cancelledMarker;

export function isCancellationRaceResult<T>(
  value: CancellationRaceResult<T>,
): value is typeof cancelledMarker {
  return value === cancelledMarker;
}

export function raceCancellation<T>(
  promise: Promise<T>,
  cancellation: JointCancellationSignal | undefined,
): Promise<CancellationRaceResult<T>> {
  if (!cancellation) {
    return promise;
  }
  if (cancellation.isCancellationRequested) {
    return Promise.resolve(cancelledMarker);
  }
  return new Promise<CancellationRaceResult<T>>((resolve, reject) => {
    let completed = false;
    let subscription: JointCancellationSubscription | undefined;
    const onCancellation = (): void => {
      if (completed) {
        return;
      }
      completed = true;
      subscription?.dispose();
      resolve(cancelledMarker);
    };
    subscription = cancellation.onCancellationRequested(onCancellation);
    if (completed) {
      subscription.dispose();
    }
    promise.then(
      (value) => {
        if (completed) {
          return;
        }
        completed = true;
        subscription?.dispose();
        resolve(value);
      },
      (error: unknown) => {
        if (completed) {
          return;
        }
        completed = true;
        subscription?.dispose();
        reject(error);
      },
    );
  });
}

export function filterMeaningful<TItem>(
  list: JointCompletionList<TItem>,
  documentText: string,
  semantics: JointItemSemantics<TItem>,
): JointCompletionList<TItem> {
  const items = list.items.filter((item) => {
    const edit = semantics.getEdit(item);
    if (!edit) {
      return true;
    }
    if (
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > documentText.length
    ) {
      return true;
    }
    return documentText.slice(edit.start, edit.end) !== edit.newText;
  });
  if (items.length === list.items.length) {
    return list;
  }
  return { ...list, items };
}

export function applyItemEdit<TItem>(
  documentText: string,
  item: TItem | undefined,
  semantics: JointItemSemantics<TItem>,
): string | undefined {
  if (!item) {
    return undefined;
  }
  const edit = semantics.getEdit(item);
  if (
    !edit ||
    edit.start < 0 ||
    edit.end < edit.start ||
    edit.end > documentText.length
  ) {
    return undefined;
  }
  return `${documentText.slice(0, edit.start)}${edit.newText}${documentText.slice(edit.end)}`;
}

export function disposeAndCancel<TItem>(
  request: ObservedRequest<TItem> | undefined,
  reason: JointDisposeReason,
): void {
  if (!request) {
    return;
  }
  request.request.disposeWhenSettled?.(reason);
  request.request.cancel(reason);
}

export function disposeReasonForSettledList<TItem>(
  request: ObservedRequest<TItem>,
): JointDisposeReason {
  return request.settledList && request.settledList.items.length > 0
    ? "not-taken"
    : "empty";
}
