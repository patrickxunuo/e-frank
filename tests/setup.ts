import { vi } from 'vitest';

/**
 * Global vitest setup.
 *
 * `lottie-react` (used by `<RunStatusFigure>`) transitively imports
 * `lottie-web`, which probes `HTMLCanvasElement.prototype.getContext` at
 * module load. jsdom's canvas implementation throws on access, so any test
 * suite that imports a component referencing Lottie crashes during module
 * resolution — even when the test never asserts against the animation.
 *
 * Stubbing the package globally replaces the player with a benign render
 * stub, which lets every component test mount without pulling in the real
 * lottie-web module. Tests that need to assert about the animation can
 * still override this mock locally.
 */
vi.mock('lottie-react', () => ({
  default: () => null,
}));
