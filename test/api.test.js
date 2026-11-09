import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { AppError } from '../src/errors.js';

const input = { cpf: '123.456.789-00', senha: 'senha-ficticia', cadastro: '000 000 0000 0', exercicio: 2026 };
const pdf = Buffer.from('%PDF-1.4\nfixture\n%%EOF');

async function withApp(t, generate) {
  const server = createApp({ generate }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, post: (body = input, headers = {}) => fetch(`${base}/api/segunda-via`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }) };
}

test('entrega PDF, normaliza os dados e não permite cache', async t => {
  const { post } = await withApp(t, async data => {
    assert.deepEqual(data, { cpf: '12345678900', senha: 'senha-ficticia', cadastro: '00000000000', exercicio: '2026' });
    return pdf;
  });
  const response = await post();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.match(response.headers.get('content-disposition'), /iptu-00000000000-2026.pdf/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  assert.match(response.headers.get('x-pdf-url'), /^\/api\/documentos\/[a-f0-9-]+\/arquivo.pdf$/);
});

test('PDF tem URL HTTP temporária para download e visualização', async t => {
  const { base, post } = await withApp(t, async () => pdf);
  const response = await post();
  const url = response.headers.get('x-pdf-url');
  const preview = response.headers.get('x-pdf-preview-url');
  const file = await fetch(`${base}${url}`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
  assert.match((await fetch(`${base}${preview}`)).headers.get('content-disposition'), /^inline/);
  await post();
  assert.equal((await fetch(`${base}${url}`)).status, 404);
});

test('rejeita dados inválidos antes de abrir navegador', async t => {
  let calls = 0;
  const { post } = await withApp(t, async () => { calls++; return pdf; });
  for (const invalid of [null, [], { ...input, cpf: '123' }, { ...input, senha: '' },
    { ...input, cadastro: '1151680005x1' }, { ...input, exercicio: 2026.1 }, { ...input, exercicio: 0 }]) {
    assert.equal((await post(invalid)).status, 400);
  }
  assert.equal(calls, 0);
});

test('recusa sites externos e DNS rebinding por Host', async t => {
  const { post, base } = await withApp(t, async () => assert.fail('Não deve emitir'));
  assert.equal((await post(input, { Origin: 'https://externo.example' })).status, 403);
  // fetch/undici pode substituir o Host; usa HTTP nativo para enviar o valor exato.
  const status = await new Promise((resolve, reject) => {
    http.get(base, { headers: { Host: 'externo.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('retorna JSON seguro para falhas e libera a vaga', async t => {
  let calls = 0;
  const { post } = await withApp(t, async () => {
    calls++;
    if (calls === 1) throw new Error('URL com senha-ficticia e token-secreto');
    if (calls === 2) throw new AppError(401, 'LOGIN_RECUSADO', 'Acesso recusado.');
    return pdf;
  });
  const first = await post();
  assert.equal(first.status, 500);
  assert.doesNotMatch(await first.text(), /senha-ficticia|token-secreto/);
  assert.equal((await post()).status, 401);
  assert.equal((await post()).status, 200);
});

test('impede emissões simultâneas sem bloquear o healthcheck', async t => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { post, base } = await withApp(t, async () => {
    started();
    await new Promise(resolve => { release = resolve; });
    return pdf;
  });
  const first = post();
  await ready;
  try {
    assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).busy, true);
    const second = await post();
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '10');
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).busy, false);
});

test('cancelamento do cliente aborta o trabalho e libera a vaga', async t => {
  let started;
  let aborted;
  const ready = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const { base } = await withApp(t, async (data, { signal }) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted(); reject(new AppError(499, 'CANCELADA', 'Cancelada.'));
    }, { once: true }));
  });
  const controller = new AbortController();
  const request = fetch(`${base}/api/segunda-via`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal,
  }).catch(error => error);
  await ready;
  controller.abort();
  await cancelled;
  assert.equal((await request).name, 'AbortError');
  assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).busy, false);
});

test('trata JSON malformado e requisições grandes', async t => {
  const { base } = await withApp(t, async () => assert.fail());
  for (const [body, expected] of [['{', 400], [JSON.stringify({ text: 'x'.repeat(9000) }), 413]]) {
    const result = await fetch(`${base}/api/segunda-via`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(result.status, expected);
  }
});

test('disponibiliza diagnóstico em memória e limpa na emissão seguinte', async t => {
  const screenshot = Buffer.from('jpeg-de-teste');
  let calls = 0;
  const { base, post } = await withApp(t, async (input, { onDiagnostic }) => {
    if (++calls === 1) {
      onDiagnostic({ stage: 'enviar_consulta', screenshot });
      throw new AppError(504, 'PORTAL_TIMEOUT', 'Tempo limite.');
    }
    return pdf;
  });
  assert.equal((await fetch(`${base}/api/diagnostico.jpg`)).status, 404);
  assert.equal((await post()).status, 504);
  const diagnostic = await fetch(`${base}/api/diagnostico.jpg`);
  assert.equal(diagnostic.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await diagnostic.arrayBuffer()), screenshot);
  assert.equal((await post()).status, 200);
  assert.equal((await fetch(`${base}/api/diagnostico.jpg`)).status, 404);
});
