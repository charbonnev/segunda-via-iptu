# Segunda via de IPTU — São Paulo

API local com front mínimo para emitir o PDF da **Notificação de Lançamento (2ª via)**. Não emite guia de pagamento e não efetua pagamentos.

## Executar

Requer Node.js 22.13 ou posterior.

```sh
npm ci
npm run browser:install
npm start
```

Abra http://127.0.0.1:3000. Informe CPF, **Senha Web da Prefeitura**, SQL e exercício. As credenciais gov.br não são compatíveis com este fluxo.

O comando `npm start` precisa continuar em execução enquanto você usa a tela. Uma aba já carregada pode permanecer visível mesmo depois de o servidor parar.

Em Linux com systemd de usuário, é possível manter o servidor independente do terminal/conversa. Na pasta do projeto:

```sh
systemd-run --user --unit=segunda-via-iptu --collect --working-directory="$PWD" --property=Restart=on-failure "$(command -v node)" src/server.js
systemctl --user status segunda-via-iptu
```

Para parar: `systemctl --user stop segunda-via-iptu`. Esse serviço é transitório, não inicia automaticamente após reiniciar o computador. Antes de executar `npm start`, pare o serviço para liberar a porta 3000.

Caso o Chromium informe falta de bibliotecas do sistema, use `npx playwright install-deps chromium` conforme sua distribuição. Em servidores sem interface gráfica, mantenha HEADLESS=true (padrão).

Variáveis opcionais: `PORT` (3000), `HEADLESS` (true) e `PORTAL_TIMEOUT_MS` (120000; entre 10000 e 300000). `.env.example` é uma referência; para carregar um `.env` próprio, execute `node --env-file=.env src/server.js`. Não coloque credenciais nele.

## API

A documentação interativa Swagger UI está em **http://127.0.0.1:3000/docs/**. A especificação OpenAPI 3.0.3 está em **http://127.0.0.1:3000/openapi.json** (também em `/api/openapi.json`), pronta para importar no Postman, Insomnia ou gerar clientes.

Para testar pelo Swagger: execute `POST /api/sessao` com CPF e Senha Web; depois execute as emissões com cadastro e exercício. O navegador envia automaticamente o cookie recebido. Não é necessário preencher **Authorize** nem copiar o cookie HttpOnly. **Execute** faz chamadas reais, incluindo login e emissão; use `GET /api/health` para um teste sem acessar a Prefeitura. A documentação usa arquivos locais, sem CDN ou validação externa da especificação.

Faça o login uma vez com `POST /api/sessao`, usando `Content-Type: application/json`:

```json
{ "cpf": "00000000000", "senha": "SUA_SENHA_WEB" }
```

A resposta define um cookie de sessão `iptu_session`, com `HttpOnly` e `SameSite=Strict`, sem CPF ou senha. O front envia esse cookie automaticamente. Em outros clientes HTTP, conserve os cookies entre as chamadas (por exemplo, com um cookie jar).

Depois, `POST /api/segunda-via` recebe apenas os dados da consulta:

```json
{ "cadastro": "000.000.0000-0", "exercicio": 2026 }
```

`GET /api/sessao` informa `{ "authenticated": true, "expiresAt": 1790000000000 }` (data de exemplo em milissegundos Unix). `DELETE /api/sessao` fecha o navegador autenticado, invalida o cookie e limpa os documentos/diagnósticos temporários.

A sessão local dura **15 minutos sem uso**. Recarregar a página não exige novo login. A Prefeitura pode encerrar a sessão antes desse prazo; nesse caso a próxima emissão retorna 401 e pede autenticação novamente. Reiniciar o serviço também encerra todas as sessões. A aplicação não armazena a senha para refazer login automaticamente.

O formato original de quatro campos continua aceito para abrir a sessão e emitir na mesma solicitação:

```json
{
  "cpf": "00000000000",
  "senha": "SUA_SENHA_WEB",
  "cadastro": "000.000.0000-0",
  "exercicio": 2026
}
```

