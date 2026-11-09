import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/sessions.js';

test('cookie de sessão permite consultas sem credenciais e logout fecha o navegador', async t => {
  let logins = 0;
  let closed = 0;
  let issues = 0;
  const app = createApp({ authenticate: async credentials => {
    logins++;
    assert.deepEqual(credentials, { cpf: '12345678900', senha: 'exemplo' });
    return {
      isOpen: () => closed === 0,
      close: async () => { closed++; },
      issue: async query => {
        issues++;
        assert.equal('senha' in query, false);
        assert.equal('cpf' in query, false);
        return Buffer.from('%PDF-1.4 teste');
      },
    };
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => app.locals.disposeSessions());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/sessao`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cpf: '12345678900', senha: 'exemplo' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.doesNotMatch(setCookie, /Max-Age|12345678900|exemplo/);
  const cookie = setCookie.split(';')[0];
  for (const exercicio of [2025, 2026]) {
    const response = await fetch(`${base}/api/segunda-via`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ cadastro: '00000000000', exercicio }),
    });
    assert.equal(response.status, 200);
    const pdfUrl = response.headers.get('x-pdf-url');
    assert.equal((await fetch(`${base}${pdfUrl}`)).status, 404);
    assert.equal((await fetch(`${base}${pdfUrl}`, { headers: { Cookie: cookie } })).status, 200);
    await response.arrayBuffer();
  }
  assert.equal(logins, 1);
  assert.equal(issues, 2);
  const state = await fetch(`${base}/api/sessao`, { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(state.authenticated, true);
  assert.equal(typeof state.expiresAt, 'number');
  const otherBrowser = await fetch(`${base}/api/sessao`).then(r => r.json());
  assert.equal(otherBrowser.authenticated, false);
  assert.equal((await fetch(`${base}/api/sessao`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 204);
  assert.equal(closed, 1);
  assert.equal((await fetch(`${base}/api/sessao`, { headers: { Cookie: cookie } }).then(r => r.json())).authenticated, false);
  const expired = await fetch(`${base}/api/segunda-via`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ cadastro: '00000000000', exercicio: 2026 }),
  });
  assert.equal(expired.status, 401);
});

test('expiração por inatividade remove a sessão e fecha recursos', async () => {
  let closed = false;
  const store = new SessionStore({ ttlMs: 60000 });
  const entry = await store.add({ isOpen: () => true, close: async () => { closed = true; } });
  entry.expiresAt = Date.now() - 1;
  assert.equal(store.get(entry.id), undefined);
  assert.equal(closed, true);
  assert.equal(store.entries.size, 0);
});

test('expiração automática e limite de sessões não deixam navegadores órfãos', async () => {
  let closed = 0;
  const store = new SessionStore({ ttlMs: 20, max: 1 });
  await store.add({ isOpen: () => true, close: async () => { closed++; } });
  await assert.rejects(store.add({ close: async () => { closed++; } }), { status: 429 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closed, 2);
  assert.equal(store.entries.size, 0);
});
