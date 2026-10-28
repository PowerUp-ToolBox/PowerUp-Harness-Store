/**
 * The preload of a Harness window's own page (the top bar and the embedded terminal). It exposes
 * one object, `window.harness`, on the Harness window's own channels: calls about this window's
 * launch only, never the main window's `window.api`. Main answers only the window it opened for
 * that launch. A web Harness's page is loaded in a separate view with no preload at all (P0-05.3).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { HARNESS_EVENT_CHANNEL, HARNESS_INVOKE_CHANNEL } from '../shared/harness-ipc.js';
import type { IpcEventMessage, IpcResult } from '../shared/ipc.js';
import { buildHarnessApi } from './build-api.js';

const harness = buildHarnessApi(
  (request) => ipcRenderer.invoke(HARNESS_INVOKE_CHANNEL, request) as Promise<IpcResult<unknown>>,
  (event, listener) => {
    const onMessage = (_sender: IpcRendererEvent, message: IpcEventMessage): void => {
      if (message.event === event) listener(message.payload);
    };
    ipcRenderer.on(HARNESS_EVENT_CHANNEL, onMessage);
    return () => {
      ipcRenderer.off(HARNESS_EVENT_CHANNEL, onMessage);
    };
  },
);

contextBridge.exposeInMainWorld('harness', harness);
