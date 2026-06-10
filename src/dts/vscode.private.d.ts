declare module 'vscode' {
  export interface LanguageModelChatInformation {
    /**
     * It is only displayed as a list item description when `multiplierNumeric` is not `undefined`, for example, as `2x`, `15x`, etc.
     */
    pricing?: string;
  }
}
