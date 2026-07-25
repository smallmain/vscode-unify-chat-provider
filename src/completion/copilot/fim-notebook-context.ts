const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  javascriptreact: 'javascript',
  jsx: 'javascript',
  typescriptreact: 'typescript',
  jade: 'pug',
  cshtml: 'razor',
  c: 'cpp',
};

const NON_DEFAULT_COMMENT_MARKERS: Readonly<
  Record<string, readonly [start: string, end: string]>
> = {
  abap: ['"', ''],
  aspdotnet: ['<%--', '--%>'],
  bat: ['REM', ''],
  bibtex: ['%', ''],
  blade: ['#', ''],
  clojure: [';', ''],
  css: ['/*', '*/'],
  dockerfile: ['#', ''],
  dotenv: ['#', ''],
  elixir: ['#', ''],
  erb: ['<%#', '%>'],
  erlang: ['%', ''],
  graphql: ['#', ''],
  haml: ['-#', ''],
  handlebars: ['{{!', '}}'],
  haskell: ['--', ''],
  html: ['<!--', '-->'],
  ini: [';', ''],
  julia: ['#', ''],
  latex: ['%', ''],
  lua: ['--', ''],
  makefile: ['#', ''],
  markdown: ['[]: #', ''],
  perl: ['#', ''],
  powershell: ['#', ''],
  python: ['#', ''],
  r: ['#', ''],
  razor: ['<!--', '-->'],
  ruby: ['#', ''],
  shellscript: ['#', ''],
  slim: ['/', ''],
  sql: ['--', ''],
  svelte: ['<!--', '-->'],
  terraform: ['#', ''],
  tex: ['%', ''],
  vb: ["'", ''],
  'vue-html': ['<!--', '-->'],
  xml: ['<!--', '-->'],
  xsl: ['<!--', '-->'],
  yaml: ['#', ''],
};

function normalizeLanguageId(languageId: string): string {
  const normalized = languageId.toLowerCase();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function commentBlockAsSingles(text: string, languageId: string): string {
  if (text.length === 0) return '';
  const trailingNewline = text.endsWith('\n');
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n');
  const [start, end] = NON_DEFAULT_COMMENT_MARKERS[languageId] ?? ['//', ''];
  const endMarker = end.length === 0 ? '' : ` ${end}`;
  const commented = lines
    .map((line) => `${start} ${line}${endMarker}`)
    .join('\n');
  return trailingNewline ? `${commented}\n` : commented;
}

export interface FimNotebookCellContext {
  readonly index: number;
  readonly languageId: string;
  readonly text: string;
}

export interface FimNotebookContextInput {
  readonly activeCellIndex: number;
  readonly activeLanguageId: string;
  readonly activeText: string;
  readonly activeCursorOffset: number;
  readonly cells: readonly FimNotebookCellContext[];
}

export interface FimNotebookContextResult {
  readonly text: string;
  readonly cursorOffset: number;
  readonly activeCellOffset: number;
  readonly activeCellLineOffset: number;
  readonly prependedText: string;
}

export function prepareFimNotebookContext(
  input: FimNotebookContextInput,
): FimNotebookContextResult {
  const normalizedActiveLanguage = normalizeLanguageId(
    input.activeLanguageId,
  );
  const beforeCells = input.cells.filter(
    (cell) =>
      cell.index < input.activeCellIndex &&
      normalizeLanguageId(cell.languageId) === normalizedActiveLanguage,
  );
  const prependedText =
    beforeCells.length === 0
      ? ''
      : `${beforeCells
          .map((cell) =>
            cell.languageId === input.activeLanguageId
              ? cell.text
              : commentBlockAsSingles(cell.text, input.activeLanguageId),
          )
          .join('\n\n')}\n\n`;
  const activeCursorOffset = Math.max(
    0,
    Math.min(input.activeText.length, input.activeCursorOffset),
  );
  return {
    text: `${prependedText}${input.activeText}`,
    cursorOffset: prependedText.length + activeCursorOffset,
    activeCellOffset: prependedText.length,
    activeCellLineOffset: prependedText.split('\n').length - 1,
    prependedText,
  };
}

export function fimNotebookLineInActiveCell(
  virtualLine: number,
  activeCellLineOffset: number,
): number {
  return Math.max(0, virtualLine - activeCellLineOffset);
}
