import type { DesktopApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    /** The typed bridge to the Runtime, exposed by src/preload/index.ts. */
    readonly api: DesktopApi;
  }
}
