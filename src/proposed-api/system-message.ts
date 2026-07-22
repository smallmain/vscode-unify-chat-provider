import * as vscode from 'vscode';

const SYSTEM_FALLBACK_START = '[System instructions]';
const SYSTEM_FALLBACK_END = '[End system instructions]';

export interface OutgoingTextChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export function mergeSystemInstructionsIntoUserMessage(
  systemInstructions: readonly string[],
  userMessage: string,
): string {
  if (systemInstructions.length === 0) {
    return userMessage;
  }
  return [
    SYSTEM_FALLBACK_START,
    systemInstructions.join('\n\n'),
    SYSTEM_FALLBACK_END,
    '',
    userMessage,
  ].join('\n');
}

export function createOutgoingLanguageModelMessages(
  messages: readonly OutgoingTextChatMessage[],
  canUseSystemMessage: boolean,
): vscode.LanguageModelChatMessage[] {
  if (canUseSystemMessage) {
    return messages.map((message) =>
      message.role === 'system'
        ? new vscode.LanguageModelChatMessage(
            vscode.LanguageModelChatMessageRole.System,
            message.content,
          )
        : vscode.LanguageModelChatMessage.User(message.content),
    );
  }

  const result: vscode.LanguageModelChatMessage[] = [];
  const pendingSystemInstructions: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      pendingSystemInstructions.push(message.content);
      continue;
    }
    result.push(
      vscode.LanguageModelChatMessage.User(
        mergeSystemInstructionsIntoUserMessage(
          pendingSystemInstructions.splice(0),
          message.content,
        ),
      ),
    );
  }

  if (pendingSystemInstructions.length > 0) {
    result.push(
      vscode.LanguageModelChatMessage.User(
        mergeSystemInstructionsIntoUserMessage(pendingSystemInstructions, ''),
      ),
    );
  }
  return result;
}
