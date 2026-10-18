/** Generate the original nine-raster pagination fixture with the shared test PDF writer. */
export function galleryFixture(): Buffer<ArrayBuffer>;
/** Generate original lettering drawn solely as vector paths on two pages. */
export function outlinedFixture(): Buffer<ArrayBuffer>;
/** Generate an original ruled 3×3 table. */
export function tableFixture(): Buffer<ArrayBuffer>;
/** Generate an original raster with a vector square and text drawn over it. */
export function overlayFixture(): Buffer<ArrayBuffer>;
/** Generate a page showing text before any font is set, with a clipped image, and an intact page. */
export function brokenTextFixture(): Buffer<ArrayBuffer>;
