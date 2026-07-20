import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_KIMI_CODE_BASE_URL,
  DEFAULT_KIMI_CODE_OAUTH_HOST,
  credentialsPath,
  datasourceApiUrl,
  defaultRefreshThreshold,
  kimiCodeBaseUrl,
  kimiCodeOAuthHost,
  normalizeEndpoint,
  oauthFlowConfig,
  oauthLockPath,
  resolveCredentialName,
  resolveKimiHome,
} from '../lib/config.mjs';
import { asciiHeader, isNotFound, isRecord, nowUnix, sleep } from '../lib/util.mjs';
import { buildDeviceHeaders, createDeviceId } from '../lib/identity.mjs';

const originalEnvironment = { ...process.env };
const temporaryDirectories = [];

afterEach(async () => {
  process.env = { ...originalEnvironment };
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('configuration', () => {
  test('normalizes default endpoints and derives the tools URL', () => {
    delete process.env.KIMI_CODE_BASE_URL;
    delete process.env.KIMI_CODE_OAUTH_HOST;
    delete process.env.KIMI_DATASOURCE_API_URL;

    expect(normalizeEndpoint(' https://example.com/// ')).toBe('https://example.com');
    expect(kimiCodeBaseUrl()).toBe(DEFAULT_KIMI_CODE_BASE_URL);
    expect(kimiCodeOAuthHost()).toBe(DEFAULT_KIMI_CODE_OAUTH_HOST);
    expect(datasourceApiUrl()).toBe(`${DEFAULT_KIMI_CODE_BASE_URL}/tools`);
  });

  test('honors explicit homes and endpoints', () => {
    process.env.KIMI_CODE_HOME = '/tmp/custom-kimi-home';
    process.env.KIMI_CODE_BASE_URL = 'https://api.example.test/';
    process.env.KIMI_CODE_OAUTH_HOST = 'https://auth.example.test/';
    process.env.KIMI_DATASOURCE_API_URL = 'https://tools.example.test/custom';

    expect(resolveKimiHome()).toBe('/tmp/custom-kimi-home');
    expect(kimiCodeBaseUrl()).toBe('https://api.example.test');
    expect(kimiCodeOAuthHost()).toBe('https://auth.example.test');
    expect(datasourceApiUrl()).toBe('https://tools.example.test/custom');
    expect(resolveCredentialName()).toMatch(/^kimi-code-env-[a-f0-9]{16}$/u);
    expect(credentialsPath()).toContain('/tmp/custom-kimi-home/credentials/');
    expect(oauthLockPath()).toContain('/tmp/custom-kimi-home/oauth/');
    expect(oauthFlowConfig()).toMatchObject({
      oauthHost: 'https://auth.example.test',
    });
  });

  test('uses a bounded dynamic refresh threshold', () => {
    expect(defaultRefreshThreshold(0)).toBe(300);
    expect(defaultRefreshThreshold(120)).toBe(300);
    expect(defaultRefreshThreshold(3_600)).toBe(1_800);
  });
});

describe('utility functions', () => {
  test('recognizes records and missing-file errors', () => {
    expect(isRecord({})).toBeTrue();
    expect(isRecord([])).toBeFalse();
    expect(isRecord(null)).toBeFalse();
    expect(isNotFound({ code: 'ENOENT' })).toBeTrue();
    expect(isNotFound(new Error('other'))).toBeFalse();
  });

  test('sanitizes HTTP headers', () => {
    expect(asciiHeader('  Kimi 数据源  ')).toBe('Kimi');
    expect(asciiHeader('数据源', 'fallback')).toBe('fallback');
  });

  test('provides clock and sleep helpers', async () => {
    const before = Math.floor(Date.now() / 1000);
    expect(nowUnix()).toBeGreaterThanOrEqual(before);
    await sleep(1);
  });
});

describe('Kimi device identity', () => {
  test('creates and reuses a persistent device id', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kimi-device-test-'));
    temporaryDirectories.push(directory);

    const first = await createDeviceId(directory);
    const second = await createDeviceId(directory);

    expect(second).toBe(first);
    expect((await readFile(path.join(directory, 'device_id'), 'utf8')).trim()).toBe(first);
  });

  test('builds upstream-compatible headers and honors explicit overrides', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kimi-device-test-'));
    temporaryDirectories.push(directory);
    process.env.KIMI_MSH_DEVICE_ID = 'fixed-device';

    const headers = await buildDeviceHeaders(directory);

    expect(headers).toMatchObject({
      'X-Msh-Platform': 'kimi_code_cli',
      'X-Msh-Device-Id': 'fixed-device',
    });
  });
});
