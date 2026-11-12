import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {setup} from './helpers.mjs';

const state=async(req,cookie)=>(await req('state',null,cookie)).data;
const outcome=(req,cookie,id,status='failed')=>req('outcome',{id,status,challenge:1},cookie);
const correction=(req,admin,id,status='available',owner=null)=>req('admin/venue',{id,name:'Corrected Bar',address:'NYC',status,owner,challenge:1,reason:'Correct an accidental submission'},admin);

// Exercise the upgrade with populated legacy tables and foreign keys enabled.
test('migration preserves existing game, sessions, media, history and relationships',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 db.exec(`UPDATE settings SET phase='live',logo='logo' WHERE id=1;
 INSERT INTO teams VALUES('team','Queens','#123456','original-hash',1,3);
 INSERT INTO sessions VALUES('token','team','team',9999999999999);
 INSERT INTO venues VALUES('bar','Bar','NYC','team','locked','2026-01-01');
 INSERT INTO attempts VALUES('attempt','bar','team','claim','completed',1,'photo',NULL,'2026-01-01','2026-01-01');
 INSERT INTO media VALUES('photo','team','photo','image/png','2026-01-01');
 INSERT INTO audit VALUES('audit','claim','{}','2026-01-01');BEGIN;`);
 db.exec(readFileSync(new URL('../migrations/0002_games_rosters_drinks.sql',import.meta.url),'utf8'));
 db.exec('COMMIT');
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 const game=db.prepare('SELECT * FROM games').get();assert.equal(game.id,'default');assert.equal(game.phase,'live');assert.equal(game.logo,'logo');assert.ok(game.timer_started_at>0);
 assert.equal(db.prepare('SELECT password FROM teams').get().password,'original-hash');assert.equal(db.prepare('SELECT adjustment FROM teams').get().adjustment,3);
 for(const table of ['teams','sessions','venues','attempts','media','audit'])assert.equal(db.prepare(`SELECT game_id FROM ${table}`).get().game_id,'default');
 assert.equal(db.prepare('SELECT photo FROM attempts').get().photo,'photo');
 assert.equal(db.prepare('SELECT podium_1 FROM settings').get().podium_1,'1');db.close();
});

test('drafts persist privately; enabling opens logins while start independently opens play',async()=>{
 const {req,admin,teams:[a],upload}=await setup({live:false});
 let st=await state(req,admin);assert.equal(st.settings.phase,'draft');assert.equal(st.settings.started_at,null);assert.equal(st.settings.timer_elapsed_ms,0);
 assert.equal((await req('bootstrap')).data.games.length,0);assert.equal((await req('bootstrap')).data.teams.length,0);
 assert.equal((await req('login',{teamId:a.id,passcode:'secret123'})).status,409);
 assert.equal((await req('admin/lifecycle',{action:'start'},admin)).status,409);
 assert.equal((await req('admin/settings',{phase:'live',name:'Bypass'},admin)).status,400);
 assert.equal((await req('admin/lifecycle',{action:'enable'},admin)).status,200);
 const login=await req('login',{teamId:a.id,passcode:'secret123'});assert.equal(login.status,200);
 st=await state(req,login.cookie);assert.equal(st.settings.phase,'lobby');assert.equal(st.settings.started_at,null);assert.equal(st.settings.timer_elapsed_ms,0);
 assert.equal((await upload(login.cookie)).status,409);
 assert.equal((await req('claim',{placeId:'early',name:'Too Early',address:'NYC'},login.cookie)).status,409);
 assert.equal((await req('admin/lifecycle',{action:'start'},admin)).status,200);
 st=await state(req,login.cookie);assert.equal(st.settings.phase,'live');assert.ok(st.settings.started_at>0);assert.equal(st.settings.timer_started_at,st.settings.started_at);
 assert.equal((await req('admin/lifecycle',{action:'start'},admin)).status,409);
 assert.equal((await upload(login.cookie)).status,200);
});

test('game clock accumulates elapsed time and freezes across pause, end and resume',async()=>{
 const {req,admin,DB}=await setup();
 DB.db.prepare('UPDATE games SET timer_started_at=? WHERE id=?').run(Date.now()-65000,'default');
 assert.equal((await req('admin/lifecycle',{action:'pause'},admin)).status,200);
 let st=await state(req,admin);const elapsed=st.settings.timer_elapsed_ms,first=st.settings.started_at;
 assert.ok(elapsed>=65000);assert.equal(st.settings.timer_started_at,null);assert.equal(st.settings.phase,'paused');
 assert.equal((await state(req,admin)).settings.timer_elapsed_ms,elapsed);
 assert.equal((await req('admin/lifecycle',{action:'resume'},admin)).status,200);
 DB.db.prepare('UPDATE games SET timer_started_at=? WHERE id=?').run(Date.now()-5000,'default');
 assert.equal((await req('admin/lifecycle',{action:'end'},admin)).status,200);
 st=await state(req,admin);assert.ok(st.settings.timer_elapsed_ms>=elapsed+5000);assert.equal(st.settings.started_at,first);assert.equal(st.settings.timer_started_at,null);
 const ended=st.settings.timer_elapsed_ms;
 await req('admin/lifecycle',{action:'resume'},admin);st=await state(req,admin);assert.equal(st.settings.timer_elapsed_ms,ended);assert.equal(st.settings.started_at,first);
});

