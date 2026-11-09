import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import SwaggerParser from '@apidevtools/swagger-parser';
import { chromium } from 'playwright';
import { openapi } from '../src/openapi.js';
import { createApp } from '../src/app.js';

test('OpenAPI válido documenta todas as operações e o contrato JSON 3.0', async () => {
  const validated = await SwaggerParser.validate(structuredClone(openapi));
  const operations = Object.entries(validated.paths).flatMap(([path, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`));
  assert.deepEqual(operations.sort(), [
    'GET /api/sessao', 'POST /api/sessao', 'DELETE /api/sessao',
    'POST /api/segunda-via', 'POST /api/segunda-via/json', 'GET /api/health', 'GET /api/diagnostico.jpg',
    'GET /api/documentos/{id}/arquivo.pdf', 'GET /api/documentos/{id}/visualizar.pdf', 'GET /api/documentos/{id}/calculo.json',
  ].sort());
  assert.equal(validated.components.schemas.Credenciais.properties.senha.format, 'password');
  assert.equal(validated.components.schemas.Credenciais.properties.senha.writeOnly, true);
  assert.deepEqual(validated.components.schemas.Calculo.properties.schema_versao.enum, ['3.0']);
  assert.equal('fatores' in validated.components.schemas.BaseConstrucao.properties, false);
  assert.ok(validated.components.schemas.BaseConstrucao.properties.fator_obsolescencia);
  assert.equal(validated.components.schemas.BaseTerrenoIncorporado.properties.fator_profundidade.nullable, true);
});

async function docsServer(t) {
  const server = createApp({ authenticate: async () => assert.fail('Teste de docs não deve autenticar no portal') }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('documentação e assets são locais, com CSP específica e especificação exportável', async t => {
  const base = await docsServer(t);
  for (const path of ['/openapi.json', '/api/openapi.json']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), openapi);
  }
  const docs = await fetch(`${base}/docs`);
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
  assert.match(await docs.text(), /swagger-ui/);
  const main = await fetch(base);
  assert.doesNotMatch(main.headers.get('content-security-policy'), /unsafe-inline/);
  for (const path of ['/docs/assets/swagger-ui.css', '/docs/assets/swagger-ui-bundle.js', '/docs/init.js']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200);
  }
});

test('Swagger renderiza e executa health na mesma origem sem erros de script/CSP', async t => {
  const base = await docsServer(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(base)) externalRequests.push(request.url()); });
  await page.goto(`${base}/docs/`);
  await page.getByRole('heading', { name: /IPTU São Paulo/ }).waitFor();
  const health = page.locator('.opblock').filter({ has: page.locator('[data-path="/api/health"]') });
  await health.locator('.opblock-summary').click();
  await health.getByRole('button', { name: 'Try it out' }).click();
  const responsePromise = page.waitForResponse(`${base}/api/health`);
  await health.getByRole('button', { name: 'Execute', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.json(), { ok: true, busy: false });
  await health.locator('.live-responses-table').waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
});
