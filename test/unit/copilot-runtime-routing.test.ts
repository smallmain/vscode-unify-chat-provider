import { describe, expect, it } from "vitest";
import {
  CopilotPresentedBranchState,
  FimListDiscardTracker,
  quickSuggestionsDisabled,
  resolveCopilotRuntimeAvailability,
  resolveJointCursorBranch,
  shouldRespectSelectedCompletionInfo,
  shouldSuppressNesProviderChange,
} from "../../src/completion/copilot/runtime-routing";

describe("FimListDiscardTracker", () => {
  it("does not end a core list when only one of several items is discarded", () => {
    const tracker = new FimListDiscardTracker();
    tracker.register("list", 2);

    expect(tracker.recordDiscardedItem("list")).toBe(false);
    expect(tracker.recordDiscardedItem("list")).toBe(true);
    expect(tracker.recordDiscardedItem("list")).toBe(false);
  });

  it("forgets scheduler discard state when the real list ends", () => {
    const tracker = new FimListDiscardTracker();
    tracker.register("list", 2);
    expect(tracker.recordDiscardedItem("list")).toBe(false);

    tracker.endList("list");

    expect(tracker.recordDiscardedItem("list")).toBe(false);
  });
});

describe("Copilot runtime availability", () => {
  it.each([
    {
      completionsEnabled: true,
      inlineEditsEnabled: true,
      expected: {
        fimEnabled: false,
        nesEnabled: true,
        serveAsCompletionsProvider: false,
      },
    },
    {
      completionsEnabled: true,
      inlineEditsEnabled: false,
      expected: {
        fimEnabled: false,
        nesEnabled: true,
        serveAsCompletionsProvider: true,
      },
    },
    {
      completionsEnabled: false,
      inlineEditsEnabled: true,
      expected: {
        fimEnabled: false,
        nesEnabled: true,
        serveAsCompletionsProvider: false,
      },
    },
    {
      completionsEnabled: false,
      inlineEditsEnabled: false,
      expected: {
        fimEnabled: false,
        nesEnabled: false,
        serveAsCompletionsProvider: false,
      },
    },
  ])(
    "routes model unification completions=$completionsEnabled inlineEdits=$inlineEditsEnabled",
    ({ completionsEnabled, inlineEditsEnabled, expected }) => {
      expect(
        resolveCopilotRuntimeAvailability({
          enableFIM: true,
          enableNES: true,
          modelUnification: true,
          trigger: "automatic",
          completionsEnabled,
          inlineEditsEnabled,
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    {
      completionsEnabled: true,
      inlineEditsEnabled: true,
      expected: {
        fimEnabled: true,
        nesEnabled: true,
        serveAsCompletionsProvider: false,
      },
    },
    {
      completionsEnabled: true,
      inlineEditsEnabled: false,
      expected: {
        fimEnabled: true,
        nesEnabled: false,
        serveAsCompletionsProvider: false,
      },
    },
    {
      completionsEnabled: false,
      inlineEditsEnabled: true,
      expected: {
        fimEnabled: false,
        nesEnabled: true,
        serveAsCompletionsProvider: false,
      },
    },
    {
      completionsEnabled: false,
      inlineEditsEnabled: false,
      expected: {
        fimEnabled: false,
        nesEnabled: false,
        serveAsCompletionsProvider: false,
      },
    },
  ])(
    "routes independent models completions=$completionsEnabled inlineEdits=$inlineEditsEnabled",
    ({ completionsEnabled, inlineEditsEnabled, expected }) => {
      expect(
        resolveCopilotRuntimeAvailability({
          enableFIM: true,
          enableNES: true,
          modelUnification: false,
          trigger: "automatic",
          completionsEnabled,
          inlineEditsEnabled,
        }),
      ).toEqual(expected);
    },
  );

  it("lets Invoke bypass only the independent FIM completions language gate", () => {
    expect(
      resolveCopilotRuntimeAvailability({
        enableFIM: true,
        enableNES: true,
        modelUnification: false,
        trigger: "invoke",
        completionsEnabled: false,
        inlineEditsEnabled: false,
      }),
    ).toEqual({
      fimEnabled: true,
      nesEnabled: false,
      serveAsCompletionsProvider: false,
    });
  });

  it("does not start a second FIM request for unified Invoke routing", () => {
    expect(
      resolveCopilotRuntimeAvailability({
        enableFIM: true,
        enableNES: true,
        modelUnification: true,
        trigger: "invoke",
        completionsEnabled: false,
        inlineEditsEnabled: false,
      }),
    ).toEqual({
      fimEnabled: false,
      nesEnabled: false,
      serveAsCompletionsProvider: false,
    });
  });
});

describe("joint cursor-end-of-line routing", () => {
  it.each([
    { line: "const value = 1;", character: 16, expected: "fim" },
    { line: "const value = 1;   ", character: 16, expected: "fim" },
    { line: "const value = 1;", character: 6, expected: "nes" },
  ] as const)(
    "routes line=$line character=$character to $expected",
    ({ line, character, expected }) => {
      expect(resolveJointCursorBranch(line, character)).toBe(expected);
    },
  );
});

describe("Copilot provider-change ownership", () => {
  it("tracks the branch of the currently presented item by identity", () => {
    const state = new CopilotPresentedBranchState();
    const fimItem = {};
    const nesItem = {};

    state.show(fimItem, "fim");
    expect(state.branch).toBe("fim");

    state.show(nesItem, "nes");
    state.end(fimItem);
    expect(state.branch).toBe("nes");

    state.end(nesItem);
    expect(state.branch).toBeUndefined();
  });

  it.each([
    {
      name: "suppresses a separate NES update while FIM is active",
      input: {
        jointProviderEnabled: false,
        suppressWhileFimInFlight: false,
        fimRequestsInFlight: 0,
        activePresentedBranch: "fim" as const,
      },
      expected: true,
    },
    {
      name: "allows a separate NES update while NES is active",
      input: {
        jointProviderEnabled: false,
        suppressWhileFimInFlight: false,
        fimRequestsInFlight: 0,
        activePresentedBranch: "nes" as const,
      },
      expected: false,
    },
    {
      name: "suppresses a joint NES update only while FIM is in flight",
      input: {
        jointProviderEnabled: true,
        suppressWhileFimInFlight: true,
        fimRequestsInFlight: 1,
        activePresentedBranch: undefined,
      },
      expected: true,
    },
    {
      name: "allows an idle joint NES update regardless of the last branch",
      input: {
        jointProviderEnabled: true,
        suppressWhileFimInFlight: true,
        fimRequestsInFlight: 0,
        activePresentedBranch: "fim" as const,
      },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(shouldSuppressNesProviderChange(input)).toBe(expected);
  });
});

describe("selected completion routing", () => {
  it("detects whether every quick-suggestion category is disabled", () => {
    expect(
      quickSuggestionsDisabled({
        other: "off",
        comments: "off",
        strings: "off",
      }),
    ).toBe(true);
    expect(
      quickSuggestionsDisabled({
        other: "off",
        comments: "on",
        strings: "off",
      }),
    ).toBe(false);
  });

  it.each([
    {
      explicit: undefined,
      quickDisabled: false,
      preRelease: false,
      expected: false,
    },
    {
      explicit: undefined,
      quickDisabled: true,
      preRelease: false,
      expected: true,
    },
    {
      explicit: undefined,
      quickDisabled: false,
      preRelease: true,
      expected: true,
    },
    { explicit: false, quickDisabled: true, preRelease: true, expected: false },
    { explicit: true, quickDisabled: false, preRelease: false, expected: true },
  ])(
    "resolves explicit=$explicit quickDisabled=$quickDisabled preRelease=$preRelease",
    ({ explicit, quickDisabled, preRelease, expected }) => {
      expect(
        shouldRespectSelectedCompletionInfo(
          explicit,
          quickDisabled,
          preRelease,
        ),
      ).toBe(expected);
    },
  );
});
