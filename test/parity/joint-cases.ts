import { expect } from "vitest";
import { COPILOT_BEHAVIOR_CONFIG } from "../../src/chat-lib/core/behavior-config";
import { arbitrateJointCompletions } from "../../src/chat-lib/core/joint/joint-arbitrator";
import { arbitrateSeparateProviderCompletions } from "../../src/chat-lib/core/joint/separate-provider-arbitrator";
import type {
  JointCompletionList,
  JointDisposeReason,
  JointItemSemantics,
  JointStartedRequest,
} from "../../src/chat-lib/core/joint/types";
import {
  CopilotPresentedBranchState,
  resolveCopilotRuntimeAvailability,
  resolveJointCursorBranch,
  shouldSuppressNesProviderChange,
} from "../../src/completion/copilot/runtime-routing";
import {
  createCancellationSource,
  createDeferred,
  expectedFor,
  flushMicrotasks,
  ManualJointClock,
  type ParityCase,
} from "./support";

interface JointItem {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly visible?: boolean;
  readonly inlineEdit?: boolean;
  readonly showInlineEditMenu?: boolean;
  readonly kind?: "string-edit" | "inline-edit" | "non-string-edit" | "no-edit";
}

interface BranchControl {
  readonly starts: boolean[];
  readonly cancellations: JointDisposeReason[];
  readonly disposals: JointDisposeReason[];
}

const semantics: JointItemSemantics<JointItem> = {
  getEdit: (item) => ({
    start: item.start,
    end: item.end,
    newText: item.newText,
  }),
  isVisible: (value) => value.visible ?? true,
  isInlineEdit: (value) => value.inlineEdit ?? false,
  showInlineEditMenu: (value) => value.showInlineEditMenu ?? false,
};

function item(
  id: string,
  start: number,
  end: number,
  newText: string,
  options: Partial<
    Pick<JointItem, "visible" | "inlineEdit" | "showInlineEditMenu" | "kind">
  > = {},
): JointItem {
  return { id, start, end, newText, ...options };
}

function resolvedBranch(list: JointCompletionList<JointItem> | undefined): {
  readonly control: BranchControl;
  start(enforceCacheDelay?: boolean): JointStartedRequest<JointItem>;
} {
  const control: BranchControl = {
    starts: [],
    cancellations: [],
    disposals: [],
  };
  return {
    control,
    start(enforceCacheDelay = false) {
      control.starts.push(enforceCacheDelay);
      return {
        result: Promise.resolve(list),
        cancel: (reason) => control.cancellations.push(reason),
        disposeWhenSettled: (reason) => control.disposals.push(reason),
      };
    },
  };
}

function deferredBranch(): {
  readonly control: BranchControl;
  readonly deferred: ReturnType<
    typeof createDeferred<JointCompletionList<JointItem> | undefined>
  >;
  start(enforceCacheDelay?: boolean): JointStartedRequest<JointItem>;
} {
  const control: BranchControl = {
    starts: [],
    cancellations: [],
    disposals: [],
  };
  const deferred = createDeferred<JointCompletionList<JointItem> | undefined>();
  return {
    control,
    deferred,
    start(enforceCacheDelay = false) {
      control.starts.push(enforceCacheDelay);
      return {
        result: deferred.promise,
        cancel: (reason) => control.cancellations.push(reason),
        disposeWhenSettled: (reason) => control.disposals.push(reason),
      };
    },
  };
}

function completionList(
  ...items: readonly JointItem[]
): JointCompletionList<JointItem> {
  return { items };
}

