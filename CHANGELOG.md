# Changelog

## v4.1.0 - 2026-01-27

### Features
- add Kimi K2.5 model support (7f9cc82, SmallMain)

### Chores
- update README.md (da9f385, SmallMain)

## v4.0.0 - 2026-01-27

### Breaking Changes
- storeApiKeyInSettings no longer support some methods of authentication (c7de0c2, SmallMain)

### Features
- add 'MiniMax-M2.1' model to iFlow provider (15324a4, SmallMain)
- add 'glm-4.7' model to iFlow provider configuration (08501c5, SmallMain)
- update Cerebras's default model list (30bfecb, SmallMain)
- add model id to model detail display (107e91d, SmallMain)
- add category support for authentication methods and providers (b2ead9d, SmallMain)
- implement retry logic and delay handling for network requests (d5c15bc, SmallMain)
- enhance Antigravity OAuth flow and client integration (976a8a5, SmallMain)
- enhance request handling with stable user ID and credential support (c3fa025, SmallMain)
- enhance session management and header handling in OpenAI responses provider (f027eea, SmallMain)
- enhance authentication handling for AnthropicProvider (8818738, SmallMain)
- added support for the Claude Code provider, and integrated Claude Code Cloak into it (ee1751a, SmallMain)
- update timeout configurations and fetch modes for providers (1d7f564, SmallMain)
- add new models and update overrides for better compatibility (2b7d0f3, SmallMain)
- add authentication checks for GitHub Copilot and Qwen Code providers (eae4639, SmallMain)
- optimize the default model lists for some providers (49845e9, SmallMain)
- add Qwen Code provider support (2c77c4c, SmallMain)
- add iFlow provider support (75810fb, SmallMain)
- add Github Copilot provider support (b02b48b, SmallMain)
- enhance well-known models feature (0c8575d, SmallMain)
- add Cerebras provider support (51b44e4, SmallMain)
- add Gemini CLI provider (611b966, SmallMain)

### Fixes
- features support for iFlow and Nvidia models (cd6e597, SmallMain)
- update l10n translations for new strings (491e7d1, SmallMain)
- trailing comma (f9087ee, SmallMain)
- trying to resolve the issue where a restart results in no custom models being available (cd905e4, SmallMain)
- enhance GoogleAIStudioProvider and AntigravityClient tool call ID handling and parsing logic (f2cf04d, SmallMain)
- enhance error printing for better debugging (4d54461, SmallMain)
- can't get Qwen Code official models (7453ad8, SmallMain)
- only GLM 4.7 model use clear thinking (2dc21dd, SmallMain)
- update base URL for Google Vertex AI provider (fc93fb8, SmallMain)
- enhance abort signal support to API providers and fetch utilities (1c92f71, SmallMain)

### Refactors
- provider official models background fetching (f038609, SmallMain)

### Chores
- update icon (0636ad8, SmallMain)
- update README and SEO metadata (5a91484, SmallMain)
- update ROADMAP.md (7e17bf4, SmallMain)
- update README.md (aff86a9, SmallMain)
- update l10n sync script to include write-locales option (111b785, SmallMain)
- update README.md (5175675, SmallMain)
- update vscode dts (91bb736, SmallMain)
- update ROADMAP.md (1fa0fec, SmallMain)

## v3.3.0 - 2026-01-22

### Features
- add Claude Code Cloak provider (2ba1c97, SmallMain)
- antigravity: enhance Claude message conversion and thinking signature handling (c9d36bb, SmallMain)
- antigravity: enhance message handling and parsing for Claude model integration (53396c3, SmallMain)
- auth: enhance account info fetching and onboarding process (00a8f40, SmallMain)
- add support for GLM-4.7-Flash (e646f12, SmallMain)
- add authentication check for Google Antigravity provider (01bc279, SmallMain)
- add OpenAI CodeX provider (e96351e, SmallMain)
- enhance well-known provider auth handling and update provider configurations (d68a7d5, SmallMain)
- enhance Antigravity client with project ID and schema merging functions (46b7e3f, SmallMain)
- auth: add detailed logging for auth flows (091e8bd, SmallMain)
- normalize system instruction handling and update model IDs in providers (160606f, SmallMain)

