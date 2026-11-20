import { describe, it, expect } from 'vitest';
import { detectStructure } from '../../bandDetector.ts';
describe('toolchain spike', () => {
  it('vitest runs pure TS vision code', () => {
    const W = 360, H = 360, g = new Float32Array(W * H).fill(0.4);
    const r = detectStructure(g, W, H, 18 / 800, 18 / 800);
    expect(Array.isArray(r.hShelves)).toBe(true);
  });
});
