/**
 * The preload script: the only code that touches both Electron and the renderer. It exposes one
 * object, `window.api`, through the context bridge; the renderer gets no `require`, `process`,
 * `ipcRenderer` or `window.electron`.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  type IpcEventMessage,
  type IpcResult,
} from '../shared/ipc.js';
import { buildApi } from './build-api.js';

const api = buildApi(
  (request) => ipcRenderer.invoke(IPC_INVOKE_CHANNEL, request) as Promise<IpcResult<unknown>>,
  (event, listener) => {
    const onMessage = (_sender: IpcRendererEvent, message: IpcEventMessage): void => {
      if (message.event === event) listener(message.payload);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, onMessage);
    return () => {
      ipcRenderer.off(IPC_EVENT_CHANNEL, onMessage);
    };
  },
);

contextBridge.exposeInMainWorld('api', api);
