import { describe, expect, it } from 'vitest';
import { workerError } from '../../packages/core/src/errors.js';

describe('workerError', () => {
  it('keeps recognized codes and gives other failures the operation code', () => {
    expect(
      workerError(
        'RESOURCE_LIMIT_EXCEEDED: Image decode budget exceeded',
        'UNSUPPORTED_PDF_FEATURE',
        3,
      ),
    ).toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED', context: { pageNumber: 3 } });
    // A rule scan failure without a recognized code reports a PDF feature, not an image error.
    expect(workerError('Invalid PDF structure', 'UNSUPPORTED_PDF_FEATURE', 1)).toMatchObject({
      code: 'UNSUPPORTED_PDF_FEATURE',
      message: 'Invalid PDF structure',
    });
    expect(workerError('Bad XRef entry', 'UNSUPPORTED_IMAGE_FEATURE', 2).code).toBe(
      'UNSUPPORTED_IMAGE_FEATURE',
    );
  });
});
