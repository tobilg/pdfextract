import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { FixturePdf } from '../../../scripts/fixtures.mjs';

/** Original test data: nine distinct one-pixel RGB images, each painted once on one page. */
export function galleryFixture() {
  const pdf = new FixturePdf();
  const images = Array.from({ length: 9 }, (_, index) => pdf.image(1, 1, [index * 25, 128, 255]));
  pdf.page(
    images.map((_, index) => `q 20 0 0 20 ${index * 30} 500 cm /I${index} Do Q`).join('\n'),
    `/XObject << ${images.map((image, index) => `/I${index} ${image} 0 R`).join(' ')} >>`,
  );
  return pdf.bytes();
}

/**
 * Original two-page vector-lettering fixture. Trace a fixed, bundled Liberation Sans
 * sentinel into filled rectangles: the PDF contains no font or image resources.
 * Keeping two pages also catches document separators being counted as extracted text.
 */
export function outlinedFixture() {
  GlobalFonts.registerFromPath(
    fileURLToPath(
      new URL('../../core/dist/assets/standard_fonts/LiberationSans-Regular.ttf', import.meta.url),
    ),
    'Fixture Sans',
  );
  const canvas = createCanvas(1000, 140);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  ctx.font = '64px "Fixture Sans"';
  ctx.fillText('VECTOR TEXT 7429', 20, 95);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const paths = ['q 0.5 0 0 -0.5 40 700 cm 0 g'];
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4] >= 128) continue;
      const start = x;
      while (x + 1 < canvas.width && data[(y * canvas.width + x + 1) * 4] < 128) x++;
      paths.push(`${start} ${y} ${x - start + 1} 1 re f`);
    }
  }
  paths.push('Q');
  const pdf = new FixturePdf();
  pdf.page(paths.join('\n'), '');
  pdf.page(paths.join('\n'), '');
  return pdf.bytes();
}

/** Original ruled 3×3 table on one page, with Helvetica text in each cell. */
export function tableFixture() {
  const pdf = new FixturePdf();
  const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const rows = [
    ['Part', 'Qty', 'Price'],
    ['Bolt', '12', '0.40'],
    ['Nut', '30', '0.15'],
  ];
  const lines = [
    ...[700, 680, 660, 640].map((y) => `50 ${y} m 350 ${y} l S`),
    ...[50, 150, 250, 350].map((x) => `${x} 700 m ${x} 640 l S`),
  ];
  const text = rows.flatMap((row, r) =>
    row.map((cell, c) => `BT /F 10 Tf ${55 + c * 100} ${686 - r * 20} Td (${cell}) Tj ET`),
  );
  pdf.page([...lines, ...text].join('\n'), `/Font << /F ${font} 0 R >>`);
  return pdf.bytes();
}

/** Original 40×20 red raster with a blue square and a word drawn over it. */
export function overlayFixture() {
  const pdf = new FixturePdf();
  const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const image = pdf.image(40, 20, Array.from({ length: 40 * 20 }, () => [255, 0, 0]).flat());
  pdf.page(
    'q 40 0 0 20 100 700 cm /I Do Q\n0 0 1 rg 110 705 10 10 re f\n0 g BT /F 8 Tf 122 706 Td (Hi) Tj ET',
    `/XObject << /I ${image} 0 R >> /Font << /F ${font} 0 R >>`,
  );
  return pdf.bytes();
}
export function brokenTextFixture() {
  const pdf = new FixturePdf();
  const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const red = pdf.image(40, 20, Array.from({ length: 40 * 20 }, () => [255, 0, 0]).flat());
  const blue = pdf.image(20, 20, Array.from({ length: 20 * 20 }, () => [0, 0, 255]).flat());
  // Page 1 shows text before any font is set, then draws the red image under a clip that cuts it.
  pdf.page(
    'BT 40 760 Td (Broken) Tj ET\nq 100 700 20 20 re W n 40 0 0 20 100 700 cm /I Do Q',
    `/XObject << /I ${red} 0 R >> /Font << /F ${font} 0 R >>`,
  );
  pdf.page(
    'q 20 0 0 20 100 700 cm /J Do Q\nBT /F 12 Tf 100 650 Td (Intact page) Tj ET',
    `/XObject << /J ${blue} 0 R >> /Font << /F ${font} 0 R >>`,
  );
  return pdf.bytes();
}
