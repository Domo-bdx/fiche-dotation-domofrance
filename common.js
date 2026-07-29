// ═══════════════════════════════════════════════════════════════════════════════
// GESTOCK — common.js
// Module partagé : API GitHub, authentification, utilitaires
// Importé par toutes les pages de l'application
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CONFIG GITHUB API ───────────────────────────────────────────────────────
function getGHToken(){return localStorage.getItem('domo_gh_token')||'';}
function getDataToken(){return localStorage.getItem('domo_data_token')||getGHToken();}
function getDataHeaders(){return {'Authorization':'Bearer '+getDataToken(),'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'};}
const GH_OWNER='Domo-bdx';
const GH_REPO='fiche-dotation-domofrance';
const GH_BRANCH='main';
// Dépôt privé pour les données
const GH_DATA_OWNER='Domo-bdx';
const GH_DATA_REPO='gestock-data';
const GH_DATA_BRANCH='main';
function getGHHeaders(){return {'Authorization':'Bearer '+getGHToken(),'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'};}
const _shas={}; const _datashas={};

function b64enc(str){
  const bytes=new TextEncoder().encode(str);
  let bin='';
  bytes.forEach(b=>bin+=String.fromCharCode(b));
  return btoa(bin);
}
function b64dec(b64){
  const bin=atob(b64.split('\n').join(''));
  const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function fetchWithTimeout(url,opts,ms=15000){
  const ctrl=new AbortController();
  const tid=setTimeout(()=>ctrl.abort(),ms);
  try{
    const r=await fetch(url,{...opts,signal:ctrl.signal});
    clearTimeout(tid);
    return r;
  }
  catch(e){
    clearTimeout(tid);
    console.error('[fetchWithTimeout] URL:',url,'Erreur:',e.name,e.message,e);
    if(e.name==='AbortError')throw new Error('Timeout — vérifiez votre connexion réseau');
    throw new Error('Fetch failed vers '+url+' : '+e.message+' ('+e.name+')');
  }
}

function assertToken(isData=false){if(isData){const t=getDataToken();if(!t||t.trim()==='')throw new Error('Token données non configuré — rendez-vous dans ⚙ Paramètres.');}else{const t=getGHToken();if(!t||t.trim()==='')throw new Error('Token GitHub non configuré — rendez-vous dans ⚙ Paramètres.');}}
async function ghRead(path){
  const isData=path.startsWith('data/');
  assertToken(isData);
  const owner=isData?GH_DATA_OWNER:GH_OWNER;
  const repo=isData?GH_DATA_REPO:GH_REPO;
  const branch=isData?GH_DATA_BRANCH:GH_BRANCH;
  const baseHeaders=isData?getDataHeaders():getGHHeaders();
  // 1) Récupérer le SHA via l'API Contents standard (JSON, léger)
  const apiUrl=`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}&t=${Date.now()}`;
  const r=await fetchWithTimeout(apiUrl,{headers:baseHeaders});
  if(r.status===404)return null;
  if(r.status===403){const txt=await r.text();if(txt.includes('rate limit'))throw new Error('Limite API GitHub atteinte — vérifiez que votre token est bien configuré dans ⚙ Paramètres.');throw new Error(`GitHub read 403: ${txt}`);}
  if(!r.ok)throw new Error(`GitHub read ${r.status}: ${await r.text()}`);
  const j=await r.json();
  if(isData)_datashas[path]=j.sha; else _shas[path]=j.sha;
  // 2) Si le contenu base64 est présent et complet, l'utiliser directement (fichiers < ~1Mo)
  if(j.content){
    const decoded=j.content.replace(/\n/g,'');
    return JSON.parse(b64dec(decoded));
  }
  // 3) Fallback pour les gros fichiers : re-demander l'API Contents avec Accept raw
  //    (reste sur api.github.com — évite les soucis CORS de raw.githubusercontent.com)
  const rawHeaders={...baseHeaders,'Accept':'application/vnd.github.raw+json'};
  const rRaw=await fetchWithTimeout(apiUrl,{headers:rawHeaders});
  if(!rRaw.ok)throw new Error(`GitHub raw read ${rRaw.status}: ${await rRaw.text()}`);
  return await rRaw.json();
}

async function ghWrite(path,data){
  const isData=path.startsWith('data/');
  assertToken(isData);
  const owner=isData?GH_DATA_OWNER:GH_OWNER;
  const repo=isData?GH_DATA_REPO:GH_REPO;
  const headers=isData?getDataHeaders():getGHHeaders();
  const body={message:'GESTOCK update '+path,content:b64enc(JSON.stringify(data))};
  const shaCache=isData?_datashas:_shas; if(shaCache[path])body.sha=shaCache[path];
  const r=await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`,{method:'PUT',headers,body:JSON.stringify(body)});
  if(!r.ok){
    const err=await r.text();
    if(r.status===409||err.includes('sha')){
      // Retry avec SHA frais — DOIT rester sur le même dépôt (public/privé) que l'écriture initiale
      await ghRead(path);
      body.sha=isData?_datashas[path]:_shas[path];
      const r2=await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`,{method:'PUT',headers,body:JSON.stringify(body)});
      if(!r2.ok)throw new Error(`GitHub write retry ${r2.status}: ${await r2.text()}`);
      const j2=await r2.json();
      if(isData)_datashas[path]=j2.content.sha; else _shas[path]=j2.content.sha;
      return;
    }
    throw new Error(`GitHub write ${r.status}: ${err}`);
  }
  const j=await r.json();
  if(isData)_datashas[path]=j.content.sha; else _shas[path]=j.content.sha;
}

