import { describe, expect, it } from "vitest";
import { COPILOT_BEHAVIOR_CONFIG } from "../../src/chat-lib/core/behavior-config";
import {
  getUserHappinessScore,
  getWindowWithIgnoredLimit,
  isNesCursorAtEndOfLine,
  isNesInlineSuggestionPosition,
  MAX_INTERACTIONS_STORED,
  NesUserInteractionMonitor,
  type NesInteractionClock,
} from "../../src/chat-lib/core/nes/user-interaction";

class FakeClock implements NesInteractionClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  advance(delayMs: number): void {
    this.value += delayMs;
  }
}

describe("NES user interaction monitor", () => {
  it("keeps the 30-action aggressiveness window", () => {
    const clock = new FakeClock(1_000);
    const monitor = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "auto",
      clock,
    );
    for (let index = 0; index < 35; index += 1) {
      monitor.handleAcceptance();
    }
    monitor.handleIgnored();
    const state = monitor.getState();
    expect(state.aggressivenessActions).toHaveLength(MAX_INTERACTIONS_STORED);
    expect(state.aggressivenessActions.at(-1)?.kind).toBe("ignored");
  });

  it("matches the official weighted happiness defaults and level thresholds", () => {
    const config = COPILOT_BEHAVIOR_CONFIG.nextEdit.userHappinessScore;
    expect(getUserHappinessScore([], config)).toBe(0.5);
    expect(
      getUserHappinessScore(
        Array.from({ length: 10 }, () => ({
          kind: "accepted" as const,
        })),
        config,
      ),
    ).toBe(1);
    expect(
      getUserHappinessScore(
        Array.from({ length: 10 }, () => ({
          kind: "rejected" as const,
        })),
        config,
      ),
    ).toBe(0);

    const clock = new FakeClock(1_000);
    const monitor = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "auto",
      clock,
    );
    expect(monitor.getAggressivenessLevel()).toEqual({
      aggressivenessLevel: "medium",
      userHappinessScore: 0.5,
    });
    for (let index = 0; index < 10; index += 1) {
      monitor.handleRejection();
    }
    expect(monitor.getAggressivenessLevel().aggressivenessLevel).toBe("low");
  });

  it("expands backwards when ignored actions hit the configured limit", () => {
    const config = {
      ...COPILOT_BEHAVIOR_CONFIG.nextEdit.userHappinessScore,
      includeIgnored: true,
      ignoredLimit: 2,
    };
    const actions = [
      { kind: "accepted" as const },
      { kind: "ignored" as const },
      { kind: "rejected" as const },
      { kind: "ignored" as const },
      { kind: "ignored" as const },
      { kind: "ignored" as const },
    ];
    expect(
      getWindowWithIgnoredLimit(actions, config).map((item) => item.kind),
    ).toEqual(["accepted", "rejected", "ignored", "ignored"]);
  });

  it("keeps debounce fixed across interaction history", () => {
    const clock = new FakeClock(1_000);
    const monitor = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "auto",
      clock,
    );
    monitor.handleRejection();
    monitor.handleIgnored();
    expect(monitor.createDelaySession().getArtificialDelay()).toBe(100);
    monitor.handleAcceptance();
    clock.advance(11 * 60 * 1_000);
    expect(monitor.createDelaySession().getArtificialDelay()).toBe(100);
  });

  it("uses the official low/medium minimum response and high debounce overrides", () => {
    const clock = new FakeClock(1_000);
    const low = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "low",
      clock,
    );
    const lowSession = low.createDelaySession();
    low.configureDelayForSetting(lowSession, "copilotNesXtab");
    expect(lowSession.getDebounceTime()).toBe(100);
    expect(lowSession.getArtificialDelay()).toBe(1_500);

    const medium = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "medium",
      clock,
    );
    const mediumSession = medium.createDelaySession();
    medium.configureDelayForSetting(mediumSession, "xtab275");
    expect(mediumSession.getArtificialDelay()).toBe(700);

    const high = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "high",
      clock,
    );
    const highSession = high.createDelaySession();
    high.configureDelayForSetting(highSession, "xtabUnifiedModel");
    expect(highSession.getDebounceTime()).toBe(0);
    expect(highSession.getArtificialDelay()).toBe(100);
  });

  it("skips explicit timing overrides for aggressiveness prompt strategies", () => {
    const clock = new FakeClock(1_000);
    const monitor = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "low",
      clock,
    );
    const session = monitor.createDelaySession();
    monitor.configureDelayForSetting(session, "xtab275EditIntent");
    expect(session.getDebounceTime()).toBe(100);
    expect(session.getArtificialDelay()).toBe(100);
    expect(monitor.getAggressivenessLevel()).toEqual({
      aggressivenessLevel: "low",
      userHappinessScore: undefined,
    });
  });

  it("skips low minimum response after the last action was accepted", () => {
    const clock = new FakeClock(1_000);
    const monitor = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "low",
      clock,
    );
    monitor.handleAcceptance();
    const session = monitor.createDelaySession();
    monitor.configureDelayForSetting(session, "copilotNesXtab");
    expect(session.getArtificialDelay()).toBe(100);
  });

  it("matches official end-of-line and inline-suggestion position detection", () => {
    expect(isNesCursorAtEndOfLine("")).toBe(true);
    expect(isNesCursorAtEndOfLine("  \t")).toBe(true);
    expect(isNesCursorAtEndOfLine(");")).toBe(false);
    expect(isNesInlineSuggestionPosition(");")).toBe(true);
    expect(isNesInlineSuggestionPosition(" value")).toBeUndefined();
    expect(isNesInlineSuggestionPosition("   ")).toBe(false);
  });

  it("applies official position debounce and skips it for speculative requests", () => {
    const clock = new FakeClock(1_000);
    const monitor = new NesUserInteractionMonitor(
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
      "auto",
      clock,
    );
    const endOfLine = monitor.createDelaySession();
    monitor.configureDelayForRequest(endOfLine, "copilotNesXtab", "  ", false);
    expect(endOfLine.getDebounceTime()).toBe(2_100);

    const inline = monitor.createDelaySession();
    monitor.configureDelayForRequest(inline, "copilotNesXtab", ");", false);
    expect(inline.getDebounceTime()).toBe(100);

    const speculative = monitor.createDelaySession();
    monitor.configureDelayForRequest(speculative, "copilotNesXtab", "", true);
    expect(speculative.getDebounceTime()).toBe(100);
  });

  it("gives inline-suggestion extra debounce priority when configured", () => {
    const clock = new FakeClock(1_000);
    const monitor = new NesUserInteractionMonitor(
      {
        ...COPILOT_BEHAVIOR_CONFIG.nextEdit,
        extraDebounceInlineSuggestionMs: 300,
      },
      "auto",
      clock,
    );
    const session = monitor.createDelaySession();
    monitor.configureDelayForRequest(session, "copilotNesXtab", ");", false);
    expect(session.getDebounceTime()).toBe(400);
  });
});
