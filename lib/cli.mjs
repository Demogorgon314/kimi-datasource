/**
 * CLI: login / status / refresh / sources / desc / call
 * Every data call runs ensureFresh via lib/client.mjs.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DATA_SOURCE_NAMES, PACKAGE_ROOT, VERSION } from './config.mjs';
import { callDataSourceTool, getDataSourceDesc } from './client.mjs';
import { runLogin, runRefresh, runStatus } from './login.mjs';

const GLOBAL_HELP = `kimi-datasource v${VERSION}

CLI for Kimi data sources. Every desc/call auto-refreshes OAuth tokens.

Usage:
  kimi-datasource <command> [args] [options]

Auth:
  login                         Device-code OAuth (writes ~/.kimi-code/credentials/)
  status                        Show credential state; refresh if expired/near expiry
  refresh                       Force refresh access_token

Data (auto token refresh):
  sources                       List known data source names
  desc <source>                 Fetch API documentation for a source
  call <source> <api> [opts]    Invoke an API

Examples:
  kimi-datasource status
  kimi-datasource sources --output json
  kimi-datasource desc arxiv
  kimi-datasource call --help

Environment:
  KIMI_CODE_HOME  KIMI_CODE_BASE_URL  KIMI_CODE_OAUTH_HOST  KIMI_DATASOURCE_API_URL
`;

const COMMAND_HELP = {
  sources: `Usage:
  kimi-datasource sources [--output text|json]

List the local catalog of 25 known data source names (managed plugin 3.4.0).
Account access and current APIs are determined by the gateway; run desc <source>.

Examples:
  kimi-datasource sources
  kimi-datasource sources --output json
`,
  desc: `Usage:
  kimi-datasource desc <source> [options]

Options:
  --output <text|json>           Output format (default: text)
  --quiet, -q                    Omit the trace footer in text and JSON output
  --help, -h                     Show this help

Examples:
  kimi-datasource desc arxiv
  kimi-datasource desc wind
  kimi-datasource desc stock_finance_data --output json
`,
  call: `Usage:
  kimi-datasource call <source> <api> [options]

Options:
  --json <object>                Full params as a JSON object
  --json-file <path|->           Read params from a JSON file or stdin (-)
  --param, -p <key=value>        Repeatable; later values override earlier ones
  --file-path <path>             Shorthand for --param file_path=...
  --output <text|json>           Output format (default: text)
  --quiet, -q                    Omit the trace footer in text and JSON output
  --help, -h                     Show this help

Parameter precedence:
  --json-file, then --json, then --param, then --file-path

Examples:
  kimi-datasource call arxiv search_papers \\
    --param query=RAG --param max_results=5 --file-path /tmp/arxiv.csv

  printf '%s' '{"query":"RAG","file_path":"/tmp/arxiv.csv"}' | \\
    kimi-datasource call arxiv search_papers --json-file - --output json
`,
  login: `Usage:
  kimi-datasource login

Start device-code OAuth login and save shared Kimi Code credentials.
`,
  status: `Usage:
  kimi-datasource status

Show credential state and refresh credentials when needed.
`,
  refresh: `Usage:
  kimi-datasource refresh

Force an OAuth access-token refresh.
`,
};

const FLAG_SPECS = new Map([
  ['help', { kind: 'boolean', canonical: 'help' }],
  ['h', { kind: 'boolean', canonical: 'help' }],
  ['version', { kind: 'boolean', canonical: 'version' }],
  ['V', { kind: 'boolean', canonical: 'version' }],
  ['quiet', { kind: 'boolean', canonical: 'quiet' }],
  ['q', { kind: 'boolean', canonical: 'quiet' }],
  ['json', { kind: 'value', canonical: 'json' }],
  ['json-file', { kind: 'value', canonical: 'json-file' }],
  ['param', { kind: 'repeatable', canonical: 'param' }],
  ['p', { kind: 'repeatable', canonical: 'param' }],
  ['file-path', { kind: 'value', canonical: 'file-path' }],
  ['file_path', { kind: 'value', canonical: 'file-path' }],
  ['output', { kind: 'value', canonical: 'output' }],
]);

const COMMAND_FLAGS = {
  login: new Set(['help']),
  status: new Set(['help']),
  refresh: new Set(['help']),
  sources: new Set(['help', 'output']),
  list: new Set(['help', 'output']),
  desc: new Set(['help', 'quiet', 'output']),
  describe: new Set(['help', 'quiet', 'output']),
  call: new Set(['help', 'quiet', 'json', 'json-file', 'param', 'file-path', 'output']),
  'skill-path': new Set(['help']),
  root: new Set(['help']),
  mcp: new Set(['help']),
  version: new Set(['help']),
  help: new Set(),
};

/**
 * @returns {{ command: string, positionals: string[], flags: Record<string, string|boolean|string[]> }}
 */
