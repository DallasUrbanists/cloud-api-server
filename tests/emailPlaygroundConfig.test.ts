import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { renderEmailPlayground } from '../src/controllers/emailPlaygroundController.js';
import { descriptionSampleButtons, descriptionSampleDialog, descriptionSamplesScript } from '../src/utils/descriptionSamples.js';

async function render(baseUrl: string | undefined) {
  const previous = process.env.EMAIL_PLAYGROUND_API_BASE_URL;
  if (baseUrl === undefined) delete process.env.EMAIL_PLAYGROUND_API_BASE_URL;
  else process.env.EMAIL_PLAYGROUND_API_BASE_URL = baseUrl;
  let body = '', status = 200, type = '';
  const headers: Record<string, string> = {};
  const response = {
    setHeader(name: string, value: string) { headers[name] = value; },
    status(value: number) { status = value; return this; },
    type(value: string) { type = value; return this; },
    send(value: string) { body = value; return this; },
  };
  try {
    await renderEmailPlayground({} as any, response as any);
    return { body, status, type, headers };
  } finally {
    if (previous === undefined) delete process.env.EMAIL_PLAYGROUND_API_BASE_URL;
    else process.env.EMAIL_PLAYGROUND_API_BASE_URL = previous;
  }
}

test('email playground defaults to the production API without caching its configuration', async () => {
  const html = await readFile(new URL('../src/views/emailPlayground.html', import.meta.url), 'utf8');
  const expected = html
    .replace('<!-- DESCRIPTION_SAMPLE_BUTTONS -->', () => descriptionSampleButtons)
    .replace('<!-- DESCRIPTION_SAMPLE_DIALOG -->', () => descriptionSampleDialog)
    .replace('/* DESCRIPTION_SAMPLES_SCRIPT */', () => descriptionSamplesScript);
  for (const value of [undefined, '', '  ']) {
    const response = await render(value);
    assert.equal(response.status, 200);
    assert.equal(response.type, 'html');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.match(response.body, /const apiBaseUrl = "https:\/\/api\.dallasurbanists\.org\/";/);
    assert.equal(response.body, expected);
  }
});

test('email playground supports local origins, API prefixes and explicit same-origin mode', async () => {
  for (const [value, expected] of [
    ['http://localhost:8080', 'http://localhost:8080/'],
    [' https://example.org/gateway/// ', 'https://example.org/gateway/'],
    ['/', '/'],
  ]) {
    const response = await render(value);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('const apiBaseUrl = ' + JSON.stringify(expected) + ';'));
  }
});

test('invalid or credential-bearing API bases fail closed without exposing configuration', async () => {
  for (const value of ['javascript:alert(1)', 'file:///private', '//example.org', '/relative', 'https://user:secret@example.org/', 'https://example.org/?key=secret', 'https://example.org/#fragment', 'not a URL']) {
    const response = await render(value);
    assert.equal(response.status, 503, value);
    assert.equal(response.type, 'text');
    assert.equal(response.body, 'Email playground API base URL is not configured correctly.');
    assert.ok(!response.body.includes('secret'));
  }
});

test('unreadable playground view fails without exposing the file path', async t => {
  const original = new Error('internal file path');
  const read = t.mock.method(fs, 'readFile', async () => { throw original; });
  syncBuiltinESMExports();
  t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(render('/'), error => {
    assert.equal((error as Error).message, 'Email playground is unavailable.');
    assert.equal((error as Error).cause, original);
    return true;
  });
});