async function readData(name){return await ghRead('data/'+name+'.json')||[]}
async function readObj(name){return await ghRead('data/'+name+'.json')||{}}
async function writeData(name,data){await ghWrite('data/'+name+'.json',data)}

async function sbGet(table,params=''){
  if(table==='stock'){const o=await readObj('stock');return Object.values(o);}
  const arr=await readData(table);
  if(params.includes('order=created_at.desc')||params.includes('createdAt'))arr.reverse();
  const lim=params.includes('limit=500')?500:params.includes('limit=1')?1:10000;
  return arr.slice(0,lim);
}
async function sbPost(table,body){
  const id=body.id||(Date.now().toString(36)+Math.random().toString(36).slice(2));
  const entry={...body,id,createdAt:new Date().toISOString()};
  if(table==='stock'){
    const k=(body.ref||'')+'__'+(body.taille||'');
    const obj=await readObj('stock');
    obj[k]={...entry,id:k};
    await writeData('stock',obj);
    return [{...entry,id:k}];
  }
  const arr=await readData(table);
  arr.unshift(entry);
  await writeData(table,arr);
  return [entry];
}
async function sbPatch(table,filter,body){
  const id=filter.replace('id=eq.','');
  if(table==='stock'){
    const obj=await readObj('stock');
    if(obj[id]){obj[id]={...obj[id],...body,updatedAt:new Date().toISOString()};await writeData('stock',obj);return [{...obj[id]}];}
    return [];
  }
  const arr=await readData(table);
  const idx=arr.findIndex(x=>x.id===id);
  if(idx>=0){arr[idx]={...arr[idx],...body,updatedAt:new Date().toISOString()};await writeData(table,arr);return [arr[idx]];}
  return [];
}
async function sbDelete(table,filter){
  const id=filter.replace('id=eq.','');
  if(table==='stock'){const obj=await readObj('stock');delete obj[id];await writeData('stock',obj);return;}
  const arr=await readData(table);
  await writeData(table,arr.filter(x=>x.id!==id));
}


// ─── ÉTAT LOCAL PARTAGÉ ──────────────────────────────────────────────────────
// ─── ÉTAT LOCAL ───────────────────────────────────────────────────────────────
let stockCache={};
let mouvementsCache=[];
let epiLines=[];
let telLines=[];
let tabLines=[];
let badgeLines=[];
let activeStockCat='Tous';
let activeCatCat='Tous';


// ─── SYNC STATUS ─────────────────────────────────────────────────────────────
function setSyncStatus(status,label){
  const dot=document.getElementById('sync-dot');
  const lbl=document.getElementById('sync-label');
  dot.className='sync-dot'+(status==='syncing'?' syncing':status==='error'?' error':'');
  lbl.textContent=label;
}

