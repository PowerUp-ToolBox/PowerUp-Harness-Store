import { open, stat } from 'node:fs/promises';
import { ArchiveSource } from '../archive-source.js';
import type { RandomAccessReader } from '../archive-source.js';

/**
 * A zip file on disk, read by position: each read opens the file read-only, reads the bytes asked
 * for and closes it again, so nothing is kept open and nothing larger than a read is held in
 * memory. The file must not change while it is being validated; a read that comes up short
 * (the file shrank) fails.
 */
export async function fileReader(path: string): Promise<RandomAccessReader> {
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error(`${path} is not a file`);
  const size = stats.size;
  return {
    size,
    async read(offset, length) {
      const bytes = new Uint8Array(length);
      const handle = await open(path, 'r');
      try {
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(bytes, filled, length - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return bytes.subarray(0, filled);
      } finally {
        await handle.close();
      }
    },
  };
}

/** Opens a zip file on disk as a Harness Package: `ArchiveSource.open(await fileReader(path))`. */
export async function openArchiveFile(path: string): Promise<ArchiveSource> {
  return ArchiveSource.open(await fileReader(path));
}
