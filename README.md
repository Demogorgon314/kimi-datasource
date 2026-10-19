# kimi-datasource

Standalone **CLI** for the structured **Kimi Data Sources included with your existing Kimi subscription**:

- A-share / HK / US stocks & financials
- Wind (minute quotes, funds, bonds, macro) · Yahoo Finance · SEC EDGAR · S&P Capital IQ · Gildata
- World Bank · IMF · FRED · NBS · WHO / FAO / OECD and other international organizations
- Chinese government data catalogs and standards · Xinhua Finance / Caixin news · Tianyancha
- arXiv / Google Scholar · Chinese law (`yuandian_law`)

The CLI authenticates with your existing Kimi account and uses the data-source access already available to that subscription. It is not a separate data provider and does not require individual API keys for Yahoo Finance, World Bank, Tianyancha, arXiv, Scholar, or the other underlying sources.

Works with **any agent that can run a shell**. Every `desc` / `call` **auto-refreshes** OAuth tokens shared with `~/.kimi-code/credentials/`.

Compile to a single binary with **Bun**.

## Kimi subscription and data access

- You must already have a Kimi subscription or account with access to Kimi Data Sources through the Coding tools gateway.
- The CLI reuses that existing entitlement; installing this project does not grant or purchase additional data access.
- Available sources, APIs, fields, limits, and freshness are controlled by Kimi and may vary with the account or environment.
- `kimi-datasource sources` lists the 25 known sources aligned with managed plugin **3.4.0**. It is a local catalog, not an account entitlement check. Run `kimi-datasource desc <source>` for current documentation; actual calls remain subject to account access.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (build + recommended runtime)
  or Node.js ≥ 18.17 (source only)
- Existing Kimi subscription or account with Kimi Data Sources access
- Login once (`kimi-datasource login` or Kimi Code `/login`)

## Install

```bash
git clone https://github.com/Demogorgon314/kimi-datasource.git
cd kimi-datasource

# Build binary → dist/kimi-datasource and install to ~/.local/bin + skills
bash install/install.sh
```

Ensure `~/.local/bin` is on `PATH`, then:

```bash
kimi-datasource status
kimi-datasource desc arxiv
```

Options:

```bash
./install/install.sh --prefix /usr/local   # install prefix
./install/install.sh --no-build            # skip compile; use existing dist/
./install/install.sh --skill-only          # only copy SKILL.md
```

## Build only

```bash
bun run build
# → dist/kimi-datasource  (+ SKILL.md, watchlist.json alongside)

# Cross-compile example:
bun run scripts/build.mjs --target bun-darwin-arm64 -o dist/kimi-datasource-darwin-arm64
```

## Usage

```bash
kimi-datasource login
kimi-datasource status
kimi-datasource refresh

kimi-datasource sources
kimi-datasource sources --output json
kimi-datasource desc arxiv
kimi-datasource call arxiv search_papers \
  --param query=RAG --param max_results=3 \
  --file-path /tmp/arxiv.csv \
  --quiet
```

| Command | Description |
|---------|-------------|
| `login` | Device-code OAuth |
| `status` | Credential state; refresh if needed |
| `refresh` | Force refresh |
| `sources` | List source names |
| `desc <source>` | API docs (auto refresh) |
| `call <source> <api> …` | Invoke API (auto refresh) |

### Data sources

| Source | Coverage |
|--------|----------|
| `stock_finance_data` | A-share / HK / US quotes, historical prices, financials |
| `yahoo_finance` | Global financial data, analyst ratings, options, institutional holders |
| `world_bank_open_data` | Long-term historical macroeconomic indicators |
| `tianyancha` | Chinese company registry, ownership and risks |
| `arxiv`, `scholar` | Preprints and academic search |
| `yuandian_law` | Chinese laws, regulations and judicial cases |
| `wind` | Securities, minute quotes, funds, bonds, macro, announcements and financial news |
| `imf` | Long-term FX, CPI, GDP forecasts and balance of payments |
| `gildata` | Natural-language stock, fund and fund-manager screening |
| `sec_edgar` | US filings: 10-K / 10-Q, S-1, Form 4, 13F, 8-K |
| `sp_data` | S&P Capital IQ fundamentals, estimates, valuations and transcripts (paid scope) |
| `china_nda` | National and provincial government open-data catalogs |
| `china_nbs` | NBS national, provincial and major-city statistics |
| `china_standards` | GB / HB / DB / TT standards |
| `who`, `fao`, `unsd` | Health, food / agriculture and UN statistics |
| `ecb`, `eurostat` | ECB and EU statistics |
| `unicef`, `oecd`, `fred` | Child indicators, OECD datasets, US / global macro series |
| `xhcj`, `caixin` | Xinhua Finance news / announcements / policies and Caixin data APIs |

