/**
 * Shared configuration: endpoints, credential names, version.
 * Keep credential naming in sync with kimi-code packages/oauth managed-kimi-code.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.1.0';
export const PACKAGE_NAME = 'kimi-datasource';

export const DEFAULT_KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';
export const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
/** Keep in sync with packages/oauth/src/identity.ts in kimi-code. */
export const KIMI_CODE_PLATFORM = 'kimi_code_cli';
/** Kimi Code managed OAuth client id (device code + refresh). */
export const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

export const REQUEST_TIMEOUT_MS = 30_000;
export const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;

/** Refresh when remaining lifetime is below max(300s, expires_in * 0.5). */
export const MIN_REFRESH_THRESHOLD_SECONDS = 300;
export const REFRESH_THRESHOLD_RATIO = 0.5;

export const DATA_SOURCE_NAMES = [
  'stock_finance_data',
  'yahoo_finance',
  'world_bank_open_data',
  'tianyancha',
  'arxiv',
  'scholar',
  'yuandian_law',
  'wind',
  'imf',
  'gildata',
  'sec_edgar',
  'sp_data',
  'china_nda',
  'china_nbs',
  'china_standards',
  'who',
  'fao',
  'unsd',
  'ecb',
  'eurostat',
  'unicef',
  'oecd',
  'fred',
  'xhcj',
  'caixin',
];

/**
 * Source-tree root when running from checkout; for bun --compile binaries,
 * falls back to the directory containing the executable (where install places SKILL.md).
 */
function resolvePackageRoot() {
  try {
    const fromModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (existsSync(path.join(fromModule, 'package.json')) || existsSync(path.join(fromModule, 'SKILL.md'))) {
      return fromModule;
    }
  } catch {
    // compiled / virtual path
  }
  return path.dirname(process.execPath);
}

export const PACKAGE_ROOT = resolvePackageRoot();

export function resolveKimiHome() {
  const explicit = process.env.KIMI_CODE_HOME?.trim();
  return explicit && explicit.length > 0 ? explicit : path.join(homedir(), '.kimi-code');
}

export function normalizeEndpoint(value) {
  return String(value).trim().replace(/\/+$/, '');
}

export function kimiCodeBaseUrl() {
  return normalizeEndpoint(process.env.KIMI_CODE_BASE_URL ?? DEFAULT_KIMI_CODE_BASE_URL);
}

export function kimiCodeOAuthHost() {
  return normalizeEndpoint(
    process.env.KIMI_CODE_OAUTH_HOST ??
      process.env.KIMI_OAUTH_HOST ??
      DEFAULT_KIMI_CODE_OAUTH_HOST,
  );
}

export function datasourceApiUrl() {
  const explicit = process.env.KIMI_DATASOURCE_API_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return `${kimiCodeBaseUrl()}/tools`;
}

/**
 * Credential file stem under `{kimiHome}/credentials/<name>.json`.
 * Default production env → `kimi-code`; custom host/base → hashed env name.
 */
export function resolveCredentialName() {
  const oauthHost = kimiCodeOAuthHost();
  const baseUrl = kimiCodeBaseUrl();
  if (
    oauthHost === normalizeEndpoint(DEFAULT_KIMI_CODE_OAUTH_HOST) &&
    baseUrl === normalizeEndpoint(DEFAULT_KIMI_CODE_BASE_URL)
  ) {
    return 'kimi-code';
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost, baseUrl }))
    .digest('hex')
    .slice(0, 16);
  return `kimi-code-env-${digest}`;
}

export function credentialsPath(kimiHome = resolveKimiHome()) {
  return path.join(kimiHome, 'credentials', `${resolveCredentialName()}.json`);
}

export function oauthLockPath(kimiHome = resolveKimiHome()) {
  return path.join(kimiHome, 'oauth', resolveCredentialName());
}

export function defaultRefreshThreshold(expiresIn) {
  if (expiresIn > 0) {
    return Math.max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * REFRESH_THRESHOLD_RATIO);
  }
  return MIN_REFRESH_THRESHOLD_SECONDS;
}

export function oauthFlowConfig() {
  return {
    name: resolveCredentialName(),
    oauthHost: kimiCodeOAuthHost(),
    clientId: process.env.KIMI_CODE_CLIENT_ID?.trim() || KIMI_CODE_CLIENT_ID,
  };
}
