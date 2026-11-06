(()=>{"use strict";
const URL="https://tfbncmdmsxdmebkdcmts.supabase.co",KEY="sb_publishable_dqqRS1NjFWJ8P6XNSzu_tQ_M4vpeYbK",STORAGE="pga-v1";
let client=null,user=null,ready=false,remote={},pending=new Map(),sending=null,lastSnapshot={},lastSync=0,importCandidates={};
let revision=0,sessionVersion=0,cloudRequest=0;
const $=id=>document.getElementById(id);
const info=m=>{if($("cloudMessage"))$("cloudMessage").textContent=m};
const read=()=>{try{return JSON.parse(localStorage.getItem(STORAGE)||"{}")}catch{return {}}};
const normalize=d=>({status:["want","playing","done","dropped"].includes(d?.status)?d.status:"want",favorite:!!d?.favorite,note:typeof d?.note==="string"?d.note:"",rating:Number.isInteger(Number(d?.rating))&&Number(d.rating)>=1&&Number(d.rating)<=10?Number(d.rating):null,want_to_buy:!!d?.want_to_buy});
const signature=d=>JSON.stringify(normalize(d));
const meaningful=d=>{const x=normalize(d);return x.status!=="want"||x.favorite||!!x.note||x.rating!==null||x.want_to_buy};
const fromRows=rows=>Object.fromEntries(rows.map(r=>[r.game_id,normalize(r)]));
const toRow=(id,d)=>({user_id:user.id,game_id:id,...normalize(d),updated_at:new Date().toISOString()});
function setLocal(data){localStorage.setItem(STORAGE,JSON.stringify(data));state=data;lastSnapshot=structuredClone(data);render()}
function snapshot(){lastSnapshot=structuredClone(read())}
async function fetchCloud(){const {data,error}=await client.from("game_progress").select("game_id,status,favorite,note,rating,want_to_buy,updated_at").eq("user_id",user.id);if(error)throw error;return data||[]}
function updateImportNotice(){const current=read();const missing=Object.keys(current).filter(id=>meaningful(current[id])&&!remote[id]);const conflicts=Object.keys(current).filter(id=>meaningful(current[id])&&remote[id]&&signature(current[id])!==signature(remote[id]));$("cloudImport").hidden=!(missing.length||conflicts.length);return {missing,conflicts}}
async function signIn(){const email=$("cloudEmail").value.trim();if(!email)return info("Укажи email");const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});info(error?"Ошибка: "+error.message:"Письмо для входа отправлено")}
async function syncFromCloud(){
if(!user)return;
if(sending||(ready&&pending.size)){info("Есть несохранённые изменения. Дождись отправки перед обновлением.");return}
const session=sessionVersion,version=revision,request=++cloudRequest;
const rows=await fetchCloud();
if(session!==sessionVersion||request!==cloudRequest)return;
// A save may have started AND finished while the cloud read was in flight.
if(version!==revision||pending.size||sending){
ready=true;info("Локальные изменения сохранены; устаревший ответ облака пропущен.");await flush();return
}
remote=fromRows(rows);
const existing=read();const {missing,conflicts}=updateImportNotice();importCandidates=Object.fromEntries([...missing,...conflicts].map(id=>[id,existing[id]]));const merged={...existing,...remote};for(const id of missing)merged[id]=existing[id];setLocal(merged);ready=true;lastSync=Date.now();info("Облако: "+rows.length+" записей"+(missing.length||conflicts.length?". Есть локальные отличия — проверь перенос.":". Синхронизировано."))
}
async function signedIn(session){
const next=session?.user||null;if(next?.id===user?.id&&ready)return;
user=next;const version=++sessionVersion;ready=false;pending.clear();remote={};importCandidates={};
$("cloudLogged").hidden=!user;$("cloudLoggedOut").hidden=!!user;
if(!user){info("Локальный режим: войди для синхронизации");return}
$("cloudIdentity").textContent=user.email||"Аккаунт";
try{if(sending)await sending;if(version===sessionVersion)await syncFromCloud()}catch(e){if(version===sessionVersion)info("Ошибка загрузки: "+e.message)}
}
async function importLocal(){
if(!user||!ready)return;
const existing=importCandidates;const ids=Object.keys(existing).filter(id=>meaningful(existing[id])&&(!remote[id]||signature(existing[id])!==signature(remote[id])));
if(!ids.length){$("cloudImport").hidden=true;return}
if(!confirm("Перенести "+ids.length+" локальных записей в облако? Совпадающие игры будут перезаписаны локальными значениями. Сначала сохрани экспорт JSON, если не уверен."))return;
try{
const current=read();for(const id of ids)current[id]=existing[id];
setLocal(current);for(const id of ids)pending.set(id,++revision);
importCandidates={};$("cloudImport").hidden=true;
// Imports and card edits must share one writer and the same retry path.
await flush()
}catch(e){info("Ошибка переноса: "+e.message)}
}
function flush(){
if(sending)return sending;
if(!ready||!user||!pending.size)return Promise.resolve();
const session=sessionVersion;
// Defer work until sending holds the promise, even if all queued IDs disappeared.
sending=Promise.resolve().then(async()=>{
try{
while(pending.size&&session===sessionVersion){
const [id,version]=pending.entries().next().value,current=read();
// Replacing a local JSON file must not turn absent records into cloud resets.
if(!Object.prototype.hasOwnProperty.call(current,id)){pending.delete(id);continue}
const d=normalize(current[id]);
const {error}=await client.from("game_progress").upsert(toRow(id,d),{onConflict:"user_id,game_id"});
if(session!==sessionVersion)return;
if(error)throw error;
remote[id]=d;
// Only acknowledge the revision actually sent; later saves remain queued.
if(pending.get(id)===version)pending.delete(id)
}
if(session===sessionVersion)info("Изменения сохранены в облаке")
}catch(e){if(session===sessionVersion)info("Не удалось сохранить: "+e.message+" — изменения остались локально; нажми «Повторить отправку».")}
}).finally(()=>{sending=null});
return sending
}
function onLocalSave(){
const current=read();++revision;
for(const id of new Set([...Object.keys(lastSnapshot),...Object.keys(current)]))if(signature(current[id])!==signature(lastSnapshot[id])){
if(Object.prototype.hasOwnProperty.call(current,id))pending.set(id,revision);
delete importCandidates[id]
}
lastSnapshot=structuredClone(current);if(user&&ready)flush()
}
async function retry(){try{if(!pending.size||!ready){await syncFromCloud();return}await flush()}catch(e){info("Ошибка: "+e.message)}}
async function start(){const panel=$("backup");if(!panel)return;const box=document.createElement("div");box.className="panel";box.innerHTML='<h3>☁ Синхронизация</h3><p class="muted">Личные данные доступны только после входа. Сохранение происходит при изменении карточки.</p><div id="cloudLoggedOut"><input type="email" id="cloudEmail" placeholder="Email" autocomplete="email"><button id="cloudSignIn">Получить ссылку для входа</button></div><div id="cloudLogged" hidden><p id="cloudIdentity"></p><div class="actions"><button id="cloudImport" hidden>Перенести локальные данные</button><button id="cloudReload">Обновить из облака</button><button id="cloudRetry">Повторить отправку</button><button id="cloudSignOut">Выйти</button></div></div><p id="cloudMessage" class="muted">Подключение…</p>';panel.prepend(box);snapshot();
if(!window.supabase?.createClient){info("Библиотека Supabase не загрузилась — локальные данные доступны");return}
client=window.supabase.createClient(URL,KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
$("cloudSignIn").onclick=signIn;$("cloudImport").onclick=importLocal;$("cloudReload").onclick=async()=>{try{await syncFromCloud()}catch(e){info("Ошибка: "+e.message)}};$("cloudRetry").onclick=retry;$("cloudSignOut").onclick=async()=>{await client.auth.signOut();await signedIn(null)};
window.archiveCloudSaved=onLocalSave;
const {data,error}=await client.auth.getSession();if(error)info("Ошибка сессии: "+error.message);else await signedIn(data.session);
client.auth.onAuthStateChange((event,session)=>{if(event==="SIGNED_IN"&&session?.user?.id!==user?.id)signedIn(session);if(event==="SIGNED_OUT")signedIn(null)});
window.addEventListener("focus",()=>{if(user&&ready&&Date.now()-lastSync>15000&&!pending.size)syncFromCloud().catch(e=>info(e.message))});
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
