import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { saveTokenWire } from '../lib/auth.mjs';
import { buildCallParams, coerceValue, parseArgv, runCli } from '../lib/cli.mjs';
import { credentialsPath } from '../lib/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'bin/kimi-datasource.mjs');
const temporaryDirectories = [];
const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write;

afterEach(async () => {
  process.env = { ...originalEnvironment };
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runCliProcess(args, input) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
  });
}

async function captureStdout(callback) {
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  await callback();
  return chunks.join('');
}

async function useTemporaryCredentials() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-cli-test-'));
  temporaryDirectories.push(directory);
  process.env.KIMI_CODE_HOME = directory;
  delete process.env.KIMI_CODE_BASE_URL;
  delete process.env.KIMI_CODE_OAUTH_HOST;
  delete process.env.KIMI_OAUTH_HOST;
  saveTokenWire(
    {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
      expires_in: 3_600,
    },
    credentialsPath(),
  );
}

describe('parseArgv', () => {
  test('parses repeatable params and canonical aliases', () => {
    expect(parseArgv(['call', 'arxiv', 'search_papers', '-p', 'query=RAG', '--param=x=1'])).toEqual({
      command: 'call',
      positionals: ['arxiv', 'search_papers'],
      flags: { param: ['query=RAG', 'x=1'] },
    });
  });

  test('boolean flags do not consume the command', () => {
    expect(parseArgv(['--quiet', 'call', 'arxiv', 'search_papers'])).toEqual({
      command: 'call',
      positionals: ['arxiv', 'search_papers'],
      flags: { quiet: true },
    });
  });

  test('rejects unknown options before any network request', () => {
    expect(() => parseArgv(['call', '--bogus', 'value'])).toThrow('Unknown option: --bogus');
  });

  test('rejects options with missing values', () => {
    expect(() => parseArgv(['call', '--file-path'])).toThrow(
      'Option --file-path requires a value.',
    );
    expect(() => parseArgv(['call', '--file-path', '--quiet'])).toThrow(
      'Option --file-path requires a value.',
    );
  });
});

describe('call parameter building', () => {
  test('applies documented precedence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kimi-datasource-test-'));
    temporaryDirectories.push(directory);
    const jsonPath = path.join(directory, 'params.json');
    await writeFile(jsonPath, '{"query":"file","max_results":1,"file_path":"file.csv"}');

    const params = await buildCallParams({
      'json-file': jsonPath,
      json: '{"query":"json","max_results":2}',
      param: ['query=param', 'max_results=3'],
      'file-path': 'final.csv',
    });

    expect(params).toEqual({
      query: 'param',
      max_results: 3,
      file_path: 'final.csv',
    });
  });

  test('reports the source of malformed JSON', async () => {
    await expect(buildCallParams({ json: 'not-json' })).rejects.toThrow(
      'Invalid JSON from --json',
    );
  });

  test('preserves identifiers with leading zeroes', () => {
    expect(coerceValue('000001')).toBe('000001');
    expect(coerceValue('12')).toBe(12);
    expect(coerceValue('1e3')).toBe(1000);
  });
});

describe('CLI behavior', () => {
  test('shows layered call help', () => {
    const result = runCliProcess(['call', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:\n  kimi-datasource call');
    expect(result.stdout).toContain('--json-file <path|->');
    expect(result.stdout).not.toContain('Auth:');
  });

  test('returns sources as JSON', () => {
    const result = runCliProcess(['sources', '--output', 'json']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      sources: expect.arrayContaining(['stock_finance_data', 'arxiv']),
    });
  });

  test('rejects an unknown option without contacting the backend', () => {
    const result = runCliProcess(['call', 'arxiv', 'search_papers', '--bogus', 'value']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option: --bogus');
  });

  test('reads JSON from stdin and fails locally when it is malformed', () => {
    const result = runCliProcess(
      ['call', 'arxiv', 'search_papers', '--json-file', '-'],
      'not-json',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid JSON from stdin');
  });

  test('supports the global version flag', () => {
    const result = runCliProcess(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  test('runs local informational commands directly', async () => {
    const output = await captureStdout(async () => {
      await runCli(['sources']);
      await runCli(['version']);
      await runCli(['root']);
      await runCli(['skill-path']);
    });

    expect(output).toContain('stock_finance_data');
    expect(output).toContain(root);
    expect(output).toContain('SKILL.md');
  });

  test('validates command flags, output formats, and extra arguments', async () => {
    await expect(runCli(['sources', '--quiet'])).rejects.toThrow(
      'Option --quiet is not valid for "sources"',
    );
    await expect(runCli(['sources', '--output', 'yaml'])).rejects.toThrow(
      'Expected text or json',
    );
    await expect(runCli(['sources', 'extra'])).rejects.toThrow(
      'Unexpected argument for "sources": extra',
    );
  });

  test('returns actionable errors for missing and retired commands', async () => {
    await expect(runCli(['desc'])).rejects.toThrow('Run: kimi-datasource sources');
    await expect(runCli(['call'])).rejects.toThrow('Run: kimi-datasource call --help');
    await expect(runCli(['mcp'])).rejects.toThrow('MCP is not available');
    await expect(runCli(['unknown'])).rejects.toThrow('Unknown command: unknown');
  });

  test('prints safe structured JSON for tool results', async () => {
    await useTemporaryCredentials();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          is_success: true,
          result: {
            assistant: [{ type: 'text', text: 'description' }],
          },
          files: [{ name: '/tmp/ignored.csv', content: 'secret file content' }],
        }),
        { status: 200 },
      );

    const stdout = await captureStdout(() =>
      runCli(['desc', 'arxiv', '--output', 'json', '--quiet']),
    );
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      command: 'desc',
      source: 'arxiv',
    });
    expect(output.text).toContain('description');
    expect(output.text).toContain('skipped returned file');
    expect(output.trace).toBeUndefined();
    expect(output.response.files[0].content).toBeUndefined();
  });
});
