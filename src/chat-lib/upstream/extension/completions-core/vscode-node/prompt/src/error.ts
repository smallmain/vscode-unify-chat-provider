// Generated from microsoft/vscode@fc3def6774c76082adf699d366f31a557ce5573f: extensions/copilot/src/extension/completions-core/vscode-node/prompt/src/error.ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export class CopilotPromptLoadFailure extends Error {
	readonly code = 'CopilotPromptLoadFailure';
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
	}
}
