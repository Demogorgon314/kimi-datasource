# Changelog

## 1.0.0 - 2026-07-20

- Initial CLI-only release with automatic Kimi OAuth refresh
- Support stock, macroeconomic, company registry, academic, and legal data sources
- Compile to a standalone binary with Bun
- Install the CLI and Agent Skill through `install/install.sh`
- Add strict CLI option validation and command-specific help
- Add stdin JSON parameters and structured JSON output for `sources`, `desc`, and `call`
- Align OAuth and gateway identity headers with current Kimi Code (`kimi_code_cli`)
- Add offline unit and integration tests for CLI, credentials, OAuth, and gateway behavior
- Expand the Agent Skill with source routing, identifier verification, result interpretation, authentication recovery, and watchlist guidance
