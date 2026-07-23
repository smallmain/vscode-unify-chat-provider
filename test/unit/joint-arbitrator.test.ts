import { describe, expect, it } from "vitest";
import {
  arbitrateJointCompletions,
  arbitrateSeparateProviderCompletions,
  type JointCancellationSignal,
  type JointCancellationSubscription,
  type JointClock,
  type JointCompletionList,
  type JointDisposeReason,
  type JointFimBranch,
  type JointItemSemantics,
  type JointNesBranch,
  type JointStartedRequest,
} from "../../src/chat-lib/core/joint";

interface TestItem {
  readonly id: string;
  readonly start?: number;
  readonly end?: number;
  readonly text?: string;
  readonly visible?: boolean;
}

const testItemSemantics: JointItemSemantics<TestItem> = {
  getEdit: (value) =>
    value.start === undefined ||
    value.end === undefined ||
    value.text === undefined
      ? undefined
      : { start: value.start, end: value.end, newText: value.text },
  isVisible: (value) => value.visible ?? true,
};

function item(
  id: string,
  start: number,
  end: number,
  text: string,
  visible = true,
): TestItem {
  return { id, start, end, text, visible };
}

function list(...items: readonly TestItem[]): JointCompletionList<TestItem> {
  return { items };
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
        throw new Error("Deferred promise has no resolve callback.");
      }
      resolvePromise(value);
    },
    reject(error): void {
      if (!rejectPromise) {
        throw new Error("Deferred promise has no reject callback.");
      }
      rejectPromise(error);
    },
  };
}

interface ControlledRequest<TItem> {
  readonly completion: Deferred<JointCompletionList<TItem> | undefined>;
  readonly cancellations: JointDisposeReason[];
  readonly disposals: JointDisposeReason[];
  readonly started: JointStartedRequest<TItem>;
}

function controlledRequest<TItem>(): ControlledRequest<TItem> {
  const completion = deferred<JointCompletionList<TItem> | undefined>();
  const cancellations: JointDisposeReason[] = [];
  const disposals: JointDisposeReason[] = [];
  return {
    completion,
    cancellations,
    disposals,
    started: {
      result: completion.promise,
      cancel: (reason) => cancellations.push(reason),
      disposeWhenSettled: (reason) => disposals.push(reason),
    },
  };
}

interface ControlledFim<TItem> extends JointFimBranch<TItem> {
  readonly requests: ControlledRequest<TItem>[];
}

function controlledFim<TItem>(): ControlledFim<TItem> {
  const requests: ControlledRequest<TItem>[] = [];
  return {
    requests,
    start(): JointStartedRequest<TItem> {
      const request = controlledRequest<TItem>();
      requests.push(request);
      return request.started;
    },
  };
}

interface ControlledNes<TItem> extends JointNesBranch<TItem> {
  readonly requests: ControlledRequest<TItem>[];
  readonly cacheDelayArguments: boolean[];
}

function controlledNes<TItem>(): ControlledNes<TItem> {
  const requests: ControlledRequest<TItem>[] = [];
  const cacheDelayArguments: boolean[] = [];
  return {
    requests,
    cacheDelayArguments,
    start(enforceCacheDelay): JointStartedRequest<TItem> {
      cacheDelayArguments.push(enforceCacheDelay);
      const request = controlledRequest<TItem>();
      requests.push(request);
      return request.started;
    },
  };
}

interface Sleeper {
  readonly wakeAt: number;
  readonly resolve: () => void;
}

class ManualClock implements JointClock {
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

class ManualCancellation implements JointCancellationSignal {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  onCancellationRequested(listener: () => void): JointCancellationSubscription {
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function baseInput(clock: ManualClock) {
  return {
    documentUri: "file:///workspace/main.ts",
    documentVersion: 4,
    documentText: "const value = 1;\n",
    fimSemantics: testItemSemantics,
    nesSemantics: testItemSemantics,
    clock,
  };
}

describe("joint completion arbitration", () => {
  it("prefers FIM even when NES resolves first in the default state", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    let completed = false;
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
    }).then((result) => {
      completed = true;
      return result;
    });

    clock.advance(2);
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    await flushPromises();
    expect(completed).toBe(false);

    clock.advance(18);
    fim.requests[0].completion.resolve(list(item("fim", 16, 16, "\nnext();")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
    expect(nes.requests[0].disposals).toEqual(["lost-race"]);
    expect(nes.requests[0].cancellations).toEqual(["lost-race"]);
    expect(nes.cacheDelayArguments).toEqual([true]);
  });

  it("falls back to NES after an empty FIM response", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
    });

    fim.requests[0].completion.resolve(list());
    await flushPromises();
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
    expect(fim.requests[0].disposals).toEqual(["not-taken"]);
    expect(fim.requests[0].cancellations).toEqual(["not-taken"]);
  });

