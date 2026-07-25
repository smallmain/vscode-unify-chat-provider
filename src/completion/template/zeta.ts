import { CompletionRuntimeError } from '../model/errors';
import type {
  EditAlgorithmDocument,
  EditAlgorithmSyntaxRange,
  ZetaCompletionRequest,
} from '../model/requests';
import {
  computeDocumentLegacyRanges,
  excerptByteRangeToDocumentUtf16Range,
} from '../edit/ranges';

export const ZETA_CURSOR_MARKER = '<|user_cursor|>';
export const ZETA1_CURSOR_MARKER = '<|user_cursor_is_here|>';
export const ZETA1_EDITABLE_START = '<|editable_region_start|>';
export const ZETA1_EDITABLE_END = '<|editable_region_end|>';
export const SEED_FIM_SUFFIX = '<[fim-suffix]>';
export const SEED_FIM_PREFIX = '<[fim-prefix]>';
export const SEED_FIM_MIDDLE = '<[fim-middle]>';
export const SEED_FILE_MARKER = '<filename>';
export const SEED_CURRENT_MARKER = '<<<<<<< CURRENT\n';
export const SEED_SEPARATOR = '=======\n';
export const SEED_UPDATED_MARKER = '>>>>>>> UPDATED\n';
export const ZETA21_END_MARKER = '<[end▁of▁sentence]>';

export interface ZetaPrompt {
  readonly prompt: string;
  readonly stops: readonly string[];
  readonly editableStart: number;
  readonly editableEnd: number;
  readonly oldEditable: string;
  readonly markerOffsets?: readonly number[];
}

export function selectZetaRanges(
  text: string,
  cursorOffset: number,
  syntaxRanges: readonly EditAlgorithmSyntaxRange[] = [],
): {
  readonly contextStart: number;
  readonly contextEnd: number;
  readonly editableStart: number;
  readonly editableEnd: number;
} {
  return selectZetaRangesForDocument({
    uri: '',
    languageId: '',
    version: 0,
    text,
    cursorOffset,
    syntaxRanges,
  });
}

export function selectZetaRangesForDocument(
  document: EditAlgorithmDocument,
): {
  readonly contextStart: number;
  readonly contextEnd: number;
  readonly editableStart: number;
  readonly editableEnd: number;
} {
  const selection = computeDocumentLegacyRanges(document);
  const editable = excerptByteRangeToDocumentUtf16Range(
    selection,
    selection.ranges.editable350,
  );
  const context = excerptByteRangeToDocumentUtf16Range(
    selection,
    selection.ranges.editable350Context150,
  );
  if (!editable || !context) {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'The Zeta context contains an invalid UTF-8 range.',
    );
  }
  return {
    contextStart: context.start,
    contextEnd: context.end,
    editableStart: editable.start,
    editableEnd: editable.end,
  };
}

function formatHistory(request: ZetaCompletionRequest): string {
  return request.editHistory
    .slice(-10)
    .map((entry) => {
      const path = entry.path ?? request.document.path ?? 'untitled';
      return `User edited ${path}:\n\`\`\`diff\n--- before\n+++ after\n-${entry.oldText}\n+${entry.newText}\n\`\`\``;
    })
    .join('\n\n');
}

const SEED_MAX_PROMPT_TOKENS = 4_096;
const SEED_PROMPT_BUDGET_MARGIN = 0.9;
const SEED_MAX_EDIT_EVENTS = 6;

function estimatedTokens(text: string): number {
  return Math.floor(Buffer.byteLength(text) / 3);
}

function seedEvent(
  entry: ZetaCompletionRequest['editHistory'][number],
  fallbackPath: string,
): string {
  const path = (entry.path ?? fallbackPath).replaceAll('\\', '/').replace(/^\/+/, '');
  const diff =
    entry.diff ??
    `${[
      ...entry.oldText.split('\n').map((line) => `-${line}`),
      ...entry.newText.split('\n').map((line) => `+${line}`),
    ].join('\n')}\n`;
  return `${entry.predicted ? '// User accepted prediction:\n' : ''}--- a/${path}\n+++ b/${path}\n${diff}`;
}

