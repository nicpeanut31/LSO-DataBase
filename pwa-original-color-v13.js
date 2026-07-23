(() => {
  'use strict';
  const installButton = document.getElementById('installAppButton');
  const connectionBanner = document.getElementById('connectionBanner');
  let deferredInstallPrompt = null;
  let refreshing = false;

  function isStandalone(){return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;}
  function showConnectionBanner(message,state='offline'){if(!connectionBanner)return;connectionBanner.textContent=message;connectionBanner.dataset.state=state;connectionBanner.classList.remove('hidden');}
  function hideConnectionBanner(){connectionBanner?.classList.add('hidden');}
  function updateConnectivity(){if(navigator.onLine){showConnectionBanner('Connection restored. Refreshing shared records…','online');window.LSOCloud?.loadSharedState?.({quiet:true}).catch(()=>undefined);window.setTimeout(hideConnectionBanner,2200);}else showConnectionBanner('You are offline. Database submissions and approvals require a connection.','offline');}
  async function installApplication(){if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;installButton?.classList.add('hidden');}
  function registerInstallEvents(){if(!installButton||isStandalone())return;window.addEventListener('beforeinstallprompt',(event)=>{event.preventDefault();deferredInstallPrompt=event;installButton.classList.remove('hidden');});installButton.addEventListener('click',installApplication);window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;installButton.classList.add('hidden');window.LSOApp?.showToast?.('LSO System was installed successfully.');});}
  async function registerServiceWorker(){
    if(!('serviceWorker' in navigator))return;
    try{
      const keys=await caches.keys();
      await Promise.all(keys.filter(key=>key.startsWith('lso-website-')&&!key.includes('20260724-original-color-13')).map(key=>caches.delete(key)));
    }catch{}
    const secure=window.isSecureContext||['localhost','127.0.0.1'].includes(location.hostname);
    if(!secure)return;
    try{
      const registration=await navigator.serviceWorker.register('./service-worker-original-color-v13.js',{scope:'./',updateViaCache:'none'});
      await registration.update();
      if(registration.waiting)registration.waiting.postMessage({type:'SKIP_WAITING'});
      registration.addEventListener('updatefound',()=>{const worker=registration.installing;if(!worker)return;worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)worker.postMessage({type:'SKIP_WAITING'});});});
      navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshing)return;refreshing=true;window.location.reload();});
    }catch(error){console.warn('PWA service worker registration failed:',error);}
  }
  window.addEventListener('online',updateConnectivity);
  window.addEventListener('offline',updateConnectivity);
  registerInstallEvents();
  registerServiceWorker();
  if(!navigator.onLine)updateConnectivity();
})();