Use a source the user names directly. For a simple lookup, choose one suitable source, read its `desc`, and stop once the result covers the question. Field, entity and API discovery may require follow-up calls within that source. Use multiple sources when a cross-source comparison is requested.

### Wind

Read the live API documentation first, then discover the native field name before requesting PE, PB, ROE or market cap:

```bash
kimi-datasource desc wind --quiet
kimi-datasource call wind wind_search_fields \
  --param query=总市值 --param limit=5 \
  --file-path /tmp/wind-market-cap-fields.csv --output json
```

Use the returned field name with the appropriate API documented by `desc`. Current Wind APIs distinguish snapshots (`*_price_indicators`), historical daily / weekly / monthly series (`*_price` / `wind_get_price`), and minute quotes (`*_quote`). Open-ended mutual funds have no intraday minute quotes. Macro indicator search returns metadata; query the time-series API for values.

These examples describe the current contract, not a fixed API guarantee. Other discovery steps include `caixin_api_search` for Caixin APIs and company search for Tianyancha entities. For long-term FX or GDP forecasts choose IMF; Yahoo Finance FX history is limited to about two years. Use NBS for Chinese official statistics, `china_nda` for dataset catalogs, and `china_standards` for standards rather than legal cases.

### `call` options

```text
--json '{…}'           full params object
--json-file path.json
--param key=value      repeatable
--file-path path       shorthand for file_path
--output text|json     stable output envelope (sources/desc/call)
--quiet / -q           strip trace footer
```

Read a complete parameter object from stdin:

```bash
printf '%s' '{"query":"RAG","max_results":3,"file_path":"/tmp/arxiv.csv"}' |
  kimi-datasource call arxiv search_papers --json-file - --output json
```

Each command has focused help with copy-pasteable examples:

```bash
kimi-datasource call --help
kimi-datasource desc --help
```

### Environment

| Variable | Default |
|----------|---------|
| `KIMI_CODE_HOME` | `~/.kimi-code` |
| `KIMI_CODE_BASE_URL` | `https://api.kimi.com/coding/v1` |
| `KIMI_CODE_OAUTH_HOST` | `https://auth.kimi.com` |
| `KIMI_DATASOURCE_API_URL` | `{BASE}/tools` |

## Agent Skill

`install/install.sh` copies `SKILL.md` into:

- `~/.agents/skills/kimi-datasource/`
- `~/.claude/skills/kimi-datasource/`
- `~/.codex/skills/kimi-datasource/`
- `~/.grok/skills/kimi-datasource/`

Agents should shell out to `kimi-datasource`, not invent HTTP calls.

## Auth model

The OAuth credential proves access to the user's existing Kimi subscription; the CLI does not store credentials for each underlying data provider.

```text
~/.kimi-code/credentials/kimi-code.json
        ↑ write on refresh / login
kimi-datasource  ──ensureFresh──►  auth.kimi.com
        │
        └── Bearer ──► api.kimi.com/coding/v1/tools
```

Refresh threshold: `max(300s, expires_in * 0.5)`.

On a gateway 401, the CLI reuses a credential rotated by the Kimi Code host if available; otherwise it forces an OAuth refresh. It retries the gateway request at most once.

## Layout

```text
bin/kimi-datasource.mjs   CLI entry (source)
lib/cli.mjs               Subcommands
lib/client.mjs            Gateway + ensureFresh
lib/auth.mjs              Token storage / lock / refresh
lib/oauth-http.mjs        OAuth HTTP
scripts/build.mjs         bun --compile
scripts/smoke.mjs         E2E smoke
install/install.sh        Build + install binary + skill
dist/kimi-datasource      Compiled binary (after build)
SKILL.md                  Agent skill
```

## Smoke test

```bash
bun run smoke
bun run smoke -- --bin dist/kimi-datasource
```

## CLI-only package

This package exposes a shell CLI rather than an MCP server.

## License

MIT
