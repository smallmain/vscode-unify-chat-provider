const MULTI_CHARACTER_PUNCTUATION = [
  '>>>=',
  '<<=',
  '>>=',
  '...',
  '..=',
  '??=',
  '**=',
  '>>>',
  '::',
  '->',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<<',
  '>>',
  '..',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '++',
  '--',
  '**',
  '??',
  '?.',
  ':=',
  '<-',
  '//',
  '/*',
  '*/',
] as const;

type CharacterClass = 'identifier' | 'newline' | 'whitespace' | 'punctuation';

function characterClass(character: string): CharacterClass {
  if (character === '\n' || character === '\r') return 'newline';
  if (/^\s$/u.test(character)) return 'whitespace';
  if (/^[\p{L}\p{N}_]$/u.test(character)) return 'identifier';
  return 'punctuation';
}

function isUppercase(character: string): boolean {
  return /^\p{Lu}$/u.test(character);
}

function isLowercase(character: string): boolean {
  return /^\p{Ll}$/u.test(character);
}

function isNumeric(character: string): boolean {
  return /^\p{N}$/u.test(character);
}

function identifierBoundary(
  previous: string,
  current: string,
  next: string | undefined,
): boolean {
  return (
    (isUppercase(current) && (isLowercase(previous) || isNumeric(previous))) ||
    (isUppercase(current) &&
      isUppercase(previous) &&
      next !== undefined &&
      isLowercase(next))
  );
}

function splitIdentifier(identifier: string): string[] {
  const characters = [...identifier];
  const tokens: string[] = [];
  let segment = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    if (character === '_') {
      if (segment) tokens.push(segment);
      segment = '';
      let underscores = character;
      while (characters[index + 1] === '_') {
        underscores += '_';
        index += 1;
      }
      tokens.push(underscores);
      continue;
    }
    if (
      segment &&
      identifierBoundary(
        characters[index - 1] ?? '',
        character,
        characters[index + 1],
      )
    ) {
      tokens.push(segment);
      segment = '';
    }
    segment += character;
  }
  if (segment) tokens.push(segment);
  return tokens;
}

