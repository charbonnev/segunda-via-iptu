import { AppError } from './errors.js';

function digits(value, size, label) {
  if (typeof value !== 'string' || !/^[\d.\s/-]+$/.test(value)) {
    throw new AppError(400, 'DADOS_INVALIDOS', `${label} inválido.`);
  }
  const result = value.replace(/\D/g, '');
  if (result.length !== size) throw new AppError(400, 'DADOS_INVALIDOS', `${label} deve ter ${size} dígitos.`);
  return result;
}

function objectBody(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    throw new AppError(400, 'DADOS_INVALIDOS', 'Envie um objeto JSON.');
  }
}

export function validateCredentials(body) {
  objectBody(body);
  const cpf = digits(body.cpf, 11, 'CPF');
  if (typeof body.senha !== 'string' || !body.senha.trim() || body.senha.length > 256) {
    throw new AppError(400, 'DADOS_INVALIDOS', 'Informe a senha (até 256 caracteres).');
  }
  return { cpf, senha: body.senha };
}

export function validateQuery(body) {
  objectBody(body);
  const cadastro = digits(body.cadastro, 11, 'Cadastro do imóvel');
  const exercicio = String(body.exercicio ?? '');
  if (!/^\d{4}$/.test(exercicio) || +exercicio < 1900 || +exercicio > 2100) {
    throw new AppError(400, 'DADOS_INVALIDOS', 'Exercício deve ser um ano entre 1900 e 2100.');
  }
  return { cadastro, exercicio };
}

export function validateInput(body) {
  return { ...validateCredentials(body), ...validateQuery(body) };
}
