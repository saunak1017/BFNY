import {TRAIN_ROUTES,countdownRemaining} from '../public/game-ui.js';
import { CHALLENGES } from './challenges.js';
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const json = (data,status=200,headers={}) => Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
class Problem extends Error {
  constructor(message,status=400,details={}) { super(message); this.status=status; this.details=details; }
}
const check = (condition,message,status=400) => { if(!condition) throw new Problem(message,status); };
const text = (s,max=120) => typeof s==='string' && s.trim().length>0 && s.trim().length<=max;
const hex = b => [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function digest(s){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));}
export async function passwordHash(s,salt=uid()) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(s),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);
  return salt+':'+hex(bits);
}
async function passwordOK(s,stored){return typeof stored==='string' && (await passwordHash(s,stored.split(':')[0]))===stored;}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('bfny-v1')).fetch(request);}};
export class GameRoom {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.db=env.DB;}
  q(sql,...args){return this.db.prepare(sql).bind(...args);}
  async one(sql,...args){return this.q(sql,...args).first();}
  async all(sql,...args){return (await this.q(sql,...args).all()).results;}
  audit(action,detail,gameId){return this.q('INSERT INTO audit(id,action,detail,created,game_id) VALUES(?,?,?,?,?)',uid(),action,JSON.stringify(detail),now(),gameId);}
  async fetch(request){
    // Serialize the complete check/write operation, including competing devices.
    return this.ctx.blockConcurrencyWhile(async()=>{
      try {return await this.route(request);} catch(e){
        if(!(e instanceof Problem)) console.error('Game request failed',e.message);
        return json({error:e instanceof Problem?e.message:'Server error. Check Worker logs and database migrations.',...(e instanceof Problem?e.details:{})},e.status||500);
      }
    });
  }
  async auth(req){
    const token=req.headers.get('Cookie')?.match(/(?:^|;\s*)bfny_session=([^;]+)/)?.[1];
    check(token,'Please sign in.',401);
    const s=await this.one('SELECT * FROM sessions WHERE token=? AND expires>?',await digest(token),Date.now());
    check(s,'Session expired. Please sign in.',401);
    s.game=await this.one('SELECT * FROM games WHERE id=?',s.game_id);
    check(s.game,'Game not found.',401);
    if(s.role==='team'){
      s.team=await this.one('SELECT * FROM teams WHERE id=? AND game_id=? AND active=1',s.team_id,s.game_id);
      check(s.team,'Team login disabled.',401);
      check(s.game.phase!=='draft','This game is not enabled yet.',401);
    }
    return s;
  }
  async body(req){
    const raw=await req.text(); check(raw.length<200000,'Request too large.',413);
    let data; try{data=JSON.parse(raw);}catch{throw new Problem('Invalid JSON.');}
    check(data && typeof data==='object' && !Array.isArray(data),'Invalid request.');
    return data;
  }
  async route(req){
    const url=new URL(req.url), path=url.pathname, method=req.method;
    if(method!=='GET' || path==='/api/live') check(req.headers.get('Origin')===url.origin,'Request origin not allowed.',403);
    if(path==='/api/bootstrap' && method==='GET'){
      const games=await this.all("SELECT id,name,phase,logo FROM games WHERE phase<>'draft' ORDER BY created DESC,id");
      return json({games,teams:await this.all("SELECT t.id,t.game_id,t.name,t.color FROM teams t JOIN games g ON g.id=t.game_id WHERE t.active=1 AND g.phase<>'draft' ORDER BY t.name"),settings:{logo:games[0]?.logo||null}});
    }
    if(path==='/api/login' && method==='POST'){
      const b=await this.body(req);check(typeof b.passcode==='string' && b.passcode.length<=256,'Enter your passcode.');
      const ip=req.headers.get('CF-Connecting-IP')||'unknown', rateKey=await digest(ip);
      const limit=await this.one('SELECT * FROM login_limits WHERE key=?',rateKey);
      check(!limit || limit.reset<Date.now() || limit.count<20,'Too many login attempts. Wait 15 minutes.',429);
      await this.q('INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset<? THEN 1 ELSE count+1 END,reset=CASE WHEN reset<? THEN excluded.reset ELSE reset END',rateKey,Date.now()+900000,Date.now(),Date.now()).run();
      let role='team',team=null,gameId;
      if(b.admin){
        check(this.env.ADMIN_PASSWORD?.length>=12,'Admin password is not configured (minimum 12 characters).',503);
        check(await digest(b.passcode)===await digest(this.env.ADMIN_PASSWORD),'Incorrect login.',401);
        role='admin';gameId=(await this.one('SELECT id FROM games ORDER BY created DESC,id LIMIT 1')).id;
      } else {
        check(text(b.teamId,100),'Choose your team.');
        team=await this.one('SELECT * FROM teams WHERE id=? AND active=1',b.teamId);
        check(team && await passwordOK(b.passcode,team.password),'Incorrect login.',401);
        check(!b.gameId || b.gameId===team.game_id,'Incorrect login.',401);
        const g=await this.one('SELECT phase FROM games WHERE id=?',team.game_id);
        check(g.phase!=='draft','This game is not enabled yet.',409);
        gameId=team.game_id;
      }
      await this.q('DELETE FROM login_limits WHERE key=?',rateKey).run();
      const token=uid()+uid(), expires=Date.now()+7*86400000;
      await this.db.batch([this.q('DELETE FROM sessions WHERE expires<?',Date.now()),this.q('INSERT INTO sessions(token,team_id,role,expires,game_id) VALUES(?,?,?,?,?)',await digest(token),team?.id||null,role,expires,gameId)]);
      return json({ok:true},200,{'Set-Cookie':`bfny_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`});
    }
    // Logos remain public so they can appear on the login screen.
    if(path.startsWith('/api/media/') && method==='GET'){
      const id=path.slice('/api/media/'.length), m=await this.one('SELECT * FROM media WHERE id=?',id);check(m,'Photo not found.',404);
      if(m.kind!=='logo'){const s=await this.auth(req);check(m.game_id===s.game_id,'Photo not found.',404);}
      const f=await this.env.PHOTOS.get(id);check(f,'Photo not found.',404);
      return new Response(f.body,{headers:{'Content-Type':m.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }
    const s=await this.auth(req), gameId=s.game_id;
    if(path==='/api/logout' && method==='POST'){
      await this.q('DELETE FROM sessions WHERE token=?',s.token).run();this.closeSockets(s.token);
      return json({ok:true},200,{'Set-Cookie':'bfny_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
    }
    if(path==='/api/live' && method==='GET'){
      check(req.headers.get('Upgrade')?.toLowerCase()==='websocket','WebSocket required.',426);
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({token:s.token,team:s.team_id,expires:s.expires});
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(path==='/api/state' && method==='GET') return json(await this.snapshot(s));
    if(path==='/api/upload' && method==='POST'){
      check(Number(req.headers.get('Content-Length')||0)<=8*1024*1024+2000,'Photo is too large (8 MB maximum).',413);
      const data=await req.formData(), file=data.get('file'), kind=data.get('kind')==='logo'?'logo':'photo';
      check(file && typeof file.arrayBuffer==='function' && file.size>0 && file.size<=8*1024*1024,'Choose a JPEG, PNG or WebP image under 8 MB.');
      if(kind==='logo') check(s.role==='admin','Admin only.',403);
      else check(s.game.phase==='live' || s.role==='admin','The game is not live.',409);
      const bytes=new Uint8Array(await file.arrayBuffer());
      const mime=bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71?'image/png':new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP'?'image/webp':null;
      check(mime,'Unsupported image. Use JPEG, PNG or WebP.');
      const recent=await this.one('SELECT COUNT(*) AS n FROM media WHERE game_id=? AND team_id IS ? AND created>?',gameId,s.team_id,new Date(Date.now()-3600000).toISOString());check(recent.n<100,'Upload limit reached. Ask the admin.',429);
      const id=uid();await this.env.PHOTOS.put(id,bytes,{httpMetadata:{contentType:mime}});
      await this.q('INSERT INTO media(id,team_id,kind,mime,created,game_id) VALUES(?,?,?,?,?,?)',id,s.team_id,kind,mime,now(),gameId).run();return json({id});
    }
    if(path.startsWith('/api/admin/') && method==='POST'){
      check(s.role==='admin','Admin only.',403);await this.admin(path,await this.body(req),s);this.broadcast();return json({ok:true});
    }
    check(s.role==='team','Use a team login to play.',403);
    check(s.game.phase==='live','The game is not live. Your submission was not recorded.',409);
    if(path==='/api/claim' && method==='POST'){
      const b=await this.body(req);
      const pending=await this.one("SELECT a.id,v.name FROM attempts a JOIN venues v ON v.game_id=a.game_id AND v.id=a.venue_id WHERE a.game_id=? AND a.team_id=? AND a.status='pending' ORDER BY a.created,a.id LIMIT 1",gameId,s.team_id);
      if(pending) throw new Problem(`You haven’t reported your challenge outcome from ${pending.name}. Report it before claiming another bar.`,409,{code:'OUTCOME_REQUIRED',attemptId:pending.id,venueName:pending.name});
      check(text(b.placeId,300)&&text(b.name,200)&&typeof b.address==='string'&&b.address.length<=400,'Select a venue from Google search.');
      const drinkers=b.drinkers??[];
      check(Array.isArray(drinkers)&&drinkers.length<=50&&drinkers.every(id=>text(id,100))&&new Set(drinkers).size===drinkers.length,'Choose each team member only once.');
      const members=await this.all('SELECT id FROM members WHERE game_id=? AND team_id=? AND active=1',gameId,s.team_id);
      check(drinkers.every(id=>members.some(m=>m.id===id)),'Only members of your team can be selected.');
      await this.photo(b.photo,s.team_id,gameId);
      const v=await this.one('SELECT * FROM venues WHERE game_id=? AND id=?',gameId,b.placeId);
      const old=await this.one('SELECT * FROM attempts WHERE game_id=? AND venue_id=? AND team_id=?',gameId,b.placeId,s.team_id);
      check(!old||old.status==='void','Your team already has an attempt at this bar. Open it under Play.',409);
      check(!v||v.status==='available'||v.status==='open',v?.status==='locked'?'This bar is locked.':'This bar is claimed and its challenge is still in progress.',409);
      check(!v||v.owner!==s.team_id,'Your team cannot retry this bar.',409);
      const kind=v?.owner?'steal':'claim', id=uid(), t=now(), ops=[];
      if(!v) ops.push(this.q('INSERT INTO venues(game_id,id,name,address,owner,status,updated) VALUES(?,?,?,?,?,?,?)',gameId,b.placeId,b.name.trim(),b.address.trim(),s.team_id,'claimed',t));
      else if(kind==='claim') ops.push(this.q("UPDATE venues SET owner=?,status='claimed',updated=? WHERE game_id=? AND id=?",s.team_id,t,gameId,b.placeId));
      if(old) ops.push(this.q('DELETE FROM attempts WHERE id=?',old.id));
      ops.push(this.q('INSERT INTO attempts(id,game_id,venue_id,team_id,kind,status,challenge,photo,completion_photo,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,gameId,b.placeId,s.team_id,kind,'pending',null,b.photo,null,t,t));
      for(const member of drinkers) ops.push(this.q('INSERT INTO drinks(game_id,venue_id,member_id,attempt_id,created) VALUES(?,?,?,?,?)',gameId,b.placeId,member,id,t));
      ops.push(this.audit(kind,{team:s.team_id,venue:b.placeId,attempt:id,drinkers},gameId));
      await this.db.batch(ops);this.broadcast();return json({id,kind});
    }
    if(path==='/api/outcome' && method==='POST'){
      const b=await this.body(req);check(['completed','failed','vetoed'].includes(b.status),'Choose an outcome.');
      check(Number.isInteger(b.challenge)&&CHALLENGES.some(c=>c.id===b.challenge),'Select a challenge.');
      const a=await this.one('SELECT * FROM attempts WHERE id=? AND game_id=? AND team_id=?',b.id,gameId,s.team_id);check(a,'Attempt not found.',404);
      check(a.status==='pending','This attempt has already been resolved.',409);
      const v=await this.one('SELECT * FROM venues WHERE game_id=? AND id=?',gameId,a.venue_id);
      check((a.kind==='claim'&&v.owner===s.team_id&&v.status==='claimed')||(a.kind==='steal'&&v.status==='open'),'This bar is no longer available for this attempt.',409);
      if(b.photo) await this.photo(b.photo,s.team_id,gameId);
      const t=now(),ops=[this.q('UPDATE attempts SET status=?,challenge=?,completion_photo=?,updated=? WHERE id=?',b.status,b.challenge,b.photo||null,t,a.id)];
      if(b.status==='completed'){
        ops.push(this.q("UPDATE venues SET owner=?,status='locked',updated=? WHERE game_id=? AND id=?",s.team_id,t,gameId,v.id));
        ops.push(this.q("UPDATE attempts SET status='lost',updated=? WHERE game_id=? AND venue_id=? AND id<>? AND status='pending'",t,gameId,v.id,a.id));
      } else if(a.kind==='claim') ops.push(this.q("UPDATE venues SET status='open',updated=? WHERE game_id=? AND id=?",t,gameId,v.id));
      ops.push(this.audit(b.status,{team:s.team_id,attempt:a.id,venue:v.id,previousOwner:v.owner},gameId));
      await this.db.batch(ops);this.broadcast();return json({ok:true});
    }
    throw new Problem('Not found.',404);
  }
  async photo(id,team,gameId){
    check(text(id,100),'Upload your team photo first.');
    check(await this.one("SELECT id FROM media WHERE id=? AND team_id=? AND game_id=? AND kind='photo'",id,team,gameId),'Upload your team photo first.');
  }
  async snapshot(s){
    const global=await this.one('SELECT podium_1,podium_2,podium_3 FROM settings WHERE id=1');
    const data={me:{role:s.role,id:s.team_id,name:s.team?.name||'Game admin'},settings:s.game,serverTime:Date.now(),
      podiumNames:[global.podium_1,global.podium_2,global.podium_3],challenges:CHALLENGES,googleKey:this.env.GOOGLE_MAPS_BROWSER_KEY||'',
      teams:await this.all("SELECT t.id,t.name,t.color,t.active,t.adjustment,COALESCE(SUM(CASE WHEN v.status='locked' THEN 2 WHEN v.owner IS NOT NULL THEN 1 ELSE 0 END),0)+t.adjustment AS score FROM teams t LEFT JOIN venues v ON v.game_id=t.game_id AND v.owner=t.id WHERE t.game_id=? GROUP BY t.id ORDER BY score DESC,t.name,t.id",s.game_id),
      venues:await this.all('SELECT * FROM venues WHERE game_id=? ORDER BY updated DESC,id',s.game_id),
      attempts:await this.all("SELECT * FROM attempts WHERE game_id=? AND status<>'void' ORDER BY created DESC,id",s.game_id),
      members:await this.all('SELECT id,team_id,name,active FROM members WHERE game_id=? ORDER BY name,id',s.game_id),
      drinks:await this.all("SELECT d.member_id,d.attempt_id,d.venue_id FROM drinks d JOIN attempts a ON a.id=d.attempt_id WHERE d.game_id=? AND a.status<>'void'",s.game_id),
      drinkers:await this.all("SELECT m.id,m.team_id,m.name,COUNT(CASE WHEN a.status<>'void' THEN d.member_id END) AS drinks FROM members m LEFT JOIN drinks d ON d.member_id=m.id LEFT JOIN attempts a ON a.id=d.attempt_id WHERE m.game_id=? GROUP BY m.id HAVING m.active=1 OR COUNT(CASE WHEN a.status<>'void' THEN d.member_id END)>0 ORDER BY drinks DESC,m.name COLLATE NOCASE,m.id",s.game_id)};
    if(s.role==='admin'){
      data.games=await this.all('SELECT id,name,phase,created FROM games ORDER BY created DESC,id');
      data.audit=await this.all('SELECT * FROM audit WHERE game_id=? ORDER BY created DESC LIMIT 100',s.game_id);
    }
    return data;
  }
  async prepareTeam(b,gameId,merge=false){
    check(text(b.name,60),'Provide a team name.');
    const old=b.id?await this.one('SELECT * FROM teams WHERE id=? AND game_id=?',b.id,gameId):null;
    check(!b.id||old,'Team not found.',404);
    const color=b.color||old?.color||'#9d2789';check(/^#[0-9a-fA-F]{6}$/.test(color),'Provide a valid team colour.');
    check(!b.passcode||(typeof b.passcode==='string'&&b.passcode.length>=6&&b.passcode.length<=128),'Team passcodes must be 6–128 characters.');
    check(old||b.passcode,'Set a passcode for the new team.');
    const duplicate=await this.one('SELECT id FROM teams WHERE game_id=? AND name=? COLLATE NOCASE',gameId,b.name.trim());check(!duplicate||duplicate.id===old?.id,'That team name is already in use.');
    const id=old?.id||uid(),hash=b.passcode?await passwordHash(b.passcode):old.password;
    const active=b.active===undefined?(old?.active??1):(b.active?1:0);
    const ops=[this.q('INSERT INTO teams(id,game_id,name,color,password,active) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,password=excluded.password,active=excluded.active',id,gameId,b.name.trim(),color,hash,active)];
    if(b.members!==undefined){
      check(Array.isArray(b.members)&&b.members.length<=50&&b.members.every(n=>text(n,80)),'Enter up to 50 member names, each 1–80 characters.');
      const names=b.members.map(n=>n.trim());check(new Set(names.map(n=>n.toLowerCase())).size===names.length,'Member names must be unique within a team.');
      if(merge){
        const existing=await this.all('SELECT name FROM members WHERE team_id=? AND active=1',id);
        check(new Set([...existing.map(m=>m.name.toLowerCase()),...names.map(n=>n.toLowerCase())]).size<=50,'A team can have up to 50 active members.');
      }else ops.push(this.q('UPDATE members SET active=0 WHERE team_id=?',id));
      for(const name of names)ops.push(this.q('INSERT INTO members(id,game_id,team_id,name,active) VALUES(?,?,?,?,1) ON CONFLICT(team_id,name) DO UPDATE SET active=1,name=excluded.name',uid(),gameId,id,name));
    }
    ops.push(this.audit('team updated',{id,name:b.name.trim(),members:b.members?.length},gameId));
    const revoke=old&&(b.passcode||!active);
    if(revoke)ops.push(this.q('DELETE FROM sessions WHERE team_id=?',id));
    return {id,ops,revoke};
  }
  async admin(path,b,s){
    const gameId=s.game_id,g=s.game;
    if(path==='/api/admin/game'){
      check(text(b.name,80),'Enter a game name (up to 80 characters).');const id=uid();
      await this.db.batch([this.q("INSERT INTO games(id,name,phase,created) VALUES(?,?,'draft',?)",id,b.name.trim(),now()),this.q('UPDATE sessions SET game_id=? WHERE token=?',id,s.token),this.audit('game created',{name:b.name.trim()},id)]);return;
    }
    if(path==='/api/admin/select-game'){
      check(text(b.id,100)&&await this.one('SELECT id FROM games WHERE id=?',b.id),'Game not found.',404);
      await this.q('UPDATE sessions SET game_id=? WHERE token=?',b.id,s.token).run();return;
    }
    if(path==='/api/admin/lifecycle'){
      const t=Date.now();let phase,elapsed=g.timer_elapsed_ms,started=g.started_at,timer=null;
      if(b.action==='enable'){check(g.phase==='draft','Only a draft can be enabled.',409);phase='lobby';}
      else if(b.action==='start'){check(g.phase==='lobby'&&g.started_at===null,'Enable the game before starting its timer.',409);phase='live';started=t;timer=t;}
      else if(b.action==='pause'){check(g.phase==='live','Only a running game can be paused.',409);phase='paused';elapsed+=Math.max(0,t-g.timer_started_at);}
      else if(b.action==='resume'){check(['paused','ended'].includes(g.phase)&&g.started_at!==null,'This game cannot be resumed.',409);phase='live';timer=t;}
      else if(b.action==='end'){check(['live','paused'].includes(g.phase),'Only a started game can be ended.',409);phase='ended';if(g.phase==='live')elapsed+=Math.max(0,t-g.timer_started_at);}
      else throw new Problem('Choose a game action.');
      await this.db.batch([this.q('UPDATE games SET phase=?,started_at=?,timer_started_at=?,timer_elapsed_ms=? WHERE id=?',phase,started,timer,elapsed,gameId),this.audit('game '+b.action,{phase},gameId)]);return;
    }
    if(path==='/api/admin/podium'){
      check(Array.isArray(b.names)&&b.names.length===3&&b.names.every(n=>typeof n==='string'&&n.trim().length<=60),'Enter three podium nicknames, up to 60 characters each.');
      const names=b.names.map((n,i)=>n.trim()||String(i+1));
      await this.db.batch([this.q('UPDATE settings SET podium_1=?,podium_2=?,podium_3=? WHERE id=1',...names),this.audit('global podium nicknames updated',{names},gameId)]);return;
    }
    if(path==='/api/admin/team'){
      const prepared=await this.prepareTeam(b,gameId);await this.db.batch(prepared.ops);if(prepared.revoke)this.closeTeamSockets(prepared.id);return;
    }
    if(path==='/api/admin/roster'){
      check(Array.isArray(b.teams)&&b.teams.length>0&&b.teams.length<=100,'Import between 1 and 100 teams.');
      const seen=new Set(),ops=[],revoke=[];let total=0;
      for(const t of b.teams){
        check(t&&text(t.name,60)&&Array.isArray(t.members)&&t.members.length>0,'Each imported team needs a name and members.');
        const key=t.name.trim().toLowerCase();check(!seen.has(key),'List each team only once.');seen.add(key);
        total+=t.members.length;check(total<=500,'Import at most 500 members at a time.');
        const old=await this.one('SELECT id FROM teams WHERE game_id=? AND name=? COLLATE NOCASE',gameId,t.name.trim());
        const prepared=await this.prepareTeam({...t,id:old?.id},gameId,true);ops.push(...prepared.ops);if(prepared.revoke)revoke.push(prepared.id);
      }
      ops.push(this.audit('roster imported',{teams:seen.size,members:total},gameId));
      await this.db.batch(ops);for(const id of revoke)this.closeTeamSockets(id);return;
    }
    if(path==='/api/admin/settings'){
      check(!('phase' in b),'Use the separate game and timer controls to change game status.');
      check(text(b.name,80),'Enter a game name (up to 80 characters).');
      if(b.logo)check(await this.one("SELECT id FROM media WHERE id=? AND game_id=? AND kind='logo'",b.logo,gameId),'Upload a logo first.');
      await this.db.batch([this.q('UPDATE games SET name=?,logo=? WHERE id=?',b.name.trim(),b.logo||null,gameId),this.audit('game settings updated',{name:b.name.trim()},gameId)]);return;
    }
    if(path==='/api/admin/adjust'){
      check(Number.isInteger(b.adjustment)&&Math.abs(b.adjustment)<=100&&text(b.reason,300),'Enter an adjustment between -100 and 100 and a reason.');
      check(await this.one('SELECT id FROM teams WHERE id=? AND game_id=?',b.teamId,gameId),'Team not found.');
      await this.db.batch([this.q('UPDATE teams SET adjustment=? WHERE id=?',b.adjustment,b.teamId),this.audit('score adjustment',b,gameId)]);return;
    }
    if(path==='/api/admin/venue'){
      const v=await this.one('SELECT * FROM venues WHERE game_id=? AND id=?',gameId,b.id);check(v,'Venue not found.',404);
      check(text(b.reason,300)&&text(b.name,200)&&typeof b.address==='string'&&b.address.length<=400,'Provide venue details and a reason.');
      check(['available','claimed','open','locked'].includes(b.status),'Invalid venue status.');
      const owner=b.status==='available'?null:b.owner;check(!owner||await this.one('SELECT id FROM teams WHERE id=? AND game_id=?',owner,gameId),'Team not found.');check(b.status==='available'||owner,'Choose an owner.');
      if(b.status==='locked')check(CHALLENGES.some(c=>c.id===Number(b.challenge)),'Select the completed challenge.');
      const t=now(),ops=[this.audit('venue correction',{before:v,after:b},gameId),this.q('UPDATE venues SET name=?,address=?,owner=?,status=?,updated=? WHERE game_id=? AND id=?',b.name.trim(),b.address.trim(),owner,b.status,t,gameId,v.id)];
      ops.push(this.q("UPDATE attempts SET status='lost',updated=? WHERE game_id=? AND venue_id=? AND status='pending'",t,gameId,v.id));
      if(owner){
        const a=await this.one('SELECT * FROM attempts WHERE game_id=? AND venue_id=? AND team_id=?',gameId,v.id,owner);
        const status=b.status==='locked'?'completed':b.status==='open'?'failed':'pending';
        if(a)ops.push(this.q('UPDATE attempts SET status=?,kind=?,challenge=?,updated=? WHERE id=?',status,'claim',b.challenge?Number(b.challenge):null,t,a.id));
        else ops.push(this.q('INSERT INTO attempts(id,game_id,venue_id,team_id,kind,status,challenge,photo,completion_photo,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',uid(),gameId,v.id,owner,'claim',status,b.challenge?Number(b.challenge):null,null,null,t,t));
      }
      if(b.status==='available')ops.push(this.q("UPDATE attempts SET status='void',updated=? WHERE game_id=? AND venue_id=?",t,gameId,v.id));
      await this.db.batch(ops);return;
    }
    if(path==='/api/admin/attempt'){
      const a=await this.one('SELECT * FROM attempts WHERE id=? AND game_id=?',b.id,gameId);check(a,'Attempt not found.',404);check(text(b.reason,300),'Enter a reason.');
      check(CHALLENGES.some(c=>c.id===Number(b.challenge)),'Select a challenge.');
      if(b.status && b.status!==a.status)check(['failed','vetoed'].includes(b.status)&&['failed','vetoed'].includes(a.status),'Use venue correction to change ownership or reopen an attempt.');
      await this.db.batch([this.q('UPDATE attempts SET challenge=?,status=?,updated=? WHERE id=?',Number(b.challenge),b.status||a.status,now(),a.id),this.audit('attempt corrected',{before:a,after:b},gameId)]);return;
    }
    if(path==='/api/admin/photo'){
      check(text(b.id,100)&&text(b.reason,300),'Choose a photo and enter a reason.');
      check(await this.one('SELECT id FROM media WHERE id=? AND game_id=?',b.id,gameId),'Photo not found.',404);
      await this.db.batch([this.q('UPDATE attempts SET photo=NULL WHERE game_id=? AND photo=?',gameId,b.id),this.q('UPDATE attempts SET completion_photo=NULL WHERE game_id=? AND completion_photo=?',gameId,b.id),this.q('DELETE FROM media WHERE id=? AND kind<>?',b.id,'logo'),this.audit('photo removed',{id:b.id,reason:b.reason},gameId)]);return;
    }
    throw new Problem('Unknown admin action.',404);
  }
  broadcast(){for(const ws of this.ctx.getWebSockets()){try{const a=ws.deserializeAttachment();if(a.expires<Date.now())ws.close(4001,'Session expired');else ws.send('refresh');}catch{}}}
  closeSockets(token){for(const ws of this.ctx.getWebSockets()){if(ws.deserializeAttachment()?.token===token)ws.close(4001,'Signed out');}}
  closeTeamSockets(team){for(const ws of this.ctx.getWebSockets()){if(ws.deserializeAttachment()?.team===team)ws.close(4001,'Sign in again');}}
  webSocketMessage(ws){if(ws.deserializeAttachment()?.expires<Date.now())ws.close(4001,'Session expired');}
  webSocketClose(ws){try{ws.close(1000,'Closed');}catch{}}
  webSocketError(ws){ws.close(1011,'Connection error');}
}
