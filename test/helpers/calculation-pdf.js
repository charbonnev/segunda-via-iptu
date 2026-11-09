import { readFile } from 'node:fs/promises';

export async function calculationItems() {
  return JSON.parse(await readFile(new URL('../fixtures/calculo-items.json', import.meta.url), 'utf8'));
}

// PDF sintético de teste: só rótulos/células de cálculo e cadastro fictício.
export async function calculationPdf(pages = undefined) {
  pages ??= await calculationItems();
  const content = pages[0].map(item => {
    const encoded = [...item.text].map(char => {
      const code = char.codePointAt(0);
      if (code > 255) throw new Error('Caractere fora de WinAnsi no fixture.');
      if (code >= 128) return `\\${code.toString(8).padStart(3, '0')}`;
      return char.replace(/([\\()])/g, '\\$1');
    }).join('');
    return `BT /F1 8 Tf 1 0 0 1 ${item.x} ${841.89 - item.y} Tm (${encoded}) Tj ET`;
  }).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const startXref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;
  return Buffer.from(output);
}
