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

/** Minimal PDF with Helvetica as /F; each content string is one 600×800 page. */
export function pdfWithText(pages: string[], pageAttributes = '') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  for (const [i, content] of pages.entries())
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] ${pageAttributes} /Resources << /Font << /F 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  let body = '%PDF-1.7\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.indexOf('xref\n')}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}
/** Text at a baseline in PDF space, 10 pt Helvetica. */
export const text = (x: number, y: number, value: string) =>
  `BT /F 10 Tf ${x} ${y} Td (${value}) Tj ET`;

/** Small object-level PDF builder: 600×800 pages, Helvetica as /F, Flate RGB images. */
export class TestPdf {
  private objects: Buffer[] = [];
  private pages: number[] = [];
  private font = this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  /** Adds an object (optionally a stream) and returns its number. */
  add(dict: string, stream?: Buffer) {
    this.objects.push(
      stream
        ? Buffer.concat([
            Buffer.from(
              `${dict.replace(/>>$/, `/Length ${stream.length} >>`)}\nstream\n`,
              'latin1',
            ),
            stream,
            Buffer.from('\nendstream'),
          ])
        : Buffer.from(dict, 'latin1'),
    );
    return this.objects.length;
  }
  /** RGB image of `width`×`height` filled by `pixel(x, y)`; `alpha` adds a gray soft mask. */
  image(
    width: number,
    height: number,
    pixel: (x: number, y: number) => number[],
    alpha?: (x: number, y: number) => number,
  ) {
    const encode = (values: number[]) => deflateSync(Buffer.from(values));
    const rgb = encode(
      Array.from({ length: width * height }, (_, i) =>
        pixel(i % width, Math.floor(i / width)),
      ).flat(),
    );
    const smask = alpha
      ? this.add(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>`,
          encode(
            Array.from({ length: width * height }, (_, i) =>
              alpha(i % width, Math.floor(i / width)),
            ),
          ),
        )
      : 0;
    return this.add(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask ? ` /SMask ${smask} 0 R` : ''} >>`,
      rgb,
    );
  }
  /**
   * A page drawing `content`. Options: `xobjects` and `fonts` by resource name (fonts sit next to
   * Helvetica as /F), `resources` adds resource dictionary entries (e.g. `/Shading << ... >>`)
   * and `extra` page dictionary entries.
   */
  page(
    content: string,
    {
      xobjects = {},
      extra = '',
      resources = '',
      fonts = {},
    }: {
      xobjects?: Record<string, number>;
      extra?: string;
      resources?: string;
      fonts?: Record<string, number>;
    } = {},
  ) {
    const refs = (map: Record<string, number>) =>
      Object.entries(map)
        .map(([name, ref]) => `/${name} ${ref} 0 R`)
        .join(' ');
    const names = refs(xobjects),
      fontNames = refs(fonts);
    const stream = this.add('<< >>', Buffer.from(content, 'latin1'));
    this.pages.push(
      this.add(
        `<< /Type /Page /Parent PAGES /MediaBox [0 0 600 800] /Resources << /Font << /F ${this.font} 0 R ${fontNames} >> /XObject << ${names} >> ${resources} >> /Contents ${stream} 0 R ${extra} >>`,
      ),
    );
  }
  build() {
    const pagesRef = this.objects.length + 1,
      catalogRef = pagesRef + 1;
    const objects = [
      ...this.objects.map((o) =>
        Buffer.from(
          o.toString('latin1').replace('/Parent PAGES', `/Parent ${pagesRef} 0 R`),
          'latin1',
        ),
      ),
      Buffer.from(
        `<< /Type /Pages /Kids [${this.pages.map((p) => `${p} 0 R`).join(' ')}] /Count ${this.pages.length} >>`,
      ),
      Buffer.from(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`),
    ];
    const chunks = [Buffer.from('%PDF-1.7\n')];
    let length = chunks[0].length;
    const offsets = objects.map((object, i) => {
      const offset = length;
      const chunk = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`),
        object,
        Buffer.from('\nendobj\n'),
      ]);
      chunks.push(chunk);
      length += chunk.length;
      return offset;
    });
    chunks.push(
      Buffer.from(
        `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalogRef} 0 R >>\nstartxref\n${length}\n%%EOF\n`,
      ),
    );
    return new Uint8Array(Buffer.concat(chunks));
  }
}
