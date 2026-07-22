import {
  BlockTrimmer,
  BlockPositionType,
  TerseBlockTrimmer,
} from '../src/chat-lib/upstream/extension/completions-core/vscode-node/lib/src/ghostText/blockTrimmer';
import { StatementTree } from '../src/chat-lib/upstream/extension/completions-core/vscode-node/lib/src/ghostText/statementTree';
import { isSupportedLanguageId } from '../src/chat-lib/upstream/extension/completions-core/vscode-node/prompt/src/parse';
import {
  isBlockBodyFinished,
  isEmptyBlockStart,
} from '../src/chat-lib/upstream/extension/completions-core/vscode-node/prompt/src/parseBlock';

export {
  isBlockBodyFinished,
  isEmptyBlockStart,
  isSupportedLanguageId,
};

export function isBlockTrimmerSupported(languageId: string): boolean {
  return BlockTrimmer.isSupported(languageId);
}

export async function blockPositionTypeAt(
  languageId: string,
  text: string,
  offset: number,
): Promise<string> {
  const tree = StatementTree.create(languageId, text, 0, text.length);
  try {
    await tree.build();
    const statement = tree.statementAt(offset);
    if (!statement) {
      return BlockPositionType.NonBlock;
    }
    const line = text.slice(0, offset).split('\n').length - 1;
    if (!statement.isCompoundStatementType && statement.children.length === 0) {
      if (
        statement.parent &&
        !statement.nextSibling &&
        statement.node.endPosition.row <= line
      ) {
        return BlockPositionType.BlockEnd;
      }
      return statement.parent
        ? BlockPositionType.MidBlock
        : BlockPositionType.NonBlock;
    }
    if (statement.children.length === 0) {
      return BlockPositionType.EmptyBlock;
    }
    const lastChild = statement.children[statement.children.length - 1];
    return offset < lastChild.node.startIndex
      ? BlockPositionType.MidBlock
      : BlockPositionType.BlockEnd;
  } finally {
    tree[Symbol.dispose]();
  }
}

export async function trimWithTerseBlockTrimmer(
  languageId: string,
  prefix: string,
  completion: string,
  lineLimit = 3,
  lookAhead = 7,
): Promise<number | undefined> {
  return new TerseBlockTrimmer(
    languageId,
    prefix,
    completion,
    lineLimit,
    lookAhead,
  ).getCompletionTrimOffset();
}
