import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveTokenWire } from '../lib/auth.mjs';
import {
  callDataSourceTool,
  getDataSourceDesc,
  invokeTool,
} from '../lib/client.mjs';
import { credentialsPath } from '../lib/config.mjs';

const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;
const temporaryDirectories = [];

afterEach(async () => {
  process.env = { ...originalEnvironment };
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function useTemporaryCredentials(token = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-client-test-'));
  temporaryDirectories.push(directory);
  process.env.KIMI_CODE_HOME = directory;
  delete process.env.KIMI_CODE_BASE_URL;
  delete process.env.KIMI_CODE_OAUTH_HOST;
  delete process.env.KIMI_OAUTH_HOST;
  saveTokenWire(
    {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
      expires_in: 3_600,
      ...token,
    },
    credentialsPath(),
  );
  return directory;
}

function toolResponse(text, files = []) {
  return {
    is_success: true,
    result: {
      assistant: [{ type: 'text', text }],
    },
    files,
  };
}

describe('Kimi tools gateway client', () => {
  test('calls a data source and writes only allowed returned files', async () => {
    const directory = await useTemporaryCredentials();
    const outputPath = path.join(directory, 'result.csv');
    const splitPath = path.join(directory, 'result_a.csv');
    const unsafePath = path.join(directory, 'other.csv');
    globalThis.fetch = async (_url, init) => {
      expect(init.headers['X-Msh-Platform']).toBe('kimi_code_cli');
      expect(init.headers.Authorization).toBe('Bearer access-token');
      return new Response(
        JSON.stringify(
          toolResponse('saved', [
            { name: outputPath, content: 'a,b\n1,2\n' },
            { name: splitPath, content: 'a,b\n3,4\n' },
            { name: unsafePath, content: 'unsafe' },
          ]),
        ),
        { status: 200, headers: { 'x-request-id': 'request-1' } },
      );
    };

    const result = await callDataSourceTool('arxiv', 'search_papers', {
      query: 'RAG',
      file_path: outputPath,
    });

    expect(result.text).toContain('saved');
    expect(result.text).toContain('skipped returned file');
    expect(result.text).toContain('request-id: request-1');
    expect(result.writtenFiles).toEqual([outputPath, splitPath]);
    expect(await readFile(outputPath, 'utf8')).toBe('a,b\n1,2\n');
    expect(await readFile(splitPath, 'utf8')).toBe('a,b\n3,4\n');
  });

  test('supports descriptions and plain-text gateway responses', async () => {
    await useTemporaryCredentials();
    globalThis.fetch = async () => new Response('plain response', { status: 200 });

    const result = await getDataSourceDesc('arxiv');

    expect(result.text).toContain('plain response');
    expect(result.writtenFiles).toEqual([]);
  });

  test('surfaces tool-level and HTTP errors', async () => {
    await useTemporaryCredentials();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          is_success: false,
          error: { assistant: [{ type: 'text', text: 'bad parameters' }] },
        }),
        { status: 200 },
      );
    await expect(getDataSourceDesc('arxiv')).rejects.toThrow(
      'Tool API returned an error: bad parameters',
    );

    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    await expect(getDataSourceDesc('arxiv')).rejects.toThrow('HTTP 503 error: unavailable');
  });

  test('refreshes once and retries a rejected gateway request', async () => {
    await useTemporaryCredentials();
    let gatewayCalls = 0;
    let refreshCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/oauth/token')) {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            expires_in: 3_600,
          }),
          { status: 200 },
        );
      }
      gatewayCalls += 1;
      if (gatewayCalls === 1) return new Response('expired', { status: 401 });
      return new Response(JSON.stringify(toolResponse('retried')), { status: 200 });
    };

    const result = await invokeTool('get_data_source_desc', { name: 'arxiv' });

    expect(result.text).toContain('retried');
    expect(result.trace.refreshed).toBeTrue();
    expect(gatewayCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  test('reuses a host-rotated credential without issuing another OAuth refresh', async () => {
    await useTemporaryCredentials();
    const sentTokens = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/api/oauth/token')) {
        throw new Error('The host already refreshed the shared credential');
      }
      sentTokens.push(init.headers.Authorization);
      if (sentTokens.length === 1) {
        saveTokenWire({
          access_token: 'host-access',
          refresh_token: 'host-refresh',
          expires_at: Math.floor(Date.now() / 1000) + 3_600,
          expires_in: 3_600,
        });
        return new Response('rotated by host', { status: 401 });
      }
      return new Response(JSON.stringify(toolResponse('recovered')), {
        status: 200,
        headers: { 'x-request-id': 'retry-request' },
      });
    };

    const result = await getDataSourceDesc('wind');

    expect(sentTokens).toEqual(['Bearer access-token', 'Bearer host-access']);
    expect(result.text).toContain('recovered');
    expect(result.trace).toMatchObject({ refreshed: true, requestId: 'retry-request' });
  });

  test('stops after one gateway retry when the replacement credential is also rejected', async () => {
    await useTemporaryCredentials();
    let gatewayCalls = 0;
    let refreshCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/api/oauth/token')) {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          access_token: 'replacement-access',
          refresh_token: 'replacement-refresh',
          expires_in: 3_600,
        }), { status: 200 });
      }
      gatewayCalls += 1;
      expect(init.headers.Authorization).toBe(
        gatewayCalls === 1 ? 'Bearer access-token' : 'Bearer replacement-access',
      );
      return new Response('rejected', { status: 401 });
    };

    await expect(getDataSourceDesc('wind')).rejects.toThrow('HTTP 401 error: rejected');
    expect(gatewayCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  test('returns a useful fallback for unexpected successful payloads', async () => {
    await useTemporaryCredentials();
    globalThis.fetch = async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 });

    const result = await getDataSourceDesc('arxiv');

    expect(result.text).toContain('did not return user text');
  });
});
