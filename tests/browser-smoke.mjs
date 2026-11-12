import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setup} from './helpers.mjs';
// Optional developer smoke test. Only Google venue lookup is stubbed; all game
// requests, sessions, SQL, image processing and WebSocket refreshes run locally.
// Google Maps is stubbed at its API boundary to check pin updates and failure UI.
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const artifactDir=process.env.BROWSER_ARTIFACT_DIR;
if(artifactDir)await mkdir(artifactDir,{recursive:true});
const {chromium}=createRequire(import.meta.url)('playwright');
const {game}=await setup({live:false});
const sockets=new Set();game.ctx.getWebSockets=()=>[...sockets];
let origin;
const server=createServer(async(req,res)=>{
 try{
  if(req.url.startsWith('/api/')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const r=await game.fetch(new Request(origin+req.url,{method:req.method,headers:req.headers,...(req.method!=='GET'?{body:Buffer.concat(chunks)}:{})}));
   res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));return;
  }
  const path=new URL(req.url,origin).pathname;if(path.includes('..')){res.writeHead(404).end();return;}
  const file=publicRoot+(path==='/'?'index.html':path.slice(1));
  if(!(await stat(file)).isFile())throw new Error('Missing file');
  const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html';
  res.writeHead(200,{'Content-Type':type});res.end(await readFile(file));
 }catch(e){res.writeHead(500).end(e.message);}
});
server.on('upgrade',async(req,socket)=>{
 try{
  assert.equal(req.headers.origin,origin);const s=await game.auth(new Request(origin+req.url,{headers:req.headers}));
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const ws={deserializeAttachment:()=>({token:s.token,team:s.team_id,expires:s.expires}),send(message){const data=Buffer.from(message);socket.write(Buffer.concat([Buffer.from([0x81,data.length]),data]));},close(){socket.end(Buffer.from([0x88,0]));}};
  sockets.add(ws);socket.on('close',()=>sockets.delete(ws));socket.on('error',()=>sockets.delete(ws));socket.on('data',data=>{if((data[0]&15)===8)ws.close();});
 }catch{socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),headless:true,args:['--no-sandbox']});
