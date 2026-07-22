import { expect } from 'vitest';
import {
  tryRebaseNesEdits,
  type NesRebaseConfig,
  type NesRebaseResult,
} from '../../src/chat-lib/core/nes/edit-rebase';
import {
  NesSpeculativeState,
  type NesSpeculativeCancelReason,
} from '../../src/chat-lib/core/nes/speculative';
import {
  NesStringEdit,
  NesStringReplacement,
} from '../../src/chat-lib/core/nes/string-edit';
import type { NesTextEdit } from '../../src/chat-lib/core/nes/types';
import { expectedFor, type ParityCase } from './support';

interface ReplacementVector {
  readonly sourceIndex?: number;
  readonly start: number;
  readonly endExclusive: number;
  readonly newText: string;
}

interface ReferenceResult {
  readonly kind: string;
  readonly edits?: readonly ReplacementVector[];
  readonly detailedEdits?: readonly (readonly ReplacementVector[])[];
  readonly appliedToCurrent?: string;
}

interface RebaseVector {
  readonly typeThrough: readonly ReplacementVector[];
  readonly autoClose: {
    readonly disabled: null;
    readonly enabled: readonly ReplacementVector[];
  };
  readonly reverseAgreement: {
    readonly disabled: null;
    readonly enabled: readonly ReplacementVector[];
  };
  readonly full: {
    readonly success: readonly {
      readonly rebasedEditIndex: number;
      readonly replacements: readonly ReplacementVector[];
    }[];
    readonly outsideEditWindow: string;
    readonly inconsistentSequentialEdits: string;
  };
  readonly consistency: {
    readonly matching: boolean;
    readonly inconsistent: boolean;
  };
  readonly sequentialReference: {
    readonly lengthDelta: ReferenceResult;
    readonly overlapping: ReferenceResult;
    readonly coarseDetailed: ReferenceResult;
    readonly invariantError: ReferenceResult;
  };
  readonly multiInnerChanges: {
    readonly strict: ReferenceResult;
    readonly lenientMiddle: ReferenceResult;
  };
}

interface SpeculativeVector {
  readonly scheduled: {
    readonly wrongStream: null;
    readonly consumedHeaderRequestId: string;
    readonly laterEditId: string;
    readonly consumedAgain: null;
  };
  readonly replacement: {
    readonly firstEvents: readonly string[];
    readonly secondPending: boolean;
  };
  readonly trajectory: Readonly<
    Record<
      | 'typeThroughPrefix'
      | 'divergentForm'
      | 'divergentPrefix'
      | 'divergentSuffix'
      | 'divergentMiddle',
      { readonly pending: boolean; readonly events: readonly string[] }
    >
  >;
}

const uri = 'file:///a.ts';
const strictConfig: NesRebaseConfig = {
  absorbSubsequenceTyping: false,
  reverseAgreement: true,
  maxImperfectAgreementLength: 1,
};

function textEdit(
  startOffset: number,
  endOffset: number,
  newText: string,
  patchIndex?: number,
): NesTextEdit {
  return {
    uri,
    startOffset,
    endOffset,
    newText,
    kind: startOffset === endOffset ? 'insert' : 'replace',
    ...(patchIndex === undefined ? {} : { patchIndex }),
  };
}

function stringEdit(
  start: number,
  endOffset: number,
  newText: string,
): NesStringEdit {
  return NesStringEdit.single(
    new NesStringReplacement({ start, endOffset }, newText),
  );
}

function replacementVector(edit: NesTextEdit): ReplacementVector {
  return {
    ...(edit.patchIndex === undefined ? {} : { sourceIndex: edit.patchIndex }),
    start: edit.startOffset,
    endExclusive: edit.endOffset,
    newText: edit.newText,
  };
}

function editsOrNull(result: NesRebaseResult): readonly ReplacementVector[] | null {
  return result.kind === 'success'
    ? result.edits.map(replacementVector)
    : null;
}

function referenceResult(result: NesRebaseResult): ReferenceResult {
  return result.kind === 'success'
    ? { kind: 'success', edits: result.edits.map(replacementVector) }
    : { kind: result.kind };
}

function rebase(
  original: string,
  edits: readonly NesTextEdit[],
  userEdit: NesStringEdit,
  current: string,
  resolution: 'strict' | 'lenient' = 'strict',
  config: NesRebaseConfig = strictConfig,
  editWindow?: { readonly start: number; readonly endOffset: number },
  cursorOffset?: number,
): NesRebaseResult {
  return tryRebaseNesEdits(
    original,
    editWindow,
    edits,
    userEdit,
    current,
    cursorOffset,
    resolution,
    config,
  );
}

