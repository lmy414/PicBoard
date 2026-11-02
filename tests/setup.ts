import { afterAll } from 'vitest';
import { installRangeGeometry } from './helpers/range-geometry';

// jsdom omits the CSSOM Range geometry used by ProseMirror caret scrolling.
// Keep these stateless methods available for the full test-file lifetime,
// including pending MutationObserver callbacks between individual tests.
const restore = typeof Range === 'undefined' ? null : installRangeGeometry();
afterAll(() => restore?.());
