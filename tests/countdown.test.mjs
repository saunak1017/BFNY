import {test} from 'node:test';
import assert from 'node:assert/strict';
import {countdownRemaining,formatCountdown,TRAIN_ROUTES} from '../public/game-ui.js';
test('countdown uses elapsed time, freezes when paused and stays at zero without side effects',()=>{
 const running={status:'running',endsAt:7380000};
 assert.equal(formatCountdown(countdownRemaining(running,0)),'02:03:00');
 assert.equal(formatCountdown(countdownRemaining(running,1000)),'02:02:59');
 assert.equal(formatCountdown(countdownRemaining(running,7381000)),'00:00:00');
 assert.equal(formatCountdown(1),'00:00:01');
 assert.equal(countdownRemaining({status:'paused',remainingMs:5500},999999),5500);
 assert.equal(countdownRemaining(null,0),0);
 assert.equal(TRAIN_ROUTES.R,'#fccc0a');assert.equal(TRAIN_ROUTES['7'],'#b933ad');
});
