const $=id=>document.getElementById(id);
$('choose').onclick=async()=>{const path=await window.desktopSetup.chooseFolder();if(path)$('folder').value=path;};
$('setup').onsubmit=async e=>{e.preventDefault();$('submit').disabled=true;$('error').textContent='';try{const result=await window.desktopSetup.save({serverUrl:$('server').value,name:$('name').value,password:$('password').value,tool:$('tool').value,workspace:$('folder').value});if(!result.ok)throw new Error(result.error);}catch(e){$('error').textContent=e.message;$('submit').disabled=false;}};
