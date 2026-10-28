import { manifestSchema } from '@harness-store/manifest';
import { describe, expect, it } from 'vitest';
import { isTag, TAGS } from '../src/shared/tags.js';

describe('TAGS', () => {
  it('lists the Manifest schema’s tags in its order (the search’s tag chips)', () => {
    const schemaTags = (manifestSchema as { $defs: { tag: { enum: string[] } } }).$defs.tag.enum;
    expect(TAGS).toEqual(schemaTags);
  });

  it.each([
    ['writing', true],
    ['Writing', false],
    ['写作', false],
    ['toString', false],
    [3, false],
  ])('isTag(%j) is %s', (value, expected) => {
    expect(isTag(value)).toBe(expected);
  });
});
