import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { chromium } from 'playwright';
import { login, issueFromPage, openPortal, PortalSession } from '../src/portal.js';

const input = { cpf: '12345678900', senha: 'senha-ficticia', cadastro: '00000000000', exercicio: '2026' };
const pdf = Buffer.from('%PDF-1.4\nfixture\n%%EOF');

async function fixture(t, { active = 1, badPdf = false, cookieNotice = false, slowResource = false, credentialId = input.cpf } = {}) {
  const app = express();
  const stats = { logins: 0 };
  app.use(express.urlencoded({ extended: false }));
  app.get('/portal', (req, res) => {
    if (!req.headers.cookie?.includes('session=fixture')) return res.redirect('/account/login');
    res.send(`<form method="post" action="/consultar"><input id="txt_SQL" name="cadastro"><input id="txt_Exercicio" name="exercicio"><input type="hidden" name="__VIEWSTATE" value="estado-atual"><button id="btnConsultar">Consultar</button></form>${cookieNotice ? '<div id="cookie" style="position:fixed;inset:0;background:white;z-index:99"><button onclick="document.querySelector(\'#cookie\').remove()">Use somente cookies necessários. Estou de acordo com a política de privacidade.</button></div>' : ''}`);
  });
  app.get('/account/login', (req, res) => res.send(`<button onclick="document.querySelector('form').hidden=false">Outras formas de acesso</button><form hidden method="post" action="/account/login"><input id="cpfCnpj" name="cpf"><input id="password" name="senha" type="password"><input type="hidden" name="__RequestVerificationToken" value="csrf"><button>Entrar</button></form>`));
  app.post('/account/login', (req, res) => {
    stats.logins++;
    assert.equal(req.body.__RequestVerificationToken, 'csrf');
    if (req.body.senha !== input.senha) return res.send('<div class="validation-summary-errors">Senha inválida</div>');
    assert.equal(req.body.cpf, credentialId);
    res.redirect('/Account/CarregarDelegado');
  });
  app.get('/Account/CarregarDelegado', (req, res) => res.send(`<form action="/continuar" method="post"><label><input type="radio" name="perfil" value="titular">Titular : ${credentialId.length === 14 ? 'Cnpj' : 'Cpf'} fictício</label><label><input type="radio" name="perfil" value="empresa" checked>Empresa</label><button>Continuar</button></form>`));
  app.post('/continuar', (req, res) => {
    assert.equal(req.body.perfil, 'titular');
    res.set('Set-Cookie', 'session=fixture; HttpOnly; SameSite=Lax').redirect('/portal');
  });
  app.post('/consultar', (req, res) => {
    assert.equal(req.body.__VIEWSTATE, 'estado-atual');
    assert.equal(req.body.cadastro, input.cadastro);
    assert.equal(req.body.exercicio, input.exercicio);
    const row = state => `<tr><td>01</td><td>${state}</td><td><form method="post" action="/gerar"><input title="Gerar Notificação" type="submit" value="Gerar"></form></td></tr>`;
    res.send(`<table id="gvDados">${row('Cancelada')}${Array.from({ length: active }, () => row('Ativa')).join('')}</table>${slowResource ? '<script src="/auxiliar-bloqueado.js"></script>' : ''}`);
  });
  app.post('/gerar', (req, res) => res.send(`<form method="post" action="/pdf"><input id="TxtProprietario" name="proprietario" value="333"><input id="TxtCompromissario" name="compromissario"><button id="btnOK">Ok</button></form>`));
  app.post('/pdf', (req, res) => {
    assert.equal(req.body.proprietario, '');
    assert.equal(req.body.compromissario, '');
    res.type('application/pdf').attachment('fixture.pdf').send(badPdf ? Buffer.from('erro html') : pdf);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ acceptDownloads: true });
  page.setDefaultTimeout(3000);
  return { page, stats, url: `http://127.0.0.1:${server.address().port}/portal` };
}

