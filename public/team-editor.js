const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function hsvToHex(h,s,v){
 const f=n=>{const k=(n+h/60)%6;return Math.round(255*v*(1-s*Math.max(0,Math.min(k,4-k,1)))).toString(16).padStart(2,'0');};
 return '#'+f(5)+f(3)+f(1);
}
export function hexToHsv(hex){
 const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
 const h=!d?0:max===r?60*((g-b)/d%6):max===g?60*((b-r)/d+2):60*((r-g)/d+4);
 return {h:(h+360)%360,s:max?d/max:0,v:max};
}
export function teamColorHTML(color){
 return `<fieldset class="color-editor"><legend>Team colour</legend><div class="color-picker-grid"><div class="color-wheel" role="img" aria-label="Colour wheel; use the sliders below for keyboard selection"><span class="color-wheel-shade"></span><span class="color-wheel-handle"></span></div><div class="color-preview" aria-label="Selected team colour"><span class="roundel">NY</span><strong>Team colour</strong><span class="color-value"></span></div></div><label for="color-hue">Hue</label><input id="color-hue" type="range" min="0" max="359" step="1"><label for="color-saturation">Saturation</label><input id="color-saturation" type="range" min="0" max="100" step="1"><label for="color-brightness">Brightness</label><input id="color-brightness" type="range" min="0" max="100" step="1"><label for="team-color">Hex colour</label><input id="team-color" value="${escape(color)}" pattern="#[0-9a-fA-F]{6}" maxlength="7" required spellcheck="false"></fieldset>`;
}
export function bindTeamColor(host){
 const input=host.querySelector('#team-color'),wheel=host.querySelector('.color-wheel');let hsv=hexToHsv(input.value);
 const ranges={h:host.querySelector('#color-hue'),s:host.querySelector('#color-saturation'),v:host.querySelector('#color-brightness')};
 function draw(){
  const hex=hsvToHex(hsv.h,hsv.s,hsv.v);input.value=hex;
  ranges.h.value=Math.round(hsv.h);ranges.s.value=Math.round(hsv.s*100);ranges.v.value=Math.round(hsv.v*100);
  const handle=host.querySelector('.color-wheel-handle'),angle=hsv.h*Math.PI/180;
  handle.style.left=(50+50*hsv.s*Math.cos(angle))+'%';handle.style.top=(50+50*hsv.s*Math.sin(angle))+'%';
  host.querySelector('.color-wheel-shade').style.opacity=1-hsv.v;
  host.querySelector('.color-preview').style.setProperty('--picked-color',hex);host.querySelector('.color-value').textContent=hex;
 }
 for(const [key,range]of Object.entries(ranges))range.oninput=()=>{hsv[key]=Number(range.value)/(key==='h'?1:100);draw();};
 input.oninput=()=>{if(/^#[0-9a-f]{6}$/i.test(input.value)){hsv=hexToHsv(input.value);draw();}};
 function pick(e){const rect=wheel.getBoundingClientRect(),radius=rect.width/2,x=e.clientX-rect.left-radius,y=e.clientY-rect.top-radius;hsv.h=(Math.atan2(y,x)*180/Math.PI+360)%360;hsv.s=Math.min(1,Math.hypot(x,y)/radius);draw();}
 wheel.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();wheel.setPointerCapture(e.pointerId);pick(e);};
 wheel.onpointermove=e=>{if(wheel.hasPointerCapture(e.pointerId))pick(e);};
 wheel.onpointerup=e=>{if(wheel.hasPointerCapture(e.pointerId))wheel.releasePointerCapture(e.pointerId);};
 draw();return ()=>input.value;
}
export function membersHTML(names){
 return `<fieldset class="roster-editor"><legend>Team members</legend><p class="info">Add each person below. Recorded drinks stay in the history when a member is removed.</p><div id="member-fields">${(names.length?names:['']).map((name,i)=>memberRow(name,i+1)).join('')}</div><div class="row between"><button type="button" id="add-member" class="ghost">+ Add member</button><span id="member-count" class="small muted"></span></div></fieldset>`;
}
function memberRow(name,n){return `<div class="member-field"><label>Member ${n}<input class="member-input" name="members" maxlength="80" autocomplete="off" value="${escape(name)}" placeholder="Name"></label><button type="button" class="ghost remove-member" aria-label="Remove member ${n}">×</button></div>`;}
export function bindMembers(host){
 const list=host.querySelector('#member-fields'),add=host.querySelector('#add-member');
 function update(){const rows=[...list.children];rows.forEach((row,i)=>{row.querySelector('label').firstChild.textContent=`Member ${i+1}`;row.querySelector('button').setAttribute('aria-label',`Remove member ${i+1}`);});add.disabled=rows.length>=50;host.querySelector('#member-count').textContent=rows.length+' / 50 fields';}
 add.onclick=()=>{if(list.children.length>=50)return;list.insertAdjacentHTML('beforeend',memberRow('',list.children.length+1));update();list.lastElementChild.querySelector('input').focus();};
 list.onclick=e=>{const remove=e.target.closest('.remove-member');if(!remove)return;const row=remove.closest('.member-field'),next=row.nextElementSibling||row.previousElementSibling;row.remove();if(!list.children.length)list.innerHTML=memberRow('',1);update();(next||list.firstElementChild).querySelector('input').focus();};
 update();return ()=>[...list.querySelectorAll('input')].map(input=>input.value.trim()).filter(Boolean);
}
