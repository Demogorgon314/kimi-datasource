/**
 * Token load / ensureFresh / save — compatible with Kimi Code credential files.
 *
 * Wire format (snake_case) matches ~/.kimi-code/credentials/kimi-code.json so
 * this MCP can share login state with Kimi Code CLI and refresh in-place.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  credentialsPath,
  defaultRefreshThreshold,
  oauthFlowConfig,
  oauthLockPath,
  resolveCredentialName,
  resolveKimiHome,
} from './config.mjs';
import { OAuthUnauthorizedError, refreshAccessToken } from './oauth-http.mjs';
import { buildDeviceHeaders } from './identity.mjs';
import { isNotFound, isRecord, nowUnix, sleep } from './util.mjs';

/** In-process refresh coalescer. */
let inFlightRefresh;

function classifyToken(wire) {
  if (wire === undefined) return { kind: 'missing' };
  const access = typeof wire.access_token === 'string' ? wire.access_token : '';
  if (access.length === 0) {
    return {
      kind: 'revoked',
      scope: typeof wire.scope === 'string' ? wire.scope : '',
      tokenType: typeof wire.token_type === 'string' ? wire.token_type : '',
    };
  }
  return { kind: 'valid', token: wire };
}

function revokedTombstone(prior) {
  return {
    access_token: '',
    refresh_token: '',
    expires_at: 0,
    scope: typeof prior.scope === 'string' ? prior.scope : '',
    token_type: typeof prior.token_type === 'string' ? prior.token_type : 'Bearer',
    expires_in: 0,
  };
}

export function loadTokenWire(filePath = credentialsPath()) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  return parsed;
}

export function saveTokenWire(wire, filePath = credentialsPath()) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }

  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const data = Buffer.from(`${JSON.stringify(wire, null, 2)}\n`, 'utf8');
  const fd = openSync(tmp, 'w', 0o600);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * Cross-process lock via exclusive sentinel + sibling `.lock` directory.
 * Best-effort; always re-read storage after acquire (same strategy as kimi-code oauth).
 */
