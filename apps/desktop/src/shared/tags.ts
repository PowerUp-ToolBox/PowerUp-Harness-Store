import type { Tag } from '@harness-store/manifest';

// A record keyed by every tag fails to compile when the Manifest schema gains or loses one; a test
// keeps the order the schema's.
const TAG_NAMES: Readonly<Record<Tag, true>> = {
  coding: true,
  writing: true,
  research: true,
  data: true,
  productivity: true,
  devops: true,
  design: true,
  education: true,
  fun: true,
  other: true,
};

/**
 * The Store's curated tags, in the Manifest schema's order: the search's tag chips. Every process
 * can import it; it does not bundle the schema.
 */
export const TAGS = Object.freeze(Object.keys(TAG_NAMES) as Tag[]);

/** Whether `value` is one of the curated tags. */
export function isTag(value: unknown): value is Tag {
  return typeof value === 'string' && Object.hasOwn(TAG_NAMES, value);
}
