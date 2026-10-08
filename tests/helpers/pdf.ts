import { deflateSync } from 'node:zlib';

/** Minimal one-page PDF with a single RGB image XObject /I drawn by `content`. */
export function pdfWithImage(content: string, width: number, height: number, rgb: Uint8Array) {
  const data = deflateSync(rgb);
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const offsets: number[] = [];
  let length = chunks[0].length;
  const add = (...parts: (string | Buffer)[]) => {
    offsets.push(length);
    for (const part of parts) {
      const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1');
      chunks.push(buffer);
      length += buffer.length;
    }
  };
  add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  add(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] ',
    '/Resources << /XObject << /I 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  );
  add(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  add(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `,
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
    data,
    '\nendstream\nendobj\n',
  );
  const xref = length;
  chunks.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
        `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(chunks));
}
