import type { HarnessWindowApi } from '../../shared/harness-ipc.js';
import type { DesktopApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    /** The typed bridge to the Runtime, exposed by src/preload/index.ts (main window only). */
    readonly api: DesktopApi;
    /**
     * A Harness window's bridge to its own launch, exposed by src/preload/harness.ts (harness.html
     * only).
     */
    readonly harness: HarnessWindowApi;
  }
}
