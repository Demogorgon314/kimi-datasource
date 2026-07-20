import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  credentialsStatus,
  ensureFreshAccessToken,
  loadTokenWire,
  saveTokenWire,
} from '../lib/auth.mjs';
import { credentialsPath } from '../lib/config.mjs';

const temporaryDirectories = [];
const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(async () => {
  process.env = { ...originalEnvironment };
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryCredentialPath() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-datasource-auth-test-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'credentials', 'kimi-code.json');
}

async function useTemporaryKimiHome() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-datasource-home-test-'));
  temporaryDirectories.push(directory);
  process.env.KIMI_CODE_HOME = directory;
  delete process.env.KIMI_CODE_BASE_URL;
  delete process.env.KIMI_CODE_OAUTH_HOST;
  delete process.env.KIMI_OAUTH_HOST;
  return directory;
}

describe('credential storage', () => {
  test('round-trips credentials using a private file', async () => {
    const filePath = await temporaryCredentialPath();
    const token = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: 123,
      expires_in: 60,
    };

    saveTokenWire(token, filePath);

    expect(loadTokenWire(filePath)).toEqual(token);
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('returns undefined for a missing credential file', async () => {
    const filePath = await temporaryCredentialPath();
    expect(loadTokenWire(filePath)).toBeUndefined();
  });

  test('returns undefined for malformed credential JSON', async () => {
    const filePath = await temporaryCredentialPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'not-json');

    expect(loadTokenWire(filePath)).toBeUndefined();
  });
});

describe('credential lifecycle', () => {
  test('reports missing, revoked, valid, and expired states', async () => {
    await useTemporaryKimiHome();
    const filePath = credentialsPath();

    expect(credentialsStatus().kind).toBe('missing');

    saveTokenWire(
      {
        access_token: '',
        refresh_token: '',
        expires_at: 0,
        expires_in: 0,
      },
      filePath,
    );
    expect(credentialsStatus().kind).toBe('revoked');

    saveTokenWire(
      {
        access_token: 'valid',
        refresh_token: 'refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3_600,
        expires_in: 3_600,
      },
      filePath,
    );
    expect(credentialsStatus()).toMatchObject({
      kind: 'valid',
      needsRefresh: false,
      hasRefreshToken: true,
    });

    saveTokenWire(
      {
        access_token: 'expired',
        refresh_token: 'refresh',
        expires_at: 1,
        expires_in: 3_600,
      },
      filePath,
    );
    expect(credentialsStatus().kind).toBe('expired');
  });

  test('returns a cached token when it is still fresh', async () => {
    await useTemporaryKimiHome();
    saveTokenWire(
      {
        access_token: 'cached-access',
        refresh_token: 'refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3_600,
        expires_in: 3_600,
      },
      credentialsPath(),
    );

    await expect(ensureFreshAccessToken()).resolves.toMatchObject({
      token: 'cached-access',
      refreshed: false,
    });
  });

  test('refreshes and persists an expired token with Kimi identity headers', async () => {
    await useTemporaryKimiHome();
    saveTokenWire(
      {
        access_token: 'expired-access',
        refresh_token: 'old-refresh',
        expires_at: 1,
        expires_in: 3_600,
      },
      credentialsPath(),
    );
    let request;
    globalThis.fetch = async (_url, init) => {
      request = init;
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3_600,
        }),
        { status: 200 },
      );
    };

    await expect(ensureFreshAccessToken()).resolves.toMatchObject({
      token: 'new-access',
      refreshed: true,
    });
    expect(request.headers['X-Msh-Platform']).toBe('kimi_code_cli');
    expect(loadTokenWire(credentialsPath())).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    });
  });

  test('tombstones a rejected refresh token', async () => {
    await useTemporaryKimiHome();
    saveTokenWire(
      {
        access_token: 'expired-access',
        refresh_token: 'rejected-refresh',
        expires_at: 1,
        expires_in: 3_600,
      },
      credentialsPath(),
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });

    await expect(ensureFreshAccessToken()).rejects.toThrow('Token refresh unauthorized');
    expect(loadTokenWire(credentialsPath())).toMatchObject({
      access_token: '',
      refresh_token: '',
      expires_at: 0,
    });
  });

  test('explains how to recover from missing credentials', async () => {
    await useTemporaryKimiHome();

    await expect(ensureFreshAccessToken()).rejects.toThrow('kimi-datasource login');
  });
});
