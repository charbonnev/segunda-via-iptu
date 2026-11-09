import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AppError } from './errors.js';

const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll('²', '2').replace(/\s+/g, ' ').trim().toUpperCase();
const invalid = () => new AppError(422, 'PDF_LAYOUT_NAO_RECONHECIDO', 'O demonstrativo do PDF não corresponde ao layout suportado. Nenhum valor foi inferido.');
const numberPattern = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;

export function parseBrazilianNumber(text) {
  if (!numberPattern.test(text)) throw invalid();
  const value = Number(text.replaceAll('.', '').replace(',', '.'));
  if (!Number.isFinite(value)) throw invalid();
  return value;
}

function dateValue(text) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(text)) throw invalid();
  const [day, month, year] = text.split('/');
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw invalid();
  return iso;
}

// Coordenadas são normalizadas para uma página A4. A leitura se ancora nos
// títulos e rótulos das células, não na ordem dos tokens no stream do PDF.
export function parseCalculationPages(pages) {
  const calcPages = pages.filter(items => items.some(i => normalize(i.text) === 'DEMONSTRATIVO DE CALCULO:'));
  if (calcPages.length !== 1) throw invalid();
  const items = calcPages[0].map(i => ({ ...i, key: normalize(i.text) }));
  const find = (pattern, top = -Infinity, bottom = Infinity) => {
    const matches = items.filter(i => pattern.test(i.key) && i.y > top && i.y < bottom);
    if (matches.length !== 1) throw invalid();
    return matches[0];
  };
  const bases = find(/^BASES DE CALCULO \(R\$\):$/);
  const predial = find(/^CALCULO DO IMPOSTO PREDIAL(?: \(R\$\):)?$/);
  const territorial = find(/^CALCULO DO IMPOSTO TERRITORIAL(?: \(R\$\):)?$/);
  const pagar = find(/^VALOR A PAGAR(?: \(R\$\):)?$/);
  const emissao = find(/^DATA DE EMISSAO:$/);
  if (!(bases.y < predial.y && predial.y < territorial.y && territorial.y < pagar.y && pagar.y < emissao.y)) throw invalid();
  for (const pattern of [/^AREAS \(M2\)$/, /^VALOR M2$/, /^FATORES$/, /^BASE DE CALCULO$/, /^FATOR$/]) {
    find(pattern, bases.y, predial.y);
  }

  function cell(label, next, bottom, kind = 'number') {
    const candidates = items.filter(i => i.x >= label.x - 2 && i.x < (next?.x ?? 575) - 2
      && i.y > label.y + 3 && i.y < bottom - 2);
    const annotations = /^(?:X|[+\-=]|= \([A-E]\)|\(A\) \+ \(B\) - DESCONTO|CREDITO DA NF ELETRONICA|DA 1[ªA]? PRESTACAO)$/;
    if (candidates.some(i => !numberPattern.test(i.text) && !/^\d{2}\/\d{2}\/\d{4}$/.test(i.text) && !annotations.test(i.key))) throw invalid();
    const values = candidates.filter(i => kind === 'date' ? /^\d{2}\/\d{2}\/\d{4}$/.test(i.text) : numberPattern.test(i.text));
    if (values.length > 1) throw invalid();
    if (values.length === 0) return null;
    if (kind === 'date') return dateValue(values[0].text);
    const negative = candidates.some(i => i.text === '-' && i.x < values[0].x && Math.abs(i.y - values[0].y) < 2);
    return parseBrazilianNumber(`${negative ? '-' : ''}${values[0].text}`);
  }
  function row(anchorPattern, labelPatterns, bottom, top = bases.y) {
    const anchor = find(anchorPattern, top, bottom);
    let previousX = -Infinity;
    const labels = labelPatterns.map(pattern => {
      const matches = items.filter(i => pattern.test(i.key) && Math.abs(i.y - anchor.y) < 2 && i.x > previousX).sort((a, b) => a.x - b.x);
      if (!matches.length) throw invalid();
      previousX = matches[0].x;
      return matches[0];
    });
    if (labels.some((label, i) => i && label.x <= labels[i - 1].x)) throw invalid();
    return labels.map((label, i) => cell(label, labels[i + 1], bottom));
  }
  const incorporated = find(/^TERRENO INCORP$/, bases.y, predial.y);
  const unincorporated = find(/^TERRENO NAO INCORP$/, bases.y, predial.y);
  const construction = row(/^CONSTRUIDA$/, [
    /^CONSTRUIDA$/, /^CONSTRUCAO$/, /^OBSOLESC$/, /^CONSTRUCAO$/, /^ESPECIAL$/,
  ], incorporated.y);
  // Os rótulos repetidos são diferenciados pela coluna, da esquerda à direita.
  const landPatterns = anchor => [anchor, /^TERRENO$/, /^PROFUND$/, /^TIPO TERR$/, /^CONDOMIN$/, /^FRACAO IDEAL$/,
    anchor.source.includes('NAO') ? /^TERR NAO INCORPORADO$/ : /^TERR INCORPORADO$/, /^ESPECIAL$/];
  const land = row(/^TERRENO INCORP$/, landPatterns(/^TERRENO INCORP$/), unincorporated.y);
  const otherLand = row(/^TERRENO NAO INCORP$/, landPatterns(/^TERRENO NAO INCORP$/), predial.y);
  find(/^= \(A\)$/, bases.y, incorporated.y);
  find(/^= \(B\)$/, incorporated.y, unincorporated.y);
  find(/^= \(C\)$/, unincorporated.y, predial.y);

  function tax(start, end, formula, reference) {
    find(new RegExp(`^= \\(${reference}\\)$`), start.y, end.y);
    if (reference === 'D') find(/^\(A\) \+ \(B\) - DESCONTO$/, start.y, end.y);
    else find(/^BASE DE CALCULO \(C\)$/, start.y, end.y);
    const patterns = [/^BASE DE CALCULO(?: \(C\))?$/, /^ALIQUOTA$/, /^DESCONTO\/ACRESCIMO$/, /^IMPOSTO CALCULADO$/,
      /^FAT ESPEC$/, /^DEDUCOES\/ACRESCIMOS$/, /^IMPOSTO A PAGAR$/];
    const labels = patterns.map(pattern => find(pattern, start.y, end.y));
    if (labels.some((label, i) => i && label.x <= labels[i - 1].x)) throw invalid();
    const values = labels.map((label, i) => cell(label, labels[i + 1], end.y));
    return {
      base_calculo_reais: values[0], formula_base_calculo: formula,
      aliquota: values[1], desconto_acrescimo_reais: values[2], imposto_calculado_reais: values[3],
      fator_especial: values[4], deducoes_acrescimos_reais: values[5], imposto_a_pagar_reais: values[6], referencia_pdf: reference,
    };
  }
  const finalLabels = [/^TOTAL DOS IMPOSTOS \(D\) \+ \(E\)$/, /^VALOR COMPENSADO E\/OU$/, /^ATUALIZACAO MONETARIA$/,
    /^TOTAL A PAGAR$/, /^DATA DE VENCIMENTO$/].map(p => find(p, pagar.y, emissao.y));
  const finalValues = finalLabels.map((label, i) => cell(label, finalLabels[i + 1], emissao.y, i === 4 ? 'date' : 'number'));
  if (finalValues[0] === null || finalValues[3] === null) throw invalid();
  const header = pages[0].filter(i => i.y < 130);
  const cadastro = header.filter(i => /^\d{3}\.\d{3}\.\d{4}-\d$/.test(i.text));
  const exerciseLabel = header.find(i => normalize(i.text) === 'EXERCICIO');
  const nlLabel = header.find(i => normalize(i.text) === 'NL');
  if (cadastro.length !== 1 || !exerciseLabel || !nlLabel) throw invalid();
  const headerValue = (label, pattern) => {
    const found = header.filter(i => pattern.test(i.text) && i.y > label.y && i.y < label.y + 30 && Math.abs(i.x - label.x) < 30);
    if (found.length !== 1) throw invalid();
    return found[0].text;
  };
  const factors = values => ({ fator_profundidade: values[2], fator_tipo_terreno: values[3], fator_condominio: values[4], fator_fracao_ideal: values[5] });
  const cadastralLand = find(/^DADOS CADASTRAIS DO TERRENO:$/);
  const cadastralConstruction = find(/^DADOS CADASTRAIS DA CONSTRUCAO:$/);
  const demonstration = find(/^DEMONSTRATIVO DE CALCULO:$/);
  if (Math.abs(cadastralLand.y - cadastralConstruction.y) > 3 || cadastralLand.x >= cadastralConstruction.x
    || cadastralLand.y >= demonstration.y) throw invalid();
  function cadastralValue(pattern, block, kind = 'number') {
    const left = block === 'terreno' ? cadastralLand.x - 3 : cadastralConstruction.x - 3;
    const right = block === 'terreno' ? cadastralConstruction.x - 5 : 575;
    const labels = items.filter(i => pattern.test(i.key) && i.x >= left && i.x < right && i.y > cadastralLand.y && i.y < demonstration.y);
    if (labels.length !== 1) throw invalid();
    const label = labels[0];
    const values = items.filter(i => i.x > label.x + 1 && i.x < right && Math.abs(i.y - label.y) < 2).sort((a, b) => a.x - b.x);
    if (!values.length) return null;
    if (kind === 'text') return values.map(i => i.text).join(' ');
    if (values.length !== 1) throw invalid();
    const value = parseBrazilianNumber(values[0].text);
    if (kind === 'integer' && !Number.isInteger(value)) throw invalid();
    return value;
  }
  const landBase = (values, reference) => ({
    area_m2: values[0], valor_m2_reais: values[1], ...factors(values),
    base_calculo_reais: values[6], fator_especial: values[7], referencia_pdf: reference,
  });
  return {
    schema_versao: '3.0', moeda: 'BRL',
    identificacao: { cadastro_imovel: cadastro[0].text, exercicio: Number(headerValue(exerciseLabel, /^\d{4}$/)), notificacao_lancamento: headerValue(nlLabel, /^\d{1,3}$/) },
    dados_cadastrais: {
      terreno: {
        area_incorporada_m2: cadastralValue(/^AREA INCORPORADA \(M2\):$/, 'terreno'),
        area_nao_incorporada_m2: cadastralValue(/^AREA NAO INCORPORADA \(M2\):$/, 'terreno'),
        area_total_m2: cadastralValue(/^AREA TOTAL \(M2\):$/, 'terreno'),
        testada_m: cadastralValue(/^TESTADA \(M\):$/, 'terreno'),
      },
      construcao: {
        area_construida_m2: cadastralValue(/^AREA CONSTRUIDA \(M2\):$/, 'construcao'),
        area_ocupada_pela_construcao_m2: cadastralValue(/^AREA OCUPADA PELA CONSTRUCAO \(M2\):$/, 'construcao'),
        ano_construcao_corrigido: cadastralValue(/^ANO DA CONSTRUCAO CORRIGIDO:$/, 'construcao', 'integer'),
        padrao_construcao: cadastralValue(/^PADRAO DA CONSTRUCAO:$/, 'construcao', 'text'),
        uso: cadastralValue(/^USO:$/, 'construcao', 'text'),
      },
    },
    demonstrativo_calculo: {
      bases_calculo: {
        construcao: {
          area_m2: construction[0], valor_m2_reais: construction[1], fator_obsolescencia: construction[2],
          base_calculo_reais: construction[3], fator_especial: construction[4], referencia_pdf: 'A',
        },
        terreno_incorporado: landBase(land, 'B'),
        terreno_nao_incorporado: landBase(otherLand, 'C'),
      },
      imposto_predial: tax(predial, territorial, '(A) + (B) - DESCONTO', 'D'),
      imposto_territorial: tax(territorial, pagar, '(C)', 'E'),
      valor_a_pagar: {
        total_impostos_reais: finalValues[0], valor_compensado_ou_credito_nf_eletronica_reais: finalValues[1],
        atualizacao_monetaria_reais: finalValues[2], total_a_pagar_reais: finalValues[3], vencimento_primeira_prestacao: finalValues[4],
      },
    },
  };
}

export async function extractCalculation(pdf) {
  let task;
  try {
    task = getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, useSystemFonts: true });
    const document = await task.promise;
    if (document.numPages > 5) throw invalid();
    const pages = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      if (page.rotate !== 0) throw invalid();
      const [x0, y0, x1, y1] = page.view;
      const { items } = await page.getTextContent();
      pages.push(items.filter(i => i.str?.trim()).map(i => ({ text: i.str.trim(), x: (i.transform[4] - x0) * 595.276 / (x1 - x0), y: (y1 - i.transform[5]) * 841.89 / (y1 - y0) })));
      page.cleanup();
    }
    return parseCalculationPages(pages);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'PDF_INVALIDO', 'Não foi possível ler o texto do PDF para extrair o cálculo.');
  } finally { await task?.destroy().catch(() => {}); }
}
