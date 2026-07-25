import "./vscode-mock";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ghostTextCases } from "./ghost-text-cases";
import { jointCases } from "./joint-cases";
import { nesCases } from "./nes-cases";
import { nesCacheSpeculativeCases } from "./nes-cache-speculative-cases";
import { nesStateCases } from "./nes-state-cases";
import {
  behaviorMatrix,
  completionEffects,
  type ParityCase,
} from "./support";
import { resetVscodeMock } from "./vscode-mock";

const cases: readonly ParityCase[] = [
  ...ghostTextCases,
  ...nesCases,
  ...nesCacheSpeculativeCases,
  ...nesStateCases,
  ...jointCases,
];

afterEach(() => {
  vi.useRealTimers();
  resetVscodeMock();
});

describe("frozen upstream parity coverage", () => {
  it("maps every behavior-matrix row to exactly one executable assertion", () => {
    const matrixIds = behaviorMatrix.rows.map((row) => row.id).sort();
    const caseIds = cases.map((entry) => entry.id).sort();
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(caseIds).toEqual(matrixIds);
    expect(cases.every((entry) => entry.assertion.trim().length > 0)).toBe(
      true,
    );
    expect(
      cases.every(
        (entry) =>
          !("parts" in entry) ||
          (entry.parts.length > 0 &&
            entry.parts.every((part) => part.assertion.trim().length > 0)),
      ),
    ).toBe(true);
  });

  it("maps every row to one reviewed completion-effect baseline", () => {
    expect(completionEffects.upstream).toEqual(behaviorMatrix.upstream);
    expect(behaviorMatrix.upstream.ref).toBe(behaviorMatrix.upstream.commit);

    const matrixIds = behaviorMatrix.rows.map((row) => row.id).sort();
    const effectIds = Object.keys(completionEffects.effects).sort();
    expect(effectIds).toEqual(matrixIds);

    for (const row of behaviorMatrix.rows) {
      expect(row.category.trim().length).toBeGreaterThan(0);
      expect(row.observable.trim().length).toBeGreaterThan(0);
      expect(row.anchor.trim().length).toBeGreaterThan(0);
      expect(row.lineStart).toBeGreaterThan(0);
      expect(row.lineEnd).toBeGreaterThanOrEqual(row.lineStart);
      expect(completionEffects.effects[row.id]).toBeDefined();
    }
  });
});

describe("completion parity vectors", () => {
  for (const parityCase of cases) {
    if ("parts" in parityCase) {
      describe(`${parityCase.id}: ${parityCase.assertion}`, () => {
        it.each(parityCase.parts)("$assertion", async (part) => {
          await part.run();
        });
      });
    } else {
      it(`${parityCase.id}: ${parityCase.assertion}`, async () => {
        await parityCase.run();
      });
    }
  }
});
