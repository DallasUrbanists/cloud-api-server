import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderStreetmixPlayground } from '../src/controllers/streetmixPlaygroundController.js';

function setting(t: any, name: string, value?: string) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

function render(t: any, provider = 'recaptcha-v3', production = true) {
  for (const [name, value] of Object.entries({ NODE_ENV: production ? 'production' : 'development',
    FIREBASE_WEB_API_KEY: 'test-web-key', FIREBASE_APP_ID: 'test-app-id', FIREBASE_PROJECT_ID: 'test-project', FIREBASE_RECAPTCHA_SITE_KEY: 'test-site-key', FIREBASE_APPCHECK_PROVIDER: provider,
    FIREBASE_APPCHECK_DEBUG_TOKEN: 'private-debug-token', API_KEYS_JSON: '[{"key":"private-application-key"}]',
  })) setting(t, name, value);
  return html();
}

function html() {
  let output = '';
  renderStreetmixPlayground({} as any, { set() {}, type() { return this; }, send(value: string) { output = value; } } as any);
  return output;
}

function browser(page: string, options: { cdnFailure?: boolean; tokenFailure?: boolean; noToken?: boolean; pendingToken?: boolean } = {}) {
  const elements = new Map<string, any>();
  const el = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '',
      reportValidity: () => true, closest() { return this; }, focus() {}, replaceChildren() {}, append() {}, addEventListener() {},
    });
    return elements.get(id);
  };
  el('coordinates').value = '32.78014, -96.79701';
  const assets: string[] = [], requests: any[] = [], activations: any[] = [], apps: any[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0, tokenCalls = 0;
  const appCheck = Object.assign(() => ({
    activate(provider: any, refresh: boolean) { activations.push({ provider, refresh }); },
    async getToken(force: boolean) {
      assert.equal(force, false); tokenCalls++;
      if (options.pendingToken) return new Promise(() => {});
      if (options.tokenFailure) throw new Error('secret provider error');
      return { token: options.noToken ? '' : `automatic-token-${tokenCalls}` };
    },
  }), { ReCaptchaV3Provider: class { kind = 'v3'; constructor(public siteKey: string) {} },
    ReCaptchaEnterpriseProvider: class { kind = 'enterprise'; constructor(public siteKey: string) {} },
  });
  const firebase = { apps, initializeApp(config: any, name: string) { const app = { config, name }; apps.push(app); return app; } } as any;
  const window: any = {};
  const context: any = { window, URL, Date, AbortSignal, crypto: { randomUUID: () => 'same-request-key-12345' },
    document: { getElementById: el, createElement: () => ({ remove() {} }), head: { appendChild(script: any) {
      assets.push(script.src);
      queueMicrotask(() => {
        if (options.cdnFailure) return script.onerror();
        if (script.src.endsWith('firebase-app-compat.js')) window.firebase = firebase;
        else firebase.appCheck = appCheck;
        script.onload();
      });
    } } },
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id: number) { timers.delete(id); },
    setInterval: () => 1, clearInterval() {}, navigator: {},
    async fetch(url: string, init: any) { requests.push({ url, ...init }); return new Response('{"error":"SOURCE_UNAVAILABLE","message":"Try again"}', { status: 502 }); },
  };
  new Script(page.match(/<script>([\s\S]+)<\/script>/)![1]).runInNewContext(context);
  return { context, el, assets, requests, activations, apps, options, tokenCalls: () => tokenCalls,
    expire() { for (const callback of [...timers.values()]) callback(); },
  };
}

for (const [provider, kind] of [['recaptcha-v3', 'v3'], ['recaptcha-enterprise', 'enterprise']]) {
  test(`Streetmix automatically acquires ${kind} tokens and reacquires on same-key retries`, async t => {
    const page = render(t, provider);
    assert.ok(!page.includes('private-debug-token')); assert.ok(!page.includes('private-application-key'));
    assert.ok(!page.includes('id="app-check"'));
    const b = browser(page);
    assert.equal(b.assets.length, 0); // No verification work until the user submits.
    await b.context.run(false);
    assert.equal(b.assets.length, 2); assert.equal(b.activations.length, 1);
    assert.equal(b.activations[0].provider.kind, kind); assert.equal(b.activations[0].provider.siteKey, 'test-site-key');
    assert.equal(b.activations[0].refresh, true);
    assert.equal(b.requests[0].url, '/api/streetmix/playground/designs');
    assert.equal(b.requests[0].headers['X-Firebase-AppCheck'], 'automatic-token-1');
    assert.equal(b.requests[0].headers['X-API-Key'], undefined);
    await b.context.run(true);
    assert.equal(b.tokenCalls(), 2); assert.equal(b.assets.length, 2); assert.equal(b.apps.length, 1);
    assert.equal(b.requests[1].headers['X-Firebase-AppCheck'], 'automatic-token-2');
    assert.equal(b.requests[1].headers['Idempotency-Key'], b.requests[0].headers['Idempotency-Key']);
    assert.equal(b.requests[1].body, b.requests[0].body);
    assert.equal(b.el('generate').disabled, false);
  });
}

