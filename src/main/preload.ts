import { contextBridge, ipcRenderer, clipboard } from "electron";

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