### Fixes
- enhance cleanJsonSchemaForAntigravity function for better schema handling (afd1abf, SmallMain)
- antigravity support (5744467, SmallMain)
- add content sanitization for Claude model to handle empty text fields (7a27eb6, SmallMain)
- enhance Antigravity provider with endpoint resolution and retry logic (4d9b790, SmallMain)
- update Antigravity model handling (796b77d, SmallMain)
- simplify model family matching for OpenRouter Claude models (4b4dde1, SmallMain)
- strip `include` param for volcengine provider (1f76de1, SmallMain)
- supplemental null checks for certain fields (b00be09, SmallMain)
- add cancellation checks before post-loop processing in multiple providers (82cc1e7, SmallMain)
- update project ID prompt and remove preview suffixes for Antigravity models (da6898e, SmallMain)

### Refactors
- vertex ai auth process (f5dd396, SmallMain)
- antigravity support (d5c54aa, SmallMain)

### Chores
- update ROADMAP.md (7c200a9, SmallMain)
- update ROADMAP.md (05921a6, SmallMain)

## v3.2.0 - 2026-01-16

### Features
- add Nvidia provider and update model alternative IDs (d51774e, SmallMain)
- implement migration for legacy API key storage format (v2.x -> v3.x) (f34a062, SmallMain)
- add default capabilities to non well-known model (14bfc8f, SmallMain)
- add StreamLake Vanchin providers and models to the integration (16d380a, SmallMain)
- add LongCat provider and models to the integration (3b070b8, SmallMain)
- add antigravity oauth support (0bea042, SmallMain)

## v3.1.1 - 2026-01-16

### Features
- enhance normalization of well-known configs with declared IDs mapping (a768d4b, SmallMain)

### Fixes
- return empty string for undefined API key in getCredential method (f8ae3ce, SmallMain)
- correct formatting of OpenCode Zen provider names in localization file (13ab94a, SmallMain)

## v3.1.0 - 2026-01-16

### Features
- add OpenCode Zen providers to localization files (7efaff0, SmallMain)
- add OpenCode Zen providers and update model alternative IDs (9581f76, SmallMain)

### Fixes
- update Doubao Seed ID to the latest version in providers.ts (7461836, SmallMain)
- update Doubao Seed ID and add Kimi K2 0711 Preview model configuration (abab2ba, SmallMain)

## v3.0.0 - 2026-01-16

### Features
- add support for oauth, and some optimizations and fixes (8f4ae2e, SmallMain)
- add provider Alibaba Cloud Model Studio (Coding Plan) (193b880, SmallMain)

### Fixes
- remove unused import from auths.ts (e241932, SmallMain)
- remove deprecated well-known auth presets for Google and Azure (d39eac7, SmallMain)
- update Chinese translations for Alibaba Cloud and other providers (7a48d35, SmallMain)
- pinned user-agent header to avoid 403 errors with openai/anthropic/google provider (da60247, SmallMain)
- initialize capabilities in createModelDraft when no existing model is provided (481dace, SmallMain)

### Chores
- add l10n scripts (4bb7a74, SmallMain)

## v2.1.6 - 2026-01-07

### Fixes
- avoid errors in caching log printing from affecting the main logic. (a6fd898, SmallMain)
- handle cancellation requests in API providers and utility functions (06c64ec, SmallMain)

### Chores
- add GitHub Actions release workflow (e5d1fd5, SmallMain)
- update package-lock.json files (8605d04, SmallMain)

## v2.1.5 - 2026-01-04

### Fixes
- log initialization message only when verbose mode is enabled (72b4fee, SmallMain)