function formatSeedEditHistory(
  request: ZetaCompletionRequest,
  tokenBudget: number,
): string {
  const header = `${SEED_FILE_MARKER}edit_history\n`;
  let used = estimatedTokens(header);
  if (used >= tokenBudget) return '';
  const selected: string[] = [];
  const events = request.editHistory.slice(-SEED_MAX_EDIT_EVENTS);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (!entry) continue;
    const rendered = seedEvent(
      entry,
      request.document.path ?? 'untitled',
    );
    const cost = estimatedTokens(rendered);
    if (used + cost > tokenBudget) break;
    used += cost;
    selected.push(rendered);
  }
  return selected.length === 0
    ? ''
    : `${header}${selected.reverse().join('')}`;
}

function formatSeedRelatedFiles(
  request: ZetaCompletionRequest,
  tokenBudget: number,
  contextStart: number,
  contextEnd: number,
): string {
  let used = 0;
  let result = '';
  for (const context of request.contexts) {
    const sameDocument =
      context.uri === request.document.uri ||
      (context.path !== undefined &&
        request.document.path !== undefined &&
        context.path.replaceAll('\\', '/') ===
          request.document.path.replaceAll('\\', '/'));
    if (
      sameDocument &&
      context.range !== undefined &&
      context.range.startOffset >= contextStart &&
      context.range.endOffset <= contextEnd
    ) {
      continue;
    }
    const content = context.content.endsWith('\n')
      ? context.content
      : `${context.content}\n`;
    const rendered = `${SEED_FILE_MARKER}${context.path ?? 'context'}\n${content}`;
    const cost = estimatedTokens(rendered);
    if (used + cost > tokenBudget) break;
    used += cost;
    result += rendered;
  }
  return result;
}

function assembleSeedPrompt(
  request: ZetaCompletionRequest,
  context: string,
  contextStart: number,
  contextEnd: number,
  editableEndInContext: number,
  cursorSection: string,
): string {
  let suffixSection = `${SEED_FIM_SUFFIX}${context.slice(editableEndInContext)}`;
  if (!suffixSection.endsWith('\n')) suffixSection += '\n';

  const totalBudget = Math.floor(
    SEED_MAX_PROMPT_TOKENS * SEED_PROMPT_BUDGET_MARGIN,
  );
  const fixedTokens = estimatedTokens(
    `${suffixSection}${SEED_FIM_PREFIX}${cursorSection}${SEED_FIM_MIDDLE}`,
  );
  const historyBudget = Math.max(0, totalBudget - fixedTokens);
  const history = formatSeedEditHistory(request, historyBudget);
  const relatedBudget = Math.max(
    0,
    historyBudget - estimatedTokens(`${history}\n`),
  );
  const related = formatSeedRelatedFiles(
    request,
    relatedBudget,
    contextStart,
    contextEnd,
  );

  return `${suffixSection}${SEED_FIM_PREFIX}${
    related ? `${related}\n` : ''
  }${history ? `${history}\n` : ''}${cursorSection}${SEED_FIM_MIDDLE}`;
}

interface MarkerLineInfo {
  readonly start: number;
  readonly blank: boolean;
  readonly goodStart: boolean;
}

function isStructuralTail(line: string): boolean {
  if (/^[}\])]/.test(line)) return true;
  return ['break', 'continue', 'return', 'throw', 'end'].includes(
    line.replace(/;$/, ''),
  );
}

function markerLines(text: string): MarkerLineInfo[] {
  const lines: MarkerLineInfo[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const blank = trimmed.length === 0;
    lines.push({
      start: offset,
      blank,
      goodStart: !blank && !isStructuralTail(trimmed),
    });
    offset += line.length + 1;
  }
  if (text.endsWith('\n') && lines.length > 1) lines.pop();
  return lines;
}

