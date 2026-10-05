import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createApp } from '../src/app.js';

let server: Server;
let base: string;
const settings = ['FIREBASE_WEB_API_KEY', 'FIREBASE_RECAPTCHA_SITE_KEY', 'FIREBASE_APPCHECK_PROVIDER', 'VITE_FIREBASE_APPCHECK_PROVIDER', 'FIREBASE_APPCHECK_DEBUG_TOKEN', 'NODE_ENV'] as const;
const original = new Map(settings.map(key => [key, process.env[key]]));

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function browser(provider?: string, fallback?: string) {
  process.env.FIREBASE_WEB_API_KEY = 'test-web-key';
  process.env.FIREBASE_RECAPTCHA_SITE_KEY = 'test-site-key';
  process.env.NODE_ENV = 'production';
  process.env.FIREBASE_APPCHECK_DEBUG_TOKEN = 'private-debug-token';
  delete process.env.FIREBASE_APPCHECK_PROVIDER;
  delete process.env.VITE_FIREBASE_APPCHECK_PROVIDER;
  if (provider !== undefined) process.env.FIREBASE_APPCHECK_PROVIDER = provider;
  if (fallback !== undefined) process.env.VITE_FIREBASE_APPCHECK_PROVIDER = fallback;
  const response = await fetch(`${base}/swagger-theme.js`);
  assert.equal(response.status, 200);
  const script = await response.text();
  assert.ok(!script.includes('private-debug-token'));
  const activations: Array<{ provider: { kind: string; siteKey: string }; refresh: boolean }> = [];
  const warnings: unknown[][] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let tokenCalls = 0;
  const appCheck = Object.assign(() => ({
    activate(provider: { kind: string; siteKey: string }, refresh: boolean) { activations.push({ provider, refresh }); },
    async getToken() { tokenCalls++; return { token: 'test-app-check-token' }; },
  }), {
    ReCaptchaV3Provider: class { kind = 'v3'; constructor(public siteKey: string) {} },
    ReCaptchaEnterpriseProvider: class { kind = 'enterprise'; constructor(public siteKey: string) {} },
  });
  const firebase = { apps: [] as unknown[], initializeApp() { this.apps.push({}); }, appCheck };
  const window = {
    location: { href: 'https://api.example.com/docs/', origin: 'https://api.example.com' },
    async fetch(input: string, init?: RequestInit) { requests.push({ url: input, init }); return new Response(); },
  };
  runInNewContext(script, {
    window, firebase, URL, Headers, Request, Promise,
    console: { warn(...args: unknown[]) { warnings.push(args); } },
    localStorage: { getItem() { return null; } },
    document: {
      createElement() { return {}; },
      head: { appendChild(script: { onload: () => void }) { queueMicrotask(script.onload); } },
      documentElement: { setAttribute() {} }, body: { setAttribute() {} },
      getElementById() { return null; }, querySelector() { return null; },
      readyState: 'loading', addEventListener() {},
    },
    setTimeout() { return 1; }, setInterval() { return 1; }, clearInterval() {},
  });
  await window.fetch('https://api.example.com/api/contacts', { headers: { 'X-API-Key': 'server-key' } });
  return { activations, warnings, requests, window, tokenCalls: () => tokenCalls };
}

for (const [setting, expected] of [[undefined, 'v3'], ['recaptcha-v3', 'v3'], ['recaptcha-enterprise', 'enterprise']] as const) {
  test(`Swagger activates ${expected} for ${setting ?? 'default'} and attaches App Check only to same-origin API requests`, async () => {
    const result = await browser(setting);
    assert.equal(result.activations.length, 1);
    assert.equal(result.activations[0].provider.kind, expected);
    assert.equal(result.activations[0].provider.siteKey, 'test-site-key');
    assert.equal(result.activations[0].refresh, true);
    assert.equal(result.warnings.length, 0);
    const headers = new Headers(result.requests[0].init?.headers);
    assert.equal(headers.get('X-Firebase-AppCheck'), 'test-app-check-token');
    assert.equal(headers.get('X-API-Key'), 'server-key');
    await result.window.fetch('https://firebaseappcheck.googleapis.com/token');
    await result.window.fetch('https://api.example.com/docs/');
    assert.equal(result.tokenCalls(), 1);
    assert.equal(result.requests[1].init, undefined);
    assert.equal(result.requests[2].init, undefined);
  });
}

test('Swagger supports VITE provider fallback and prefers the server setting', async () => {
  assert.equal((await browser(undefined, 'recaptcha-enterprise')).activations[0].provider.kind, 'enterprise');
  assert.equal((await browser('recaptcha-v3', 'recaptcha-enterprise')).activations[0].provider.kind, 'v3');
});

test('Swagger reports an invalid provider instead of activating the wrong provider', async () => {
  const result = await browser('invalid-provider');
  assert.equal(result.activations.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(String(result.warnings[0][1]), /FIREBASE_APPCHECK_PROVIDER/);
});