  it("does not hide a FIM failure behind a successful NES request", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const failure = new Error("fim failed");
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
    });

    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    fim.requests[0].completion.reject(failure);
    const result = await resultPromise;

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.source : undefined).toBe("fim");
    expect(result.kind === "failed" ? result.error : undefined).toBe(failure);
    expect(nes.requests[0].cancellations).toEqual(["token-cancellation"]);
  });

  it("returns a fast agreeing NES from cache without starting FIM", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
      lastNesSuggestion: {
        documentUri: "file:///workspace/main.ts",
        documentVersion: 4,
        documentWithEditApplied: "const value = 2;\n",
        wasShown: true,
      },
    });

    clock.advance(5);
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
    expect(fim.requests).toHaveLength(0);
    expect(nes.cacheDelayArguments).toEqual([false]);
  });

  it("starts FIM after 10ms and lets an agreeing NES win the race", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
      lastNesSuggestion: {
        documentUri: "file:///workspace/main.ts",
        documentVersion: 3,
        documentWithEditApplied: "const value = 2;\n",
        wasShown: true,
      },
    });

    clock.advance(10);
    await flushPromises();
    expect(fim.requests).toHaveLength(1);
    expect(nes.cacheDelayArguments).toEqual([true]);

    clock.advance(2);
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
    expect(fim.requests[0].disposals).toEqual(["not-taken"]);
    expect(fim.requests[0].cancellations).toEqual(["not-taken"]);
  });

  it("falls back to FIM when a raced NES disagrees with the shown edit", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
      lastNesSuggestion: {
        documentUri: "file:///workspace/main.ts",
        documentVersion: 4,
        documentWithEditApplied: "const value = 2;\n",
        wasShown: true,
      },
    });

    clock.advance(10);
    await flushPromises();
    clock.advance(2);
    nes.requests[0].completion.resolve(list(item("nes-new", 14, 15, "3")));
    await flushPromises();
    clock.advance(3);
    fim.requests[0].completion.resolve(list(item("fim", 16, 16, "\nnext();")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
  });

  it("suppresses FIM for a selection-triggered request", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
      selectionTriggered: true,
      lastNesSuggestion: {
        documentUri: "file:///workspace/main.ts",
        documentVersion: 4,
        documentWithEditApplied: "const value = 2;\n",
        wasShown: true,
      },
    });

    clock.advance(10);
    await flushPromises();
    nes.requests[0].completion.resolve(list(item("different", 14, 15, "3")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
    expect(fim.requests).toHaveLength(0);
  });

  it("filters no-op FIM edits before selecting the NES fallback", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
    });

    fim.requests[0].completion.resolve(list(item("noop", 14, 15, "1")));
    await flushPromises();
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
    expect(fim.requests[0].disposals).toEqual(["not-taken"]);
    expect(fim.requests[0].cancellations).toEqual(["not-taken"]);
  });

  it("keeps only meaningful candidates from a multi-candidate FIM list", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
    });

    fim.requests[0].completion.resolve(
      list(item("noop", 14, 15, "1"), item("meaningful", 16, 16, "\nnext();")),
    );
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
    expect(
      result.kind === "result"
        ? result.list.items.map((candidate) => candidate.id)
        : [],
    ).toEqual(["meaningful"]);
  });

  it("cancels each started branch once when the outer request is cancelled", async () => {
    const clock = new ManualClock();
    const cancellation = new ManualCancellation();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
      cancellation,
    });

    cancellation.cancel();
    cancellation.cancel();
    const result = await resultPromise;

    expect(result.kind).toBe("cancelled");
    expect(fim.requests[0].disposals).toEqual(["token-cancellation"]);
    expect(nes.requests[0].disposals).toEqual(["token-cancellation"]);
    expect(fim.requests[0].cancellations).toEqual(["token-cancellation"]);
    expect(nes.requests[0].cancellations).toEqual(["token-cancellation"]);
  });

  it("handles cancellation fired synchronously during listener registration", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const cancellation: JointCancellationSignal = {
      isCancellationRequested: false,
      onCancellationRequested(listener): JointCancellationSubscription {
        listener();
        return { dispose: () => undefined };
      },
    };
    const result = await arbitrateJointCompletions({
      ...baseInput(clock),
      fim,
      nes,
      cancellation,
    });

    expect(result.kind).toBe("cancelled");
    expect(fim.requests[0].cancellations).toEqual(["token-cancellation"]);
    expect(nes.requests[0].cancellations).toEqual(["token-cancellation"]);
  });
});

