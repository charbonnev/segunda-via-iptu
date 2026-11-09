import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { extractCalculation, parseCalculationPages, parseBrazilianNumber } from '../src/calculo.js';
import { createApp } from '../src/app.js';
import { calculationItems, calculationPdf } from './helpers/calculation-pdf.js';

const expected = JSON.parse(await readFile(new URL('../examples/calculo.json', import.meta.url), 'utf8'));

test('inclui dados cadastrais e agrupa as bases por linha do PDF', async () => {
  assert.deepEqual(parseCalculationPages(await calculationItems()), expected);
  assert.deepEqual(await extractCalculation(await calculationPdf()), expected);
});

test('dados cadastrais preservam unidades, texto e zero separado de células vazias do cálculo', async () => {
  const result = parseCalculationPages(await calculationItems());
  assert.equal(result.schema_versao, '3.0');
  assert.deepEqual(result.dados_cadastrais, {
    terreno: { area_incorporada_m2: 400, area_nao_incorporada_m2: 0, area_total_m2: 400, testada_m: 10 },
    construcao: { area_construida_m2: 80, area_ocupada_pela_construcao_m2: 80, ano_construcao_corrigido: 1978, padrao_construcao: '1-A', uso: 'residência' },
  });
  const bases = result.demonstrativo_calculo.bases_calculo;
  assert.deepEqual(Object.keys(bases), ['construcao', 'terreno_incorporado', 'terreno_nao_incorporado']);
  assert.deepEqual(bases.construcao, { area_m2: 80, valor_m2_reais: 1499, fator_obsolescencia: 0.2, base_calculo_reais: 23984, fator_especial: 1, referencia_pdf: 'A' });
  for (const line of Object.values(bases)) assert.equal('fatores' in line, false);
  assert.deepEqual(Object.keys(bases.terreno_incorporado).filter(key => key.startsWith('fator_')), ['fator_profundidade', 'fator_tipo_terreno', 'fator_condominio', 'fator_fracao_ideal', 'fator_especial']);
  assert.equal(bases.terreno_nao_incorporado.area_m2, null);
});

test('campos cadastrais vazios não pegam números da linha seguinte e uso permite texto composto', async () => {
  const pages = await calculationItems();
  const label = pages[0].find(i => i.text === 'Área construída (m²):');
  pages[0] = pages[0].filter(i => !(i.text === '80' && Math.abs(i.y - label.y) < 2 && i.x > label.x));
  const usage = pages[0].find(i => i.text === 'residência');
  pages[0].push({ text: 'multifamiliar', x: usage.x + 60, y: usage.y });
  const result = parseCalculationPages(pages);
  assert.equal(result.dados_cadastrais.construcao.area_construida_m2, null);
  assert.equal(result.dados_cadastrais.construcao.area_ocupada_pela_construcao_m2, 80);
  assert.equal(result.dados_cadastrais.construcao.uso, 'residência multifamiliar');
});

test('recusa rótulo cadastral ausente e ano não inteiro', async () => {
  const missing = await calculationItems();
  missing[0] = missing[0].filter(i => i.text !== 'Testada (m):');
  assert.throws(() => parseCalculationPages(missing), { code: 'PDF_LAYOUT_NAO_RECONHECIDO' });
  const invalidYear = await calculationItems();
  invalidYear[0].find(i => i.text === '1978').text = '1978,5';
  assert.throws(() => parseCalculationPages(invalidYear), { code: 'PDF_LAYOUT_NAO_RECONHECIDO' });
});

test('preserva vazios, zero, negativos e datas sem depender da ordem dos tokens', async () => {
  const pages = await calculationItems();
  pages[0].reverse();
  const result = parseCalculationPages(pages).demonstrativo_calculo;
  assert.equal(result.bases_calculo.terreno_nao_incorporado.area_m2, null);
  assert.equal(result.imposto_territorial.base_calculo_reais, null);
  assert.equal(result.imposto_territorial.imposto_a_pagar_reais, 0);
  assert.equal(result.imposto_predial.deducoes_acrescimos_reais, -1150.9);
  assert.equal(result.valor_a_pagar.vencimento_primeira_prestacao, '2026-02-10');
  const split = await calculationItems();
  const signed = split[0].find(i => i.text === '-1.150,90');
  signed.text = '1.150,90';
  split[0].push({ text: '-', x: signed.x - 4, y: signed.y });
  assert.equal(parseCalculationPages(split).demonstrativo_calculo.imposto_predial.deducoes_acrescimos_reais, -1150.9);
});

test('extrai terceira linha preenchida sem deslocar valores de outras colunas', async () => {
  const pages = await calculationItems();
  const row = pages[0].find(i => i.text === 'TERRENO NÃO INCORP');
  pages[0].push({ text: '25', x: 45, y: row.y + 11.3 }, { text: '123,45', x: 118, y: row.y + 11.3 });
  const result = parseCalculationPages(pages).demonstrativo_calculo.bases_calculo;
  assert.equal(result.terreno_nao_incorporado.area_m2, 25);
  assert.equal(result.terreno_nao_incorporado.valor_m2_reais, 123.45);
  assert.equal(result.terreno_nao_incorporado.fator_profundidade, null);
});

test('recusa layout desconhecido, números ambíguos, datas inválidas e PDF ilegível', async () => {
  const missing = await calculationItems();
  missing[0] = missing[0].filter(i => i.text !== 'FATORES');
  assert.throws(() => parseCalculationPages(missing), { code: 'PDF_LAYOUT_NAO_RECONHECIDO' });
  const duplicate = await calculationItems();
  duplicate[0].push({ ...duplicate[0].find(i => i.text === '80') });
  assert.throws(() => parseCalculationPages(duplicate), { code: 'PDF_LAYOUT_NAO_RECONHECIDO' });
  const badDate = await calculationItems();
  badDate[0].find(i => i.text === '10/02/2026').text = '31/02/2026';
  assert.throws(() => parseCalculationPages(badDate), { code: 'PDF_LAYOUT_NAO_RECONHECIDO' });
  const malformed = await calculationItems();
  malformed[0].find(i => i.text === '1.499,00').text = '1,2,3';
  assert.throws(() => parseCalculationPages(malformed), { code: 'PDF_LAYOUT_NAO_RECONHECIDO' });
  await assert.rejects(extractCalculation(Buffer.from('não é um PDF')), { code: 'PDF_INVALIDO' });
  assert.equal(parseBrazilianNumber('1.234.567,89'), 1234567.89);
  assert.equal(parseBrazilianNumber('-0,2500'), -0.25);
  assert.throws(() => parseBrazilianNumber('1,2,3'));
});

test('endpoint JSON emite uma vez e permite consultar o mesmo JSON pelo documento', async t => {
  let calls = 0;
  const pdf = await calculationPdf();
  const server = createApp({ generate: async () => { calls++; return pdf; } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = { cpf: '12345678900', senha: 'ficticia', cadastro: '00000000000', exercicio: 2026 };
  const response = await fetch(`${base}/api/segunda-via/json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(await fetch(`${base}${response.headers.get('x-json-url')}`).then(r => r.json()), expected);
  const pdfResponse = await fetch(`${base}${response.headers.get('x-pdf-url')}`);
  assert.deepEqual(Buffer.from(await pdfResponse.arrayBuffer()), pdf);
  assert.equal(calls, 1);
  input.cadastro = '11111111111';
  const mismatch = await fetch(`${base}/api/segunda-via/json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(mismatch.status, 422);
  assert.equal((await mismatch.json()).code, 'PDF_DIVERGENTE');
});
