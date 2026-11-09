import { chromium } from 'playwright';
import { AppError } from './errors.js';

export const PORTAL_URL = 'https://notcertiptu.prefeitura.sp.gov.br/PaginasRestritas/frm001_Gerar_Notif_Lanc.aspx';

export async function openPortal(page, portalUrl = PORTAL_URL) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(portalUrl, { waitUntil: 'domcontentloaded' });
      return;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      // Recursos auxiliares podem atrasar DOMContentLoaded mesmo com o
      // formulário disponível. Só aceita controles conhecidos do fluxo.
      if (await page.locator('#txt_SQL').isVisible()
        || (await page.locator('#cpfCnpj').count() === 1
          && await page.getByRole('button', { name: /Outras formas de acesso/i }).isVisible())) return;
      if (attempt === 1) throw error;
      // Repete somente a navegação GET inicial, nunca um POST de credenciais.
    }
  }
}

// O navegador mantém cookies, PKCE, anti-CSRF e estado ASP.NET na mesma sessão.
// Nenhum token é fabricado, extraído ou persistido pela aplicação.
async function waitForAccess(page, onStage) {
  await page.waitForFunction(() => {
    const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    return visible(document.querySelector('#txt_SQL'))
      || /\/Account\/CarregarDelegado/i.test(location.pathname)
      || [...document.querySelectorAll('.validation-summary-errors, .field-validation-error, [role="alert"]')]
        .some(e => visible(e) && e.textContent.trim())
      || [...document.querySelectorAll('iframe')].some(e => visible(e) && /captcha/i.test(e.src));
  }, null, { timeout: 30000 });
  if (await page.locator('#txt_SQL').isVisible()) return;
  if (/\/Account\/CarregarDelegado/i.test(new URL(page.url()).pathname)) {
    onStage('perfil');
    const titular = page.getByRole('radio', { name: /^Titular\s*:/i });
    if (await titular.count() !== 1) {
      throw new AppError(502, 'PERFIL_NAO_ENCONTRADO', 'Não foi possível identificar o perfil de titular no portal.');
    }
    await titular.check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click({ noWaitAfter: true });
    await page.locator('#txt_SQL').waitFor({ state: 'visible', timeout: 30000 });
    return;
  }
  const hasCaptcha = await page.locator('iframe[src*="captcha"]').count();
  if (hasCaptcha) throw new AppError(409, 'INTERACAO_NECESSARIA', 'O portal solicitou CAPTCHA. Esta API não resolve desafios de autenticação.');
  throw new AppError(401, 'LOGIN_RECUSADO', 'O portal recusou o acesso. Verifique CPF/CNPJ e Senha Web.');
}

export async function login(page, { cpf, senha }, portalUrl = PORTAL_URL, onStage = () => {}) {
  onStage('abrir_portal');
  await openPortal(page, portalUrl);
  if (await page.locator('#txt_SQL').isVisible()) return;
  onStage('formulario_login');
  await page.getByRole('button', { name: /Outras formas de acesso/i }).click();
  await page.locator('#cpfCnpj').fill(cpf);
  await page.locator('#password').fill(senha);
  onStage('enviar_login');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click({ noWaitAfter: true });
  await waitForAccess(page, onStage);
}

async function dismissCookieNotice(page) {
  // O AX do navegador e o DOM nem sempre dão o mesmo papel ao controle.
  const choice = page.getByText(/^Use somente cookies necessários\./i).first();
  if (await choice.isVisible()) {
    await choice.click({ noWaitAfter: true, timeout: 10000 });
    await choice.waitFor({ state: 'hidden', timeout: 10000 });
    return true;
  }
  return false;
}

export async function issueFromPage(page, { cadastro, exercicio }, onStage = () => {}) {
  onStage('cookies');
  await dismissCookieNotice(page);
  onStage('preencher_consulta');
  await page.locator('#txt_SQL').fill(cadastro);
  await page.locator('#txt_Exercicio').fill(exercicio);
  onStage('enviar_consulta');
  try {
    await page.locator('#btnConsultar').click({ noWaitAfter: true, timeout: 10000 });
  } catch (error) {
    // O aviso pode aparecer depois de preencher os campos. Repete o clique
    // somente se houve timeout por sobreposição e o aviso foi fechado.
    if (error.name !== 'TimeoutError' || !await dismissCookieNotice(page)) throw error;
    await page.locator('#btnConsultar').click({ noWaitAfter: true });
  }
  onStage('resultado_consulta');
  const rows = page.locator('#gvDados tr').filter({ has: page.locator('input[title="Gerar Notificação"]') });
  try {
    await rows.first().waitFor({ state: 'visible', timeout: 30000 });
  } catch {
    if (await page.locator('#cpfCnpj').isVisible()) {
      throw new AppError(401, 'SESSAO_EXPIRADA', 'A sessão expirou durante a consulta. Tente novamente.');
    }
    throw new AppError(422, 'CONSULTA_SEM_RESULTADO', 'O portal não disponibilizou notificações para esse cadastro e exercício, ou mudou o formulário.');
  }
  // Evita selecionar uma notificação cancelada ou decidir entre várias ativas.
  const activeRows = rows.filter({ has: page.getByRole('cell', { name: 'Ativa', exact: true }) });
  const count = await activeRows.count();
  if (count !== 1) {
    throw new AppError(422, 'NOTIFICACAO_AMBIGUA', count === 0
      ? 'Não há uma notificação ativa disponível.'
      : 'Há mais de uma notificação ativa. É necessária seleção manual no portal.');
  }
  onStage('gerar');
  await activeRows.locator('input[title="Gerar Notificação"]').click({ noWaitAfter: true });
  await page.locator('#btnOK').waitFor({ state: 'visible' });
  // Confirmado no portal: campos vazios permitem emitir a via com sigilo fiscal.
  await page.locator('#TxtProprietario').fill('');
  await page.locator('#TxtCompromissario').fill('');
  onStage('download');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('#btnOK').click({ noWaitAfter: true }),
  ]);
  const failure = await download.failure();
  if (failure) throw new AppError(502, 'DOWNLOAD_FALHOU', 'O portal não concluiu o download do PDF.');
  const stream = await download.createReadStream();
  if (!stream) throw new AppError(502, 'PDF_INDISPONIVEL', 'O portal não disponibilizou o arquivo.');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) throw new AppError(502, 'PDF_MUITO_GRANDE', 'O arquivo retornado excede 20 MB.');
      chunks.push(chunk);
    }
  } finally { await download.delete().catch(() => {}); }
  const pdf = Buffer.concat(chunks);
  if (pdf.subarray(0, 5).toString() !== '%PDF-') {
    throw new AppError(502, 'RESPOSTA_INVALIDA', 'O portal retornou um arquivo que não é PDF.');
  }
  return pdf;
}

