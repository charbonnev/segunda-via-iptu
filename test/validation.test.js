import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCredentials, validateInput, validateQuery } from '../src/validation.js';

test('CPF e CNPJ aceitam pontuação no campo novo e no alias anterior', () => {
  for (const [document, normalized] of [['123.456.789-00', '12345678900'], ['00.000.000/0000-00', '00000000000000']]) {
    for (const field of ['cpfCnpj', 'cpf']) {
      assert.deepEqual(validateCredentials({ [field]: document, senha: 'exemplo' }), { cpf: normalized, senha: 'exemplo' });
      assert.deepEqual(validateCredentials({ [field]: normalized, senha: 'exemplo' }), { cpf: normalized, senha: 'exemplo' });
    }
  }
});

test('identificadores duplicados precisam coincidir após normalização', () => {
  assert.equal(validateCredentials({ cpfCnpj: '00.000.000/0000-00', cpf: '00000000000000', senha: 'exemplo' }).cpf, '00000000000000');
  assert.throws(() => validateCredentials({ cpfCnpj: '00000000000000', cpf: '12345678900', senha: 'exemplo' }), { status: 400 });
});

test('recusa documentos fora de 11/14 dígitos e tipos inválidos', () => {
  for (const document of [null, 12345678900, [], '', 'x'.repeat(14), ...[10, 12, 13, 15].map(length => '0'.repeat(length))]) {
    assert.throws(() => validateCredentials({ cpfCnpj: document, senha: 'exemplo' }), { code: 'DADOS_INVALIDOS', status: 400 });
  }
  assert.throws(() => validateCredentials({ cpfCnpj: null, cpf: '12345678900', senha: 'exemplo' }), { status: 400 });
});

test('emissão combinada aceita CNPJ, mas cadastro SQL mantém 11 dígitos', () => {
  assert.deepEqual(validateInput({ cpfCnpj: '00.000.000/0000-00', senha: 'exemplo', cadastro: '000.000.0000-0', exercicio: 2026 }), {
    cpf: '00000000000000', senha: 'exemplo', cadastro: '00000000000', exercicio: '2026',
  });
  assert.throws(() => validateQuery({ cadastro: '00000000000000', exercicio: 2026 }), { status: 400 });
});
