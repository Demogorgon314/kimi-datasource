/**
 * Pure HTTP wrappers for Kimi OAuth (device code + refresh).
 * Adapted from kimi-code packages/oauth (self-contained, no package deps).
 */

import { isRecord, sleep } from './util.mjs';

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function extractApiErrorMessage(data) {
  if (!isRecord(data)) return undefined;
  for (const key of ['error_description', 'message', 'detail', 'error']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function pickErrorDetail(data) {
  return extractApiErrorMessage(data) ?? 'unknown';
}

function describeFetchFailure(error) {
  if (!(error instanceof Error)) return String(error);
  const messages = new Set();
  let current = error;
  while (current !== undefined) {
    messages.add(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return [...messages].join(': ');
}

function tokenFromResponse(payload) {
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth response missing access_token');
  }
  const refreshToken = payload.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new Error('OAuth response missing refresh_token');
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth response missing or invalid expires_in');
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    scope: typeof payload.scope === 'string' ? payload.scope : '',
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    expires_in: expiresIn,
  };
}

async function postForm(url, params, deviceHeaders, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const body = new URLSearchParams(params).toString();
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal !== undefined) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...deviceHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal,
    });
  } catch (error) {
    throw new Error(`OAuth request to ${url} failed: ${describeFetchFailure(error)}`, {
      cause: error,
    });
  }

  const status = response.status;
  let data = {};
  try {
    const parsed = await response.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    // non-JSON
  }
  return { status, data };
}

export async function requestDeviceAuthorization(config, options = {}) {
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/device_authorization`;
  const { status, data } = await postForm(url, { client_id: config.clientId }, options.deviceHeaders);

  if (status !== 200) {
    throw new Error(`Device authorization failed (HTTP ${status}): ${pickErrorDetail(data)}`);
  }

  const userCode = data.user_code;
  const deviceCode = data.device_code;
  const verificationUriComplete = data.verification_uri_complete;
  if (typeof userCode !== 'string' || userCode.length === 0) {
    throw new Error('Device authorization response missing user_code');
  }
  if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
    throw new Error('Device authorization response missing device_code');
  }
  if (typeof verificationUriComplete !== 'string' || verificationUriComplete.length === 0) {
    throw new Error('Device authorization response missing verification_uri_complete');
  }

  return {
    userCode,
    deviceCode,
    verificationUri: typeof data.verification_uri === 'string' ? data.verification_uri : '',
    verificationUriComplete,
    expiresIn: data.expires_in !== undefined ? Number(data.expires_in) : null,
    interval: Number(data.interval ?? 5),
  };
}

/**
 * @returns {{ kind: 'success', token } | { kind: 'pending', errorCode, description } | { kind: 'expired' } | { kind: 'denied', description }}
 */
export async function pollDeviceToken(config, deviceCode, options = {}) {
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/token`;
  const { status, data } = await postForm(
    url,
    {
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    options.deviceHeaders,
  );

  if (status === 200 && typeof data.access_token === 'string') {
    return { kind: 'success', token: tokenFromResponse(data) };
  }

  if (status >= 500) {
    throw new Error(`Device token polling server error (HTTP ${status}): ${pickErrorDetail(data)}`);
  }

  const errorCode = typeof data.error === 'string' ? data.error : 'unknown_error';
  const detail = extractApiErrorMessage(data);
  const description =
    typeof data.error_description === 'string' ? data.error_description : (detail ?? '');

  switch (errorCode) {
    case 'authorization_pending':
    case 'slow_down':
      return { kind: 'pending', errorCode, description };
    case 'expired_token':
      return { kind: 'expired' };
    case 'access_denied':
      return { kind: 'denied', description };
    default:
      throw new Error(
        `Device token polling failed (HTTP ${status}): ${detail ?? `${errorCode} ${description}`}`,
      );
  }
}

export class OAuthUnauthorizedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthUnauthorizedError';
  }
}

export async function refreshAccessToken(config, refreshToken, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const backoff = options.backoffMs ?? ((attempt) => 2 ** attempt * 1000);
  const sleepFn = options.sleep ?? sleep;
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/token`;

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let status;
    let data;
    try {
      ({ status, data } = await postForm(
        url,
        {
          client_id: config.clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        },
        options.deviceHeaders,
      ));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries - 1) {
        await sleepFn(backoff(attempt));
        continue;
      }
      throw lastError;
    }

    if (status === 200 && typeof data.access_token === 'string') {
      return tokenFromResponse(data);
    }

    const errorCode = typeof data.error === 'string' ? data.error : '';
    const detail = extractApiErrorMessage(data);
    if (status === 401 || status === 403 || errorCode === 'invalid_grant') {
      throw new OAuthUnauthorizedError(detail ?? 'Token refresh unauthorized.');
    }

    const desc = detail ?? `Token refresh failed (HTTP ${status}).`;
    if (RETRYABLE_STATUSES.has(status)) {
      lastError = new Error(desc);
      if (attempt < maxRetries - 1) {
        await sleepFn(backoff(attempt));
        continue;
      }
    } else {
      throw new Error(desc);
    }
  }

  throw lastError ?? new Error('Token refresh failed after retries.');
}
