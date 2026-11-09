import { readFileSync } from 'node:fs';

const example = JSON.parse(readFileSync(new URL('../examples/calculo.json', import.meta.url), 'utf8'));
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const number = { type: 'number', nullable: true, description: 'Valor extraído do PDF; null quando a célula está vazia. Zero preenchido permanece 0.' };
const text = { type: 'string', nullable: true };
const integer = { type: 'integer', nullable: true };
const query = {
  cadastro: { type: 'string', pattern: '^(?:[.\\s/-]*\\d){11}[.\\s/-]*$', description: 'SQL com 11 dígitos; aceita pontuação e espaços.', example: '000.000.0000-0' },
  exercicio: { oneOf: [{ type: 'integer', minimum: 1900, maximum: 2100 }, { type: 'string', pattern: '^(?:19\\d{2}|20\\d{2}|2100)$' }], example: 2026 },
};
const credentials = {
  cpf: { type: 'string', pattern: '^(?:[.\\s/-]*\\d){11}[.\\s/-]*$', description: 'CPF de acesso à Senha Web, com 11 dígitos. Exemplo fictício.', example: '00000000000' },
  senha: { type: 'string', format: 'password', writeOnly: true, minLength: 1, maxLength: 256, pattern: '\\S', description: 'Senha Web da Prefeitura (não é a senha gov.br). Não é guardada na sessão.', example: 'PREENCHA_SUA_SENHA_WEB' },
};
const baseRow = (reference, factors) => object({
  area_m2: number, valor_m2_reais: number, ...Object.fromEntries(factors.map(name => [name, number])),
  base_calculo_reais: number, fator_especial: number, referencia_pdf: { type: 'string', enum: [reference] },
});
const tax = reference => object({
  base_calculo_reais: number, formula_base_calculo: { type: 'string' }, aliquota: { ...number, description: 'Copiada do PDF, sem conversão para porcentagem.' },
  desconto_acrescimo_reais: number, imposto_calculado_reais: number, fator_especial: number,
  deducoes_acrescimos_reais: number, imposto_a_pagar_reais: number, referencia_pdf: { type: 'string', enum: [reference] },
});
const errorDescriptions = {
  400: 'Dados ou JSON inválidos.', 401: 'Login recusado ou sessão expirada. Entre novamente; a senha não é reenviada automaticamente.',
  403: 'Host ou origem não autorizada. Use a mesma origem local da documentação.', 404: 'Documento expirado, inexistente ou de outra sessão.',
  409: 'CAPTCHA ou interação adicional identificada. A API não resolve desafios.', 413: 'Corpo da requisição excede 8 KB.',
  415: 'Use Content-Type: application/json.', 422: 'Consulta sem resultado/ambígua ou PDF com layout, conteúdo ou identificação incompatível.',
  429: 'Operação em andamento ou limite de quatro sessões atingido.', 500: 'Erro interno.',
  502: 'Falha no portal, navegador ou download.', 504: 'Tempo limite; a mensagem indica a etapa.',
};
const errors = (...statuses) => Object.fromEntries(statuses.map(status => [status, {
  description: errorDescriptions[status], content: { 'application/json': { schema: ref('Erro') } },
  ...(status === 429 ? { headers: { 'Retry-After': { description: 'Quando ocupado, segundos sugeridos antes de tentar novamente.', schema: { type: 'integer', example: 10 } } } } : {}),
}]));
const json = (schema, description, responseExample) => ({ description, content: { 'application/json': { schema, ...(responseExample ? { example: responseExample } : {}) } } });
const body = (schema, examples) => ({ required: true, content: { 'application/json': { schema, ...(examples ? { examples } : {}) } } });
const cookieHeader = { description: 'Cookie iptu_session; HttpOnly, SameSite=Strict, Path=/api. O navegador recebe automaticamente.', schema: { type: 'string' } };
const resultHeaders = {
  'X-PDF-URL': { description: 'URL local temporária para baixar o mesmo PDF.', schema: { type: 'string', example: '/api/documentos/00000000-0000-4000-8000-000000000000/arquivo.pdf' } },
  'X-PDF-Preview-URL': { description: 'URL local temporária de visualização do PDF.', schema: { type: 'string' } },
  'X-JSON-URL': { description: 'URL local para extrair/ler o JSON do mesmo PDF, sem nova emissão.', schema: { type: 'string' } },
  'Set-Cookie': cookieHeader,
};
const emissionBody = body({ anyOf: [ref('Consulta'), ref('LoginEConsulta')] }, {
  sessaoAtiva: { summary: 'Reutilizar sessão (recomendado)', value: { cadastro: '000.000.0000-0', exercicio: 2026 } },
  primeiroAcesso: { summary: 'Login e emissão em uma chamada (compatibilidade)', value: { cpf: '00000000000', senha: 'PREENCHA_SUA_SENHA_WEB', cadastro: '000.000.0000-0', exercicio: 2026 } },
});
const documentParams = [{ name: 'id', in: 'path', required: true, description: 'Identificador opaco obtido nos cabeçalhos da emissão. Não é o SQL.', schema: { type: 'string', format: 'uuid' } }];
const sessionSecurity = [{ SessionCookie: [] }];
const emission = asJson => ({
  tags: ['Emissão'], operationId: asJson ? 'emitirCalculoJson' : 'emitirPdf',
  summary: asJson ? 'Emitir notificação e receber o cálculo em JSON' : 'Emitir e baixar a notificação em PDF',
  description: 'Com sessão ativa, envie apenas cadastro e exercicio. Sem sessão, informe também cpf e senha, ou faça POST /api/sessao antes. Uma única operação é executada por vez. A extração JSON usa o PDF emitido e não recalcula os valores.',
  security: [...sessionSecurity, {}], requestBody: emissionBody,
  responses: {
    200: {
      description: asJson ? 'Cálculo no contrato schema_versao 3.0; PDF disponível nos cabeçalhos.' : 'PDF binário da Notificação de Lançamento (não é guia de pagamento).',
      headers: { ...resultHeaders, ...(!asJson ? { 'Content-Disposition': { schema: { type: 'string' }, description: 'attachment; filename="iptu-SQL-EXERCICIO.pdf"' } } : {}) },
      content: asJson ? { 'application/json': { schema: ref('Calculo'), example } } : { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
    },
    ...errors(400, 401, 403, 409, 413, 415, 422, 429, 500, 502, 504),
  },
});
const cachedDocument = (mode, summary, content) => ({
  get: {
    tags: ['Documentos'], operationId: `obter${mode}`, summary,
    description: 'Reutiliza o último PDF emitido, sem novo login ou emissão. Expira após cinco minutos, nova emissão bem-sucedida, logout ou reinício do serviço. Use a mesma sessão que emitiu o documento.',
    security: sessionSecurity, parameters: documentParams,
    responses: { 200: { description: summary, content }, ...errors(403, 404, ...(mode === 'Calculo' ? [422] : []), 500) },
  },
});

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'IPTU São Paulo · API local', version: '1.0.0',
    description: 'Emissão da segunda via da **Notificação de Lançamento** e extração do cálculo em JSON (schema 3.0).\n\n**Como testar aqui:** 1. Expanda POST /api/sessao, clique em Try it out, informe seu CPF e Senha Web e execute. 2. Execute POST /api/segunda-via/json ou /api/segunda-via apenas com cadastro e exercício. O cookie é enviado automaticamente nesta mesma origem; não precisa preencher Authorize nem copiar tokens. 3. Ao terminar, execute DELETE /api/sessao.\n\nA sessão fica em memória por 15 minutos sem uso. A Prefeitura pode expirá-la antes; reiniciar o serviço encerra todas as sessões. As senhas não são armazenadas pela aplicação. Exemplos têm CPF e SQL fictícios. **Try it out / Execute realiza chamadas reais ao portal**. Não há resolução de CAPTCHA/MFA nem pagamento de impostos. Para outros clientes, conserve os cookies entre as chamadas. Todos os arquivos desta documentação são locais.',
  },
  servers: [{ url: '/', description: 'Mesma origem da documentação (servidor local)' }],
  tags: [{ name: 'Sessão' }, { name: 'Emissão' }, { name: 'Documentos' }, { name: 'Operação' }],
  paths: {
    '/api/sessao': {
      get: { tags: ['Sessão'], operationId: 'consultarSessao', summary: 'Verificar a sessão atual', description: 'Não renova o prazo de inatividade nem faz login na Prefeitura.', responses: { 200: json(ref('Sessao'), 'Estado local da sessão.'), ...errors(403, 500) } },
      post: {
        tags: ['Sessão'], operationId: 'iniciarSessao', summary: 'Entrar com CPF e Senha Web',
        description: 'Substitui a sessão deste navegador. Use Senha Web da Prefeitura, não a senha gov.br. O cookie HttpOnly é recebido pelo navegador automaticamente.',
        requestBody: body(ref('Credenciais')),
        responses: { 200: { ...json(ref('Sessao'), 'Autenticado. Reutilize o cookie nas próximas chamadas.'), headers: { 'Set-Cookie': cookieHeader } }, ...errors(400, 401, 403, 409, 413, 415, 429, 500, 502, 504) },
      },
      delete: { tags: ['Sessão'], operationId: 'encerrarSessao', summary: 'Sair e fechar o navegador autenticado', description: 'Invalida o cookie e remove os documentos/diagnósticos temporários desta sessão.', responses: { 204: { description: 'Sessão encerrada; sem corpo.', headers: { 'Set-Cookie': cookieHeader } }, ...errors(403, 429, 500) } },
    },
    '/api/segunda-via': { post: emission(false) },
    '/api/segunda-via/json': { post: emission(true) },
    '/api/documentos/{id}/arquivo.pdf': cachedDocument('Pdf', 'Baixar o PDF já emitido', { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }),
    '/api/documentos/{id}/visualizar.pdf': cachedDocument('Previa', 'Visualizar o PDF já emitido', { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }),
    '/api/documentos/{id}/calculo.json': cachedDocument('Calculo', 'Ler o JSON do PDF já emitido', { 'application/json': { schema: ref('Calculo'), example } }),
    '/api/health': { get: { tags: ['Operação'], operationId: 'health', summary: 'Verificar se a API está disponível e ocupada', responses: { 200: json(object({ ok: { type: 'boolean' }, busy: { type: 'boolean' } }), 'API disponível.', { ok: true, busy: false }), ...errors(403, 500) } } },
    '/api/diagnostico.jpg': { get: { tags: ['Operação'], operationId: 'obterDiagnostico', summary: 'Obter a captura temporária de uma falha pós-login', description: 'Captura apenas a página do IPTU após login. Pode conter dados da consulta. Disponível à sessão responsável por até cinco minutos ou até a próxima emissão. Não captura senha ou tela de login.', security: sessionSecurity, responses: { 200: { description: 'Captura JPEG.', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } }, ...errors(403, 404, 500) } } },
  },
  components: {
    securitySchemes: { SessionCookie: { type: 'apiKey', in: 'cookie', name: 'iptu_session', description: 'Obtido por POST /api/sessao. Nesta UI, use o login normal; o navegador recebe e envia o cookie HttpOnly automaticamente.' } },
    schemas: {
      Credenciais: object(credentials), Consulta: object(query), LoginEConsulta: object({ ...credentials, ...query }),
      Sessao: object({ authenticated: { type: 'boolean' }, expiresAt: { type: 'integer', format: 'int64', nullable: true, description: 'Prazo de inatividade em milissegundos Unix, ou null sem sessão.' } }),
      Erro: object({ code: { type: 'string', example: 'SESSAO_EXPIRADA' }, error: { type: 'string', example: 'Entre com CPF e Senha Web para iniciar uma sessão.' } }, ['error']),
      Identificacao: object({ cadastro_imovel: { type: 'string', example: '000.000.0000-0' }, exercicio: { type: 'integer', example: 2026 }, notificacao_lancamento: { type: 'string', example: '01' } }),
      DadosTerreno: object({ area_incorporada_m2: number, area_nao_incorporada_m2: number, area_total_m2: number, testada_m: number }),
      DadosConstrucao: object({ area_construida_m2: number, area_ocupada_pela_construcao_m2: number, ano_construcao_corrigido: integer, padrao_construcao: text, uso: text }),
      BaseConstrucao: baseRow('A', ['fator_obsolescencia']),
      BaseTerrenoIncorporado: baseRow('B', ['fator_profundidade', 'fator_tipo_terreno', 'fator_condominio', 'fator_fracao_ideal']),
      BaseTerrenoNaoIncorporado: baseRow('C', ['fator_profundidade', 'fator_tipo_terreno', 'fator_condominio', 'fator_fracao_ideal']),
      ImpostoPredial: tax('D'), ImpostoTerritorial: tax('E'),
      ValorAPagar: object({ total_impostos_reais: number, valor_compensado_ou_credito_nf_eletronica_reais: number, atualizacao_monetaria_reais: number, total_a_pagar_reais: number, vencimento_primeira_prestacao: { type: 'string', format: 'date', nullable: true, description: 'Data ISO do PDF (não é um cálculo de vencimento atualizado).' } }),
      Calculo: { ...object({
        schema_versao: { type: 'string', enum: ['3.0'] }, moeda: { type: 'string', enum: ['BRL'] }, identificacao: ref('Identificacao'),
        dados_cadastrais: object({ terreno: ref('DadosTerreno'), construcao: ref('DadosConstrucao') }),
        demonstrativo_calculo: object({ bases_calculo: object({ construcao: ref('BaseConstrucao'), terreno_incorporado: ref('BaseTerrenoIncorporado'), terreno_nao_incorporado: ref('BaseTerrenoNaoIncorporado') }), imposto_predial: ref('ImpostoPredial'), imposto_territorial: ref('ImpostoTerritorial'), valor_a_pagar: ref('ValorAPagar') }),
      }), description: 'Valores copiados do PDF. Vazios são null, zeros permanecem 0, valores negativos são mantidos. Fatores são campos diretos das linhas. Alíquota não é convertida para porcentagem.', example },
    },
  },
};
