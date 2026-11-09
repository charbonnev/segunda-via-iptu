import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const timeoutMs = Number(process.env.PORTAL_TIMEOUT_MS || 120000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 300000) throw new Error('PORTAL_TIMEOUT_MS deve estar entre 10000 e 300000.');
const app = createApp({ timeoutMs, headless: process.env.HEADLESS !== 'false' });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`IPTU local: http://127.0.0.1:${port}`);
});
server.requestTimeout = 330000;
server.on('error', () => { console.error('Não foi possível iniciar o servidor. Verifique a porta.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => { await app.locals.disposeSessions(); process.exit(0); }));
}