async function loadAllStock(){
  setSyncStatus('syncing','Chargement EPI…');
  try{
    const obj=await readObj('stock');
    stockCache={};
    Object.entries(obj).forEach(([k,r])=>{
      const sep=k.lastIndexOf('__');
      const ref=sep>=0?k.substring(0,sep):k;
      const taille=sep>=0?k.substring(sep+2):'Unique';
      stockCache[k]={...r,ref,taille,id:k};
    });
    const nbEntries=Object.keys(stockCache).length;
    setSyncStatus('ok','Base synchronisée ('+nbEntries+' refs)');
    document.getElementById('conn-bar').style.display='none';
    if(nbEntries===0){
      const bar=document.getElementById('conn-bar');
      if(bar){bar.style.display='flex';bar.innerHTML='<span style="color:#c0392b;font-weight:600">⚠ Stock chargé mais vide (0 référence) — vérifiez data/stock.json sur gestock-data</span>';}
    }
    return true;
  }catch(e){
    setSyncStatus('error','Erreur stock: '+e.message);
    console.error('loadAllStock error:',e);
    const bar=document.getElementById('conn-bar');
    if(bar){bar.style.display='flex';bar.innerHTML='<span style="color:#c0392b;font-weight:600">⚠ Erreur chargement stock : '+e.message+'</span>';}
    return false;
  }
}


// ─── CHARGEMENT DONNÉES ──────────────────────────────────────────────────────
async function loadAllMouvements(){
  try{const arr=await readData('mouvements');mouvementsCache=arr.slice(0,500);}
  catch(e){console.error(e)}
}

async function forceSyncStock(){
  document.getElementById('sync-msg').innerHTML='<div class="msg info">Synchronisation en cours…</div>';
  await loadAllStock();
  await loadAllMouvements();
  await loadMobDevices();
  await loadPapeterieStock();
  await loadPapeterieMovements();
  await loadAttentes();
  renderStockStats();
  renderStock();
  renderPapeterieStats();
  updateAlerteBadge();
  document.getElementById('sync-msg').innerHTML='<div class="msg ok">✓ Synchronisation terminée.</div>';
  setTimeout(()=>document.getElementById('sync-msg').innerHTML='',3000);
}

function getStock(ref,taille){
  const k=ref+'__'+taille;
  if(!stockCache[k])stockCache[k]={ref,taille,qte:0,seuil:2,attribues:0};
  const s=stockCache[k];
  return {...s,qte:Number(s.qte)||0,seuil:Number(s.seuil)||0,attribues:Number(s.attribues)||0};
}

async function saveStockRow(ref,taille,fields){
  const k=ref+'__'+taille;
  setSyncStatus('syncing','Sauvegarde…');
  try{
    const obj=await readObj('stock');
    const existing=obj[k]||{qte:0,seuil:2,attribues:0};
    // Format allégé : uniquement qte/seuil/attribues (designation/categorie viennent de CATALOGUE)
    const data={qte:existing.qte||0,seuil:existing.seuil||2,attribues:existing.attribues||0,...fields};
    obj[k]=data;
    await writeData('stock',obj);
    stockCache[k]={...data,ref,taille,id:k};
    setSyncStatus('ok','Sauvegardé');
  }catch(e){
    setSyncStatus('error','Erreur: '+e.message);
    console.error(e);
  }
}

