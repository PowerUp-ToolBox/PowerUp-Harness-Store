/**
 * The preload script: the only code that touches both Electron and the renderer. It exposes one
 * object, `window.api`, through the context bridge; the renderer gets no `require`, `process`,
 * `ipcRenderer` or `window.electron`. Besides the IPC methods it carries `pathForFile`, the path
 * of a folder dropped on the Publish screen, which only the preload can read (Electron's
 * `webUtils`).
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
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
  (file) => webUtils.getPathForFile(file),
);

contextBridge.exposeInMainWorld('api', api);
