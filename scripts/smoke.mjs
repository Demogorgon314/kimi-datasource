#!/usr/bin/env bun
/**
 * Smoke test against source CLI or compiled binary.
 *
 *   bun run scripts/smoke.mjs
 *   bun run scripts/smoke.mjs --bin dist/kimi-datasource
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialsStatus, ensureFreshAccessToken } from '../lib/auth.mjs';
import { VERSION } from '../lib/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseBin(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bin') return path.resolve(argv[i + 1] ?? '');
    if (argv[i].startsWith('--bin=')) return path.resolve(argv[i].slice('--bin='.length));
  }
  return null;
}

const compiled = parseBin(process.argv.slice(2));
const useCompiled = Boolean(compiled);

function run(args, timeoutMs = 45_000) {
  if (useCompiled) {
    return spawnSync(compiled, args, { encoding: 'utf8', timeout: timeoutMs });
  }
  return spawnSync(process.execPath.includes('bun') ? 'bun' : process.execPath, [
    ...(process.execPath.includes('bun') ? [] : []),
    path.join(root, 'bin/kimi-datasource.mjs'),
    ...args,
  ], {
    encoding: 'utf8',
    timeout: timeoutMs,
    // Prefer bun when available for source runs
    env: process.env,
  });
}

function runSourceOrBun(args, timeoutMs = 45_000) {
  if (useCompiled) {
    return spawnSync(compiled, args, { encoding: 'utf8', timeout: timeoutMs });
  }
  // Always use bun for source when this script is bun; else node
  const isBun = typeof Bun !== 'undefined';
  if (isBun) {
    return spawnSync('bun', [path.join(root, 'bin/kimi-datasource.mjs'), ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  }
  return spawnSync(process.execPath, [path.join(root, 'bin/kimi-datasource.mjs'), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function mustOk(label, result) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function main() {
  console.log(`kimi-datasource smoke v${VERSION}${useCompiled ? ` (bin=${compiled})` : ' (source)'}`);

  const status = credentialsStatus();
  console.log('credentials:', status.kind, status.filePath);
  if (status.kind === 'missing' || status.kind === 'revoked') {
    console.error('No usable credentials. Run: kimi-datasource login');
    process.exit(2);
  }

  const fresh = await ensureFreshAccessToken();
  console.log('✓ ensureFreshAccessToken refreshed=', fresh.refreshed, 'token_len=', fresh.token.length);

  const help = mustOk('help', runSourceOrBun(['--help']));
  if (!help.includes('desc') || !help.includes('call')) {
    throw new Error('help missing expected commands');
  }
  console.log('✓ help');

  if (help.includes('\nmcp') || /MCP:/u.test(help)) {
    throw new Error('help still mentions MCP (should be removed)');
  }
  console.log('✓ help has no MCP section');

  const sources = mustOk('sources', runSourceOrBun(['sources']));
  if (!sources.includes('arxiv')) throw new Error('sources missing arxiv');
  console.log('✓ sources');

  const desc = mustOk('desc', runSourceOrBun(['desc', 'arxiv', '--quiet']));
  if (!/arxiv|search_papers/i.test(desc)) {
    throw new Error(`desc unexpected: ${desc.slice(0, 200)}`);
  }
  console.log('✓ desc arxiv len=', desc.length);

  const outCsv = `/tmp/kimi-ds-smoke-${Date.now()}.csv`;
  const call = mustOk(
    'call',
    runSourceOrBun(
      [
        'call',
        'arxiv',
        'search_papers',
        '--param',
        'query=RAG',
        '--param',
        'max_results=1',
        '--file-path',
        outCsv,
        '--quiet',
      ],
      60_000,
    ),
  );
  if (!call.includes(outCsv) && !/data_preview|saved/i.test(call)) {
    throw new Error(`call unexpected: ${call.slice(0, 300)}`);
  }
  console.log('✓ call arxiv search_papers');

  console.log('All smoke checks passed.');
}

// unused helper silence
void run;

main().catch((err) => {
  console.error('SMOKE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
