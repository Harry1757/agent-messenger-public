const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopSetup',{
 chooseFolder:()=>ipcRenderer.invoke('setup:folder'),
 save:data=>ipcRenderer.invoke('setup:save',data)
});