export function computeZeta21MarkerOffsets(text: string): readonly number[] {
  if (!text) return [0, 0];
  const lines = markerLines(text);
  const offsets = [0];
  let lastBoundaryLine = 0;
  const findGoodStart = (from: number): number | undefined => {
    const end = Math.min(lines.length, from + 5);
    for (let index = from; index < end; index += 1) {
      if (lines[index]?.goodStart) return index;
    }
    return undefined;
  };
  let line = 0;
  while (line < lines.length) {
    const gap = line - lastBoundaryLine;
    const current = lines[line];
    const previous = lines[line - 1];
    if (
      gap >= 6 &&
      current &&
      !current.blank &&
      previous?.blank
    ) {
      const target = current.goodStart ? line : (findGoodStart(line) ?? line);
      const targetLine = lines[target];
      if (
        targetLine &&
        lines.length - target >= 6 &&
        targetLine.start > (offsets[offsets.length - 1] ?? 0)
      ) {
        offsets.push(targetLine.start);
        lastBoundaryLine = target;
        line = target + 1;
        continue;
      }
    }
    if (gap >= 16) {
      const target = findGoodStart(line) ?? line;
      const targetLine = lines[target];
      if (
        targetLine &&
        targetLine.start > (offsets[offsets.length - 1] ?? 0)
      ) {
        offsets.push(targetLine.start);
        lastBoundaryLine = target;
        line = target + 1;
        continue;
      }
    }
    line += 1;
  }
  if (offsets[offsets.length - 1] !== text.length) {
    offsets.push(text.length);
  }
  return offsets.length === 1 ? [0, text.length] : offsets;
}

function writeZeta21Editable(
  editable: string,
  cursorOffset: number,
  markerOffsets: readonly number[],
): string {
  let result = '';
  let cursorWritten = false;
  for (let index = 0; index < markerOffsets.length; index += 1) {
    const offset = markerOffsets[index] ?? 0;
    result += `<|marker_${index + 1}|>`;
    const next = markerOffsets[index + 1];
    if (next === undefined) continue;
    const block = editable.slice(offset, next);
    if (!cursorWritten && cursorOffset >= offset && cursorOffset <= next) {
      const local = cursorOffset - offset;
      result += `${block.slice(0, local)}${ZETA_CURSOR_MARKER}${block.slice(local)}`;
      cursorWritten = true;
    } else {
      result += block;
    }
  }
  return result;
}

export function buildZetaPrompt(request: ZetaCompletionRequest): ZetaPrompt {
  const text = request.document.text;
  const ranges = selectZetaRangesForDocument(request.document);
  const context = text.slice(ranges.contextStart, ranges.contextEnd);
  const editableStartInContext = ranges.editableStart - ranges.contextStart;
  const editableEndInContext = ranges.editableEnd - ranges.contextStart;
  const cursorInContext = request.document.cursorOffset - ranges.contextStart;
  const oldEditable = text.slice(ranges.editableStart, ranges.editableEnd);
  const path = request.document.path ?? 'untitled';

  if (request.kind === 'zeta1') {
    const beforeEditable = context.slice(0, editableStartInContext);
    const editableBeforeCursor = context.slice(
      editableStartInContext,
      cursorInContext,
    );
    const editableAfterCursor = context.slice(
      cursorInContext,
      editableEndInContext,
    );
    const afterEditable = context.slice(editableEndInContext);
    const excerpt = [
      `\`\`\`${path}`,
      ranges.contextStart === 0 ? '<|start_of_file|>' : '',
      beforeEditable,
      ZETA1_EDITABLE_START,
      `${editableBeforeCursor}${ZETA1_CURSOR_MARKER}${editableAfterCursor}`,
      ZETA1_EDITABLE_END,
      afterEditable,
      '```',
    ].filter((part) => part !== '').join('\n');
    const prompt = [
      '### Instruction:',
      'You are a code completion assistant and your task is to analyze user edits and then rewrite an excerpt that the user provides, suggesting the appropriate edits within the excerpt, taking into account the cursor location.',
      '',
      '### User Edits:',
      '',
      formatHistory(request),
      '',
      '### User Excerpt:',
      '',
      excerpt,
      '',
      '### Response:',
    ].join('\n');
    return {
      prompt,
      stops: [
        ZETA1_EDITABLE_END,
        `${ZETA1_EDITABLE_END}\n`,
        `${ZETA1_EDITABLE_END}\n\n`,
      ],
      editableStart: ranges.editableStart,
      editableEnd: ranges.editableEnd,
      oldEditable,
    };
  }

  const prefixBeforeEditable = context.slice(0, editableStartInContext);
  const editableCursor = request.document.cursorOffset - ranges.editableStart;
  if (request.kind === 'zeta2') {
    let cursorSection = `${SEED_FILE_MARKER}${path}\n${prefixBeforeEditable}${SEED_CURRENT_MARKER}${oldEditable.slice(0, editableCursor)}${ZETA_CURSOR_MARKER}${oldEditable.slice(editableCursor)}`;
    if (!cursorSection.endsWith('\n')) cursorSection += '\n';
    cursorSection += SEED_SEPARATOR;
    return {
      prompt: assembleSeedPrompt(
        request,
        context,
        ranges.contextStart,
        ranges.contextEnd,
        editableEndInContext,
        cursorSection,
      ),
      stops: [],
      editableStart: ranges.editableStart,
      editableEnd: ranges.editableEnd,
      oldEditable,
    };
  }

  const markerOffsets = computeZeta21MarkerOffsets(oldEditable);
  const marked = writeZeta21Editable(
    oldEditable,
    editableCursor,
    markerOffsets,
  );
  let cursorSection = `${SEED_FILE_MARKER}${path}\n${prefixBeforeEditable}${marked}`;
  if (!cursorSection.endsWith('\n')) cursorSection += '\n';
  return {
    prompt: assembleSeedPrompt(
      request,
      context,
      ranges.contextStart,
      ranges.contextEnd,
      editableEndInContext,
      cursorSection,
    ),
    stops: [ZETA21_END_MARKER],
    editableStart: ranges.editableStart,
    editableEnd: ranges.editableEnd,
    oldEditable,
    markerOffsets,
  };
}

