import { afterEach, describe, expect, test } from 'bun:test';

import {
  OAuthUnauthorizedError,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
} from '../lib/oauth-http.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const config = {
  oauthHost: 'https://auth.example.test',
  clientId: 'client-id',
};

const tokenResponse = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3_600,
  scope: 'openid',
  token_type: 'Bearer',
};

describe('device authorization', () => {
  test('parses a valid device authorization response', async () => {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        user_code: 'ABCD',
        device_code: 'device-code',
        verification_uri: 'https://example.test',
        verification_uri_complete: 'https://example.test/device',
        expires_in: 600,
        interval: 2,
      });

    await expect(requestDeviceAuthorization(config)).resolves.toEqual({
      userCode: 'ABCD',
      deviceCode: 'device-code',
      verificationUri: 'https://example.test',
      verificationUriComplete: 'https://example.test/device',
      expiresIn: 600,
      interval: 2,
    });
  });

  test('reports HTTP and malformed-response errors', async () => {
    globalThis.fetch = async () => jsonResponse(400, { error_description: 'bad client' });
    await expect(requestDeviceAuthorization(config)).rejects.toThrow(
      'Device authorization failed (HTTP 400): bad client',
    );

    globalThis.fetch = async () => jsonResponse(200, {});
    await expect(requestDeviceAuthorization(config)).rejects.toThrow('missing user_code');
  });
});

describe('device token polling', () => {
  test('returns successful tokens and pending states', async () => {
    globalThis.fetch = async () => jsonResponse(200, tokenResponse);
    const success = await pollDeviceToken(config, 'device-code');
    expect(success.kind).toBe('success');
    expect(success.token.access_token).toBe('access-token');

    globalThis.fetch = async () =>
      jsonResponse(400, { error: 'authorization_pending', error_description: 'wait' });
    await expect(pollDeviceToken(config, 'device-code')).resolves.toEqual({
      kind: 'pending',
      errorCode: 'authorization_pending',
      description: 'wait',
    });
  });

  test('maps expired and denied states', async () => {
    globalThis.fetch = async () => jsonResponse(400, { error: 'expired_token' });
    await expect(pollDeviceToken(config, 'device-code')).resolves.toEqual({ kind: 'expired' });

    globalThis.fetch = async () =>
      jsonResponse(400, { error: 'access_denied', error_description: 'no' });
    await expect(pollDeviceToken(config, 'device-code')).resolves.toEqual({
      kind: 'denied',
      description: 'no',
    });
  });

  test('throws for server and unknown errors', async () => {
    globalThis.fetch = async () => jsonResponse(503, { message: 'unavailable' });
    await expect(pollDeviceToken(config, 'device-code')).rejects.toThrow(
      'server error (HTTP 503): unavailable',
    );

    globalThis.fetch = async () => jsonResponse(400, { error: 'unexpected' });
    await expect(pollDeviceToken(config, 'device-code')).rejects.toThrow(
      'Device token polling failed',
    );
  });
});

describe('token refresh', () => {
  test('returns a normalized token', async () => {
    globalThis.fetch = async () => jsonResponse(200, tokenResponse);

    const token = await refreshAccessToken(config, 'old-refresh-token');

    expect(token).toMatchObject({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3_600,
    });
    expect(token.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('retries retryable failures', async () => {
    let attempts = 0;
    const delays = [];
    globalThis.fetch = async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(503, { message: 'retry me' })
        : jsonResponse(200, tokenResponse);
    };

    const token = await refreshAccessToken(config, 'old-refresh-token', {
      sleep: async (delay) => delays.push(delay),
      backoffMs: () => 7,
    });

    expect(token.access_token).toBe('access-token');
    expect(attempts).toBe(2);
    expect(delays).toEqual([7]);
  });

  test('classifies invalid grants as unauthorized', async () => {
    globalThis.fetch = async () => jsonResponse(400, { error: 'invalid_grant' });

    await expect(refreshAccessToken(config, 'bad-token')).rejects.toBeInstanceOf(
      OAuthUnauthorizedError,
    );
  });

  test('wraps fetch failures with endpoint context', async () => {
    globalThis.fetch = async () => {
      throw new Error('offline');
    };

    await expect(
      refreshAccessToken(config, 'token', {
        maxRetries: 1,
      }),
    ).rejects.toThrow('OAuth request to https://auth.example.test/api/oauth/token failed: offline');
  });
});