export const jointCases: readonly ParityCase[] = [
  {
    id: "core-provider-presentation",
    assertion:
      "visible completions block edits while the last all-edit candidate wins",
    async run() {
      const expected = expectedFor<{
        visibleBlocking: { completions: string[]; inlineEdit: null };
        invisibleAndEdits: { inlineEdit: string };
      }>("core-provider-presentation");
      const visibleFim = resolvedBranch(
        completionList(item("fim-visible", 0, 0, "F", { visible: true })),
      );
      const nesEdit = resolvedBranch(
        completionList(item("nes-edit", 0, 0, "N", { inlineEdit: true })),
      );
      const visible = await arbitrateSeparateProviderCompletions({
        documentText: "",
        fim: { start: () => visibleFim.start() },
        nes: { start: () => nesEdit.start() },
        fimSemantics: semantics,
        nesSemantics: semantics,
        trigger: "explicit",
      });
      expect(visible.kind).toBe("result");
      expect(
        visible.kind === "result"
          ? visible.list.items.map((value) => value.item.id)
          : [],
      ).toEqual(expected.visibleBlocking.completions);
      expect(expected.visibleBlocking.inlineEdit).toBeNull();

      const invisibleFim = resolvedBranch(
        completionList(item("fim-invisible", 0, 0, "F", { visible: false })),
      );
      const twoEdits = resolvedBranch(
        completionList(
          item("nes-edit-1", 0, 0, "N1", { inlineEdit: true }),
          item("nes-edit-2", 0, 0, "N2", { inlineEdit: true }),
        ),
      );
      const edits = await arbitrateSeparateProviderCompletions({
        documentText: "",
        fim: { start: () => invisibleFim.start() },
        nes: { start: () => twoEdits.start() },
        fimSemantics: semantics,
        nesSemantics: semantics,
        trigger: "explicit",
      });
      expect(edits.kind).toBe("result");
      expect(
        edits.kind === "result"
          ? edits.list.items[edits.list.items.length - 1]?.item.id
          : undefined,
      ).toBe(expected.invisibleAndEdits.inlineEdit);
    },
  },
  {
    id: "core-provider-cycling-order",
    assertion:
      "ordinary inline completions precede showInlineEditMenu suggestions in the cycling list",
    async run() {
      const expected = expectedFor<
        Array<{ source: "fim" | "nes"; id: string }>
      >("core-provider-cycling-order");
      const cycling = await arbitrateSeparateProviderCompletions({
        documentText: "",
        fim: {
          start: () =>
            resolvedBranch(
              completionList(item("fim-visible", 0, 0, "F", { visible: true })),
            ).start(),
        },
        nes: {
          start: () =>
            resolvedBranch(
              completionList(
                item("nes-menu", 0, 0, "N", {
                  showInlineEditMenu: true,
                }),
              ),
            ).start(),
        },
        fimSemantics: semantics,
        nesSemantics: semantics,
        trigger: "explicit",
      });
      expect(cycling.kind).toBe("result");
      expect(
        cycling.kind === "result"
          ? cycling.list.items.map((value) => ({
              source: value.source,
              id: value.item.id,
            }))
          : [],
      ).toEqual(expected);
    },
  },
  {
    id: "model-unification-routing",
    assertion:
      "model unification uses only the unified NES path while joint routing stays independently disabled",
    run() {
      const expected = expectedFor<{
        jointProviderEnabled: boolean;
        unified: {
          fimEnabled: boolean;
          nesEnabled: boolean;
          serveAsCompletionsProvider: boolean;
        };
        independent: {
          fimEnabled: boolean;
          nesEnabled: boolean;
          serveAsCompletionsProvider: boolean;
        };
      }>("model-unification-routing");
      expect(COPILOT_BEHAVIOR_CONFIG.joint.enabled).toBe(
        expected.jointProviderEnabled,
      );
      expect(
        resolveCopilotRuntimeAvailability({
          enableFIM: true,
          enableNES: true,
          modelUnification: true,
          trigger: "automatic",
          completionsEnabled: true,
          inlineEditsEnabled: true,
        }),
      ).toEqual(expected.unified);
      expect(
        resolveCopilotRuntimeAvailability({
          enableFIM: true,
          enableNES: true,
          modelUnification: false,
          trigger: "automatic",
          completionsEnabled: true,
          inlineEditsEnabled: true,
        }),
      ).toEqual(expected.independent);
    },
  },
  {
    id: "separate-provider-change-ownership",
    assertion:
      "provider changes cannot replace a visible result owned by another separate provider",
    run() {
      const expected = expectedFor<{
        activeAfterFim: "fim";
        suppressSeparateNesWhileFimActive: boolean;
        activeAfterNes: "nes";
        endingOldFimPreserves: "nes";
        suppressJointNesWhileFimInFlight: boolean;
        suppressJointNesWhileIdle: boolean;
      }>("separate-provider-change-ownership");
      const state = new CopilotPresentedBranchState();
      const fimItem = {};
      const nesItem = {};

      state.show(fimItem, "fim");
      expect(state.branch).toBe(expected.activeAfterFim);
      expect(
        shouldSuppressNesProviderChange({
          jointProviderEnabled: false,
          suppressWhileFimInFlight: false,
          fimRequestsInFlight: 0,
          activePresentedBranch: state.branch,
        }),
      ).toBe(expected.suppressSeparateNesWhileFimActive);

      state.show(nesItem, "nes");
      expect(state.branch).toBe(expected.activeAfterNes);
      state.end(fimItem);
      expect(state.branch).toBe(expected.endingOldFimPreserves);

      expect(
        shouldSuppressNesProviderChange({
          jointProviderEnabled: true,
          suppressWhileFimInFlight: true,
          fimRequestsInFlight: 1,
          activePresentedBranch: state.branch,
        }),
      ).toBe(expected.suppressJointNesWhileFimInFlight);
      expect(
        shouldSuppressNesProviderChange({
          jointProviderEnabled: true,
          suppressWhileFimInFlight: true,
          fimRequestsInFlight: 0,
          activePresentedBranch: state.branch,
        }),
      ).toBe(expected.suppressJointNesWhileIdle);
    },
  },
  {
    id: "joint-default-and-selection",
    assertion:
      "default prefers FIM while selection requests only NES and disposes loser",
    async run() {
      const expected = expectedFor<{
        defaultWinner: string;
        selectionWinner: string;
        defaultStarts: Array<{ source: string; enforceCacheDelay?: boolean }>;
        selectionStarts: Array<{ source: string; enforceCacheDelay?: boolean }>;
      }>("joint-default-and-selection");
      const fim = resolvedBranch({ items: [item("fim", 1, 1, "F")] });
      const nes = resolvedBranch({ items: [item("nes", 1, 1, "N")] });
      const normal = await arbitrateJointCompletions({
        documentUri: "file:///joint.ts",
        documentVersion: 1,
        documentText: "ab",
        fim: { start: () => fim.start() },
        nes: { start: (delay) => nes.start(delay) },
        fimSemantics: semantics,
        nesSemantics: semantics,
      });
      expect(normal.kind).toBe("result");
      if (normal.kind !== "result")
        throw new Error("Expected default joint result.");
      expect(normal.source).toBe(expected.defaultWinner);
      expect(nes.control.cancellations).toContain("lost-race");
      expect(fim.control.starts).toHaveLength(
        expected.defaultStarts.filter((entry) => entry.source === "fim").length,
      );
      expect(nes.control.starts).toEqual(
        expected.defaultStarts
          .filter((entry) => entry.source === "nes")
          .map((entry) => entry.enforceCacheDelay ?? false),
      );

      const selectionFim = resolvedBranch({
        items: [item("fim-selection", 1, 1, "F")],
      });
      const selectionNes = resolvedBranch({
        items: [item("nes-selection", 1, 1, "N")],
      });
      const selection = await arbitrateJointCompletions({
        documentUri: "file:///joint.ts",
        documentVersion: 1,
        documentText: "ab",
        fim: { start: () => selectionFim.start() },
        nes: { start: (delay) => selectionNes.start(delay) },
        fimSemantics: semantics,
        nesSemantics: semantics,
        selectionTriggered: true,
      });
      expect(selection.kind).toBe("result");
      if (selection.kind !== "result")
        throw new Error("Expected selection joint result.");
      expect(selection.source).toBe(expected.selectionWinner);
      expect(selectionFim.control.starts).toHaveLength(
        expected.selectionStarts.filter((entry) => entry.source === "fim")
          .length,
      );
      expect(selectionNes.control.starts).toEqual(
        expected.selectionStarts
          .filter((entry) => entry.source === "nes")
          .map((entry) => entry.enforceCacheDelay ?? false),
      );
    },
  },
  {
    id: "joint-cursor-end-of-line",
    assertion:
      "cursorEndOfLine routes trailing whitespace to FIM and in-line text to NES",
    run() {
      const expected = expectedFor<{
        endOfLine: "fim" | "nes";
        trailingWhitespace: "fim" | "nes";
        middleOfLine: "fim" | "nes";
      }>("joint-cursor-end-of-line");
      expect(resolveJointCursorBranch("const value = 1;", 16)).toBe(
        expected.endOfLine,
      );
      expect(resolveJointCursorBranch("const value = 1;   ", 16)).toBe(
        expected.trailingWhitespace,
      );
      expect(resolveJointCursorBranch("const value = 1;", 6)).toBe(
        expected.middleOfLine,
      );
    },
  },
  {
    id: "joint-cache-wait-agreement",
    assertion:
      "shown NES gets 10ms agreement window and cancellation disposes both branches",
    async run() {
      const expected = expectedFor<{
        cacheWaitMs: number;
        fastWinner: string;
        agreement: boolean;
        cancellationResult: null;
        cancellations: string[];
        disposalReasons: Array<{ kind: JointDisposeReason }>;
      }>("joint-cache-wait-agreement");
      const documentText = "ab";
      const matching = item("matching-nes", 1, 1, "N");
      const fastNes = resolvedBranch({ items: [matching] });
      const fast = await arbitrateJointCompletions({
        documentUri: "file:///joint.ts",
        documentVersion: 2,
        documentText,
        nes: { start: (delay) => fastNes.start(delay) },
        fimSemantics: semantics,
        nesSemantics: semantics,
        lastNesSuggestion: {
          documentUri: "file:///joint.ts",
          documentVersion: 2,
          documentWithEditApplied: "aNb",
          wasShown: true,
        },
        cacheWaitMs: expected.cacheWaitMs,
        clock: new ManualJointClock(1_000),
      });
      expect(fast.kind).toBe("result");
      if (fast.kind !== "result")
        throw new Error("Expected fast joint result.");
      expect(fast.source).toBe(expected.fastWinner);
      expect(expected.agreement).toBe(true);

      const clock = new ManualJointClock(2_000);
      const slowNes = deferredBranch();
      const timeoutFim = resolvedBranch({
        items: [item("timeout-fim", 1, 1, "F")],
      });
      const timed = arbitrateJointCompletions({
        documentUri: "file:///joint.ts",
        documentVersion: 2,
        documentText,
        fim: { start: () => timeoutFim.start() },
        nes: { start: (delay) => slowNes.start(delay) },
        fimSemantics: semantics,
        nesSemantics: semantics,
        lastNesSuggestion: {
          documentUri: "file:///joint.ts",
          documentVersion: 1,
          documentWithEditApplied: "aNb",
          wasShown: true,
        },
        cacheWaitMs: expected.cacheWaitMs,
        clock,
      });
      await flushMicrotasks(4);
      clock.advance(expected.cacheWaitMs - 1);
      await flushMicrotasks(2);
      expect(timeoutFim.control.starts).toHaveLength(0);
      clock.advance(1);
      await flushMicrotasks(8);
      const timedResult = await timed;
      expect(timedResult.kind).toBe("result");
      if (timedResult.kind !== "result")
        throw new Error("Expected timeout joint result.");
      expect(timedResult.source).toBe("fim");

      const cancellation = createCancellationSource();
      const cancelledFim = deferredBranch();
      const cancelledNes = deferredBranch();
      const pending = arbitrateJointCompletions({
        documentUri: "file:///joint.ts",
        documentVersion: 1,
        documentText,
        fim: { start: () => cancelledFim.start() },
        nes: { start: (delay) => cancelledNes.start(delay) },
        fimSemantics: semantics,
        nesSemantics: semantics,
        cancellation: cancellation.token,
      });
      await flushMicrotasks(4);
      cancellation.cancel();
      const cancelled = await pending;
      expect(cancelled.kind).toBe("cancelled");
      expect(expected.cancellationResult).toBeNull();
      expect(expected.cancellations).toEqual(["fim", "nes"]);
      expect([
        ...cancelledFim.control.disposals,
        ...cancelledNes.control.disposals,
      ]).toEqual(expected.disposalReasons.map((entry) => entry.kind));
      expect(cancelledFim.control.cancellations).toEqual([
        "token-cancellation",
      ]);
      expect(cancelledNes.control.cancellations).toEqual([
        "token-cancellation",
      ]);
    },
  },
];