// ─── TABS ─────────────────────────────────────────────────────────────────────

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function goTab(t,btn){
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  if(t==='parametres'&&currentUser&&currentUser.role==='admin'&&usersCache.length>0){renderUsersList();}
  if(t==='dashboard'){renderDashboard();}
  document.getElementById('tab-'+t).classList.add('active');
  if(btn)btn.classList.add('active');
  if(t==='stock'){if(Object.keys(stockCache).length===0){loadAllStock().then(()=>{renderStockStats();renderStock();});}else{renderStockStats();renderStock();}}
  if(t==='historique'){loadAllMouvements().then(renderHistorique)}
  if(t==='fiches'){loadAllMouvements().then(fichesRender);}
  if(t==='alertes'){renderAlertes();renderPEAlertes();renderAttentesAlertes();buildMailPreview(getAlertes());}
  if(t==='catalogue')renderCatalogue();
  if(t==='parametres'){loadConfigIntoForm();loadTokenInForm();}
  if(t==='reception'){document.getElementById('rec-date').value=new Date().toISOString().slice(0,10);renderRecHisto()}
  if(t==='mobilite'){loadMobDevices().then(()=>{renderMobStats();renderMobTel();renderMobTab();renderMobBadge()})}
  if(t==='papeterie'){renderPapeterieStats();renderPapeterieAlertes();}
  closeMobileNav();
  setTimeout(applyResponsiveLabels,80);
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
// ─── UTILS ────────────────────────────────────────────────────────────────────
function showMsg(id,msg,type){const el=document.getElementById(id);if(!el)return;el.innerHTML=`<div class="msg ${type}">${msg}</div>`;}


// ─── AUTHENTIFICATION ────────────────────────────────────────────────────────
let currentUser = null;
let usersCache  = [];

async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function loadUsers(){
  try{
    const url=`https://api.github.com/repos/${GH_DATA_OWNER}/${GH_DATA_REPO}/contents/data/users.json?ref=${GH_DATA_BRANCH}&t=${Date.now()}`;
    const r=await fetch(url,{headers:getDataHeaders()});
    if(!r.ok)return;
    const j=await r.json();
    usersCache=JSON.parse(atob(j.content.replace(/\n/g,'')));
  }catch(e){console.error('loadUsers',e);}
}

async function saveUsers(){
  await ghWrite('data/users.json', usersCache);
}

async function doLogin(){
  const login=document.getElementById('login-user').value.trim().toLowerCase();
  const pwd=document.getElementById('login-pwd').value;
  const errEl=document.getElementById('login-error');
  const btn=document.getElementById('login-btn');
  if(!login||!pwd){errEl.textContent='Veuillez saisir votre identifiant et mot de passe.';return;}
  btn.textContent='Connexion…';btn.disabled=true;errEl.textContent='';
  try{
    await loadUsers();
    const user=usersCache.find(u=>u.login===login);
    if(!user||!user.actif){errEl.textContent='Identifiant inconnu ou compte désactivé.';btn.textContent='Se connecter';btn.disabled=false;return;}
    const hash=await sha256(pwd);
    if(hash!==user.hash){errEl.textContent='Mot de passe incorrect.';btn.textContent='Se connecter';btn.disabled=false;return;}
    currentUser={login:user.login,nom:user.nom,role:user.role};
    sessionStorage.setItem('gestock_user',JSON.stringify(currentUser));
    if(user.premiere_connexion){
      document.getElementById('login-overlay').style.display='none';
      document.getElementById('chgpwd-overlay').style.display='flex';
    }else{loginSuccess();}
  }catch(e){errEl.textContent='Erreur : '+e.message;btn.textContent='Se connecter';btn.disabled=false;}
}

async function doChangePassword(){
  const newPwd=document.getElementById('chgpwd-new').value;
  const conf=document.getElementById('chgpwd-confirm').value;
  const errEl=document.getElementById('chgpwd-error');
  if(newPwd.length<8){errEl.textContent='8 caractères minimum.';return;}
  if(newPwd!==conf){errEl.textContent='Les mots de passe ne correspondent pas.';return;}
  try{
    const hash=await sha256(newPwd);
    const idx=usersCache.findIndex(u=>u.login===currentUser.login);
    if(idx>=0){usersCache[idx].hash=hash;usersCache[idx].premiere_connexion=false;}
    await saveUsers();
    document.getElementById('chgpwd-overlay').style.display='none';
    loginSuccess();
  }catch(e){document.getElementById('chgpwd-error').textContent='Erreur : '+e.message;}
}

function loginSuccess(){
  document.getElementById('login-overlay').style.display='none';
  const badge=document.getElementById('user-badge');
  const initiales=currentUser.nom.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('user-avatar').textContent=initiales;
  document.getElementById('user-name').textContent=currentUser.nom;
  document.getElementById('user-role-badge').textContent=currentUser.role==='admin'?'⚙ Admin':'✏ Gestionnaire';
  badge.style.display='flex';
  if(currentUser.role==='admin')document.getElementById('section-gestion-comptes').style.display='block';
  const mci=document.getElementById('mon-compte-info');
  if(mci)mci.innerHTML='<strong>'+currentUser.nom+'</strong> &nbsp;·&nbsp; '+(currentUser.role==='admin'?'<span class="tag-admin">Admin</span>':'<span class="tag-gest">Gestionnaire</span>')+'&nbsp;<button class="btn" style="padding:3px 10px;font-size:11px;margin-left:12px" onclick="deconnexion()">Se déconnecter</button>';
  initApp();
}

function deconnexion(){
  if(!confirm('Voulez-vous vous déconnecter ?'))return;
  sessionStorage.removeItem('gestock_user');
  currentUser=null;
  usersCache=[];
  document.getElementById('user-badge').style.display='none';
  document.getElementById('login-overlay').style.display='flex';
  document.getElementById('login-user').value='';
  document.getElementById('login-pwd').value='';
  document.getElementById('login-error').textContent='';
}

// ─── GESTION COMPTES (admin) ───────────────────────────────────────────

function renderUsersList(){
  const el=document.getElementById('users-list');
  if(!el)return;
  el.innerHTML=usersCache.map(u=>`
    <div class="user-card" style="${!u.actif?'opacity:.5':''}">
      <div class="user-card-avatar">${u.nom.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>
      <div class="user-card-info">
        <strong>${u.nom}</strong>
        <span>${u.login} &nbsp;·&nbsp; ${u.role==='admin'?'<span class=\"tag-admin\">Admin</span>':'<span class=\"tag-gest\">Gestionnaire</span>'}
        ${u.premiere_connexion?'&nbsp;<span style=\"color:#c0392b;font-size:10px\">⚠ Mdp non changé</span>':''}
        ${!u.actif?'&nbsp;<span class=\"tag-inactif\">Inactif</span>':''}</span>
      </div>
      <div class="user-card-actions">
        ${u.login!==currentUser.login?`
          <button class="btn" style="font-size:11px;padding:4px 10px" onclick="toggleUserActif('${u.login}')"> ${u.actif?'Désactiver':'Activer'}</button>
          <button class="btn" style="font-size:11px;padding:4px 10px" onclick="resetUserPassword('${u.login}')">Réinit. mdp</button>
        `:'<span style=\"font-size:11px;color:#888\">Mon compte</span>'}
      </div>
    </div>`).join('');
}

async function toggleUserActif(login){
  const idx=usersCache.findIndex(u=>u.login===login);
  if(idx<0)return;
  if(!confirm((usersCache[idx].actif?'Désactiver':'Activer')+' le compte de '+usersCache[idx].nom+' ?'))return;
  usersCache[idx].actif=!usersCache[idx].actif;
  await saveUsers();renderUsersList();
}

async function resetUserPassword(login){
  const idx=usersCache.findIndex(u=>u.login===login);
  if(idx<0)return;
  if(!confirm('Réinitialiser le mot de passe de '+usersCache[idx].nom+' à Domofrance2026! ?'))return;
  usersCache[idx].hash='da64d74e30f78be8fd7e8b22cc86519f7c66d35b1dfdb602b22e8c74a0771965';
  usersCache[idx].premiere_connexion=true;
  await saveUsers();renderUsersList();
  showMsg('nu-msg','Mot de passe réinitialisé.','success');
}

function openNewUserForm(){document.getElementById('new-user-form').style.display='block';}

async function saveNewUser(){
  const login=document.getElementById('nu-login').value.trim().toLowerCase();
  const nom=document.getElementById('nu-nom').value.trim();
  const role=document.getElementById('nu-role').value;
  const pwd=document.getElementById('nu-pwd').value.trim();
  if(!login||!nom){showMsg('nu-msg','Login et nom obligatoires.','err');return;}
  if(usersCache.find(u=>u.login===login)){showMsg('nu-msg','Ce login existe déjà.','err');return;}
  if(pwd.length<6){showMsg('nu-msg','Mot de passe trop court.','err');return;}
  const hash=await sha256(pwd);
  usersCache.push({login,nom,role,hash,actif:true,premiere_connexion:true});
  await saveUsers();renderUsersList();
  document.getElementById('new-user-form').style.display='none';
  document.getElementById('nu-login').value='';document.getElementById('nu-nom').value='';
  showMsg('nu-msg','Compte créé. Mot de passe initial : '+pwd,'success');
}

async function changerMonMotDePasse(){
  const newPwd=document.getElementById('mc-new').value;
  const conf=document.getElementById('mc-confirm').value;
  if(newPwd.length<8){showMsg('mc-msg','8 caractères minimum.','err');return;}
  if(newPwd!==conf){showMsg('mc-msg','Les mots de passe ne correspondent pas.','err');return;}
  const hash=await sha256(newPwd);
  const idx=usersCache.findIndex(u=>u.login===currentUser.login);
  if(idx>=0){usersCache[idx].hash=hash;usersCache[idx].premiere_connexion=false;}
  await saveUsers();
  document.getElementById('mc-new').value='';document.getElementById('mc-confirm').value='';
  showMsg('mc-msg','Mot de passe modifié avec succès.','success');
}


// ═══════════════════════════════════════════════════════════════════════
// ─── EXPORT EXCEL ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

function exportStockEPI(){
  if(typeof XLSX==='undefined'){alert('Librairie XLSX non chargée. Vérifiez votre connexion.');return;}
  const rows=[['Référence','Désignation','Catégorie','Taille','Stock','Seuil','Attribués','Prix unitaire']];
  CATALOGUE.filter(a=>!a.catalogOnly).forEach(a=>{
    (a.tailles||['Unique']).forEach(t=>{
      const key=String(a.ref||'')+'__'+String(t||'');
      const s=stockCache[key]||{qte:0,seuil:0,attribues:0};
      rows.push([
        String(a.ref||''),
        String(a.nom||''),
        String(a.cat||''),
        String(t||''),
        Number(s.qte)||0,
        Number(s.seuil)||0,
        Number(s.attribues)||0,
        Number(a.prix)||0
      ]);
    });
  });
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!cols']=[{wch:14},{wch:35},{wch:18},{wch:8},{wch:7},{wch:7},{wch:10},{wch:12}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Stock EPI');
  const date=new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb,'GESTOCK_Stock_EPI_'+date+'.xlsx');
}

