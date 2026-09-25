import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { preview, truncate } from '../src/problem.js';

describe('preview', () => {
  it('is JSON.stringify shortened to 60 code points, for any JSON value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(preview(value)).toBe(truncate(JSON.stringify(value)));
      }),
      { numRuns: 2_000 },
    );
  });

  it('agrees with JSON.stringify on long strings, astral characters and lone surrogates', () => {
    const values = [
      'x'.repeat(59),
      'x'.repeat(60),
      'x'.repeat(61),
      'x'.repeat(1_000_000),
      '😀'.repeat(100),
      '\ud800'.repeat(100),
      '"\\\n'.repeat(100),
      { ['k'.repeat(100)]: 1 },
      Array.from({ length: 100 }, (_, i) => i),
      [[[[['a']]]], { b: [null, true, 1.5] }],
    ];
    for (const value of values) expect(preview(value)).toBe(truncate(JSON.stringify(value)));
  });

  it('renders values nested far deeper than JSON.stringify can, in bounded time', () => {
    let deepArray: unknown = [];
    let deepObject: unknown = {};
    for (let i = 0; i < 1_000_000; i++) {
      deepArray = [deepArray];
      deepObject = { a: deepObject };
    }
    expect(() => JSON.stringify(deepArray)).toThrow(RangeError);
    expect(preview(deepArray)).toBe(`${'['.repeat(60)}…`);
    expect(preview(deepObject)).toBe(`${'{"a":'.repeat(12)}…`);
  });

  it('renders huge lists without walking them', () => {
    const huge = new Array<number>(50_000_000);
    const started = performance.now();
    expect(preview(huge)).toBe(`[${'null,'.repeat(11)}null…`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('renders values with no JSON form (from options) instead of throwing', () => {
    expect(preview(1n)).toBe('1');
    expect(preview(undefined)).toBe('undefined');
    expect(preview(Symbol('s'))).toBe('Symbol(s)');
    expect(preview(() => 1)).toBe('function');
    expect(preview([undefined, () => 1, { a: undefined, b: 1 }])).toBe('[null,null,{"b":1}]');
    const circular: unknown[] = [];
    circular.push(circular);
    expect(preview(circular)).toBe(`${'['.repeat(60)}…`);
  });
});
