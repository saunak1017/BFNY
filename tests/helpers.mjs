import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {GameRoom} from '../worker/index.js';
export class D1 {
 constructor(){this.db=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())this.db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));}
 prepare(sql){const db=this.db;let args=[];return {bind(...a){args=a;return this;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};}};}
 async batch(stmts){this.db.exec('BEGIN');try{const results=[];for(const s of stmts)results.push(await s.run());this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
export async function setup({live=true}={}){
 const DB=new D1(),objects=new Map();let tail=Promise.resolve();
 const ctx={blockConcurrencyWhile(fn){const run=tail.then(fn);tail=run.catch(()=>{});return run;},getWebSockets(){return [];}};
 const game=new GameRoom(ctx,{DB,ADMIN_PASSWORD:'Long-admin-secret-2026',GOOGLE_MAPS_BROWSER_KEY:'test',PHOTOS:{async put(id,bytes){objects.set(id,bytes);},async get(id){return objects.has(id)?{body:objects.get(id)}:null;}}});
 const req=async(path,body,cookie,origin='https://game.example')=>{const r=await game.fetch(new Request('https://game.example/api/'+path,{method:body?'POST':'GET',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body?body instanceof FormData?body:JSON.stringify(body):undefined}));let data;try{data=await r.clone().json();}catch{data=null;}return {status:r.status,data,cookie:r.headers.get('Set-Cookie')?.split(';')[0]};};
 const admin=(await req('login',{admin:true,passcode:'Long-admin-secret-2026'})).cookie;
 const teams=[];for(const name of ['Mets','Queens','Brooklyn']){assert.equal((await req('admin/team',{name,color:'#ffcc00',passcode:'secret123',members:[name+' One',name+' Two']},admin)).status,200);}
 const st=(await req('state',null,admin)).data;
 if(live)await req('admin/lifecycle',{action:'enable'},admin);
 for(const t of live?st.teams:[]){teams.push({...t,cookie:(await req('login',{teamId:t.id,passcode:'secret123'})).cookie});}
 if(live)await req('admin/lifecycle',{action:'start'},admin);
 const upload=async(cookie,kind='photo')=>{const f=new FormData();f.append('file',new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}),'test.png');f.append('kind',kind);return req('upload',f,cookie);};
 const claim=async(t,placeId='bar-1')=>req('claim',{placeId,name:'Test Bar',address:'NYC',photo:(await upload(t.cookie)).data.id},t.cookie);
 return {DB,req,admin,teams:live?teams:st.teams,upload,claim,game};
}