function exportStockMobilite(){
  if(typeof XLSX==='undefined'){alert('Librairie XLSX non chargée. Vérifiez votre connexion.');return;}
  const wb=XLSX.utils.book_new();
  // Téléphones
  const telRows=[['ID','Marque','Modèle','IMEI','Ligne SIM','Collaborateur','Site','Statut','Date attribution']];
  (mobCache.tel||[]).forEach(t=>telRows.push([t.id||'',t.marque||'',t.modele||'',t.imei||'',t.sim||'',t.collaborateur||'',t.site||'',t.statut||'',t.date_attribution||'']));
  const wsTel=XLSX.utils.aoa_to_sheet(telRows);
  wsTel['!cols']=[{wch:14},{wch:12},{wch:22},{wch:18},{wch:14},{wch:25},{wch:16},{wch:12},{wch:16}];
  XLSX.utils.book_append_sheet(wb,wsTel,'Telephones');
  // Tablettes
  const tabRows=[['ID','Nom','Marque','Modèle','IMEI','Collaborateur','Site','Statut','Date attribution']];
  (mobCache.tab||[]).forEach(t=>tabRows.push([t.id||'',t.nom||'',t.marque||'',t.modele||'',t.imei||'',t.collaborateur||'',t.site||'',t.statut||'',t.date_attribution||'']));
  const wsTab=XLSX.utils.aoa_to_sheet(tabRows);
  wsTab['!cols']=[{wch:14},{wch:20},{wch:12},{wch:22},{wch:18},{wch:25},{wch:16},{wch:12},{wch:16}];
  XLSX.utils.book_append_sheet(wb,wsTab,'Tablettes');
  // Badges
  const badgeLabels={acces:'Acces',watchdoc:'WatchDoc',alarme:'Unaverse',telecommande_siege:'Acces Siege',autre:'Autre'};
  const badgeRows=[['ID','Numéro','Type','Collaborateur','Site','Statut','Date attribution']];
  (mobCache.badge||[]).forEach(b=>badgeRows.push([b.id||'',b.numero||'',badgeLabels[b.type_badge]||b.type_badge||'',b.collaborateur||'',b.site||'',b.statut||'',b.date_attribution||'']));
  const wsBadge=XLSX.utils.aoa_to_sheet(badgeRows);
  wsBadge['!cols']=[{wch:14},{wch:14},{wch:20},{wch:25},{wch:16},{wch:12},{wch:16}];
  XLSX.utils.book_append_sheet(wb,wsBadge,'Badges');
  const date=new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb,'GESTOCK_Stock_Mobilite_'+date+'.xlsx');
}


