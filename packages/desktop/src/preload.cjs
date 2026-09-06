// SPDX-License-Identifier: Apache-2.0
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('physicalSystems', Object.freeze({
  snapshot: () => ipcRenderer.invoke('physical-systems:snapshot'),
  command: (name, payload = {}) => ipcRenderer.invoke('physical-systems:command', name, payload),
  subscribe: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A state listener is required.');
    const receive = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('physical-systems:snapshot', receive);
    return () => ipcRenderer.removeListener('physical-systems:snapshot', receive);
  },
}));
