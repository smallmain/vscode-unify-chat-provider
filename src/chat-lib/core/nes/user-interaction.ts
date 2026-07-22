import type {
  CopilotBehaviorConfig,
  NesAggressivenessLevel,
  NesAggressivenessSetting,
  NesPromptStrategy,
  UserHappinessScoreConfig,
} from "../behavior-config";

export type NesUserActionKind = "accepted" | "rejected" | "ignored";

export interface NesUserAction {
  readonly kind: NesUserActionKind;
}

export interface NesInteractionClock {
  now(): number;
}

export const MAX_INTERACTIONS_CONSIDERED = 10;
export const MAX_INTERACTIONS_STORED = 30;

const SYSTEM_CLOCK: NesInteractionClock = { now: Date.now };

export function isNesCursorAtEndOfLine(textAfterCursor: string): boolean {
  return /^\s*$/.test(textAfterCursor);
}

export function isNesInlineSuggestionPosition(
  textAfterCursor: string,
): boolean | undefined {
  const isMiddleOfLine = textAfterCursor.trim().length !== 0;
  const isValidMiddleOfLine = /^\s*[)>}\]"'`]*\s*[:{;,]?\s*$/.test(
    textAfterCursor.trim(),
  );
  if (isMiddleOfLine && !isValidMiddleOfLine) {
    return undefined;
  }
  return isMiddleOfLine && isValidMiddleOfLine;
}

export function shouldRecordNesIgnored(
  wasShown: boolean,
  wasSuperseded: boolean,
): boolean {
  return wasShown && !wasSuperseded;
}

export function getNesExtraDebounceMs(
  config: Pick<
    CopilotBehaviorConfig["nextEdit"],
    "extraDebounceEndOfLineMs" | "extraDebounceInlineSuggestionMs"
  >,
  textAfterCursor: string,
  speculative: boolean,
): number | undefined {
  if (speculative) return undefined;
  if (
    isNesInlineSuggestionPosition(textAfterCursor) &&
    config.extraDebounceInlineSuggestionMs > 0
  ) {
    return config.extraDebounceInlineSuggestionMs;
  }
  return isNesCursorAtEndOfLine(textAfterCursor)
    ? config.extraDebounceEndOfLineMs
    : undefined;
}

export function getWindowWithIgnoredLimit(
  actions: readonly NesUserAction[],
  config: UserHappinessScoreConfig,
): NesUserAction[] {
  const { limitConsecutiveIgnored, limitTotalIgnored, ignoredLimit } = config;
  if (!limitConsecutiveIgnored && !limitTotalIgnored) {
    return actions.slice(-MAX_INTERACTIONS_CONSIDERED);
  }

  const result: NesUserAction[] = [];
  let consecutiveIgnored = 0;
  let totalIgnored = 0;
  for (
    let index = actions.length - 1;
    index >= 0 && result.length < MAX_INTERACTIONS_CONSIDERED;
    index -= 1
  ) {
    const action = actions[index];
    if (action.kind === "ignored") {
      if (
        (limitConsecutiveIgnored && consecutiveIgnored >= ignoredLimit) ||
        (limitTotalIgnored && totalIgnored >= ignoredLimit)
      ) {
        continue;
      }
      consecutiveIgnored += 1;
      totalIgnored += 1;
    } else {
      consecutiveIgnored = 0;
    }
    result.push(action);
  }
  result.reverse();
  return result;
}

export function getUserHappinessScore(
  actions: readonly NesUserAction[],
  config: UserHappinessScoreConfig,
): number {
  if (actions.length === 0) {
    return 0.5;
  }
  const window = getWindowWithIgnoredLimit(actions, config);
  if (window.length === 0) {
    return 0.5;
  }

  let weightedScore = 0;
  let totalWeight = 0;
  let scoredActionCount = 0;
  for (const [index, action] of window.entries()) {
    if (action.kind === "ignored" && !config.includeIgnored) {
      continue;
    }
    scoredActionCount += 1;
    const weight = index + 1;
    const score =
      action.kind === "accepted"
        ? config.acceptedScore
        : action.kind === "rejected"
          ? config.rejectedScore
          : config.ignoredScore;
    const normalized =
      (score - config.rejectedScore) /
      (config.acceptedScore - config.rejectedScore);
    weightedScore += normalized * weight;
    totalWeight += weight;
  }

  const rawScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;
  const dataConfidence = scoredActionCount / MAX_INTERACTIONS_CONSIDERED;
  return 0.5 + (rawScore - 0.5) * dataConfidence;
}

export class NesDelaySession {
  private extraDebounceMs = 0;

  constructor(
    private baseDebounceMs: number,
    private expectedTotalMs: number | undefined,
    private readonly invocationTime: number,
    private readonly clock: NesInteractionClock = SYSTEM_CLOCK,
  ) {}

  setExtraDebounce(extraDebounceMs: number): void {
    this.extraDebounceMs = extraDebounceMs;
  }

  setBaseDebounceTime(baseDebounceMs: number): void {
    this.baseDebounceMs = baseDebounceMs;
  }

  setExpectedTotalTime(expectedTotalMs: number): void {
    this.expectedTotalMs = expectedTotalMs;
  }