CPF fictício no exemplo. CPF e SQL aceitam pontuação. A resposta de sucesso é o arquivo binário `application/pdf`, com `Content-Disposition: attachment`. Erros retornam JSON `{ "code": "...", "error": "..." }`.

| Status | Situação |
| --- | --- |
| 400 / 413 / 415 | Dados, tamanho ou tipo de requisição inválido |
| 401 | Acesso recusado ou sessão expirada |
| 403 | Host/origem fora da interface local |
| 409 | CAPTCHA ou interação adicional identificada |
| 422 | Sem resultado ou sem uma única notificação ativa |
| 429 | Uma emissão já está em andamento |
| 502 / 504 | Portal indisponível, mudança de fluxo ou tempo limite |

`GET /api/health` informa `{ "ok": true, "busy": false }`.

## JSON do demonstrativo de cálculo

`POST /api/segunda-via/json` recebe os mesmos dados da emissão: com sessão ativa, apenas `cadastro` e `exercicio`. O endpoint emite o PDF e extrai dele o JSON, sem consultar outras fontes nem recalcular os valores. A resposta é `application/json`.

Para extrair de um PDF **já emitido**, use `GET /api/documentos/:id/calculo.json` (URL retornada no cabeçalho `X-JSON-URL` da emissão). Esse GET não faz outro login nem emite um novo documento. O front oferece o botão **Ver dados em JSON**. O PDF continua disponível pelos cabeçalhos `X-PDF-URL` e `X-PDF-Preview-URL`.

A estrutura segue os cabeçalhos e subcélulas do demonstrativo:

```text
identificacao
  cadastro_imovel, exercicio, notificacao_lancamento
dados_cadastrais
  terreno → area_incorporada_m2, area_nao_incorporada_m2, area_total_m2, testada_m
  construcao → area_construida_m2, area_ocupada_pela_construcao_m2,
    ano_construcao_corrigido, padrao_construcao, uso
demonstrativo_calculo
  bases_calculo
    construcao → area_m2, valor_m2_reais, fator_obsolescencia,
      base_calculo_reais, fator_especial, referencia_pdf
    terreno_incorporado → area_m2, valor_m2_reais,
      fator_profundidade, fator_tipo_terreno, fator_condominio, fator_fracao_ideal,
      base_calculo_reais, fator_especial, referencia_pdf
    terreno_nao_incorporado → mesmos campos do terreno incorporado
  imposto_predial → base_calculo_reais, aliquota, desconto_acrescimo_reais,
    imposto_calculado_reais, fator_especial, deducoes_acrescimos_reais, imposto_a_pagar_reais
  imposto_territorial → mesmos campos do predial
  valor_a_pagar → total_impostos_reais, valor_compensado_ou_credito_nf_eletronica_reais,
    atualizacao_monetaria_reais, total_a_pagar_reais, vencimento_primeira_prestacao
```

Consulte [examples/calculo.json](examples/calculo.json) para o exemplo completo, com cadastro fictício. `schema_versao` identifica o contrato (**3.0**) e `moeda` é BRL. A versão 2.0 incluiu os dados cadastrais e substituiu o agrupamento por coluna por três linhas em `bases_calculo`: `construcao`, `terreno_incorporado` e `terreno_nao_incorporado`. A versão 3.0 remove o objeto intermediário `fatores`: cada fator é um campo direto da linha, com prefixo `fator_`. Os endpoints não mudam.

Célula vazia é `null`; `0,00` é `0`. Números usam a representação JSON (`1.499,00` vira `1499`, `0,010` vira `0.01`) e datas usam ISO (`2026-02-10`). A alíquota é copiada como está, sem converter para porcentagem. Valores negativos são preservados. O ano corrigido é inteiro; padrão e uso são textos. Os dados cadastrais são lidos separadamente do demonstrativo: uma área cadastral preenchida com zero não substitui uma célula vazia da base de cálculo. Não são extraídos nome ou CPF do solicitante.

