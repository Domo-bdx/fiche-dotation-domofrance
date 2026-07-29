// GESTOCK — common.js v2
// Module partagé chargé par toutes les pages

// ─── GITHUB API ──────────────────────────────────────────────────────────────
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


// ─── ÉTAT LOCAL ──────────────────────────────────────────────────────────────
// ─── ÉTAT LOCAL ───────────────────────────────────────────────────────────────
let stockCache={};
let mouvementsCache=[];
let epiLines=[];
let telLines=[];
let tabLines=[];
let badgeLines=[];
let activeStockCat='Tous';
let activeCatCat='Tous';


// ─── CHARGEMENT MOUVEMENTS ───────────────────────────────────────────────────
async function loadAllMouvements(){
  try{const arr=await readData('mouvements');mouvementsCache=arr.slice(0,500);}
  catch(e){console.error(e)}
}


// ─── SYNC STATUS ─────────────────────────────────────────────────────────────
function setSyncStatus(state, label){
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if(dot) dot.style.background = state==='ok'?'#48bb78':state==='syncing'?'#ed8936':'#e53e3e';
  if(lbl) lbl.textContent = label;
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
function showMsg(id, msg, type){
  const el = document.getElementById(id);
  if(!el) return;
  el.innerHTML = '<div class="msg ' + type + '">' + msg + '</div>';
  setTimeout(()=>{ if(el) el.innerHTML=''; }, 5000);
}

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