// ═══════════════════════════════════════════════════════════════════════
// ─── MODULE DASHBOARD ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

let _dbCharts = {};

function destroyChart(id) {

// ─── INITIALISATION ──────────────────────────────────────────────────────────
async function initEpi(){
  document.getElementById('conn-detail').textContent='Test de connexion GitHub…';
  setSyncStatus('syncing','Connexion…');
  if(!localStorage.getItem('domo_gh_token')){
    setSyncStatus('error','Token manquant');
    document.getElementById('conn-detail').innerHTML='<span style="color:#c53030">⚠ Token GitHub non configuré — va dans <strong>⚙ Paramètres</strong> pour le saisir</span>';
    return;
  }
  try{
    const r=await fetchWithTimeout(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`,{headers:{'Authorization':'Bearer '+getGHToken(),'Accept':'application/vnd.github.v3+json'}},12000);
    if(r.status===401){setSyncStatus('error','Token invalide');document.getElementById('conn-detail').textContent='✗ Erreur 401 : Token invalide';return;}
    if(r.status===403){setSyncStatus('error','Permission refusée');document.getElementById('conn-detail').textContent='✗ Erreur 403 : Accès refusé';return;}
    if(r.status===404){setSyncStatus('error','Dépôt introuvable');document.getElementById('conn-detail').textContent='✗ Erreur 404 : Dépôt introuvable';return;}
    if(!r.ok){setSyncStatus('error','GitHub erreur '+r.status);document.getElementById('conn-detail').textContent='✗ GitHub erreur '+r.status;return;}
  }catch(e){
    setSyncStatus('error','Réseau: '+e.message);
    document.getElementById('conn-detail').textContent='✗ Erreur réseau: '+e.message;
    return;
  }

  try{
    setSyncStatus('syncing','Chargement EPI…');
    await loadAllStock();
    setSyncStatus('syncing','Chargement mobilité…');
    await loadMobDevices();
    setSyncStatus('syncing','Chargement historique…');
    await loadAllMouvements();
    await loadCollabs();
    setSyncStatus('syncing','Chargement papeterie…');
    await loadPapeterieStock();
    await loadPapeterieMovements();
    setSyncStatus('syncing','Chargement attentes…');
    await loadAttentes();
    setSyncStatus('ok','Base synchronisée');
    renderStockStats();
    renderPapeterieStats();
    updateAlerteBadge();

    const n=getAlertes().length;
    const nPE=getPEAlertes().length;
    const nPap=getPapeterieAlertes().length;
    const nAtt=getAttentesDisponibles().length;
    const banners=[];
    if(nAtt>0) banners.push(`<div class="banner-alerte" style="background:#f0fff4;border-color:#9ae6b4"><div style="font-size:16px">⏳</div><div style="flex:1"><strong>${nAtt} article(s) en attente prêt(s) à envoyer</strong> — stock reconstitué</div><button class="btn success small" onclick="goTab('alertes',document.getElementById('btn-alertes'))">Voir</button></div>`);
    if(n>0) banners.push(`<div class="banner-alerte"><div style="font-size:16px">📬</div><div style="flex:1"><strong>${n} article(s) EPI en alerte stock</strong></div><button class="btn primary small" onclick="goTab('alertes',document.getElementById('btn-alertes'))">Voir les alertes</button></div>`);
    if(nPE>0) banners.push(`<div class="banner-alerte" style="background:#f0fff4;border-color:#9ae6b4"><div style="font-size:16px">🎓</div><div style="flex:1"><strong>${nPE} complément(s) EPI à envoyer</strong> — fin de période d'essai</div><button class="btn success small" onclick="goTab('alertes',document.getElementById('btn-alertes'))">Voir</button></div>`);
    if(nPap>0) banners.push(`<div class="banner-alerte papeterie"><div style="font-size:16px">📄</div><div style="flex:1"><strong>${nPap} article(s) papeterie en alerte stock</strong></div><button class="btn primary small" onclick="goTab('papeterie',document.getElementById('btn-papeterie'))">Voir papeterie</button></div>`);
    if(banners.length) document.getElementById('global-banner').innerHTML=banners.join('');
  }catch(e){
    setSyncStatus('error','Erreur: '+e.message);console.error(e);
  }
}
// initApp() appelé par chaque page individuellement