export function parseArgv(argv) {
  const args = [...argv];
  const flags = {};
  const positionals = [];

  while (args.length > 0) {
    const a = args.shift();
    if (a === undefined) break;
    if (a === '--') {
      positionals.push(...args);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const name = a.slice(2, eq);
        const spec = flagSpec(name);
        const value = a.slice(eq + 1);
        if (spec.kind === 'boolean') {
          if (value !== 'true' && value !== 'false') {
            throw new Error(`Option --${name} expects true or false when using "=".`);
          }
          flags[spec.canonical] = value === 'true';
        } else {
          pushFlag(flags, spec, value);
        }
        continue;
      }
      const name = a.slice(2);
      const spec = flagSpec(name);
      if (spec.kind === 'boolean') {
        flags[spec.canonical] = true;
      } else {
        pushFlag(flags, spec, takeOptionValue(args, `--${name}`));
      }
      continue;
    }
    if (a.startsWith('-') && a.length === 2) {
      const name = a.slice(1);
      const spec = flagSpec(name);
      if (spec.kind === 'boolean') {
        flags[spec.canonical] = true;
      } else {
        pushFlag(flags, spec, takeOptionValue(args, `-${name}`));
      }
      continue;
    }
    if (a.startsWith('-')) {
      throw new Error(`Unknown or unsupported option: ${a}`);
    }
    positionals.push(a);
  }

  const command = positionals.shift() ?? 'help';
  return { command, positionals, flags };
}

function flagSpec(name) {
  const spec = FLAG_SPECS.get(name);
  if (spec === undefined) {
    throw new Error(`Unknown option: ${name.length === 1 ? '-' : '--'}${name}`);
  }
  return spec;
}

function takeOptionValue(args, displayName) {
  const value = args.shift();
  if (value === undefined || (value !== '-' && value.startsWith('-'))) {
    throw new Error(`Option ${displayName} requires a value.`);
  }
  return value;
}

function pushFlag(flags, spec, value) {
  if (spec.kind === 'repeatable') {
    if (!Array.isArray(flags.param)) flags.param = [];
    flags.param.push(value);
    return;
  }
  flags[spec.canonical] = value;
}

function flagTrue(flags, name) {
  return flags[name] === true;
}

function stripTrace(text) {
  return text.replace(/\n\n\[kimi-datasource\][^\n]*\s*$/u, '').trimEnd();
}

export async function buildCallParams(flags) {
  let params = {};

  if (typeof flags['json-file'] === 'string') {
    const source = flags['json-file'];
    const raw = await readFile(source === '-' ? 0 : source, 'utf8');
    const parsed = parseJsonObject(raw, source === '-' ? 'stdin' : `--json-file ${source}`);
    params = { ...params, ...parsed };
  }

  if (typeof flags.json === 'string') {
    const parsed = parseJsonObject(flags.json, '--json');
    params = { ...params, ...parsed };
  }

  const paramList = Array.isArray(flags.param) ? flags.param : [];
  for (const item of paramList) {
    const eq = item.indexOf('=');
    if (eq === -1) {
      throw new Error(`Invalid --param (expected key=value): ${item}`);
    }
    const key = item.slice(0, eq).trim();
    const rawVal = item.slice(eq + 1);
    if (key.length === 0) throw new Error(`Invalid --param key: ${item}`);
    params[key] = coerceValue(rawVal);
  }

  if (typeof flags['file-path'] === 'string') {
    params.file_path = flags['file-path'];
  } else if (typeof flags.file_path === 'string') {
    params.file_path = flags.file_path;
  }

  return params;
}

