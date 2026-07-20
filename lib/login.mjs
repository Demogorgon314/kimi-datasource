/**
 * Device-code OAuth login (RFC 8628), writes the same credential file as Kimi Code.
 */

import {
  DEVICE_CODE_TIMEOUT_MS,
  oauthFlowConfig,
  resolveKimiHome,
  credentialsPath,
  resolveCredentialName,
  VERSION,
} from './config.mjs';
import {
  credentialsStatus,
  ensureFreshAccessToken,
  saveTokenWire,
} from './auth.mjs';
import { pollDeviceToken, requestDeviceAuthorization } from './oauth-http.mjs';
import { nowUnix, sleep } from './util.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildDeviceHeaders } from './identity.mjs';

async function deviceHeaders() {
  return buildDeviceHeaders(resolveKimiHome());
}

export async function runLogin() {
  const config = oauthFlowConfig();
  const kimiHome = resolveKimiHome();
  const filePath = credentialsPath(kimiHome);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const headers = await deviceHeaders();
  const startedAt = nowUnix();
  const deadlineAt = startedAt + Math.ceil(DEVICE_CODE_TIMEOUT_MS / 1000);

  console.log(`kimi-datasource login v${VERSION}`);
  console.log(`Credential: ${resolveCredentialName()}`);
  console.log(`Write path: ${filePath}`);
  console.log(`OAuth host: ${config.oauthHost}`);
  console.log('');

  while (true) {
    const auth = await requestDeviceAuthorization(config, { deviceHeaders: headers });
    console.log('Open this URL in a browser and approve access:');
    console.log(`  ${auth.verificationUriComplete}`);
    console.log('');
    console.log(`User code: ${auth.userCode}`);
    console.log('Waiting for authorization…');

    let currentInterval = Math.max(auth.interval, 1);
    let deviceExpired = false;

    while (true) {
      if (nowUnix() >= deadlineAt) {
        throw new Error(
          `Device authorization timed out after ${Math.ceil(DEVICE_CODE_TIMEOUT_MS / 1000)}s`,
        );
      }

      const result = await pollDeviceToken(config, auth.deviceCode, { deviceHeaders: headers });
      if (result.kind === 'success') {
        saveTokenWire(result.token, filePath);
        console.log('');
        console.log('Login successful.');
        console.log(`Access token expires at: ${new Date(result.token.expires_at * 1000).toISOString()}`);
        console.log(`Saved to: ${filePath}`);
        return result.token;
      }
      if (result.kind === 'denied') {
        throw new Error(
          `Authorization denied${result.description ? `: ${result.description}` : ''}`,
        );
      }
      if (result.kind === 'expired') {
        deviceExpired = true;
        console.log('Device code expired; requesting a new one…');
        break;
      }
      if (result.errorCode === 'slow_down') {
        currentInterval += 5;
      }
      await sleep(currentInterval * 1000);
    }

    if (!deviceExpired) break;
    if (nowUnix() >= deadlineAt) {
      throw new Error('Device authorization timed out');
    }
  }

  throw new Error('Device flow ended unexpectedly');
}

export async function runStatus() {
  const status = credentialsStatus();
  console.log(`kimi-datasource status v${VERSION}`);
  console.log(`kind:            ${status.kind}`);
  console.log(`credential:      ${status.credentialName}`);
  console.log(`file:            ${status.filePath}`);
  if (status.kind === 'valid' || status.kind === 'expired') {
    console.log(
      `expires_at:      ${status.expiresAt} (${new Date(status.expiresAt * 1000).toISOString()})`,
    );
    console.log(`remaining_s:     ${status.remainingSeconds}`);
    console.log(`needs_refresh:   ${status.needsRefresh}`);
    console.log(`has_refresh:     ${status.hasRefreshToken}`);
  }
  if (
    (status.kind === 'valid' || status.kind === 'expired') &&
    status.hasRefreshToken &&
    (status.needsRefresh || status.kind === 'expired')
  ) {
    console.log('');
    console.log('Refreshing…');
    const result = await ensureFreshAccessToken();
    console.log(`refreshed:       ${result.refreshed}`);
    const after = credentialsStatus();
    if (after.kind === 'valid' || after.kind === 'expired') {
      console.log(
        `expires_at:      ${after.expiresAt} (${new Date(after.expiresAt * 1000).toISOString()})`,
      );
      console.log(`remaining_s:     ${after.remainingSeconds}`);
    }
    return after;
  }
  return status;
}

export async function runRefresh() {
  const result = await ensureFreshAccessToken({ force: true });
  console.log(`refreshed: ${result.refreshed}`);
  console.log(`token_len: ${result.token.length}`);
  const status = credentialsStatus();
  if (status.kind === 'valid' || status.kind === 'expired') {
    console.log(
      `expires_at: ${new Date(status.expiresAt * 1000).toISOString()} (remaining ${status.remainingSeconds}s)`,
    );
  }
  return result;
}