async function acquireRefreshLock(kimiHome) {
  if (process.platform === 'win32') return async () => {};
  if (process.env.KIMI_DISABLE_OAUTH_LOCK === '1') return async () => {};

  const target = oauthLockPath(kimiHome);
  const lockDir = `${target}.lock`;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    try {
      writeFileSync(target, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      // peer may have created it
    }
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      return async () => {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if (!isRecord(err) || err.code !== 'EEXIST') {
        throw new Error(
          `Unable to acquire OAuth refresh lock for "${resolveCredentialName()}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await sleep(50 + Math.floor(Math.random() * 50));
    }
  }
  throw new Error(
    `Unable to acquire OAuth refresh lock for "${resolveCredentialName()}" within 15s`,
  );
}

function shouldRefresh(token, force) {
  if (force) return true;
  const expiresAt = typeof token.expires_at === 'number' ? token.expires_at : 0;
  if (expiresAt === 0) return false;
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 0;
  const remaining = expiresAt - nowUnix();
  return remaining < defaultRefreshThreshold(expiresIn);
}

function tokenChanged(a, b) {
  return (
    a.refresh_token !== b.refresh_token ||
    a.access_token !== b.access_token ||
    a.expires_at !== b.expires_at ||
    a.expires_in !== b.expires_in
  );
}

/**
 * Return a valid access_token, refreshing when within the dynamic threshold.
 * Writes refreshed tokens back to the shared Kimi Code credentials file.
 *
 * @returns {Promise<{ kimiHome: string, token: string, refreshed: boolean }>}
 */
export async function ensureFreshAccessToken(options = {}) {
  const force = options.force === true;
  if (inFlightRefresh !== undefined) {
    if (!force || inFlightRefresh.force) {
      return inFlightRefresh.promise;
    }
    return inFlightRefresh.promise.catch(() => undefined).then(() => ensureFreshAccessToken(options));
  }

  const promise = doEnsureFresh(force).finally(() => {
    if (inFlightRefresh?.promise === promise) {
      inFlightRefresh = undefined;
    }
  });
  inFlightRefresh = { promise, force };
  return promise;
}

async function doEnsureFresh(force) {
  const kimiHome = resolveKimiHome();
  const filePath = credentialsPath(kimiHome);
  const initial = classifyToken(loadTokenWire(filePath));

  switch (initial.kind) {
    case 'missing':
      throw new Error(
        `Kimi credentials not found: ${filePath}\n` +
          `Run \`kimi-datasource login\` or log in via Kimi Code (\`/login\`).`,
      );
    case 'revoked':
      throw new Error(
        `Stored token was rejected; re-login required.\n` +
          `Run \`kimi-datasource login\` or Kimi Code \`/login\`.`,
      );
    case 'valid':
      break;
  }

  let token = initial.token;
  if (!shouldRefresh(token, force)) {
    return { kimiHome, token: token.access_token, refreshed: false };
  }

  const release = await acquireRefreshLock(kimiHome);
  try {
    const afterLock = classifyToken(loadTokenWire(filePath));
    let active;
    switch (afterLock.kind) {
      case 'revoked':
        throw new Error(
          `Stored token was rejected; re-login required.\nRun \`kimi-datasource login\`.`,
        );
      case 'missing':
        active = token;
        break;
      case 'valid': {
        const after = afterLock.token;
        if (!shouldRefresh(after, force)) {
          return { kimiHome, token: after.access_token, refreshed: false };
        }
        if (force && tokenChanged(after, token)) {
          return { kimiHome, token: after.access_token, refreshed: false };
        }
        active = after;
        break;
      }
    }

    const refreshTok = typeof active.refresh_token === 'string' ? active.refresh_token : '';
    if (refreshTok.length === 0) {
      throw new Error(
        `Token has no refresh_token; re-login required.\nRun \`kimi-datasource login\`.`,
      );
    }

    try {
      const config = oauthFlowConfig();
      // storage name must match credential file stem; oauthFlowConfig.name does
      const refreshed = await refreshAccessToken(config, refreshTok, {
        deviceHeaders: await buildDeviceHeaders(kimiHome),
      });
      saveTokenWire(refreshed, filePath);
      return { kimiHome, token: refreshed.access_token, refreshed: true };
    } catch (error) {
      if (error instanceof OAuthUnauthorizedError) {
        await sleep(100);
        const recovery = classifyToken(loadTokenWire(filePath));
        if (
          recovery.kind === 'valid' &&
          recovery.token.refresh_token !== active.refresh_token
        ) {
          return { kimiHome, token: recovery.token.access_token, refreshed: true };
        }
        saveTokenWire(revokedTombstone(active), filePath);
        throw new Error(
          `Token refresh unauthorized: ${error.message}\nRun \`kimi-datasource login\` or Kimi Code \`/login\`.`,
        );
      }
      throw error;
    }
  } finally {
    await release();
  }
}

export function credentialsStatus() {
  const kimiHome = resolveKimiHome();
  const filePath = credentialsPath(kimiHome);
  const state = classifyToken(loadTokenWire(filePath));
  const now = nowUnix();
  if (state.kind === 'missing') {
    return { kind: 'missing', kimiHome, filePath, credentialName: resolveCredentialName() };
  }
  if (state.kind === 'revoked') {
    return { kind: 'revoked', kimiHome, filePath, credentialName: resolveCredentialName() };
  }
  const expiresAt = state.token.expires_at ?? 0;
  const remaining = expiresAt - now;
  return {
    kind: remaining > 0 ? 'valid' : 'expired',
    kimiHome,
    filePath,
    credentialName: resolveCredentialName(),
    expiresAt,
    expiresIn: state.token.expires_in,
    remainingSeconds: remaining,
    needsRefresh: shouldRefresh(state.token, false),
    hasRefreshToken: Boolean(state.token.refresh_token),
  };
}

export { resolveKimiHome, credentialsPath, resolveCredentialName };
