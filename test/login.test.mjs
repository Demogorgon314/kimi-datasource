import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadTokenWire, saveTokenWire } from '../lib/auth.mjs';
import { credentialsPath } from '../lib/config.mjs';
import { runLogin, runRefresh, runStatus } from '../lib/login.mjs';

const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const temporaryDirectories = [];

afterEach(async () => {
  process.env = { ...originalEnvironment };
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function useTemporaryKimiHome() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-login-test-'));
  temporaryDirectories.push(directory);
  process.env.KIMI_CODE_HOME = directory;
  delete process.env.KIMI_CODE_BASE_URL;
  delete process.env.KIMI_CODE_OAUTH_HOST;
  delete process.env.KIMI_OAUTH_HOST;
  return directory;
}

function captureLogs() {
  const lines = [];
  console.log = (...values) => lines.push(values.join(' '));
  return lines;
}

describe('authentication commands', () => {
  test('reports missing credentials without refreshing', async () => {
    await useTemporaryKimiHome();
    const logs = captureLogs();

    const status = await runStatus();

    expect(status.kind).toBe('missing');
    expect(logs.join('\n')).toContain('kind:            missing');
  });

  test('reports a fresh credential without a network request', async () => {
    await useTemporaryKimiHome();
    saveTokenWire(
      {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3_600,
        expires_in: 3_600,
      },
      credentialsPath(),
    );
    globalThis.fetch = async () => {
      throw new Error('unexpected network request');
    };
    captureLogs();

    const status = await runStatus();

    expect(status).toMatchObject({ kind: 'valid', needsRefresh: false });
  });

  test('force refreshes credentials', async () => {
    await useTemporaryKimiHome();
    saveTokenWire(
      {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3_600,
        expires_in: 3_600,
      },
      credentialsPath(),
    );
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3_600,
        }),
        { status: 200 },
      );
    const logs = captureLogs();

    const result = await runRefresh();

    expect(result).toMatchObject({ token: 'rotated-access', refreshed: true });
    expect(logs.join('\n')).toContain('refreshed: true');
  });

  test('completes device-code login and saves credentials', async () => {
    await useTemporaryKimiHome();
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/api/oauth/device_authorization')) {
        return new Response(
          JSON.stringify({
            user_code: 'ABCD',
            device_code: 'device-code',
            verification_uri_complete: 'https://example.test/device',
            interval: 1,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: 'login-access',
          refresh_token: 'login-refresh',
          expires_in: 3_600,
        }),
        { status: 200 },
      );
    };
    const logs = captureLogs();

    const token = await runLogin();

    expect(token.access_token).toBe('login-access');
    expect(loadTokenWire(credentialsPath())).toMatchObject({
      access_token: 'login-access',
      refresh_token: 'login-refresh',
    });
    expect(requests[0].init.headers['X-Msh-Platform']).toBe('kimi_code_cli');
    expect(logs.join('\n')).toContain('Login successful.');
  });
});