function applyEdits(text: string, edits: readonly ReplacementVector[]): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.endExclusive)}`;
  }
  return result;
}

const cancelReasonNames: Readonly<Record<NesSpeculativeCancelReason, string>> = {
  rejected: 'rejected',
  ignoredDismissed: 'ignoredDismissed',
  superseded: 'superseded',
  replaced: 'replaced',
  trajectoryForm: 'divergedFromTrajectoryForm',
  trajectoryPrefix: 'divergedFromTrajectoryPrefix',
  trajectoryMiddle: 'divergedFromTrajectoryMiddle',
  trajectorySuffix: 'divergedFromTrajectorySuffix',
  cacheCleared: 'cacheCleared',
  documentClosed: 'documentClosed',
  disposed: 'disposed',
};

function trajectoryResult(currentText: string): {
  readonly pending: boolean;
  readonly events: readonly string[];
} {
  const state = new NesSpeculativeState<never, string>();
  const events: string[] = [];
  state.setPending({
    documentUri: uri,
    postEditContent: 'preMODELpost',
    trajectoryPrefix: 'pre',
    trajectorySuffix: 'post',
    trajectoryNewText: 'MODEL',
    value: 'pending',
    cancel: (reason) => {
      events.push(`speculative request cancelled: ${cancelReasonNames[reason]}`);
      events.push('cancel', 'dispose');
    },
  });
  state.onDocumentChanged(uri, currentText);
  return { pending: state.pending !== undefined, events };
}

export const nesStateCases: readonly ParityCase[] = [
  {
    id: 'nes-rebase-agreement',
    assertion: 'local rebase matches official agreement and sequential-coordinate vectors',
    run() {
      const expected = expectedFor<RebaseVector>('nes-rebase-agreement');
      expect(
        editsOrNull(
          rebase(
            'ab',
            [textEdit(1, 1, 'hello')],
            stringEdit(1, 1, 'he'),
            'aheb',
          ),
        ),
      ).toEqual(expected.typeThrough);

      const autoCloseDisabled = rebase(
        'call',
        [textEdit(4, 4, '(value)')],
        stringEdit(4, 4, '()'),
        'call()',
        'strict',
        { ...strictConfig, absorbSubsequenceTyping: false },
      );
      const autoCloseEnabled = rebase(
        'call',
        [textEdit(4, 4, '(value)')],
        stringEdit(4, 4, '()'),
        'call()',
        'strict',
        { ...strictConfig, absorbSubsequenceTyping: true },
      );
      expect(editsOrNull(autoCloseDisabled)).toEqual(expected.autoClose.disabled);
      expect(editsOrNull(autoCloseEnabled)).toEqual(expected.autoClose.enabled);

      const reverseDisabled = rebase(
        '',
        [textEdit(0, 0, 'foo')],
        stringEdit(0, 0, 'foobar'),
        'foobar',
        'strict',
        { ...strictConfig, reverseAgreement: false },
      );
      const reverseEnabled = rebase(
        '',
        [textEdit(0, 0, 'foo')],
        stringEdit(0, 0, 'foobar'),
        'foobar',
      );
      expect(editsOrNull(reverseDisabled)).toEqual(
        expected.reverseAgreement.disabled,
      );
      expect(editsOrNull(reverseEnabled)).toEqual(
        expected.reverseAgreement.enabled,
      );

      const fullSuccess = rebase(
        'ab',
        [textEdit(1, 1, 'hello', 0)],
        stringEdit(1, 1, 'he'),
        'aheb',
        'strict',
        { ...strictConfig, maxImperfectAgreementLength: 5 },
        { start: 0, endOffset: 2 },
        3,
      );
      expect(
        fullSuccess.kind === 'success'
          ? [
              {
                rebasedEditIndex: 0,
                replacements: fullSuccess.edits.map((edit) => ({
                  start: edit.startOffset,
                  endExclusive: edit.endOffset,
                  newText: edit.newText,
                })),
              },
            ]
          : fullSuccess.kind,
      ).toEqual(expected.full.success);
      expect(
        rebase(
          'ab',
          [textEdit(1, 1, 'hello')],
          stringEdit(1, 1, 'he'),
          'aheb',
          'strict',
          strictConfig,
          { start: 0, endOffset: 1 },
          4,
        ).kind,
      ).toBe(expected.full.outsideEditWindow);
      expect(
        rebase(
          'ab',
          [textEdit(1, 1, 'hello')],
          stringEdit(1, 1, 'he'),
          'not-the-user-edit',
        ).kind,
      ).toBe(expected.full.inconsistentSequentialEdits);
      expect({
        matching: stringEdit(1, 1, 'he').apply('ab') === 'aheb',
        inconsistent:
          stringEdit(1, 1, 'he').apply('ab') === 'not-the-user-edit',
      }).toEqual(expected.consistency);

      const lengthDelta = referenceResult(
        rebase(
          'one\ntwo\nthree',
          [
            textEdit(0, 3, 'first', 0),
            textEdit(6, 9, 'second', 1),
          ],
          NesStringEdit.empty,
          'one\ntwo\nthree',
        ),
      );
      expect(lengthDelta.kind).toBe(expected.sequentialReference.lengthDelta.kind);
      expect(lengthDelta.edits).toEqual(
        expected.sequentialReference.lengthDelta.edits,
      );

      const overlapping = referenceResult(
        rebase(
          'abcdef',
          [textEdit(1, 3, 'X', 0), textEdit(1, 2, 'YZ', 1)],
          NesStringEdit.empty,
          'abcdef',
        ),
      );
      expect(overlapping.kind).toBe(expected.sequentialReference.overlapping.kind);
      expect(overlapping.edits).toEqual(
        expected.sequentialReference.overlapping.edits,
      );

      const coarse = referenceResult(
        rebase(
          'abc\ndef',
          [textEdit(0, 7, 'abc\ndXf', 0)],
          NesStringEdit.empty,
          'abc\ndef',
        ),
      );
      expect(coarse.kind).toBe(expected.sequentialReference.coarseDetailed.kind);
      expect(coarse.edits).toEqual(
        expected.sequentialReference.coarseDetailed.edits,
      );

      expect(
        rebase(
          'bcbaXca',
          [textEdit(4, 6, ')Zb', 0), textEdit(6, 6, 'Y', 1)],
          NesStringEdit.empty,
          'bcbaXca',
        ).kind,
      ).toBe(expected.sequentialReference.invariantError.kind);

      const strictMulti = referenceResult(
        rebase(
          'one\nmiddle\nthree',
          [textEdit(0, 16, 'ONE\nmiddle\nTHREE', 0)],
          stringEdit(11, 12, 'T'),
          'one\nmiddle\nThree',
        ),
      );
      expect(strictMulti.kind).toBe(expected.multiInnerChanges.strict.kind);
      expect(strictMulti.edits).toEqual(expected.multiInnerChanges.strict.edits);
      if (strictMulti.edits) {
        expect(applyEdits('one\nmiddle\nThree', strictMulti.edits)).toBe(
          expected.multiInnerChanges.strict.appliedToCurrent,
        );
      }

      const lenientMulti = referenceResult(
        rebase(
          'one\nmiddle\nthree',
          [textEdit(0, 16, 'ONE\nmiddle\nTHREE', 0)],
          stringEdit(6, 7, 'X'),
          'one\nmiXdle\nthree',
          'lenient',
        ),
      );
      expect(lenientMulti.kind).toBe(
        expected.multiInnerChanges.lenientMiddle.kind,
      );
      expect(lenientMulti.edits).toEqual(
        expected.multiInnerChanges.lenientMiddle.edits,
      );
      if (lenientMulti.edits) {
        expect(applyEdits('one\nmiXdle\nthree', lenientMulti.edits)).toBe(
          expected.multiInnerChanges.lenientMiddle.appliedToCurrent,
        );
      }
    },
  },
  {
    id: 'nes-speculative-lifecycle',
    assertion: 'local speculative ownership and trajectory cancellation match official state',
    run() {
      const expected = expectedFor<SpeculativeVector>(
        'nes-speculative-lifecycle',
      );
      const scheduled = new NesSpeculativeState<
        { readonly result: { readonly edit: { readonly id: string } } },
        never
      >();
      scheduled.schedule({
        originRequestId: 'stream-a',
        suggestion: { result: { edit: { id: 'later-edit' } } },
      });
      expect(scheduled.consumeScheduled('stream-b') ?? null).toBe(
        expected.scheduled.wrongStream,
      );
      const consumed = scheduled.consumeScheduled('stream-a');
      expect({
        consumedHeaderRequestId: consumed?.originRequestId,
        laterEditId: consumed?.suggestion.result.edit.id,
        consumedAgain: scheduled.consumeScheduled('stream-a') ?? null,
      }).toEqual({
        consumedHeaderRequestId: expected.scheduled.consumedHeaderRequestId,
        laterEditId: expected.scheduled.laterEditId,
        consumedAgain: expected.scheduled.consumedAgain,
      });

      const replacement = new NesSpeculativeState<never, string>();
      const firstEvents: string[] = [];
      replacement.setPending({
        documentUri: uri,
        postEditContent: 'preMODELpost',
        trajectoryPrefix: 'pre',
        trajectorySuffix: 'post',
        trajectoryNewText: 'MODEL',
        value: 'first',
        cancel: (reason) => {
          firstEvents.push(
            `speculative request cancelled: ${cancelReasonNames[reason]}`,
          );
          firstEvents.push('cancel', 'dispose');
        },
      });
      replacement.setPending({
        documentUri: uri,
        postEditContent: 'preMODELpost',
        trajectoryPrefix: 'pre',
        trajectorySuffix: 'post',
        trajectoryNewText: 'MODEL',
        value: 'second',
        cancel: () => undefined,
      });
      expect({
        firstEvents,
        secondPending: replacement.pending !== undefined,
      }).toEqual(expected.replacement);

      expect({
        typeThroughPrefix: trajectoryResult('preMOpost'),
        divergentForm: trajectoryResult('short'),
        divergentPrefix: trajectoryResult('badMODELpost'),
        divergentSuffix: trajectoryResult('preMODELbad'),
        divergentMiddle: trajectoryResult('preMXpost'),
      }).toEqual(expected.trajectory);
    },
  },
];