  getDebounceTime(): number {
    const expectedDebounceMs =
      this.expectedTotalMs === undefined
        ? this.baseDebounceMs
        : Math.min(this.baseDebounceMs, this.expectedTotalMs);
    const timeAlreadySpent = this.clock.now() - this.invocationTime;
    return Math.max(
      0,
      expectedDebounceMs + this.extraDebounceMs - timeAlreadySpent,
    );
  }

  getArtificialDelay(): number {
    if (this.expectedTotalMs === undefined) {
      return 0;
    }
    return Math.max(
      0,
      this.expectedTotalMs - (this.clock.now() - this.invocationTime),
    );
  }
}

export function isAggressivenessPromptStrategy(
  strategy: NesPromptStrategy,
): boolean {
  return (
    strategy === "xtabAggressiveness" ||
    strategy === "xtab275Aggressiveness" ||
    strategy === "xtab275AggressivenessHighLow" ||
    strategy === "xtab275EditIntent" ||
    strategy === "xtab275EditIntentShort"
  );
}

export class NesUserInteractionMonitor {
  private aggressivenessActions: NesUserAction[] = [];
  private lastActionWasAcceptance = false;

  constructor(
    private readonly config: CopilotBehaviorConfig["nextEdit"],
    private setting: NesAggressivenessSetting = config.defaultAggressivenessSetting,
    private readonly clock: NesInteractionClock = SYSTEM_CLOCK,
  ) {}

  setAggressivenessSetting(setting: NesAggressivenessSetting): void {
    this.setting = setting;
  }

  handleAcceptance(): void {
    this.record("accepted");
  }

  handleRejection(): void {
    this.record("rejected");
  }

  handleIgnored(): void {
    this.record("ignored");
  }

  get wasLastActionAcceptance(): boolean {
    return this.lastActionWasAcceptance;
  }

  createDelaySession(requestTime?: number): NesDelaySession {
    const expectedTotalMs = this.config.backoffDebounceEnabled
      ? this.config.requestDebounceMs
      : undefined;
    return new NesDelaySession(
      this.config.requestDebounceMs,
      expectedTotalMs,
      requestTime ?? this.clock.now(),
      this.clock,
    );
  }

  configureDelayForSetting(
    session: NesDelaySession,
    strategy: NesPromptStrategy,
  ): void {
    if (isAggressivenessPromptStrategy(strategy)) {
      return;
    }
    switch (this.setting) {
      case "auto":
        return;
      case "high":
        session.setBaseDebounceTime(this.config.aggressivenessHighDebounceMs);
        return;
      case "medium":
        if (!this.wasLastActionAcceptance) {
          session.setExpectedTotalTime(
            this.config.aggressivenessMediumMinResponseTimeMs,
          );
        }
        return;
      case "low":
        if (!this.wasLastActionAcceptance) {
          session.setExpectedTotalTime(
            this.config.aggressivenessLowMinResponseTimeMs,
          );
        }
    }
  }

  configureDelayForRequest(
    session: NesDelaySession,
    strategy: NesPromptStrategy,
    textAfterCursor: string,
    speculative: boolean,
  ): void {
    const extraDebounceMs = getNesExtraDebounceMs(
      this.config,
      textAfterCursor,
      speculative,
    );
    if (extraDebounceMs !== undefined) {
      session.setExtraDebounce(extraDebounceMs);
    }
    this.configureDelayForSetting(session, strategy);
  }

  getAggressivenessLevel(): {
    readonly aggressivenessLevel: NesAggressivenessLevel;
    readonly userHappinessScore: number | undefined;
  } {
    if (this.setting !== "auto") {
      return {
        aggressivenessLevel: this.setting,
        userHappinessScore: undefined,
      };
    }
    if (this.config.configuredAggressivenessLevel !== null) {
      return {
        aggressivenessLevel: this.config.configuredAggressivenessLevel,
        userHappinessScore: undefined,
      };
    }
    const userHappinessScore = getUserHappinessScore(
      this.aggressivenessActions,
      this.config.userHappinessScore,
    );
    const aggressivenessLevel: NesAggressivenessLevel =
      userHappinessScore >= this.config.userHappinessScore.highThreshold
        ? "high"
        : userHappinessScore >= this.config.userHappinessScore.mediumThreshold
          ? "medium"
          : "low";
    return { aggressivenessLevel, userHappinessScore };
  }

  getState(): {
    readonly setting: NesAggressivenessSetting;
    readonly aggressivenessActions: readonly NesUserAction[];
    readonly wasLastActionAcceptance: boolean;
    readonly aggressivenessLevel: NesAggressivenessLevel;
    readonly userHappinessScore: number | undefined;
  } {
    const aggressiveness = this.getAggressivenessLevel();
    return {
      setting: this.setting,
      aggressivenessActions: [...this.aggressivenessActions],
      wasLastActionAcceptance: this.wasLastActionAcceptance,
      ...aggressiveness,
    };
  }

  private record(kind: NesUserActionKind): void {
    const action = { kind } as const;
    this.lastActionWasAcceptance = kind === "accepted";
    this.aggressivenessActions = [...this.aggressivenessActions, action].slice(
      -MAX_INTERACTIONS_STORED,
    );
  }
}
