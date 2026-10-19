/**
 * Shared Kimi tools gateway client (auto ensureFresh + optional 401 retry).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureFreshAccessToken, loadTokenWire } from './auth.mjs';
import {
  KIMI_CODE_PLATFORM,
  REQUEST_TIMEOUT_MS,
  VERSION,
  credentialsPath,
  datasourceApiUrl,
} from './config.mjs';
import { buildDeviceHeaders } from './identity.mjs';
import { isRecord } from './util.mjs';

const API_URL = datasourceApiUrl();

/**
 * @param {string} method  e.g. get_data_source_desc | call_data_source_tool
 * @param {Record<string, unknown>} params
 * @param {{ platform?: string }} [options]
 * @returns {Promise<{
 *   response: unknown,
 *   text: string,
 *   fileWarnings: string[],
 *   writtenFiles: string[],
 *   trace: object
 * }>}
 */
export async function invokeTool(method, params, options = {}) {
  const trace = {};
  const response = await callKimiTool(method, params, trace, options);
  const { warnings: fileWarnings, writtenFiles } = await writeResponseFiles(
    response,
    expectedResponseFilePath(params),
  );
  const text = extractText(response);
  return {
    response,
    text: appendTrace(appendWarnings(text.trim(), fileWarnings), trace),
    fileWarnings,
    writtenFiles,
    trace,
  };
}

export async function getDataSourceDesc(name, options = {}) {
  return invokeTool('get_data_source_desc', { name }, options);
}

export async function callDataSourceTool(dataSourceName, apiName, params, options = {}) {
  return invokeTool(
    'call_data_source_tool',
    {
      data_source_name: dataSourceName,
      api_name: apiName,
      params,
    },
    options,
  );
}

async function callKimiTool(method, params, trace = {}, options = {}) {
  const platform = options.platform ?? KIMI_CODE_PLATFORM;
  const { kimiHome, token, refreshed } = await ensureFreshAccessToken();
  trace.refreshed = refreshed;
  const toolCallId = randomUUID();
  trace.toolCallId = toolCallId;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: await buildHeaders(kimiHome, token, toolCallId, platform),
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    });
    trace.requestId = extractRequestId(response.headers);
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401) {
        // Kimi Code may have rotated the shared credential during this request.
        // Reuse that token before attempting another OAuth refresh.
        const storedToken = loadTokenWire(credentialsPath(kimiHome))?.access_token;
        const hostRotated =
          typeof storedToken === 'string' && storedToken.length > 0 && storedToken !== token;
        const retry = await ensureFreshAccessToken({ force: !hostRotated });
        const retryId = randomUUID();
        trace.toolCallId = retryId;
        trace.refreshed = refreshed || retry.refreshed || hostRotated;
        const response2 = await fetch(API_URL, {
          method: 'POST',
          headers: await buildHeaders(retry.kimiHome, retry.token, retryId, platform),
          body: JSON.stringify({ method, params }),
          signal: controller.signal,
        });
        trace.requestId = extractRequestId(response2.headers);
        const text2 = await response2.text();
        if (!response2.ok) {
          throw new Error(`HTTP ${response2.status} error: ${text2}`);
        }
        try {
          return JSON.parse(text2);
        } catch {
          return text2;
        }
      }
      throw new Error(`HTTP ${response.status} error: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildHeaders(kimiHome, token, toolCallId, platform) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Msh-Tool-Call-Id': toolCallId,
    ...(await buildDeviceHeaders(kimiHome, platform)),
    'User-Agent': `kimi-datasource/${VERSION}`,
  };
}

async function writeResponseFiles(response, expectedOutputPath) {
  if (!isRecord(response) || !Array.isArray(response.files)) {
    return { warnings: [], writtenFiles: [] };
  }
  const warnings = [];
  const writtenFiles = [];

  for (const file of response.files) {
    if (!isRecord(file)) continue;
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    if (name.length === 0 || file.content === undefined || file.content === null) continue;

    const writePath = allowedResponseFilePath(name, expectedOutputPath);
    if (writePath === undefined) {
      warnings.push(
        `Warning: skipped returned file ${name} because it is outside the requested output path.`,
      );
      continue;
    }

    try {
      await mkdir(path.dirname(writePath), { recursive: true });
      if (file.encoding === 'base64') {
        await writeFile(writePath, Buffer.from(String(file.content), 'base64'));
      } else {
        await writeFile(writePath, String(file.content), 'utf8');
      }
      writtenFiles.push(writePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Warning: failed to write file ${writePath}: ${message}`);
    }
  }

  return { warnings, writtenFiles };
}

function expectedResponseFilePath(params) {
  return outputPathField(params) ?? (isRecord(params) ? outputPathField(params.params) : undefined);
}

function outputPathField(value) {
  if (!isRecord(value)) return undefined;
  for (const field of ['file_path', 'filepath']) {
    const pathValue = value[field];
    if (typeof pathValue !== 'string') continue;
    const trimmed = pathValue.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function allowedResponseFilePath(name, expectedOutputPath) {
  if (expectedOutputPath === undefined) return undefined;

  const actual = path.resolve(name);
  const expected = path.resolve(expectedOutputPath);
  if (actual === expected) return actual;

  const actualParts = path.parse(actual);
  const expectedParts = path.parse(expected);
  if (actualParts.dir !== expectedParts.dir) return undefined;
  if (actualParts.ext !== expectedParts.ext) return undefined;
  if (!actualParts.name.startsWith(`${expectedParts.name}_`)) return undefined;

  return actual;
}

function appendWarnings(text, warnings) {
  if (warnings.length === 0) return text;
  return `${text}\n\n${warnings.join('\n')}`;
}

function extractRequestId(headers) {
  for (const key of ['x-request-id', 'x-trace-id', 'x-msh-request-id', 'x-msh-trace-id', 'request-id']) {
    const value = headers.get(key);
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function appendTrace(text, trace) {
  if (trace === undefined || trace.toolCallId === undefined) return text;
  const parts = [];
  if (trace.requestId !== undefined) parts.push(`request-id: ${trace.requestId}`);
  if (trace.refreshed === true) parts.push('token: refreshed');
  parts.push(`tool-call-id: ${trace.toolCallId}`);
  return `${text}\n\n[kimi-datasource] ${parts.join(' · ')}`;
}

function extractText(response) {
  if (typeof response === 'string') return response;
  if (!isRecord(response)) return String(response);

  if (response.is_success === false) {
    const message = extractChannelText(response.error) ?? JSON.stringify(response);
    throw new Error(`Tool API returned an error: ${message}`);
  }

  const text = extractChannelText(response.result);
  if (text !== undefined) return text;
  return `Tool API succeeded but did not return user text. Raw response: ${JSON.stringify(response)}`;
}

function extractChannelText(value) {
  if (!isRecord(value)) return undefined;
  for (const channel of ['assistant', 'user']) {
    const items = value[channel];
    if (!Array.isArray(items)) continue;
    const text = items
      .filter((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}