test('one pending outcome blocks claims and steals on every team device',async()=>{
 const {req,admin,teams:[a,b],claim,upload}=await setup();
 const open=await claim(b,'open-bar');await outcome(req,b.cookie,open.data.id,'vetoed');
 const original=await claim(a,'first-bar');
 const otherDevice=(await req('login',{teamId:a.id,passcode:'secret123'})).cookie;
 const photo=(await upload(otherDevice)).data.id;
 for(const placeId of ['second-bar','open-bar']){
  const blocked=await req('claim',{placeId,name:'Second Bar',address:'NYC',photo},otherDevice);
  assert.equal(blocked.status,409);assert.equal(blocked.data.code,'OUTCOME_REQUIRED');assert.equal(blocked.data.attemptId,original.data.id);assert.equal(blocked.data.venueName,'Test Bar');
 }
 assert.equal((await state(req,admin)).venues.length,2);
 await outcome(req,a.cookie,original.data.id);const next=await claim(a,'open-bar');assert.equal(next.status,200);assert.equal(next.data.kind,'steal');
 assert.equal((await claim(a,'third-bar')).data.code,'OUTCOME_REQUIRED');
 await outcome(req,a.cookie,next.data.id,'vetoed');assert.equal((await claim(a,'third-bar')).status,200);
});