const errors=[];
async function context(viewport={width:1280,height:900}){
 const ctx=await browser.newContext({viewport});
 await ctx.route('https://fonts.googleapis.com/**',r=>r.fulfill({body:'',contentType:'text/css'}));
 await ctx.addInitScript(()=>{
  const probe=window.__maps={instances:[],markers:[],lookups:[],failMap:false};
  const position=id=>({lat:40.72+id.length/1000,lng:-73.98+id.length/1000});
  class Place {constructor({id}){this.id=id;}async fetchFields(){probe.lookups.push(this.id);this.location={toJSON:()=>position(this.id)};}}
  class MapWidget {constructor(host,options){this.host=host;this.zoom=options.zoom;this.fitCalls=0;probe.instances.push(this);host.dataset.mapInstance=String(probe.instances.length);host.style.background='linear-gradient(35deg,#253b40,#364937)';}fitBounds(){this.fitCalls++;}setZoom(value){this.zoom=value;}}
  class Marker {constructor(options){this.map=options.map;this.position=options.position;this.button=document.createElement('button');this.button.style.cssText='margin:6px;padding:10px;min-height:44px';this.map.host.append(this.button);probe.markers.push(this);}setOptions(options){Object.assign(this,options);this.button.title=options.title;this.button.setAttribute('aria-label',options.title);this.button.textContent=options.title;this.button.style.borderColor=options.icon.fillColor;}setMap(map){this.map=map;if(!map)this.button.remove();else map.host.append(this.button);}getPosition(){return this.position;}addListener(name,callback){this.button.addEventListener(name,callback);}}
  class InfoWindow {setContent(content){this.content=content;}open({map}){map.host.append(this.content);}close(){this.content?.remove();}}
  class LatLngBounds {constructor(){this.positions=[];}extend(position){this.positions.push(position);}isEmpty(){return !this.positions.length;}}
  customElements.define('test-places',class extends HTMLElement{
   connectedCallback(){this.innerHTML='<input aria-label="Venue for test"><button type="button">Choose venue</button>';this.querySelector('button').onclick=()=>{const name=this.querySelector('input').value,ev=new Event('gmp-select');ev.placePrediction={toPlace:()=>({id:name.toLowerCase().replaceAll(' ','-'),displayName:name,formattedAddress:'New York, NY',location:{toJSON:()=>position(name)},async fetchFields(){}})};this.dispatchEvent(ev);};}
  });window.google={maps:{places:{PlaceAutocompleteElement:customElements.get('test-places'),Place},InfoWindow,LatLngBounds,SymbolPath:{CIRCLE:'circle'},async importLibrary(name){if(probe.failMap)throw new Error('Test Google Maps failure');return name==='maps'?{Map:MapWidget}:{Marker};}}};
 });
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);return {ctx,page};
}
async function fillMembers(page,names){
 while(await page.locator('.member-field').count()>1)await page.locator('.remove-member').last().click();
 await page.locator('.member-input').first().fill(names[0]||'');
 for(const name of names.slice(1)){await page.getByRole('button',{name:'+ Add member',exact:true}).click();await page.locator('.member-input').last().fill(name);}
}
async function login(page,name){await page.locator('#login-team').selectOption({label:name});await page.locator('#passcode').fill('secret123');await page.getByRole('button',{name:'Let’s go →',exact:true}).click();await page.locator('#play-list').waitFor();}
async function findBar(page,name){await page.getByLabel('Venue for test').fill(name);await page.getByRole('button',{name:'Choose venue',exact:true}).click();await page.locator('[data-action="claim-selected"]').waitFor();}
async function openClaim(page,name,members){await findBar(page,name);await page.locator('[data-action="claim-selected"]').click();for(const member of members)await page.getByLabel(member,{exact:true}).check();await page.locator('#gallery').setInputFiles(join(publicRoot,'branding/logo.png'));await page.waitForFunction(()=>document.querySelector('#upload-status')?.textContent.startsWith('Ready'));await page.getByLabel('We are at this venue and have met the claiming requirement.',{exact:true}).check();}
async function submitClaim(page){await page.getByRole('button',{name:'Claim +1 point',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#modal').open);}
async function recordOutcome(page,status){await page.locator('[data-action="outcome"]').first().click();await page.locator('[data-pick="1"]').click();await page.locator('#outcome').selectOption(status);await page.getByRole('button',{name:'Confirm outcome',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#modal').open);}
try{
 const {page:admin}=await context();await admin.getByRole('button',{name:'Game admin? Sign in here',exact:true}).click();await admin.locator('#passcode').fill('Long-admin-secret-2026');await admin.getByRole('button',{name:'Open admin',exact:true}).click();await admin.locator('#admin-game').waitFor();
 await admin.getByRole('button',{name:'Import teams & members',exact:true}).click();await admin.locator('#roster-csv').fill('team,member,color,passcode\nQueens,Alice,#9d2789,secret123\nQueens,Bob,,\nMets,Charlie,#e4393a,secret123');await admin.getByRole('button',{name:'Preview import',exact:true}).click();await admin.getByRole('button',{name:'Import roster',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);
 for(const [name,members] of [['Queens','Alice\nBob'],['Mets','Charlie']]){await admin.locator('.rank-row').filter({hasText:name}).getByRole('button',{name:'Edit',exact:true}).click();await fillMembers(admin,members.split('\n'));await admin.getByRole('button',{name:'Save team',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);}
 await admin.locator('.rank-row').filter({hasText:'Queens'}).getByRole('button',{name:'Edit',exact:true}).click();assert.deepEqual(await admin.locator('.member-input').evaluateAll(inputs=>inputs.map(i=>i.value)),['Alice','Bob']);await admin.getByRole('button',{name:'Cancel',exact:true}).click();
 // Create teams directly in the site, with optional names and the colour wheel.
 for(const expectedName of ['Team 1','Team 2']){
  await admin.getByRole('button',{name:'+ Create team',exact:true}).click();await fillMembers(admin,['Casey','Riley']);
  const wheel=await admin.locator('.color-wheel').boundingBox();await admin.mouse.click(wheel.x+wheel.width*.8,wheel.y+wheel.height*.5);
  await admin.getByLabel('Hue',{exact:true}).focus();await admin.keyboard.press('Home');await admin.keyboard.press('ArrowRight');
  await admin.getByLabel('Brightness',{exact:true}).focus();await admin.keyboard.press('End');
  const picked=await admin.locator('#team-color').inputValue();assert.ok(/^#[0-9a-f]{6}$/.test(picked));assert.notEqual(picked,'#9d2789');
  await admin.locator('#team-pass').fill('secret123');if(artifactDir){await admin.locator('#modal').evaluate(el=>el.scrollTop=0);await admin.screenshot({path:join(artifactDir,'team-editor.png')});}await admin.getByRole('button',{name:'Create team',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);
  await admin.locator('.rank-row').filter({hasText:expectedName}).getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await admin.locator('#team-color').inputValue(),picked);assert.deepEqual(await admin.locator('.member-input').evaluateAll(inputs=>inputs.map(i=>i.value)),['Casey','Riley']);await admin.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 await admin.getByRole('button',{name:'Enable game',exact:true}).click();await admin.getByRole('button',{name:'Start timer & play',exact:true}).waitFor();
 const {page:queens}=await context({width:390,height:844});await login(queens,'Queens');await queens.getByText('The lobby is open.',{exact:false}).waitFor();await findBar(queens,'First Stop');assert.equal(await queens.locator('[data-action="claim-selected"]').isEnabled(),false);assert.equal(await queens.locator('[data-game-clock]').textContent(),'Not started');
 await admin.getByRole('button',{name:'Start timer & play',exact:true}).click();await queens.waitForFunction(()=>!document.querySelector('#phase-notice').textContent.includes('lobby'));await queens.getByLabel('Venue for test').waitFor();
 const {page:other}=await context();await login(other,'Queens');await openClaim(other,'Held Stop',['Alice']);
 await openClaim(queens,'First Stop',['Alice','Bob']);await submitClaim(queens);
 // A claim form left open on another device must be stopped by the backend.
 await other.getByRole('button',{name:'Claim +1 point',exact:true}).click();await other.getByRole('heading',{name:'Report your previous challenge',exact:true}).waitFor();await other.getByRole('button',{name:'Report outcome →',exact:true}).click();await other.getByRole('heading',{name:'Record your challenge',exact:true}).waitFor();await other.locator('[data-action="close"]').first().click();
 // The ordinary next-claim path opens the same popup before requesting a photo.
 await findBar(queens,'Second Stop');await queens.locator('[data-action="claim-selected"]').click();await queens.getByRole('heading',{name:'Report your previous challenge',exact:true}).waitFor();await queens.locator('[data-action="close"]').first().click();await recordOutcome(queens,'failed');
 await openClaim(queens,'Second Stop',['Alice','Bob']);await submitClaim(queens);await recordOutcome(queens,'completed');
 await openClaim(queens,'Third Stop',['Alice']);await submitClaim(queens);await recordOutcome(queens,'vetoed');
 await queens.getByRole('button',{name:'Scoreboard',exact:true}).click();await queens.locator('.podium').waitFor();await queens.waitForFunction(()=>document.querySelector('#map-status')?.textContent.includes('3 claimed'));assert.ok(await queens.locator('#territory-map').evaluate(el=>el.getBoundingClientRect().height>=320));const mapInstance=await queens.locator('#territory-map').getAttribute('data-map-instance');assert.equal(await queens.locator('.podium-place:not(.empty-place)').count(),2);
 const {page:mets}=await context();await login(mets,'Mets');await openClaim(mets,'Mets Stop',['Charlie']);await submitClaim(mets);await recordOutcome(mets,'completed');
 await queens.waitForFunction(()=>document.querySelectorAll('.podium-place:not(.empty-place)').length===3&&document.querySelector('#map-status')?.textContent.includes('4 claimed'));assert.equal(await queens.locator('#territory-map').getAttribute('data-map-instance'),mapInstance);await queens.locator('#activity-ticker').getByText('locked Mets Stop',{exact:false}).first().waitFor();assert.equal(await queens.locator('.podium-place:not(.empty-place)').count(),3);assert.deepEqual(await queens.locator('.podium-place.place-1 .drinker-name').allTextContents(),['Alice']);assert.equal(await queens.locator('.podium-place.place-1 .drink-count').innerText(),'3\ndrinks');
 if(artifactDir)await queens.screenshot({path:join(artifactDir,'scoreboard-mobile.png'),fullPage:true});assert.equal(await queens.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 // Team filters, pin details, stealing, and colour changes stay live without rebuilding the map.
 await queens.locator('.team-select').filter({hasText:'Mets'}).click();await queens.waitForFunction(()=>document.querySelector('#map-status')?.textContent.startsWith('1 claimed'));
 await queens.getByRole('button',{name:'All Teams',exact:true}).click();await queens.waitForFunction(()=>document.querySelector('#map-status')?.textContent.startsWith('4 claimed'));
 await queens.locator('#territory-map button').filter({hasText:'First Stop'}).click();await queens.locator('.map-info').getByRole('heading',{name:'First Stop',exact:true}).waitFor();
 await openClaim(mets,'First Stop',['Charlie']);await mets.getByRole('button',{name:'Start attempt',exact:true}).click();await mets.waitForFunction(()=>!document.querySelector('#modal').open);await recordOutcome(mets,'completed');
 await queens.waitForFunction(()=>window.__maps.markers.some(m=>m.map&&m.title==='First Stop — Mets'&&m.icon.fillColor==='#e4393a'));
 await queens.locator('#activity-ticker').getByText('stole First Stop from',{exact:false}).first().waitFor();assert.equal(await queens.locator('#territory-map').getAttribute('data-map-instance'),mapInstance);
 await admin.locator('.rank-row').filter({hasText:'Mets'}).getByRole('button',{name:'Edit',exact:true}).click();await admin.locator('#team-color').fill('#00aaff');await admin.getByRole('button',{name:'Save team',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);
 await queens.waitForFunction(()=>window.__maps.markers.some(m=>m.map&&m.title==='First Stop — Mets'&&m.icon.fillColor==='#00aaff'));
 // A Google outage leaves the bar list usable and reports the map error.
 await queens.getByRole('button',{name:'Feed',exact:true}).click();await queens.evaluate(()=>window.__maps.failMap=true);await queens.getByRole('button',{name:'Scoreboard',exact:true}).click();await queens.getByText('Map unavailable:',{exact:false}).waitFor();assert.ok(await queens.locator('#venue-list .venue').count()>0);
 await queens.getByRole('button',{name:'Feed',exact:true}).click();await queens.evaluate(()=>window.__maps.failMap=false);await queens.getByRole('button',{name:'Scoreboard',exact:true}).click();await queens.waitForFunction(()=>document.querySelector('#map-status')?.textContent.startsWith('4 claimed'));
 await admin.getByRole('button',{name:'Podium nicknames',exact:true}).click();await admin.locator('#podium-0').fill('Custom first');await admin.getByRole('button',{name:'Save for all games',exact:true}).click();await queens.getByText('Custom first',{exact:true}).waitFor();
 // The restored subway countdown uses its own controls and clock.
 await admin.getByRole('button',{name:'Countdown & final stop',exact:true}).click();await admin.locator('#final-label').fill('Test Final Stop');await admin.locator('#final-address').fill('123 Broadway, New York');await admin.getByRole('button',{name:'Start Countdown',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);await queens.getByRole('timer').waitFor();await queens.getByText('Test Final Stop',{exact:true}).waitFor();
 await admin.getByRole('button',{name:'Countdown & final stop',exact:true}).click();await admin.getByRole('button',{name:'Pause',exact:true}).click();await queens.getByText('FINAL STOP · PAUSED',{exact:true}).waitFor();
 await admin.getByRole('button',{name:'Countdown & final stop',exact:true}).click();await admin.getByRole('button',{name:'Resume',exact:true}).click();
 await admin.locator('.rank-row').filter({hasText:'Team 2'}).getByRole('button',{name:'Remove',exact:true}).click();await admin.locator('#team-confirm').fill('Team 2');await admin.getByRole('button',{name:'Confirm',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(await admin.locator('.rank-row').filter({hasText:'Team 2'}).count(),0);
 await admin.getByRole('button',{name:'Pause game & timer',exact:true}).click();await queens.getByText('The game and timer are paused.',{exact:false}).waitFor();const frozen=await queens.locator('[data-game-clock]').textContent();await queens.waitForTimeout(1200);assert.equal(await queens.locator('[data-game-clock]').textContent(),frozen);
 await admin.getByRole('button',{name:'Resume game & timer',exact:true}).click();await admin.getByRole('button',{name:'+ New draft',exact:true}).click();await admin.locator('#game-name').fill('Next Game');await admin.getByRole('button',{name:'Create draft',exact:true}).click();await admin.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(await admin.locator('#admin-game option:checked').textContent(),'Next Game · draft');await admin.getByRole('button',{name:'Podium nicknames',exact:true}).click();assert.equal(await admin.locator('#podium-0').inputValue(),'Custom first');await admin.getByRole('button',{name:'Cancel',exact:true}).click();if(artifactDir)await admin.screenshot({path:join(artifactDir,'admin-desktop.png'),fullPage:true});
 await admin.getByRole('button',{name:'Reset this game',exact:true}).click();await admin.locator('#reset-confirm').fill('RESET');await admin.getByRole('button',{name:'Reset Game',exact:true}).click();await admin.locator('#login').waitFor();assert.ok(await queens.locator('#territory-map').isVisible());
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',flows:['roster CSV import','editable roster round-trip','individual member fields','optional numbered team names','colour wheel and keyboard sliders','live territory map','team map filters','pin details','live ownership and colour changes','map failure fallback','activity ticker','map viewport preservation','subway countdown controls','unused team deletion','game-scoped reset','draft/lobby/start separation','live WebSocket updates','cross-device reporting guard','outcome popup','1+1 scoring','one drink per member/bar','three-person podium','global podium nicknames','mobile layout','pause/resume clock','multiple saved games'],browserErrors:errors}));
}finally{await browser.close();for(const socket of sockets)socket.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
