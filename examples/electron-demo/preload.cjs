const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  spawn:       (name, cli, task)  => ipcRenderer.invoke('spawn', name, cli, task),
  release:     (name)             => ipcRenderer.invoke('release', name),
  sendMessage: (to, text)         => ipcRenderer.invoke('send-message', to, text),
  listAgents:  ()                 => ipcRenderer.invoke('list-agents'),

  onMessage:     (cb) => { ipcRenderer.on('message',      (_e, d) => cb(d)); },
  onAgentUpdate: (cb) => { ipcRenderer.on('agent-update', (_e, d) => cb(d)); },
  onBrokerStatus:(cb) => { ipcRenderer.on('broker-status',(_e, d) => cb(d)); },
  onBrokerLog:   (cb) => { ipcRenderer.on('broker-log',   (_e, d) => cb(d)); },
});
