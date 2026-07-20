#!/usr/bin/env bun
/**
 * Compile a standalone kimi-datasource binary with Bun.
 *
 * Usage:
 *   bun run scripts/build.mjs
 *   bun run scripts/build.mjs --target bun-darwin-arm64
 *   bun run scripts/build.mjs --outfile dist/kimi-datasource
 */

import { mkdirSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'bin/kimi-datasource.mjs');

function parseArgs(argv) {
  const out = { outfile: path.join(root, 'dist/kimi-datasource'), target: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--outfile' || a === '-o') {
      out.outfile = path.resolve(argv[++i] ?? out.outfile);
    } else if (a.startsWith('--outfile=')) {
      out.outfile = path.resolve(a.slice('--outfile='.length));
    } else if (a === '--target' || a === '-t') {
      out.target = argv[++i];
    } else if (a.startsWith('--target=')) {
      out.target = a.slice('--target='.length);
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: bun run scripts/build.mjs [--outfile path] [--target bun-darwin-arm64|…]`);
      process.exit(0);
    }
  }
  return out;
}

const { outfile, target } = parseArgs(process.argv.slice(2));
mkdirSync(path.dirname(outfile), { recursive: true });

const args = ['build', entry, '--compile', '--outfile', outfile];
if (target) {
  args.push('--target', target);
}

console.log(`$ bun ${args.join(' ')}`);
const result = spawnSync('bun', args, { stdio: 'inherit', cwd: root });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

try {
  chmodSync(outfile, 0o755);
} catch {
  // Windows
}

// Bundle skill assets next to the binary for installers / skill-path fallback
const distDir = path.dirname(outfile);
for (const name of ['SKILL.md', 'watchlist.json']) {
  const src = path.join(root, name);
  if (existsSync(src)) {
    copyFileSync(src, path.join(distDir, name));
  }
}

console.log(`Built: ${outfile}`);
const ver = spawnSync(outfile, ['version'], { encoding: 'utf8' });
if (ver.status === 0) {
  console.log(`version: ${ver.stdout.trim()}`);
} else {
  console.warn('warning: could not run binary version check');
  if (ver.stderr) process.stderr.write(ver.stderr);
}
