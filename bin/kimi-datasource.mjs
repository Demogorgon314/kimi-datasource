#!/usr/bin/env node
import { runCli } from '../lib/cli.mjs';

const code = await runCli(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

process.exit(code ?? 0);