test('login, seleção titular, postback e PDF usando sessão isolada', async t => {
  const { page, url } = await fixture(t);
  await login(page, input, url);
  assert.deepEqual(await issueFromPage(page, input), pdf);
});

test('login recusado devolve erro de autenticação', async t => {
  const { page, url } = await fixture(t);
  await assert.rejects(login(page, { ...input, senha: 'incorreta' }, url), { status: 401, code: 'LOGIN_RECUSADO' });
});

test('não escolhe automaticamente entre duas notificações ativas', async t => {
  const { page, url } = await fixture(t, { active: 2 });
  await login(page, input, url);
  await assert.rejects(issueFromPage(page, input), { status: 422, code: 'NOTIFICACAO_AMBIGUA' });
});

test('rejeita download que não é PDF', async t => {
  const { page, url } = await fixture(t, { badPdf: true });
  await login(page, input, url);
  await assert.rejects(issueFromPage(page, input), { status: 502, code: 'RESPOSTA_INVALIDA' });
});

test('aproveita formulário pronto quando recurso auxiliar atrasa DOMContentLoaded', async t => {
  const { page, url } = await fixture(t);
  await page.route('**/auxiliar-lento.js', () => {});
  await page.route('**/entrada-lenta', route => route.fulfill({
    contentType: 'text/html',
    body: '<button>Outras formas de acesso</button><input id="cpfCnpj"><script src="/auxiliar-lento.js"></script>',
  }));
  page.setDefaultNavigationTimeout(1500);
  await openPortal(page, new URL('/entrada-lenta', url).href);
  assert.equal(await page.locator('#cpfCnpj').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Outras formas de acesso' }).isVisible(), true);
});

test('repete GET inicial uma única vez quando a abertura expira', async () => {
  let attempts = 0;
  const page = {
    goto: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('demora'), { name: 'TimeoutError' }); },
    locator: () => ({ isVisible: async () => false, count: async () => 0 }),
  };
  await openPortal(page, 'https://example.invalid');
  assert.equal(attempts, 2);
});

test('fecha consentimento pelo texto mesmo quando seu papel não é tab', async t => {
  const { page, url } = await fixture(t, { cookieNotice: true });
  await login(page, input, url);
  assert.deepEqual(await issueFromPage(page, input), pdf);
});

test('consulta não aguarda recurso auxiliar bloqueado após postback', async t => {
  const { page, url } = await fixture(t, { slowResource: true });
  await page.route('**/auxiliar-bloqueado.js', () => {});
  await login(page, input, url);
  assert.deepEqual(await issueFromPage(page, input), pdf);
});

test('sessão real de navegador emite duas vezes com um login e detecta expiração', async t => {
  const { url, stats } = await fixture(t);
  const session = new PortalSession({ portalUrl: url });
  t.after(() => session.close());
  await session.authenticate({ cpf: input.cpf, senha: input.senha });
  const query = { cadastro: input.cadastro, exercicio: input.exercicio };
  assert.deepEqual(await session.issue(query), pdf);
  assert.deepEqual(await session.issue(query), pdf);
  assert.equal(stats.logins, 1);
  await session.context.clearCookies();
  await assert.rejects(session.issue(query), { status: 401, code: 'SESSAO_EXPIRADA' });
  assert.equal(stats.logins, 1);
  await session.close();
  assert.equal(session.isOpen(), false);
});

test('CNPJ é enviado integralmente ao login e seleciona titular CNPJ', async t => {
  const cpf = '00000000000000';
  const { url, stats } = await fixture(t, { credentialId: cpf });
  const session = new PortalSession({ portalUrl: url });
  t.after(() => session.close());
  await session.authenticate({ cpf, senha: input.senha });
  assert.deepEqual(await session.issue({ cadastro: input.cadastro, exercicio: input.exercicio }), pdf);
  assert.equal(stats.logins, 1);
});
