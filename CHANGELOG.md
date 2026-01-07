# Changelog

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


