export const TRAIN_ROUTES = {
 '1':'#ee352e','2':'#ee352e','3':'#ee352e','4':'#00933c','5':'#00933c','6':'#00933c','7':'#b933ad',
 A:'#0039a6',C:'#0039a6',E:'#0039a6',B:'#ff6319',D:'#ff6319',F:'#ff6319',M:'#ff6319',G:'#6cbe45',
 J:'#996633',Z:'#996633',L:'#a7a9ac',N:'#fccc0a',Q:'#fccc0a',R:'#fccc0a',W:'#fccc0a',S:'#808183'
};
export function countdownRemaining(timer,now){
 if(!timer)return 0;
 return Math.max(0,timer.status==='running'?timer.endsAt-now:timer.remainingMs);
}
export function formatCountdown(ms){
 const seconds=Math.max(0,Math.ceil(ms/1000));
 return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
}