test('simultaneous different-bar claims by one team cannot bypass reporting',async()=>{
 const {req,admin,teams:[a],upload}=await setup();const photo=(await upload(a.cookie)).data.id;
 const results=await Promise.all(['a','b'].map(placeId=>req('claim',{placeId,name:placeId,address:'NYC',photo},a.cookie)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const st=await state(req,admin);assert.equal(st.venues.length,1);assert.equal(st.attempts.length,1);
 const won=results.find(r=>r.status===200);await outcome(req,a.cookie,won.data.id,'completed');
 assert.equal((await req('claim',{placeId:'c',name:'c',address:'NYC',photo},a.cookie)).status,200);
});

test('drinks count selected teammates once and survive failed challenges and ownership changes',async()=>{
 const {req,admin,teams:[a,b],upload}=await setup();let st=await state(req,admin);
 const ma=st.members.find(m=>m.team_id===a.id),mb=st.members.find(m=>m.team_id===b.id),photo=(await upload(a.cookie)).data.id;
 for(const drinkers of [[ma.id,ma.id],[mb.id],['unknown']])assert.equal((await req('claim',{placeId:'bar',name:'Bar',address:'NYC',photo,drinkers},a.cookie)).status,400);
 assert.equal((await state(req,admin)).drinks.length,0);
 const body={placeId:'bar',name:'Bar',address:'NYC',photo,drinkers:[ma.id]};
 const results=await Promise.all([req('claim',body,a.cookie),req('claim',body,a.cookie)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const first=results.find(r=>r.status===200);await outcome(req,a.cookie,first.data.id);
 const steal=await req('claim',{...body,photo:(await upload(b.cookie)).data.id,drinkers:[mb.id]},b.cookie);assert.equal(steal.status,200);
 await outcome(req,b.cookie,steal.data.id,'completed');st=await state(req,admin);
 assert.equal(st.teams.find(t=>t.id===a.id).score,0);assert.equal(st.teams.find(t=>t.id===b.id).score,2);
 assert.equal(st.drinkers.find(m=>m.id===ma.id).drinks,1);assert.equal(st.drinkers.find(m=>m.id===mb.id).drinks,1);assert.equal(st.drinks.length,2);
 assert.equal((await outcome(req,b.cookie,steal.data.id,'completed')).status,409);assert.equal((await state(req,admin)).drinks.length,2);
 // Undoing a mistaken venue also removes its drink counts. Retrying records once.
 assert.equal((await correction(req,admin,'bar')).status,200);st=await state(req,admin);assert.equal(st.drinks.length,0);assert.equal(st.drinkers.find(m=>m.id===ma.id).drinks,0);
 assert.equal((await req('claim',body,a.cookie)).status,200);assert.equal((await state(req,admin)).drinkers.find(m=>m.id===ma.id).drinks,1);
});

test('losing a competing steal resolves automatically and releases the reporting block',async()=>{
 const {req,admin,teams:[a,b,c],claim}=await setup();const first=await claim(a);await outcome(req,a.cookie,first.data.id);
 const bAttempt=await claim(b),cAttempt=await claim(c);await outcome(req,b.cookie,bAttempt.data.id,'completed');
 assert.equal((await state(req,admin)).attempts.find(x=>x.id===cAttempt.data.id).status,'lost');
 assert.equal((await claim(c,'next-bar')).status,200);
});

test('roster imports merge existing names, retain history, revoke changed codes, and validate atomically',async()=>{
 const {req,admin,teams:[a],upload}=await setup();let st=await state(req,admin);const member=st.members.find(m=>m.team_id===a.id);
 const photo=(await upload(a.cookie)).data.id;await req('claim',{placeId:'roster-bar',name:'Roster Bar',address:'NYC',photo,drinkers:[member.id]},a.cookie);
 const imported=await req('admin/roster',{teams:[{name:a.name,members:[member.name,'New Member']},{name:'New Team',color:'#123456',passcode:'new-code',members:['Alex','Sam']}]},admin);assert.equal(imported.status,200);
 st=await state(req,admin);assert.equal(st.members.find(m=>m.team_id===a.id&&m.name===member.name).id,member.id);assert.equal(st.members.filter(m=>m.team_id===a.id&&m.active).length,3);
 assert.equal(st.drinkers.find(m=>m.id===member.id).drinks,1);assert.equal((await req('state',null,a.cookie)).status,200);
 const edit=await req('admin/team',{id:a.id,name:a.name,color:a.color,members:['New Member']},admin);assert.equal(edit.status,200);
 st=await state(req,admin);assert.equal(st.members.find(m=>m.id===member.id).active,0);assert.equal(st.drinkers.find(m=>m.id===member.id).drinks,1);
 const before=st.teams.length;
 assert.equal((await req('admin/roster',{teams:[{name:'Should Roll Back',passcode:'new-code',members:['A']},{name:'Invalid Team',members:['B']}]},admin)).status,400);
 assert.equal((await state(req,admin)).teams.length,before);
 assert.equal((await req('admin/roster',{teams:[{name:a.name,passcode:'rotated-code',members:['New Member']}]},admin)).status,200);
 assert.equal((await req('state',null,a.cookie)).status,401);
 assert.ok((await state(req,admin)).audit.every(a=>!a.detail.includes('rotated-code')&&!a.detail.includes('new-code')));
});

test('games isolate repeated team names, bars, rosters, outcomes, media, and scores; podium names are global',async()=>{
 const {req,admin,teams:[a],claim,upload}=await setup();const first=await claim(a,'same-bar'),photo=(await upload(a.cookie)).data.id;
 const original=await state(req,admin),firstId=original.settings.id,firstMember=original.members.find(m=>m.team_id===a.id);
 assert.equal((await req('admin/game',{name:'Second game'},admin)).status,200);
 let second=await state(req,admin);const secondId=second.settings.id;assert.notEqual(secondId,firstId);assert.equal(second.settings.phase,'draft');assert.equal(second.teams.length,0);assert.equal(second.venues.length,0);assert.equal(second.audit.length,1);
 assert.equal((await req('admin/team',{name:a.name,color:'#654321',passcode:'second-code',members:[firstMember.name]},admin)).status,200);
 second=await state(req,admin);const b=second.teams[0];
 assert.equal((await req('admin/team',{id:a.id,name:'Wrong game',color:'#123456'},admin)).status,404);
 assert.equal((await req('admin/adjust',{teamId:a.id,adjustment:1,reason:'wrong game'},admin)).status,400);
 assert.equal((await correction(req,admin,'same-bar','locked',a.id)).status,404);
 assert.equal((await req('media/'+photo,null,admin)).status,404);
 await req('admin/lifecycle',{action:'enable'},admin);const bCookie=(await req('login',{teamId:b.id,passcode:'second-code'})).cookie;
 await req('admin/lifecycle',{action:'start'},admin);
 const ownPhoto=(await upload(bCookie)).data.id;
 const claimBody={placeId:'same-bar',name:'Same Bar',address:'NYC',photo:ownPhoto,drinkers:[firstMember.id]};
 assert.equal((await req('claim',claimBody,bCookie)).status,400);
 const ownMember=second.members.find(m=>m.team_id===b.id);
 const secondClaim=await req('claim',{...claimBody,drinkers:[ownMember.id]},bCookie);assert.equal(secondClaim.status,200);
 assert.equal((await outcome(req,bCookie,first.data.id,'completed')).status,404);
 await outcome(req,bCookie,secondClaim.data.id,'completed');
 assert.equal((await req('admin/podium',{names:['Champion','Runner-up','Third']},admin)).status,200);
 assert.deepEqual((await state(req,a.cookie)).podiumNames,['Champion','Runner-up','Third']);
 assert.equal((await state(req,a.cookie)).teams.find(t=>t.id===a.id).score,1);assert.equal((await state(req,bCookie)).teams[0].score,2);
 assert.equal((await state(req,bCookie)).drinkers.length,1);assert.equal((await state(req,bCookie)).drinkers[0].drinks,1);
 await req('admin/select-game',{id:firstId},admin);assert.equal((await state(req,admin)).venues[0].name,'Test Bar');
 assert.equal((await req('admin/podium',{names:['','','']},admin)).status,200);assert.deepEqual((await state(req,bCookie)).podiumNames,['1','2','3']);
});
