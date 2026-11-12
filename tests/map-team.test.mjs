import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers.mjs';
const snapshot=async(req,cookie)=>(await req('state',null,cookie)).data;
test('blank team names receive distinct game-scoped defaults, including simultaneous requests',async()=>{
 const {req,admin}=await setup({live:false});
 const create=name=>req('admin/team',{...(name===undefined?{}:{name}),color:'#123456',passcode:'test-pass',members:['Alex','Sam']},admin);
 assert.equal((await create('TEAM 1')).status,200);
 const results=await Promise.all([create(''),create('   '),create()]);assert.ok(results.every(r=>r.status===200));
 let st=await snapshot(req,admin);assert.ok(['TEAM 1','Team 2','Team 3','Team 4'].every(n=>st.teams.some(t=>t.name===n)));
 const original=st.teams.find(t=>t.name==='Team 2');
 await req('admin/team',{id:original.id,color:original.color,members:['Alex']},admin);st=await snapshot(req,admin);assert.equal(st.teams.find(t=>t.id===original.id).name,'Team 2');
 assert.equal((await create({})).status,400);assert.equal((await create('a'.repeat(61))).status,400);
 await req('admin/game',{name:'Another game'},admin);await create('');st=await snapshot(req,admin);assert.equal(st.teams[0].name,'Team 1');
});
test('restored public activity includes only the current game and safe event fields',async()=>{
 const {req,admin,teams:[a],claim}=await setup();await claim(a,'old-game-bar');const first=(await snapshot(req,admin)).settings.id;
 await req('admin/game',{name:'Second game'},admin);let st=await snapshot(req,admin);assert.deepEqual(st.activity,[]);
 await req('admin/team',{name:'Other team',color:'#ffcc00',passcode:'other-pass'},admin);st=await snapshot(req,admin);const other=st.teams[0];
 await req('admin/lifecycle',{action:'enable'},admin);const cookie=(await req('login',{teamId:other.id,passcode:'other-pass'})).cookie;await req('admin/lifecycle',{action:'start'},admin);
 await claim({...other,cookie},'new-game-bar');st=await snapshot(req,cookie);assert.equal(st.activity.length,1);assert.equal(st.activity[0].venue,'new-game-bar');assert.equal(st.audit,undefined);
 assert.ok(Object.keys(st.activity[0]).every(k=>['id','action','team','venue','previousOwner'].includes(k)));
 assert.equal((await snapshot(req,a.cookie)).activity[0].venue,'old-game-bar');
 await req('admin/reset',{confirmation:'RESET'},admin);assert.equal((await req('state',null,a.cookie)).status,200);
 const fresh=(await req('login',{admin:true,passcode:'Long-admin-secret-2026'})).cookie;await req('admin/select-game',{id:first},fresh);assert.equal((await snapshot(req,fresh)).venues.length,1);
});
test('legacy countdown remains readable and countdown controls isolate saved games',async()=>{
 const {req,admin,DB}=await setup();const legacy={label:'Old final stop',address:'NYC',route:'R',durationMs:5000,remainingMs:5000,status:'paused',endsAt:null};
 DB.db.prepare('UPDATE settings SET countdown=? WHERE id=1').run(JSON.stringify(legacy));assert.deepEqual((await snapshot(req,admin)).countdown,legacy);
 await req('admin/game',{name:'New draft'},admin);assert.equal((await snapshot(req,admin)).countdown,null);
 await req('admin/countdown',{action:'start',label:'New stop',address:'Queens',route:'7',seconds:60},admin);const second=(await snapshot(req,admin)).settings.id;
 await req('admin/select-game',{id:'default'},admin);assert.deepEqual((await snapshot(req,admin)).countdown,legacy);
 await req('admin/reset',{confirmation:'RESET'},admin);const fresh=(await req('login',{admin:true,passcode:'Long-admin-secret-2026'})).cookie;
 await req('admin/select-game',{id:second},fresh);assert.equal((await snapshot(req,fresh)).countdown.label,'New stop');
});