export function tokenizeKeptRate(text: string): readonly string[] {
  const characters = [...text];
  const tokens: string[] = [];
  for (let index = 0; index < characters.length; ) {
    const character = characters[index] ?? '';
    const kind = characterClass(character);
    if (kind === 'punctuation') {
      const remaining = characters.slice(index).join('');
      const punctuation = MULTI_CHARACTER_PUNCTUATION.find((value) =>
        remaining.startsWith(value),
      );
      const token = punctuation ?? character;
      tokens.push(token);
      index += [...token].length;
      continue;
    }
    let end = index + 1;
    while (
      end < characters.length &&
      characterClass(characters[end] ?? '') === kind
    ) {
      end += 1;
    }
    const token = characters.slice(index, end).join('');
    if (kind === 'identifier') tokens.push(...splitIdentifier(token));
    else tokens.push(token);
    index = end;
  }
  return tokens;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

function fillLcsMasks<T>(
  left: readonly T[],
  right: readonly T[],
): { readonly left: boolean[]; readonly right: boolean[] } {
  const leftMask = Array.from({ length: left.length }, () => false);
  const rightMask = Array.from({ length: right.length }, () => false);
  if (left.length === 0 || right.length === 0) {
    return { left: leftMask, right: rightMask };
  }
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    leftMask[prefix] = true;
    rightMask[prefix] = true;
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) {
    leftMask[left.length - suffix - 1] = true;
    rightMask[right.length - suffix - 1] = true;
    suffix += 1;
  }
  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const columns = rightMiddle.length + 1;
  const table = new Uint32Array((leftMiddle.length + 1) * columns);
  const cell = (row: number, column: number): number =>
    table[row * columns + column] ?? 0;
  for (let row = 1; row <= leftMiddle.length; row += 1) {
    for (let column = 1; column <= rightMiddle.length; column += 1) {
      table[row * columns + column] =
        leftMiddle[row - 1] === rightMiddle[column - 1]
          ? cell(row - 1, column - 1) + 1
          : Math.max(cell(row - 1, column), cell(row, column - 1));
    }
  }
  let row = leftMiddle.length;
  let column = rightMiddle.length;
  while (row > 0 && column > 0) {
    if (leftMiddle[row - 1] === rightMiddle[column - 1]) {
      leftMask[prefix + row - 1] = true;
      row -= 1;
      column -= 1;
    } else if (cell(row - 1, column) >= cell(row, column - 1)) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  row = leftMiddle.length;
  column = rightMiddle.length;
  while (row > 0 && column > 0) {
    if (leftMiddle[row - 1] === rightMiddle[column - 1]) {
      rightMask[prefix + column - 1] = true;
      row -= 1;
      column -= 1;
    } else if (cell(row, column - 1) >= cell(row - 1, column)) {
      column -= 1;
    } else {
      row -= 1;
    }
  }
  return { left: leftMask, right: rightMask };
}

interface ComparisonUnit {
  readonly text: string;
}

function isIdentifierToken(token: string): boolean {
  return token.length > 0 && /^[\p{L}\p{N}_]+$/u.test(token);
}

function comparisonUnits(tokens: readonly string[]): readonly ComparisonUnit[] {
  const units: ComparisonUnit[] = [];
  for (let index = 0; index < tokens.length; ) {
    if (!isIdentifierToken(tokens[index] ?? '')) {
      units.push({ text: tokens[index] ?? '' });
      index += 1;
      continue;
    }
    let text = '';
    while (index < tokens.length && isIdentifierToken(tokens[index] ?? '')) {
      text += tokens[index] ?? '';
      index += 1;
    }
    units.push({ text });
  }
  return units;
}

export interface KeptRateMetrics {
  readonly candidateNew: number;
  readonly referenceNew: number;
  readonly candidateDeleted: number;
  readonly referenceDeleted: number;
  readonly kept: number;
  readonly correctlyDeleted: number;
  readonly discarded: number;
  readonly context: number;
  readonly keptRate: number;
  readonly recallRate: number;
}

export function computeKeptRate(
  base: string,
  candidate: string,
  reference: string,
): KeptRateMetrics {
  if (base === candidate && candidate === reference) {
    return {
      candidateNew: 0,
      referenceNew: 0,
      candidateDeleted: 0,
      referenceDeleted: 0,
      kept: 0,
      correctlyDeleted: 0,
      discarded: 0,
      context: byteLength(candidate),
      keptRate: 1,
      recallRate: 1,
    };
  }
  const candidateDelta = Math.abs(byteLength(candidate) - byteLength(base));
  const referenceDelta = Math.abs(byteLength(reference) - byteLength(base));
  if (Math.abs(candidateDelta - referenceDelta) > 512) {
    return {
      candidateNew: candidateDelta,
      referenceNew: referenceDelta,
      candidateDeleted: 0,
      referenceDeleted: 0,
      kept: 0,
      correctlyDeleted: 0,
      discarded: candidateDelta,
      context: 0,
      keptRate: 0,
      recallRate: 0,
    };
  }
  const baseUnits = comparisonUnits(tokenizeKeptRate(base));
  const candidateUnits = comparisonUnits(tokenizeKeptRate(candidate));
  const referenceUnits = comparisonUnits(tokenizeKeptRate(reference));
  const baseTexts = baseUnits.map((unit) => unit.text);
  const candidateTexts = candidateUnits.map((unit) => unit.text);
  const referenceTexts = referenceUnits.map((unit) => unit.text);
  const candidateBase = fillLcsMasks(candidateTexts, baseTexts);
  const referenceBase = fillLcsMasks(referenceTexts, baseTexts);
  const candidateNewUnits = candidateTexts.filter(
    (_unit, index) => !candidateBase.left[index],
  );
  const referenceNewUnits = referenceTexts.filter(
    (_unit, index) => !referenceBase.left[index],
  );
  const keptMask = fillLcsMasks(candidateNewUnits, referenceNewUnits).left;
  const sum = (values: readonly string[]): number =>
    values.reduce((total, value) => total + byteLength(value), 0);
  const candidateNew = sum(candidateNewUnits);
  const referenceNew = sum(referenceNewUnits);
  const kept = sum(candidateNewUnits.filter((_unit, index) => keptMask[index]));
  const context = sum(
    candidateTexts.filter((_unit, index) => candidateBase.left[index]),
  );
  const candidateDeleted = sum(
    baseTexts.filter((_unit, index) => !candidateBase.right[index]),
  );
  const referenceDeleted = sum(
    baseTexts.filter((_unit, index) => !referenceBase.right[index]),
  );
  const correctlyDeleted = sum(
    baseTexts.filter(
      (_unit, index) =>
        !candidateBase.right[index] && !referenceBase.right[index],
    ),
  );
  const discarded = candidateNew - kept;
  const matched = kept + correctlyDeleted;
  const candidateEdit = candidateNew + candidateDeleted;
  const referenceEdit = referenceNew + referenceDeleted;
  return {
    candidateNew,
    referenceNew,
    candidateDeleted,
    referenceDeleted,
    kept,
    correctlyDeleted,
    discarded,
    context,
    keptRate:
      candidateEdit === 0
        ? referenceEdit === 0
          ? 1
          : 0
        : matched / candidateEdit,
    recallRate:
      referenceEdit === 0
        ? candidateEdit === 0
          ? 1
          : 0
        : matched / referenceEdit,
  };
}
