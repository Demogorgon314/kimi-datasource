import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, hostname, release, type } from 'node:os';
import path from 'node:path';

import { KIMI_CODE_PLATFORM, VERSION } from './config.mjs';
import { asciiHeader } from './util.mjs';

export async function createDeviceId(kimiHome) {
  const deviceIdPath = path.join(kimiHome, 'device_id');
  try {
    const existing = (await readFile(deviceIdPath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Fall through to create a best-effort local device id.
  }

  const id = randomUUID();
  try {
    await mkdir(kimiHome, { recursive: true, mode: 0o700 });
    await writeFile(deviceIdPath, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Requests can still use the in-memory id.
  }
  return id;
}

export async function buildDeviceHeaders(kimiHome, platform = KIMI_CODE_PLATFORM) {
  return {
    'X-Msh-Platform': asciiHeader(process.env.KIMI_MSH_PLATFORM ?? platform),
    'X-Msh-Version': asciiHeader(process.env.KIMI_MSH_VERSION ?? VERSION),
    'X-Msh-Device-Name': asciiHeader(process.env.KIMI_MSH_DEVICE_NAME ?? hostname()),
    'X-Msh-Device-Model': asciiHeader(process.env.KIMI_MSH_DEVICE_MODEL ?? deviceModel()),
    'X-Msh-Os-Version': asciiHeader(process.env.KIMI_MSH_OS_VERSION ?? release()),
    'X-Msh-Device-Id': asciiHeader(
      process.env.KIMI_MSH_DEVICE_ID ?? (await createDeviceId(kimiHome)),
    ),
  };
}

function deviceModel() {
  const os = type();
  const osVersion = release();
  const osArch = arch();
  if (os === 'Darwin') return `macOS ${osVersion} ${osArch}`;
  if (os === 'Windows_NT') return `Windows ${osVersion} ${osArch}`;
  return `${os} ${osVersion} ${osArch}`.trim();
}