// O objeto guarda apenas o navegador autenticado, nunca as credenciais.
export class PortalSession {
  constructor({ headless = true, portalUrl = PORTAL_URL } = {}) {
    this.headless = headless;
    this.portalUrl = portalUrl;
  }
  isOpen() { return !!this.browser?.isConnected() && !!this.page && !this.page.isClosed(); }
  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
  async run(operation, { signal, timeoutMs = 120000, onDiagnostic = () => {} } = {}) {
    let expired = false;
    let stage = 'navegador';
    const onStage = value => { stage = value; };
    const close = () => { void this.close(); };
    signal?.throwIfAborted();
    signal?.addEventListener('abort', close, { once: true });
    const timer = setTimeout(() => { expired = true; close(); }, timeoutMs);
    try {
      const result = await operation(onStage);
      if (expired) { await this.close(); throw Object.assign(new Error('Prazo excedido.'), { name: 'TimeoutError' }); }
      if (signal?.aborted) throw new AppError(499, 'REQUISICAO_CANCELADA', 'Solicitação cancelada.');
      return result;
    } catch (error) {
      if (expired || signal?.aborted) await this.close();
      if (this.page && ['cookies', 'preencher_consulta', 'enviar_consulta', 'resultado_consulta', 'gerar', 'download'].includes(stage)
        && new URL(this.page.url()).hostname === 'notcertiptu.prefeitura.sp.gov.br') {
        try { onDiagnostic({ stage, screenshot: await this.page.screenshot({ type: 'jpeg', timeout: 3000 }) }); }
        catch { /* Navegador fechado ou indisponível. */ }
      }
      if (signal?.aborted) throw new AppError(499, 'REQUISICAO_CANCELADA', 'Solicitação cancelada.');
      if (expired || error.name === 'TimeoutError') {
        console.warn(`PORTAL_TIMEOUT etapa=${stage}`);
        const descriptions = {
          navegador: 'iniciar o navegador', abrir_portal: 'abrir o portal da Prefeitura',
          formulario_login: 'abrir o formulário Senha Web', enviar_login: 'aguardar a resposta do login Senha Web',
          perfil: 'selecionar o perfil de titular', cookies: 'fechar o aviso de cookies',
          preencher_consulta: 'preencher o cadastro e exercício', enviar_consulta: 'clicar em Consultar',
          resultado_consulta: 'aguardar o resultado da consulta', gerar: 'abrir a confirmação da notificação', download: 'baixar o PDF',
        };
        throw new AppError(504, 'PORTAL_TIMEOUT', `Tempo limite ao ${descriptions[stage]}. Código da etapa: ${stage}.`);
      }
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'PORTAL_INDISPONIVEL', 'Não foi possível completar a operação no portal. Confira a conexão e a instalação do Chromium.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', close);
    }
  }
  async authenticate(credentials, options) {
    try {
      await this.run(async onStage => {
        this.browser = await chromium.launch({ headless: this.headless, timeout: 20000 });
        if (options?.signal?.aborted) { await this.close(); throw new AppError(499, 'REQUISICAO_CANCELADA', 'Solicitação cancelada.'); }
        this.context = await this.browser.newContext({ acceptDownloads: true, locale: 'pt-BR' });
        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(15000);
        this.page.setDefaultNavigationTimeout(30000);
        await login(this.page, credentials, this.portalUrl, onStage);
      }, options);
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async issue(input, options) {
    if (!this.isOpen()) throw new AppError(401, 'SESSAO_EXPIRADA', 'A sessão expirou. Entre novamente com CPF/CNPJ e Senha Web.');
    return this.run(async onStage => {
      onStage('abrir_portal');
      // Nova consulta na mesma sessão, incluindo cookies HttpOnly da Prefeitura.
      // Se a Prefeitura pedir login, não reenvia credenciais automaticamente.
      await openPortal(this.page, this.portalUrl);
      if (!await this.page.locator('#txt_SQL').isVisible()) {
        throw new AppError(401, 'SESSAO_EXPIRADA', 'A sessão da Prefeitura expirou. Entre novamente com CPF/CNPJ e Senha Web.');
      }
      return issueFromPage(this.page, input, onStage);
    }, options);
  }
}

export async function openAuthenticatedSession(credentials, options = {}) {
  return new PortalSession(options).authenticate(credentials, options);
}

// Compatibilidade para clientes que desejam uma emissão isolada.
export async function generatePdf(input, options = {}) {
  const session = await openAuthenticatedSession(input, options);
  try { return await session.issue(input, options); }
  finally { await session.close(); }
}
