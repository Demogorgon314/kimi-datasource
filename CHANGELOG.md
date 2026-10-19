# Changelog

## 1.1.0 - 2026-10-18

- Align the known source catalog with managed kimi-datasource plugin 3.4.0: add Wind, IMF, Gildata, SEC EDGAR, S&P Capital IQ, Chinese government catalogs / NBS / standards, WHO, FAO, UNSD, ECB, Eurostat, UNICEF, OECD, FRED, Xinhua Finance and Caixin (25 sources total)
- Update CLI help, README and Agent Skill with source routing, capability boundaries, Wind field discovery and Caixin API discovery
- Clarify that the local source catalog does not guarantee account entitlement
- Reuse host-rotated credentials before forcing OAuth refresh on a gateway 401, keeping a single retry

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