function removeFirstMarker(output: string, marker: string): string {
  const index = output.indexOf(marker);
  return index < 0
    ? output
    : `${output.slice(0, index)}${output.slice(index + marker.length)}`;
}

function parseZeta1(output: string): string {
  const startPattern = `${ZETA1_EDITABLE_START}\n`;
  const endPattern = `\n${ZETA1_EDITABLE_END}`;
  const start = output.indexOf(startPattern);
  const end = output.trimEnd().endsWith(ZETA1_EDITABLE_END)
    ? output.lastIndexOf(endPattern)
    : -1;
  if (start < 0 || end < start || output.slice(0, start).trim()) {
    return output;
  }
  return removeFirstMarker(
    output.slice(start + startPattern.length, end),
    ZETA1_CURSOR_MARKER,
  );
}

function parseZeta21(output: string, prompt: ZetaPrompt): string {
  const cleaned = output.endsWith(ZETA21_END_MARKER)
    ? output.slice(0, -ZETA21_END_MARKER.length)
    : output;
  const tags = [...cleaned.matchAll(/<\|marker_(\d+)\|>/g)];
  if (tags.length < 2 || !prompt.markerOffsets) {
    return output;
  }
  const first = tags[0];
  const last = tags[tags.length - 1];
  const startNumber = Number(first?.[1]);
  const endNumber = Number(last?.[1]);
  const firstIndex = first?.index;
  const lastIndex = last?.index;
  if (
    !Number.isSafeInteger(startNumber) ||
    !Number.isSafeInteger(endNumber) ||
    firstIndex === undefined ||
    lastIndex === undefined
  ) {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'Zeta 2.1 returned invalid region markers.',
    );
  }
  const startOffset = prompt.markerOffsets[startNumber - 1];
  const endOffset = prompt.markerOffsets[endNumber - 1];
  if (startOffset === undefined || endOffset === undefined || startOffset > endOffset) {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'Zeta 2.1 returned out-of-range region markers.',
    );
  }
  if (startNumber === endNumber) return prompt.oldEditable;
  const firstTagLength = first[0].length;
  const replacement = cleaned
    .slice(firstIndex + firstTagLength, lastIndex)
    .replace(/<\|marker_\d+\|>/g, '');
  const replacementWithoutCursor = removeFirstMarker(
    replacement,
    ZETA_CURSOR_MARKER,
  );
  return `${prompt.oldEditable.slice(0, startOffset)}${replacementWithoutCursor}${prompt.oldEditable.slice(endOffset)}`;
}

export function parseZetaOutput(
  kind: ZetaCompletionRequest['kind'],
  output: string,
  prompt: ZetaPrompt,
): string {
  switch (kind) {
    case 'zeta1':
      return parseZeta1(output);
    case 'zeta2':
      {
        const protocolContent = output.endsWith(SEED_UPDATED_MARKER)
          ? output.slice(0, -SEED_UPDATED_MARKER.length)
          : output;
        return removeFirstMarker(
          removeFirstMarker(protocolContent, ZETA_CURSOR_MARKER),
          ZETA1_CURSOR_MARKER,
        );
      }
    case 'zeta2.1':
      return parseZeta21(output, prompt);
  }
}
