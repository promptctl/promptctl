import { contextBridge, ipcRenderer, clipboard } from "electron";

// [LAW:locality-or-seam] The library's renderer bridge expects a structural
// `IpcRendererLike` (invoke/send/on/removeListener with the event-arg-prefix
// shape Electron actually uses). Exposing the raw shape here — instead of the
// listener-stripping wrapper electronAPI uses — keeps the library's protocol
// contract intact (its forward path receives the IpcRendererEvent first arg
// and discriminates on it).
const tmuxIpc = {
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) =>
    ipcRenderer.send(channel, ...args),
  on: (
    channel: string,
    listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void,
  ) => {
    ipcRenderer.on(channel, listener);
  },
  removeListener: (
    channel: string,
    listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void,
  ) => {
    ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("electronAPI", {
  send: (channel: string, ...args: unknown[]) =>
    ipcRenderer.send(channel, ...args),
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  writeClipboard: (text: string) => clipboard.writeText(text),
});

contextBridge.exposeInMainWorld("tmuxIpc", tmuxIpc);
