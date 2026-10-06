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
