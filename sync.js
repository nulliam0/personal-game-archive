(()=>{"use strict";
const URL="https://tfbncmdmsxdmebkdcmts.supabase.co";
const KEY="sb_publishable_dqqRS1NjFWJ8P6XNSzu_tQ_M4vpeYbK";
const localKey="pga-v1";
let client=null,user=null,remote={},busy=false,ready=false,dirty=new Set();
const $=id=>document.getElementById(id);
const info=message=>{if($("cloudMessage"))$("cloudMessage").textContent=message};
const local=()=>{try{return JSON.parse(localStorage.getItem(localKey)||"{}")}catch{return {}}};
const writeLocal=s=>{localStorage.setItem(localKey,JSON.stringify(s));if(typeof state!=="undefined")state=s;if(typeof render==="function")render()};
const valid=d=>({status:["want","playing","done","dropped"].includes(d?.status)?d.status:"want",favorite:!!d?.favorite,note:typeof d?.note==="string"?d.note:""});
const changed=d=>d&&((d.status&&d.status!=="want")||d.favorite||d.note);
const rowsToState=rows=>Object.fromEntries(rows.map(r=>[r.game_id,{status:r.status,favorite:r.favorite,note:r.note}]));
const userRow=(id,d)=>({user_id:user.id,game_id:id,...valid(d),updated_at:new Date().toISOString()});
async function loadCloud(){const {data,error}=await client.from("game_progress").select("game_id,status,favorite,note,updated_at").eq("user_id",user.id);if(error)throw error;remote=rowsToState(data||[]);return data||[]}
async function persist(id){if(!user||!ready)return;const d=local()[id]||{};const {error}=await client.from("game_progress").upsert(userRow(id,d),{onConflict:"user_id,game_id"});if(error)throw error;remote[id]=valid(d)}
async function onLocalSave(){if(!user||!ready)return;const current=local();for(const [id,d] of Object.entries(current)){if(JSON.stringify(valid(d))!==JSON.stringify(valid(remote[id]||{})))dirty.add(id)}if(busy)return;busy=true;try{while(dirty.size){const id=dirty.values().next().value;dirty.delete(id);await persist(id)}info("Изменения сохранены в облаке")}catch(e){info("Ошибка синхронизации: "+e.message)}finally{busy=false}}
async function signIn(){const email=$("cloudEmail").value.trim();if(!email)return info("Введи адрес электронной почты");const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});info(error?"Ошибка: "+error.message:"Письмо со ссылкой отправлено. Проверь почту.")}
async function signedIn(session){user=session?.user||null;ready=false;$("cloudLogged").hidden=!user;$("cloudLoggedOut").hidden=!!user;if(!user){info("Облако не подключено — данные хранятся на этом устройстве");return} $("cloudIdentity").textContent=user.email||"Аккаунт";try{const rows=await loadCloud();const existing=local();const count=Object.values(existing).filter(changed).length;const cloud=rowsToState(rows);const missing=Object.keys(existing).filter(k=>changed(existing[k])&&!cloud[k]);if(missing.length){$("cloudImport").hidden=false;info("Облако подключено. На устройстве есть "+missing.length+" локальных записей, которых нет в облаке. Нажми «Перенести локальные данные», чтобы сохранить их.");}else{$("cloudImport").hidden=true;writeLocal({...existing,...cloud});ready=true;info("Синхронизировано: "+rows.length+" записей")}}catch(e){info("Не удалось загрузить облачные записи: "+e.message)}}
async function importLocal(){if(!user)return;const existing=local();const missing=Object.entries(existing).filter(([id,d])=>changed(d)&&!remote[id]);try{if(missing.length){const {error}=await client.from("game_progress").upsert(missing.map(([id,d])=>userRow(id,d)),{onConflict:"user_id,game_id"});if(error)throw error}const rows=await loadCloud();writeLocal({...existing,...rowsToState(rows)});ready=true;$("cloudImport").hidden=true;info("Локальные записи перенесены, синхронизация включена")}catch(e){info("Ошибка переноса: "+e.message)}}
async function start(){const panel=$("backup");if(!panel)return;const div=document.createElement("div");div.className="panel";div.innerHTML='<h3>☁ Синхронизация</h3><p class="muted">Вход по электронной почте. Заметки и статусы доступны только твоему аккаунту.</p><div id="cloudLoggedOut"><input type="email" id="cloudEmail" placeholder="Твой email" autocomplete="email"><button id="cloudSignIn">Получить ссылку для входа</button></div><div id="cloudLogged" hidden><p id="cloudIdentity"></p><button id="cloudImport" hidden>Перенести локальные данные</button> <button id="cloudReload">Обновить из облака</button> <button id="cloudSignOut">Выйти</button></div><p class="muted" id="cloudMessage">Загрузка…</p>';panel.prepend(div);
if(!window.supabase?.createClient){info("Не удалось загрузить библиотеку Supabase. Проверь интернет.");return}
client=window.supabase.createClient(URL,KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
$("cloudSignIn").onclick=signIn;$("cloudImport").onclick=importLocal;$("cloudReload").onclick=()=>signedIn({user});$("cloudSignOut").onclick=async()=>{await client.auth.signOut();user=null;ready=false;info("Выполнен выход. Локальные записи сохранены.");$("cloudLogged").hidden=true;$("cloudLoggedOut").hidden=false};
const oldSave=window.save; // original save is top-level const, so use storage event hook via explicit change in index
window.archiveCloudSaved=onLocalSave;
const {data}=await client.auth.getSession();await signedIn(data.session);
client.auth.onAuthStateChange((event,session)=>{if(event==="SIGNED_IN"&&session?.user?.id!==user?.id)signedIn(session);if(event==="SIGNED_OUT")signedIn(null)});
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();