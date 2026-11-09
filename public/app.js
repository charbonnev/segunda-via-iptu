const form = document.querySelector('#form');
const submit = document.querySelector('#submit');
const status = document.querySelector('#status');
const download = document.querySelector('#download');
const preview = document.querySelector('#preview');
const empty = document.querySelector('#empty');
const showJson = document.querySelector('#show-json');
const jsonPreview = document.querySelector('#json-preview');
let jsonUrl;
showJson.addEventListener('click', async () => {
  if (!jsonUrl) return;
  showJson.disabled = true;
  try {
    const response = await fetch(jsonUrl);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível extrair o JSON.');
    jsonPreview.textContent = JSON.stringify(data, null, 2);
    jsonPreview.hidden = false;
  } catch (error) { status.className = 'error'; status.hidden = false; status.textContent = error.message; }
  finally { showJson.disabled = false; }
});
let objectUrl;
let authenticated = false;
const credentials = document.querySelector('#credentials');
const sessionPanel = document.querySelector('#session-panel');
const logout = document.querySelector('#logout');
function setSession(active) {
  authenticated = active;
  credentials.hidden = credentials.disabled = active;
  sessionPanel.hidden = !active;
  if (active) document.querySelector('#cpf').value = '';
  document.querySelector('#senha').value = '';
}
async function checkSession() {
  const response = await fetch('/api/sessao');
  if (!response.ok) throw new Error('Não foi possível verificar a sessão local.');
  setSession((await response.json()).authenticated);
}
submit.disabled = true;
checkSession().catch(() => setSession(false)).finally(() => { submit.disabled = false; });
logout.addEventListener('click', async () => {
  submit.disabled = logout.disabled = true;
  try {
    const response = await fetch('/api/sessao', { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error);
    setSession(false);
    preview.removeAttribute('src');
    download.removeAttribute('href');
    preview.hidden = download.hidden = true;
    showJson.hidden = jsonPreview.hidden = true;
    jsonUrl = undefined;
    status.hidden = false;
    status.className = '';
    status.textContent = 'Sessão encerrada. Entre novamente para consultar.';
  } catch (error) { status.hidden = false; status.className = 'error'; status.textContent = error.message; }
  finally { submit.disabled = logout.disabled = false; }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const payload = Object.fromEntries(new FormData(form));
  const cadastro = payload.cadastro.replace(/\D/g, '');
  const exercicio = payload.exercicio;
  document.querySelector('#senha').value = '';
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
  preview.removeAttribute('src');
  download.removeAttribute('href');
  preview.hidden = download.hidden = empty.hidden = true;
  showJson.hidden = jsonPreview.hidden = true;
  jsonPreview.textContent = '';
  jsonUrl = undefined;
  status.hidden = false;
  status.className = '';
  status.textContent = 'Acessando a Prefeitura e gerando o documento… Isso pode levar até alguns minutos.';
  submit.disabled = logout.disabled = true;
  form.setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 325000);
  try {
    if (!authenticated) {
      status.textContent = 'Entrando com sua Senha Web…';
      const login = await fetch('/api/sessao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf: payload.cpf, senha: payload.senha }), signal: controller.signal,
      });
      delete payload.senha;
      if (!login.ok) throw new Error((await login.json()).error || 'Não foi possível entrar.');
      setSession(true);
    }
    status.textContent = 'Consultando a Prefeitura com a sessão conectada…';
    const response = await fetch('/api/segunda-via', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cadastro: payload.cadastro, exercicio: payload.exercicio }),
      signal: controller.signal,
    });
    delete payload.senha;
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) setSession(false);
      throw new Error(result.error || 'Não foi possível gerar o PDF.');
    }
    if (!response.headers.get('content-type')?.includes('application/pdf')) throw new Error('A API não retornou um PDF.');
    const blob = await response.blob();
    const pdfUrl = response.headers.get('X-PDF-URL');
    const previewUrl = response.headers.get('X-PDF-Preview-URL');
    jsonUrl = response.headers.get('X-JSON-URL');
    showJson.hidden = !jsonUrl;
    if (!pdfUrl) objectUrl = URL.createObjectURL(blob);
    download.href = pdfUrl || objectUrl;
    download.download = `iptu-${cadastro}-${exercicio}.pdf`;
    preview.src = previewUrl || objectUrl;
    download.hidden = preview.hidden = false;
    status.textContent = 'Documento gerado. Você já pode baixar a segunda via.';
  } catch (error) {
    status.className = 'error';
    status.textContent = error.name === 'AbortError' ? 'O tempo limite foi atingido. Tente novamente.'
      : error instanceof TypeError ? 'O servidor local está indisponível. Inicie-o com npm start na pasta do projeto e tente novamente.' : error.message;
  } finally {
    delete payload.senha;
    clearTimeout(timer);
    submit.disabled = logout.disabled = false;
    form.removeAttribute('aria-busy');
  }
});
window.addEventListener('pagehide', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
