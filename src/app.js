import express from 'express';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateInput, validateCredentials, validateQuery } from './validation.js';
import { openAuthenticatedSession } from './portal.js';
import { SessionStore, sessionId, COOKIE_NAME } from './sessions.js';
import { AppError } from './errors.js';
import { extractCalculation } from './calculo.js';
import swaggerUi from 'swagger-ui-dist';
import { openapi } from './openapi.js';

export function createApp({ generate, authenticate = openAuthenticatedSession, sessionTtlMs = 15 * 60 * 1000, timeoutMs = 120000, headless = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  let busy = false;
  let diagnostic;
  let diagnosticTimer;
  let document;
  let documentTimer;
  const sessions = new SessionStore({ ttlMs: sessionTtlMs });
  app.locals.disposeSessions = () => sessions.closeAll();
  const setCookie = (res, id) => res.cookie(COOKIE_NAME, id, { httpOnly: true, sameSite: 'strict', path: '/api' });
  const clearCookie = res => res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/api' });
  const calculation = doc => {
    doc.calculation ??= extractCalculation(doc.pdf).then(data => {
      if (data.identificacao.cadastro_imovel.replace(/\D/g, '') !== doc.query.cadastro || String(data.identificacao.exercicio) !== doc.query.exercicio) {
        throw new AppError(422, 'PDF_DIVERGENTE', 'O cadastro ou exercício do PDF não corresponde à consulta solicitada.');
      }
      return data;
    });
    return doc.calculation;
  };
  const requireSlot = res => {
    if (busy) {
      res.set('Retry-After', '10');
      throw new AppError(429, 'EMISSAO_EM_ANDAMENTO', 'Já há uma operação em andamento. Aguarde e tente novamente.');
    }
  };
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    // API para execução local; evita que outros sites acionem o serviço local.
    const host = req.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      return res.status(403).json({ code: 'HOST_RECUSADO', error: 'Use localhost ou 127.0.0.1.' });
    }
    if ((req.headers.origin && req.headers.origin !== `http://${host}`)
      || req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ code: 'ORIGEM_RECUSADA', error: 'Origem não autorizada.' });
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.get(['/openapi.json', '/api/openapi.json'], (req, res) => res.json(openapi));
  app.use('/docs', (req, res, next) => {
    // Swagger usa estilos inline; a exceção fica restrita à documentação.
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    next();
  });
  app.use('/docs/assets', express.static(swaggerUi.absolutePath(), { index: false, dotfiles: 'deny' }));
  app.get('/api/health', (req, res) => res.json({ ok: true, busy }));
  app.get('/api/sessao', (req, res) => {
    const entry = sessions.get(sessionId(req));
    if (!entry) clearCookie(res);
    res.json({ authenticated: !!entry, expiresAt: entry?.expiresAt ?? null });
  });
  app.post('/api/sessao', async (req, res, next) => {
    let ownsSlot = false;
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    let entry;
    try {
      if (!req.is('application/json')) throw new AppError(415, 'TIPO_INVALIDO', 'Envie Content-Type: application/json.');
      const credentials = validateCredentials(req.body);
      requireSlot(res);
      busy = ownsSlot = true;
      res.on('close', abort);
      await sessions.remove(sessionId(req));
      const portal = await authenticate(credentials, { signal: controller.signal, timeoutMs, headless });
      if (res.destroyed || controller.signal.aborted) { await portal.close(); return; }
      entry = await sessions.add(portal);
      setCookie(res, entry.id);
      res.json({ authenticated: true, expiresAt: entry.expiresAt });
    } catch (error) { if (!res.destroyed) { if (ownsSlot) clearCookie(res); next(error); } }
    finally {
      res.off('close', abort);
      if (ownsSlot) busy = false;
      if (req.body && typeof req.body === 'object') delete req.body.senha;
    }
  });
  app.delete('/api/sessao', async (req, res, next) => {
    let ownsSlot = false;
    try {
      requireSlot(res);
      busy = ownsSlot = true;
      const id = sessionId(req);
      await sessions.remove(id);
      if (!document?.owner || document.owner === id) { document = undefined; clearTimeout(documentTimer); }
      if (!diagnostic?.owner || diagnostic.owner === id) { diagnostic = undefined; clearTimeout(diagnosticTimer); }
      clearCookie(res);
      res.status(204).end();
    } catch (error) { next(error); }
    finally { if (ownsSlot) busy = false; }
  });
  app.get('/api/documentos/:id/:mode', async (req, res) => {
    if (!document || req.params.id !== document.id || !['arquivo.pdf', 'visualizar.pdf', 'calculo.json'].includes(req.params.mode)
      || (document.owner && sessions.get(sessionId(req))?.id !== document.owner)) {
      return res.status(404).json({ code: 'PDF_EXPIRADO', error: 'O PDF expirou ou não foi encontrado. Gere uma nova via.' });
    }
    if (req.params.mode === 'calculo.json') return res.json(await calculation(document));
    const disposition = req.params.mode === 'visualizar.pdf' ? 'inline' : 'attachment';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${document.filename}"`,
      'Content-Security-Policy': "default-src 'none'; object-src 'self'; frame-ancestors 'self'",
    }).send(document.pdf);
  });
  app.get('/api/diagnostico.jpg', (req, res) => {
    if (!diagnostic || (diagnostic.owner && sessions.get(sessionId(req))?.id !== diagnostic.owner)) return res.status(404).json({ error: 'Nenhuma captura de diagnóstico disponível.' });
    res.type('image/jpeg').send(diagnostic.screenshot);
  });
  app.post(['/api/segunda-via', '/api/segunda-via/json'], async (req, res, next) => {
    const controller = new AbortController();
    let ownsSlot = false;
    let entry;
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    try {
      if (!req.is('application/json')) throw new AppError(415, 'TIPO_INVALIDO', 'Envie Content-Type: application/json.');
      entry = sessions.get(sessionId(req));
      if (!entry && req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !('cpf' in req.body) && !('cpfCnpj' in req.body) && !('senha' in req.body)) {
        clearCookie(res);
        throw new AppError(401, 'SESSAO_EXPIRADA', 'Entre com CPF/CNPJ e Senha Web para iniciar uma sessão.');
      }
      const input = entry ? validateQuery(req.body) : validateInput(req.body);
      requireSlot(res);
      busy = true;
      diagnostic = undefined;
      clearTimeout(diagnosticTimer);
      ownsSlot = true;
      res.on('close', abort);
      const options = {
        signal: controller.signal, timeoutMs, headless,
        onDiagnostic: value => {
          diagnostic = { ...value, owner: entry?.id };
          clearTimeout(diagnosticTimer);
          diagnosticTimer = setTimeout(() => { diagnostic = undefined; }, 5 * 60 * 1000);
          diagnosticTimer.unref();
        },
      };
      let pdf;
      if (entry) {
        sessions.pause(entry);
        pdf = await entry.portal.issue(input, options);
      } else if (generate) {
        pdf = await generate(input, options);
      } else {
        // Compatibilidade com a API original de quatro campos: cria a sessão
        // e também devolve o PDF na mesma solicitação.
        const portal = await authenticate({ cpf: input.cpf, senha: input.senha }, options);
        entry = await sessions.add(portal);
        sessions.pause(entry);
        setCookie(res, entry.id);
        pdf = await portal.issue(validateQuery(input), options);
      }
      if (!res.destroyed) {
        document = {
          id: randomUUID(), pdf, owner: entry?.id,
          query: validateQuery(input),
          filename: `iptu-${input.cadastro}-${input.exercicio}.pdf`,
        };
        clearTimeout(documentTimer);
        documentTimer = setTimeout(() => { document = undefined; }, 5 * 60 * 1000);
        documentTimer.unref();
        res.set({
          'X-PDF-URL': `/api/documentos/${document.id}/arquivo.pdf`,
          'X-PDF-Preview-URL': `/api/documentos/${document.id}/visualizar.pdf`,
          'X-JSON-URL': `/api/documentos/${document.id}/calculo.json`,
        });
        if (req.path.endsWith('/json')) res.json(await calculation(document));
        else res.set({
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${document.filename}"`,
        }).send(pdf);
      }
    } catch (error) {
      if (entry && (error.status === 401 || controller.signal.aborted || !entry.portal.isOpen())) {
        await sessions.remove(entry.id);
        if (!res.destroyed) clearCookie(res);
      }
      if (!res.destroyed) next(error);
    } finally {
      res.off('close', abort);
      if (ownsSlot) busy = false;
      if (entry && ownsSlot) sessions.touch(entry);
      // Não manter credenciais no objeto da requisição após a operação.
      if (req.body && typeof req.body === 'object') delete req.body.senha;
    }
  });
  app.use('/api', (req, res) => res.status(404).json({ code: 'ROTA_INEXISTENTE', error: 'Rota não encontrada.' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ code: 'JSON_INVALIDO', error: 'JSON inválido.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ code: 'CORPO_MUITO_GRANDE', error: 'O limite da requisição é 8 KB.' });
    }
    res.status(error instanceof AppError ? error.status : 500).json({
      code: error instanceof AppError ? error.code : 'ERRO_INTERNO',
      error: error instanceof AppError ? error.message : 'Não foi possível concluir a solicitação.',
    });
  });
  return app;
}
