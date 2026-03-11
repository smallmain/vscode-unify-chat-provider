# Roadmap

- Optimize the storage content in the settings.json file and the logic for displaying the UI, fixing some issues with the OAuth process (for example, reauthorization not working properly, etc.).
- Optimize the display strategy for balance monitoring.
- Supports load balancing for multiple accounts and multiple suppliers.
- Commit message generate support.
- add Kiro provider.
- add Amazon Bedrock provider.
- The `nativeTool` should include a configuration option within `ModelConfig`. In addition to `Default`, `Enable`, and `Disable`, add an `Auto` option that automatically selects the appropriate setting based on the model family. Also, include native tool implementations for various models to force a specific choice. Remove the related `Features`. Add the `Anthropic WebFetchTool` and ensure that citation content is handled correctly (it may not be displayed directly).
- The current Features use “Feature” as the key and should also use conditions to determine which Features should be enabled. In addition to boolean values, other types of data are also supported. So user can override the support of a Feature in the configuration.
- Support more apps import:
  - RooCode
  - CherryStudio
  - CLIProxyAPI
  - ccswitch
- FIM/NES support.
- Automatic configuration update: It is possible to configure a URL (which will be automatically set when importing from the URL) and a switch. Once the switch is turned on, the latest configuration will be fetched periodically.
