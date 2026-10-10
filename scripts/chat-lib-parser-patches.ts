import { relative, resolve } from 'node:path';

const workspaceRoot = process.cwd();
const blockTrimmerPath = resolve(
  workspaceRoot,
  'src/chat-lib/upstream/extension/completions-core/vscode-node/lib/src/ghostText/blockTrimmer.ts',
);
const parseBlockPath = resolve(
  workspaceRoot,
  'src/chat-lib/upstream/extension/completions-core/vscode-node/prompt/src/parseBlock.ts',
);

function replaceOnce(
  source: string,
  expected: string,
  replacement: string,
  filePath: string,
): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(
      `GhostText parser patch anchor is missing or ambiguous in ${relative(workspaceRoot, filePath)}.`,
    );
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

export function patchChatLibParserSource(
  filePath: string,
  source: string,
): string {
  const resolved = resolve(filePath);
  const normalizedSource = source.replace(/\r\n?/g, '\n');
  if (resolved === blockTrimmerPath) {
    return replaceOnce(
      normalizedSource,
      "import { IPosition, TextDocumentContents } from '../textDocument';",
      [
        'interface IPosition {',
        '\treadonly line: number;',
        '\treadonly character: number;',
        '}',
        '',
        'interface TextDocumentContents {',
        '\treadonly detectedLanguageId: string;',
        '\tgetText(): string;',
        '\toffsetAt(position: IPosition): number;',
        '}',
      ].join('\n'),
      filePath,
    );
  }
  if (resolved === parseBlockPath) {
    return replaceOnce(
      normalizedSource,
      [
        '\t\tif (endIndex < solution.length) {',
        '\t\t\t// descendant block is finished, stop at end of block',
        '\t\t\tconst lengthOfBlock = endIndex - prefix.length;',
        '\t\t\treturn lengthOfBlock > 0 ? lengthOfBlock : undefined;',
        '\t\t}',
        '\t}',
      ].join('\n'),
      [
        '\t\tif (endIndex < solution.length) {',
        '\t\t\t// descendant block is finished, stop at end of block',
        '\t\t\tconst lengthOfBlock = endIndex - prefix.length;',
        '\t\t\treturn lengthOfBlock > 0 ? lengthOfBlock : undefined;',
        '\t\t}',
        '\t\treturn undefined;',
        '\t}',
      ].join('\n'),
      filePath,
    );
  }
  return source;
}
