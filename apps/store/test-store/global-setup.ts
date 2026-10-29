import { seed } from '../scripts/seed.ts';

/** Every store test file starts from the seed catalogue (and leaves it as it found it). */
export default async function setup(): Promise<void> {
  await seed();
}