test('Streetmix verification failures never submit a generation request and can retry', async t => {
  const page = render(t);
  for (const options of [{ cdnFailure: true }, { tokenFailure: true }, { noToken: true }]) {
    const b = browser(page, options);
    await b.context.run(false);
    assert.equal(b.requests.length, 0);
    assert.match(b.el('status').textContent, /Browser verification could not complete/);
    assert.ok(!b.el('status').textContent.includes('secret'));
    assert.equal(b.el('retry').hidden, false); assert.equal(b.el('generate').disabled, false);
    b.options.cdnFailure = b.options.tokenFailure = b.options.noToken = false;
    await b.context.run(true);
    assert.equal(b.requests.length, 1);
  }
});

test('Streetmix bounds browser verification and blocks duplicate submissions while pending', async t => {
  const b = browser(render(t), { pendingToken: true });
  const pending = b.context.run(false);
  assert.equal(b.el('generate').disabled, true);
  await b.context.run(false);
  b.expire();
  await pending;
  assert.equal(b.requests.length, 0); assert.equal(b.el('generate').disabled, false);
  assert.match(b.el('status').textContent, /Browser verification could not complete/);
});

test('Streetmix uses VITE settings as fallback and omits dev debug configuration in production', async t => {
  render(t);
  for (const name of ['FIREBASE_WEB_API_KEY', 'FIREBASE_APP_ID', 'FIREBASE_RECAPTCHA_SITE_KEY', 'FIREBASE_APPCHECK_PROVIDER']) setting(t, name);
  setting(t, 'VITE_FIREBASE_API_KEY', 'vite-web-key'); setting(t, 'VITE_FIREBASE_APP_ID', 'vite-app-id');
  setting(t, 'VITE_RECAPTCHA_SITE_KEY', 'vite-site-key'); setting(t, 'VITE_FIREBASE_APPCHECK_PROVIDER', 'recaptcha-enterprise');
  const page = html(); assert.ok(!page.includes('private-debug-token'));
  const b = browser(page); await b.context.run(false);
  assert.equal(b.activations[0].provider.kind, 'enterprise');
  assert.equal(b.apps[0].config.apiKey, 'vite-web-key'); assert.equal(b.apps[0].config.appId, 'vite-app-id');
  assert.equal(b.activations[0].provider.siteKey, 'vite-site-key');
});

test('Streetmix requires production config, accepts unconfigured local development, and escapes HTML delimiters', async t => {
  render(t);
  setting(t, 'FIREBASE_WEB_API_KEY', ''); setting(t, 'VITE_FIREBASE_API_KEY', '');
  const missing = browser(html()); await missing.context.run(false);
  assert.equal(missing.requests.length, 0);
  setting(t, 'NODE_ENV', 'development');
  const local = browser(html()); await local.context.run(false);
  assert.equal(local.requests.length, 1); assert.equal(local.requests[0].headers['X-Firebase-AppCheck'], undefined);
  setting(t, 'FIREBASE_WEB_API_KEY', '</script><script>unsafe</script>');
  assert.ok(!html().includes('</script><script>unsafe'));
  const debug = browser(html()); await debug.context.run(false);
  assert.equal(debug.context.window.FIREBASE_APPCHECK_DEBUG_TOKEN, 'private-debug-token');
});

test('Streetmix rejects an invalid provider before SDK loading or submission', async t => {
  const b = browser(render(t, 'invalid-provider')); await b.context.run(false);
  assert.equal(b.assets.length, 0); assert.equal(b.requests.length, 0);
});

test('Streetmix coordinate input accepts either Texas order and submits normalized numeric coordinates', async t => {
  const b = browser(render(t));
  for (const text of ['32.78014, -96.79701', ' -96.79701 , 32.78014 ']) {
    b.el('coordinates').value = text;
    await b.context.run(false);
    assert.deepEqual(JSON.parse(b.requests.at(-1).body), { latitude: 32.78014, longitude: -96.79701 });
  }
  assert.equal(b.requests.length, 2);
  for (const text of ['', '32.7', '32.7 -96.7', '32.7, -96.7, 1', '32.7,', 'word, -96.7', '0x20, -96.7', '32.7, -118', 'NaN, -96.7', 'Infinity, 32', '0,0']) {
    b.el('coordinates').value = text;
    await b.context.run(false);
    assert.equal(b.requests.length, 2, text);
    assert.equal(b.el('status').className, 'error');
  }
});
