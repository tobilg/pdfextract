import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';

// Deliberately small PDF writer for test data, not a parser or runtime engine.
export class FixturePdf {
  objects = [null, '', ''];
  pages = [];
  encryption;
  password(password) {
    const padding = Buffer.from(
      '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
      'hex',
    );
    const padded = (s) => Buffer.concat([Buffer.from(s), padding]).subarray(0, 32);
    const md5 = (data) => createHash('md5').update(data).digest();
    const rc4 = (key, data) => {
      const s = Array.from({ length: 256 }, (_, i) => i);
      for (let i = 0, j = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) % 256;
        [s[i], s[j]] = [s[j], s[i]];
      }
      let i = 0,
        j = 0;
      return Buffer.from(
        data.map((value) => {
          i = (i + 1) % 256;
          j = (j + s[i]) % 256;
          [s[i], s[j]] = [s[j], s[i]];
          return value ^ s[(s[i] + s[j]) % 256];
        }),
      );
    };
    const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const owner = rc4(md5(padded('fixture-owner')).subarray(0, 5), padded(password));
    const key = md5(
      Buffer.concat([padded(password), owner, Buffer.from([252, 255, 255, 255]), id]),
    ).subarray(0, 5);
    const user = rc4(key, padding);
    const ref = this.add(
      `<< /Filter /Standard /V 1 /R 2 /P -4 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> >>`,
    );
    this.encryption = {
      trailer: `/Encrypt ${ref} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`,
      encode: (bytes, number) =>
        rc4(
          md5(
            Buffer.concat([
              key,
              Buffer.from([number & 255, (number >> 8) & 255, (number >> 16) & 255, 0, 0]),
            ]),
          ).subarray(0, 10),
          bytes,
        ),
    };
  }
  add(value) {
    this.objects.push(value);
    return this.objects.length - 1;
  }
  stream(dict, bytes) {
    bytes = Buffer.from(bytes);
    if (this.encryption) bytes = this.encryption.encode(bytes, this.objects.length);
    return this.add(
      Buffer.concat([
        Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`),
        bytes,
        Buffer.from('\nendstream'),
      ]),
    );
  }
  image(width, height, bytes, extra = '', color = '/DeviceRGB') {
    return this.stream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /ColorSpace ${color} /Filter /FlateDecode ${extra}`,
      deflateSync(Buffer.from(bytes)),
    );
  }
  page(content, resources, extra = '') {
    const stream = this.stream('', Buffer.from(content, 'binary'));
    this.pages.push(
      this.add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << ${resources} >> /Contents ${stream} 0 R ${extra} >>`,
      ),
    );
  }
  bytes() {
    this.objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    this.objects[2] = `<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map((n) => `${n} 0 R`).join(' ')}] >>`;
    const chunks = [Buffer.from('%PDF-1.7\n%\x80\x81\x82\x83\n', 'binary')],
      offsets = [0];
    let length = chunks[0].length;
    for (let n = 1; n < this.objects.length; n++) {
      offsets[n] = length;
      const b = Buffer.concat([
        Buffer.from(`${n} 0 obj\n`),
        Buffer.from(this.objects[n]),
        Buffer.from('\nendobj\n'),
      ]);
      chunks.push(b);
      length += b.length;
    }
    chunks.push(
      Buffer.from(
        `xref\n0 ${this.objects.length}\n0000000000 65535 f \n${offsets
          .slice(1)
          .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
          .join(
            '',
          )}trailer\n<< /Size ${this.objects.length} /Root 1 0 R ${this.encryption?.trailer ?? ''} >>\nstartxref\n${length}\n%%EOF\n`,
      ),
    );
    return Buffer.concat(chunks);
  }
}
export async function generate() {
  await mkdir('tests/fixtures', { recursive: true });
  const save = (name, p) => writeFile(`tests/fixtures/${name}.pdf`, p.bytes());
  const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const p = new FixturePdf();
  const font = p.add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const mask = p.image(2, 2, [255, 128, 0, 255], '', '/DeviceGray');
  const im = p.image(2, 2, rgb, `/SMask ${mask} 0 R`);
  const form = p.stream(
    `/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Im ${im} 0 R >> >>`,
    Buffer.from('/Im Do'),
  );
  p.page(
    `BT /F 18 Tf 30 740 Td (Native caf\xe9) Tj ET q 100 0 0 100 30 500 cm /Fm Do Q q 20 0 0 20 200 500 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\xff EI Q`,
    `/Font << /F ${font} 0 R >> /XObject << /Fm ${form} 0 R >>`,
  );
  p.page('q 40 0 0 40 20 20 cm /Im Do Q', `/XObject << /Im ${im} 0 R >>`);
  await save('baseline', p);
  const large = new FixturePdf();
  const largeRgb = Buffer.alloc(4096 * 2048 * 3);
  for (let i = 0; i < largeRgb.length; i += 3) {
    largeRgb[i] = 31;
    largeRgb[i + 1] = 127;
    largeRgb[i + 2] = 233;
  }
  const li = large.image(4096, 2048, largeRgb);
  large.page('q 40 0 0 20 10 10 cm /Im Do Q', `/XObject << /Im ${li} 0 R >>`);
  await save('large-small', large);
  const huge = new FixturePdf();
  const hugeImage = huge.image(
    8000,
    5000,
    Buffer.alloc(8000 * 5000 * 3).fill(Buffer.from([31, 127, 233])),
  );
  huge.page('q 80 0 0 50 10 10 cm /Im Do Q', `/XObject << /Im ${hugeImage} 0 R >>`);
  await save('40-megapixels', huge);
  const encrypted = new FixturePdf();
  encrypted.password('fixture-pass');
  const ef = encrypted.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  encrypted.page('BT /F 12 Tf 20 700 Td (PASSWORD SENTINEL) Tj ET', `/Font << /F ${ef} 0 R >>`);
  await save('password', encrypted);
  const colors = new FixturePdf();
  const icc = colors.stream(
    '/N 3',
    await readFile('vendor/icc-profiles/profiles/sRGB-v2-micro.icc'),
  );
  const p3 = colors.stream(
    '/N 3',
    await readFile('vendor/icc-profiles/profiles/DisplayP3-v2-micro.icc'),
  );
  const imgs = [
    colors.image(2, 2, rgb),
    colors.image(2, 2, [0, 64, 128, 255], '', '/DeviceGray'),
    colors.image(2, 2, [0, 1, 1, 0], '', '[/Indexed /DeviceRGB 1 <ff000000ff00>]'),
    colors.image(
      2,
      2,
      [0, 255, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 0, 0, 0, 255],
      '',
      '/DeviceCMYK',
    ),
    colors.image(2, 2, rgb, '', `[/ICCBased ${icc} 0 R]`),
    colors.image(2, 2, [0, 64, 128, 255], '/Decode [1 0]', '/DeviceGray'),
    colors.image(2, 2, rgb, '/Mask [255 255 0 0 0 0]'),
    colors.image(
      2,
      2,
      [128, 64, 32, 32, 128, 64, 64, 32, 128, 180, 180, 40],
      '',
      `[/ICCBased ${p3} 0 R]`,
    ),
  ];
  colors.page(
    imgs.map((_, i) => `q 20 0 0 20 ${i * 30} 500 cm /I${i} Do Q`).join('\n'),
    `/XObject << ${imgs.map((n, i) => `/I${i} ${n} 0 R`).join(' ')} >>`,
  );
  await save('colors', colors);
  const long = new FixturePdf();
  const f = long.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let n = 1; n <= 150; n++)
    long.page(`BT /F 12 Tf 20 700 Td (Page ${n}) Tj ET`, `/Font << /F ${f} 0 R >>`);
  await save('150-pages', long);
  const layout = new FixturePdf(),
    lf = layout.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  layout.page(
    'BT /F 12 Tf 40 740 Td (LEFT FIRST) Tj 0 -20 Td (LEFT SECOND) Tj ET BT /F 12 Tf 340 740 Td (RIGHT FIRST) Tj 0 -20 Td (RIGHT SECOND) Tj ET',
    `/Font << /F ${lf} 0 R >>`,
  );
  layout.page('', '');
  layout.page(
    'BT /F 12 Tf 40 740 Td (ROTATED) Tj ET',
    `/Font << /F ${lf} 0 R >>`,
    '/CropBox [20 30 580 770] /Rotate 90 /UserUnit 2',
  );
  await save('layout', layout);
  const variants = new FixturePdf();
  const stencil = variants.stream(
    '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ImageMask true /BitsPerComponent 1',
    Buffer.from([0b01000000, 0b10000000]),
  );
  variants.page(
    'q 1 0 0 rg 40 0 0 40 20 20 cm /S Do Q q 0 0 1 rg 40 0 0 40 80 20 cm /S Do Q q 1 0 0 rg 40 0 0 40 140 20 cm /S Do Q',
    `/XObject << /S ${stencil} 0 R >>`,
  );
  await save('stencils', variants);
  const clip = new FixturePdf(),
    ci = clip.image(2, 2, rgb);
  clip.page(
    'q 20 20 10 10 re W n 20 0 0 20 20 20 cm /I Do Q q 0 40 -20 0 100 100 cm /I Do Q',
    `/XObject << /I ${ci} 0 R >>`,
  );
  await save('clipped-rotated', clip);
  const excessive = new FixturePdf(),
    ei = excessive.image(100000, 100000, [0]);
  excessive.page('/I Do', `/XObject << /I ${ei} 0 R >>`);
  await save('excessive', excessive);
  const malformed = new FixturePdf(),
    mi = malformed.image(10, 10, [0, 1, 2]);
  malformed.page('/I Do', `/XObject << /I ${mi} 0 R >>`);
  await save('malformed-image', malformed);
  const jpeg = new FixturePdf(),
    jc = createCanvas(64, 32),
    jx = jc.getContext('2d');
  jx.fillStyle = 'rgb(40,120,200)';
  jx.fillRect(0, 0, 64, 32);
  const ji = jpeg.stream(
    '/Type /XObject /Subtype /Image /Width 64 /Height 32 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode',
    jc.toBuffer('image/jpeg', 95),
  );
  jpeg.page('q 32 0 0 16 20 20 cm /I Do Q', `/XObject << /I ${ji} 0 R >>`);
  await save('jpeg', jpeg);
  for (const variant of ['scan', 'mixed', 'hidden', 'repeated-ocr']) {
    const c = createCanvas(1600, 400),
      ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'black';
    ctx.font = '64px sans-serif';
    ctx.fillText('RASTER SENTINEL 7429', 60, 120);
    ctx.fillText('Deutsche Karte Berlin', 60, 250);
    const rgba = ctx.getImageData(0, 0, c.width, c.height).data,
      pixels = new Uint8Array(c.width * c.height * 3);
    for (let s = 0, d = 0; s < rgba.length; s += 4) {
      pixels[d++] = rgba[s];
      pixels[d++] = rgba[s + 1];
      pixels[d++] = rgba[s + 2];
    }
    const doc = new FixturePdf(),
      im = doc.image(c.width, c.height, pixels),
      font = doc.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    doc.page(
      `q 480 0 0 120 30 480 cm /Im Do Q ${variant === 'mixed' ? 'BT /F 18 Tf 30 740 Td (Native paragraph) Tj ET' : ''} ${variant === 'hidden' ? 'BT 3 Tr /F 19.2 Tf 48 564 Td (RASTER SENTINEL 7429) Tj 0 -39 Td (Deutsche Karte Berlin) Tj ET' : ''}`,
      `/XObject << /Im ${im} 0 R >> /Font << /F ${font} 0 R >>`,
    );
    if (variant === 'repeated-ocr')
      doc.page(
        'q 240 0 0 60 30 600 cm /Im Do Q q 0 240 -60 0 400 400 cm /Im Do Q',
        `/XObject << /Im ${im} 0 R >>`,
      );
    await save(variant, doc);
  }
  await writeFile('tests/fixtures/corrupt.pdf', '%PDF-1.7\ncorrupt');
}
if (process.argv[1]?.endsWith('fixtures.mjs')) await generate();
