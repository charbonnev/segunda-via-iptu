import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createApp } from '../src/app.js';
import { calculationItems, calculationPdf } from './helpers/calculation-pdf.js';

test('formulário reutiliza sessão após recarregar, baixa PDF e permite sair', async t => {
  const pages = await calculationItems();
  pages[0].find(i => i.text === '000.000.0000-0').text = '000.000.0000-0';
  const pdf = await calculationPdf(pages);
  let logins = 0;
  let issues = 0;
  let open = true;
  const app = createApp({ authenticate: async input => {
    logins++;
    assert.deepEqual(input, { cpf: '12345678900', senha: 'teste-local' });
    return {
      isOpen: () => open,
      close: async () => { open = false; },
      issue: async input => {
        issues++;
        assert.deepEqual(input, { cadastro: '00000000000', exercicio: '2026' });
        return pdf;
      },
    };
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => app.locals.disposeSessions());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('CPF de acesso').fill('12345678900');
  await page.getByLabel('Senha Web', { exact: true }).fill('teste-local');
  await page.getByRole('button', { name: 'Gerar segunda via' }).click();
  await page.getByText('Documento gerado. Você já pode baixar a segunda via.', { exact: true }).waitFor();
  assert.equal(await page.locator('#senha').inputValue(), '');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /Baixar PDF/ }).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'iptu-00000000000-2026.pdf');
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), pdf);
  await page.getByRole('button', { name: /Ver dados em JSON/ }).click();
  await page.locator('#json-preview').waitFor({ state: 'visible' });
  const calculation = JSON.parse(await page.locator('#json-preview').textContent());
  assert.equal(calculation.demonstrativo_calculo.bases_calculo.construcao.area_m2, 80);
  assert.equal(calculation.demonstrativo_calculo.bases_calculo.terreno_nao_incorporado.area_m2, null);
  assert.equal(issues, 1);

  await page.reload();
  await page.getByRole('button', { name: 'Sair', exact: true }).waitFor();
  assert.equal(await page.locator('#credentials').isVisible(), false);
  await page.getByRole('button', { name: 'Gerar segunda via' }).click();
  await page.getByText('Documento gerado. Você já pode baixar a segunda via.', { exact: true }).waitFor();
  assert.equal(logins, 1);
  assert.equal(issues, 2);

  // A tela continua carregada quando o servidor cai: explica como reiniciar.
  await page.route('**/api/segunda-via', route => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Gerar segunda via' }).click();
  await page.getByText('O servidor local está indisponível. Inicie-o com npm start na pasta do projeto e tente novamente.', { exact: true }).waitFor();
  assert.equal(await page.locator('#senha').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Gerar segunda via' }).isEnabled(), true);
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await page.getByText('Sessão encerrada. Entre novamente para consultar.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Senha Web', { exact: true }).isVisible(), true);
  assert.equal(open, false);
});