function parseJsonObject(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON from ${source}: ${message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  return parsed;
}

export function coerceValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) return Number(raw);
  if (
    (raw.startsWith('{') && raw.endsWith('}')) ||
    (raw.startsWith('[') && raw.endsWith(']')) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function printMaybeQuiet(text, flags) {
  const out = flagTrue(flags, 'quiet') ? stripTrace(text) : text;
  process.stdout.write(`${out}\n`);
}

function outputFormat(flags) {
  const format = flags.output ?? 'text';
  if (format !== 'text' && format !== 'json') {
    throw new Error(`Invalid --output value "${format}". Expected text or json.`);
  }
  return format;
}

function validateCommandFlags(command, flags) {
  const allowed = COMMAND_FLAGS[command];
  if (allowed === undefined) return;
  for (const name of Object.keys(flags)) {
    if (name === 'version') continue;
    if (!allowed.has(name)) {
      throw new Error(`Option --${name} is not valid for "${command}". Run: kimi-datasource ${command} --help`);
    }
  }
}

function assertPositionals(command, positionals, expectedCount) {
  if (positionals.length <= expectedCount) return;
  throw new Error(
    `Unexpected argument for "${command}": ${positionals[expectedCount]}\n` +
      `Run: kimi-datasource ${command} --help`,
  );
}

function commandHelp(command) {
  const canonical = command === 'list' ? 'sources' : command === 'describe' ? 'desc' : command;
  return COMMAND_HELP[canonical] ?? GLOBAL_HELP;
}

function responseWithoutFileContents(response) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return response;
  if (!Array.isArray(response.files)) return response;
  return {
    ...response,
    files: response.files.map((file) => {
      if (file === null || typeof file !== 'object' || Array.isArray(file)) return file;
      const { content: _content, ...metadata } = file;
      return metadata;
    }),
  };
}

function printToolResult(result, flags, context) {
  if (outputFormat(flags) === 'text') {
    printMaybeQuiet(result.text, flags);
    return;
  }
  const output = {
    ok: true,
    ...context,
    text: stripTrace(result.text),
    files: result.writtenFiles,
    response: responseWithoutFileContents(result.response),
  };
  if (!flagTrue(flags, 'quiet')) output.trace = result.trace;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, positionals, flags } = parseArgv(argv);

  if (flagTrue(flags, 'version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === 'help') {
    assertPositionals(command, positionals, 1);
    process.stdout.write(commandHelp(positionals[0]));
    return 0;
  }

  validateCommandFlags(command, flags);

  if (flagTrue(flags, 'help')) {
    process.stdout.write(commandHelp(command));
    return 0;
  }

  if (command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (command) {
    case 'login':
      await runLogin();
      return 0;
    case 'status':
      await runStatus();
      return 0;
    case 'refresh':
      await runRefresh();
      return 0;
    case 'sources':
    case 'list':
      assertPositionals(command, positionals, 0);
      if (outputFormat(flags) === 'json') {
        process.stdout.write(`${JSON.stringify({ ok: true, sources: DATA_SOURCE_NAMES })}\n`);
        return 0;
      }
      for (const name of DATA_SOURCE_NAMES) {
        process.stdout.write(`${name}\n`);
      }
      return 0;
    case 'desc':
    case 'describe': {
      const name = positionals[0];
      if (!name) {
        throw new Error('Usage: kimi-datasource desc <source>\nRun: kimi-datasource sources');
      }
      assertPositionals(command, positionals, 1);
      if (!DATA_SOURCE_NAMES.includes(name)) {
        process.stderr.write(
          `Warning: unknown source "${name}". Known: ${DATA_SOURCE_NAMES.join(', ')}\n`,
        );
      }
      const result = await getDataSourceDesc(name);
      printToolResult(result, flags, { command: 'desc', source: name });
      return 0;
    }
    case 'call': {
      const source = positionals[0];
      const api = positionals[1];
      if (!source || !api) {
        throw new Error(
          'Usage: kimi-datasource call <source> <api> [options]\nRun: kimi-datasource call --help',
        );
      }
      assertPositionals(command, positionals, 2);
      const params = await buildCallParams(flags);
      if (Object.keys(params).length === 0) {
        process.stderr.write(
          'Warning: no params provided. Many APIs require file_path and other fields — run desc first.\n',
        );
      }
      const result = await callDataSourceTool(source, api, params);
      printToolResult(result, flags, { command: 'call', source, api });
      return 0;
    }
    case 'skill-path':
      process.stdout.write(`${path.join(PACKAGE_ROOT, 'SKILL.md')}\n`);
      return 0;
    case 'root':
      process.stdout.write(`${PACKAGE_ROOT}\n`);
      return 0;
    case 'mcp':
      throw new Error(
        'MCP is not available in this package. Use the CLI instead:\n  kimi-datasource desc <source>\n  kimi-datasource call <source> <api> …',
      );
    default:
      throw new Error(`Unknown command: ${command}\n\n${GLOBAL_HELP}`);
  }
}