A extração usa texto e coordenadas do PDF, ancorados nos rótulos do modelo de notificação validado. Não depende da ordem interna dos tokens. Se faltar um cabeçalho, houver valor ambíguo ou o layout mudar, retorna 422 `PDF_LAYOUT_NAO_RECONHECIDO`; PDF sem texto legível retorna `PDF_INVALIDO`. Não há OCR nem substituição de campos ilegíveis por zero. O cadastro e o exercício extraídos são comparados com a consulta; divergência retorna `PDF_DIVERGENTE`.

## Fluxo e dados

1. Abre o portal oficial em um navegador Chromium isolado e faz o login Senha Web.
2. Seleciona o perfil **Titular** se a tela de representações aparecer.
3. Consulta SQL e exercício e seleciona a única notificação **Ativa**.
4. Clica em Gerar, deixa proprietário e compromissário vazios e confirma OK.
5. Captura o download, verifica a assinatura `%PDF-` e responde com o PDF.

O fluxo de consulta/download com campos de identificação vazios foi validado manualmente no portal em 09/11/2026. A via gerada preserva a informação de contribuinte protegida por sigilo fiscal. A seleção de empresas representadas não faz parte desta versão.

Não é necessário gerar tokens manualmente: os cookies, anti-CSRF, PKCE e campos ASP.NET são tratados pelo navegador durante o fluxo oficial. O mesmo navegador e contexto são reutilizados durante a sessão, com um limite de quatro sessões locais simultâneas. Ao sair ou expirar, o navegador é fechado. Não é exportado um perfil persistente nem um arquivo de estado de autenticação. CPF e senha são usados apenas na autenticação e não são guardados no objeto da sessão. O download temporário do Playwright é excluído após a leitura do PDF. A aplicação não registra corpos de requisição ou erros brutos do navegador.

Para compatibilidade com o navegador integrado, a API mantém o último PDF **em memória por até cinco minutos**, ou até a próxima emissão bem-sucedida. Os cabeçalhos `X-PDF-URL` e `X-PDF-Preview-URL` da resposta apontam para URLs HTTP locais com identificador aleatório, usadas pela interface para baixar e visualizar o arquivo. A resposta original continua sendo o PDF binário. Após expirar, as URLs retornam 404. Só o botão Baixar salva uma cópia escolhida pelo usuário.

O serviço escuta exclusivamente em `127.0.0.1`, rejeita origens externas e executa uma emissão de cada vez. É uma ferramenta local, sem autenticação própria para hospedagem pública. Desafios CAPTCHA/MFA não são resolvidos nem contornados. Um desafio não reconhecido ou alteração do portal pode aparecer como erro de prazo ou de fluxo.

Erros de prazo identificam a etapa, por exemplo `abrir_portal`, `enviar_login`, `enviar_consulta` ou `download`. O serviço registra apenas esse identificador fixo para diagnóstico. Se a abertura inicial expirar sem mostrar um formulário conhecido, a navegação GET é repetida uma única vez; o envio de credenciais nunca é repetido automaticamente. Nos postbacks, aguarda-se o resultado esperado, sem esperar pelo carregamento de recursos auxiliares da página.

Se houver falha após o login na tela do IPTU, a API mantém uma captura dessa tela **somente em memória**, por até cinco minutos ou até a próxima emissão, para diagnóstico em `GET /api/diagnostico.jpg`. Ela pode conter dados da consulta. Não são capturadas telas de login, senhas, tokens ou cookies; a captura não é gravada em disco pela aplicação.

## Testes e limites de verificação

```sh
npm test
```

Os testes verificam validação, resposta PDF, sigilo dos erros, concorrência, cancelamento, cookie de sessão, restauração após recarregar, logout, expiração e duas emissões com um único login em portal simulado. Não enviam credenciais à Prefeitura. A reutilização ponta a ponta da sessão real precisa ser testada pela interface local; a aplicação não herda a sessão do navegador integrado.

Base técnica: [autenticação](https://playwright.dev/docs/auth), [downloads do Playwright](https://playwright.dev/docs/downloads) e [Express](https://expressjs.com/en/5x/api/).