describe("separate-provider presentation arbitration", () => {
  it("invokes both branches concurrently but keeps a visible FIM over faster NES", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    let completed = false;
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics: testItemSemantics,
      trigger: "automatic",
      clock,
    }).then((result) => {
      completed = true;
      return result;
    });

    expect(fim.requests).toHaveLength(1);
    expect(nes.requests).toHaveLength(1);
    clock.advance(2);
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    await flushPromises();
    expect(completed).toBe(false);

    clock.advance(18);
    fim.requests[0].completion.resolve(list(item("fim", 16, 16, "\nnext();")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
    expect(nes.requests[0].disposals).toEqual(["not-taken"]);
    expect(nes.requests[0].cancellations).toEqual(["not-taken"]);
  });

  it("returns an automatic visible FIM immediately and cancels pending NES", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics: testItemSemantics,
      trigger: "automatic",
      clock,
    });

    clock.advance(5);
    fim.requests[0].completion.resolve(list(item("fim", 16, 16, "\nnext();")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
    expect(nes.requests[0].disposals).toEqual(["lost-race"]);
    expect(nes.requests[0].cancellations).toEqual(["lost-race"]);
  });

  it("isolates a FIM error and allows NES to display", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics: testItemSemantics,
      trigger: "automatic",
      clock,
    });

    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    fim.requests[0].completion.reject(new Error("isolated"));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
  });

  it("waits for all providers on explicit requests before choosing FIM", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    let completed = false;
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics: testItemSemantics,
      trigger: "explicit",
      clock,
    }).then((result) => {
      completed = true;
      return result;
    });

    fim.requests[0].completion.resolve(list(item("fim", 16, 16, "\nnext();")));
    await flushPromises();
    expect(completed).toBe(false);
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
  });

  it("selects NES when FIM has no visible suggestion", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics: testItemSemantics,
      trigger: "automatic",
      clock,
    });

    fim.requests[0].completion.resolve(
      list(item("invisible-fim", 16, 16, "\nnext();", false)),
    );
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
  });

  it("targets only NES for a provider-specific change hint", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics: testItemSemantics,
      trigger: "automatic",
      requestScope: "nes",
      clock,
    });

    expect(fim.requests).toHaveLength(0);
    expect(nes.requests).toHaveLength(1);
    nes.requests[0].completion.resolve(list(item("nes", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
  });

  it("targets only FIM when the request scope selects FIM", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics: testItemSemantics,
      trigger: "automatic",
      requestScope: "fim",
      clock,
    });

    expect(fim.requests).toHaveLength(1);
    expect(nes.requests).toHaveLength(0);
    fim.requests[0].completion.resolve(list(item("fim", 16, 16, "\nnext();")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
  });

  it("allows a NES cursor ghost text to stop an automatic request early", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const nesSemantics: JointItemSemantics<TestItem> = {
      ...testItemSemantics,
      isInlineEdit: () => false,
      showInlineEditMenu: () => false,
    };
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics,
      trigger: "automatic",
      clock,
    });

    clock.advance(2);
    nes.requests[0].completion.resolve(list(item("nes-ghost", 14, 15, "2")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("nes");
    expect(fim.requests[0].disposals).toEqual(["lost-race"]);
    expect(fim.requests[0].cancellations).toEqual(["lost-race"]);
  });

  it("does not early-stop for a NES item with an inline edit menu", async () => {
    const clock = new ManualClock();
    const fim = controlledFim<TestItem>();
    const nes = controlledNes<TestItem>();
    const nesSemantics: JointItemSemantics<TestItem> = {
      ...testItemSemantics,
      isInlineEdit: () => false,
      showInlineEditMenu: () => true,
    };
    let completed = false;
    const resultPromise = arbitrateSeparateProviderCompletions({
      documentText: "const value = 1;\n",
      fim,
      nes,
      fimSemantics: testItemSemantics,
      nesSemantics,
      trigger: "automatic",
      clock,
    }).then((result) => {
      completed = true;
      return result;
    });

    clock.advance(2);
    nes.requests[0].completion.resolve(list(item("nes-menu", 14, 15, "2")));
    await flushPromises();
    expect(completed).toBe(false);
    clock.advance(8);
    fim.requests[0].completion.resolve(list(item("fim", 16, 16, "\nnext();")));
    const result = await resultPromise;

    expect(result.kind).toBe("result");
    expect(result.kind === "result" ? result.source : undefined).toBe("fim");
    expect(
      result.kind === "result"
        ? result.list.items.map((candidate) => ({
            source: candidate.source,
            id: candidate.item.id,
          }))
        : [],
    ).toEqual([
      { source: "fim", id: "fim" },
      { source: "nes", id: "nes-menu" },
    ]);
    expect(fim.requests[0].disposals).toEqual([]);
    expect(nes.requests[0].disposals).toEqual([]);
  });
});
