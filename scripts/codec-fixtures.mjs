// Optional fixture regeneration: OpenJPEG opj_compress and libtiff tiffcp.
// Runtime/tests use the committed PDFs, never these native tools.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixturePdf } from './fixtures.mjs';

const dir = await mkdtemp(join(tmpdir(), 'pdfextract-codecs-'));
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr || r.error}`);
}
async function pdf(name, filter, data, bpc, color, extra = '') {
  const p = new FixturePdf();
  const im = p.stream(
    `/Type /XObject /Subtype /Image /Width 64 /Height 32 /BitsPerComponent ${bpc} /ColorSpace ${color} /Filter /${filter} ${extra}`,
    data,
  );
  p.page('q 32 0 0 16 20 20 cm /Im Do Q', `/XObject << /Im ${im} 0 R >>`);
  await writeFile(`tests/fixtures/${name}.pdf`, p.bytes());
}
try {
  const rgb = Buffer.alloc(64 * 32 * 3);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) rgb.set([x * 4, y * 8, 127], (y * 64 + x) * 3);
  await writeFile(join(dir, 'source.ppm'), Buffer.concat([Buffer.from('P6\n64 32\n255\n'), rgb]));
  run('opj_compress', ['-i', join(dir, 'source.ppm'), '-o', join(dir, 'source.jp2')]);
  await pdf('jpx', 'JPXDecode', await readFile(join(dir, 'source.jp2')), 8, '/DeviceRGB');

  // Little-endian uncompressed single-strip TIFF, alternating 8x8 squares.
  const bits = Buffer.alloc(256);
  for (let y = 0; y < 32; y++)
    for (let byte = 0; byte < 8; byte++)
      bits[y * 8 + byte] = (Math.floor(y / 8) + byte) % 2 ? 255 : 0;
  const tags = [
    [256, 4, 64],
    [257, 4, 32],
    [258, 3, 1],
    [259, 3, 1],
    [262, 3, 1],
    [273, 4, 134],
    [277, 3, 1],
    [278, 4, 32],
    [279, 4, 256],
    [284, 3, 1],
  ];
  const header = Buffer.alloc(134);
  header.write('II');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  header.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, value], i) => {
    const o = 10 + 12 * i;
    header.writeUInt16LE(tag, o);
    header.writeUInt16LE(type, o + 2);
    header.writeUInt32LE(1, o + 4);
    header.writeUInt32LE(value, o + 8);
  });
  await writeFile(join(dir, 'source.tif'), Buffer.concat([header, bits]));
  run('tiffcp', ['-c', 'g4', join(dir, 'source.tif'), join(dir, 'g4.tif')]);
  const tiff = await readFile(join(dir, 'g4.tif'));
  const ifd = tiff.readUInt32LE(4),
    fields = new Map();
  for (let i = 0; i < tiff.readUInt16LE(ifd); i++) {
    const p = ifd + 2 + i * 12;
    fields.set(tiff.readUInt16LE(p), tiff.readUInt32LE(p + 8));
  }
  const g4 = tiff.subarray(fields.get(273), fields.get(273) + fields.get(279));
  await pdf(
    'ccitt',
    'CCITTFaxDecode',
    g4,
    1,
    '/DeviceGray',
    '/DecodeParms << /K -1 /Columns 64 /Rows 32 /BlackIs1 true >>',
  );

  // ISO JBIG2 embedded sequential page information + immediate MMR generic region.
  const segment = (number, type, data) => {
    const h = Buffer.alloc(11);
    h.writeUInt32BE(number);
    h[4] = type;
    h[6] = 1;
    h.writeUInt32BE(data.length, 7);
    return Buffer.concat([h, data]);
  };
  const page = Buffer.alloc(19);
  page.writeUInt32BE(64);
  page.writeUInt32BE(32, 4);
  const region = Buffer.alloc(18);
  region.writeUInt32BE(64);
  region.writeUInt32BE(32, 4);
  region[17] = 1;
  // The JBIG2 binary-image convention reverses TIFF's BlackIsZero samples.
  await pdf(
    'jbig2',
    'JBIG2Decode',
    Buffer.concat([segment(1, 48, page), segment(2, 38, Buffer.concat([region, g4]))]),
    1,
    '/DeviceGray',
    '/Decode [1 0]',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