## v2.1.4 - 2025-12-31

### Fixes
- codex migration does not read auth file (bfe6b38, SmallMain)

## v2.1.3 - 2025-12-31

### Fixes
- improve thinking level and budget handling in GoogleAIStudioProvider (0c83cbb, SmallMain)

## v2.1.2 - 2025-12-31

### Fixes
- adjust translation for penalty and temperature (f30147c, SmallMain)

## v2.1.1 - 2025-12-31

### Chores
- update docs (dddf86c, SmallMain)

## v2.1.0 - 2025-12-31

### Features
- add chinese translations (aa4419b, SmallMain)
- add i18n support (b29e5a8, SmallMain)

### Fixes
- update chinese transitions (f670578, SmallMain)
- gemini cli migration logic (3070510, SmallMain)
- match the Ollama ID specification. (f703828, SmallMain)

### Chores
- remove multilingual support note and update README_zh-CN.md (7a3dd19, SmallMain)
- update docs (ce3da67, SmallMain)
- add 'oai' keyword to package.json (8c9673e, SmallMain)

## v2.0.1 - 2025-12-30

### Chores
- update release scripts (98fe150, SmallMain)
- update docs (0a9a4e1, SmallMain)

## v2.0.0 - 2025-12-30

### Breaking Changes
- remove mimic (ac8d40a, SmallMain)

### Features
- add Gemini CLI migration support (db10250, SmallMain)
- add Google Vertex AI provider support (79fb48a, SmallMain)
- add Google AI Studio provider and Gemini models (8696320, SmallMain)
- add native support for Google AI Studio (Gemini API) (0f95dd0, SmallMain)
- URI import support (6488302, SmallMain)
- enhance config input handling with URL support (7ef034b, SmallMain)
- add OpenRouter and Volcano Engine (Coding Plan) providers support (bf36ba0, SmallMain)
- add gpt-oss series and deepseek models support (f544439, SmallMain)

### Fixes
- some ui bugs (7262255, SmallMain)
- google client thinking config (00b1550, SmallMain)
- google client thinking config (6262489, SmallMain)
- the matching between the model ID and the Family is too lenient. (cb15a0b, SmallMain)
- make the timeout detection more lenient (b68092d, SmallMain)
- provider ModelScope does not add to features list (367f234, SmallMain)
- fix Anthropic client base URL handler (37fb07a, SmallMain)

### Refactors
- refactoring conflict handling for provider or model name/ID (c002f43, SmallMain)

### Chores
- update docs (75970b1, SmallMain)
- update ROADMAP (ec0f7a6, SmallMain)
- add sponsor URL to package.json (c07c446, SmallMain)
- update docs for URI and cloud sync (1adf768, SmallMain)
- update keywords in package.json (803f5ad, SmallMain)
- update docs and roadmap (c0996b5, SmallMain)
- adjust models order in copilot's model picker (97c99b5, SmallMain)
- update chinese README (04098d6, SmallMain)
- update release scripts (48eaaa3, SmallMain)

## v1.2.0 - 2025-12-26

### Features
- add xAI provider and Grok models (0784cfb, SmallMain)

### Fixes
- cannot find module error (6ce351c, SmallMain)

### Chores
- update docs (76b2809, SmallMain)
- improve SEO and documentation (c9581c0, SmallMain)

## v1.1.0 - 2025-12-25

### Features

- added some well-known suppliers and models.

### Fixes

- fixed several issues.

### Chores

- improved the documentation.

## v1.1.0 - 2025-12-25

### Features

- added some well-known suppliers and models.

### Fixes

- fixed several issues.

### Chores

- improved the documentation.

## v1.1.0 - 2025-12-25

### Features

- added some well-known suppliers and models.

### Fixes

- fixed several issues.

### Chores

- improved the documentation.

## v1.0.0 - 2025-12-23

### Features

- Initial release of the project.


