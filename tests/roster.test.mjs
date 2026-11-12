import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRosterCSV} from '../public/roster.js';

test('CSV groups members, handles BOM, CRLF, quoted commas and escaped quotes',()=>{
 const groups=parseRosterCSV('\uFEFFteam,member,color,passcode\r\n"Queens, NY","Alex ""Ace""",#123456,secret123\r\n"Queens, NY",Sam,,\r\n');
 assert.deepEqual(groups,[{name:'Queens, NY',members:['Alex "Ace"','Sam'],color:'#123456',passcode:'secret123'}]);
 assert.deepEqual(parseRosterCSV('member,team\nAlex,Queens\nSam,queens'),[{name:'Queens',members:['Alex','Sam']}]);
});
test('CSV rejects ambiguous, incomplete, duplicate, inconsistent or excessive input',()=>{
 for(const csv of ['team,name\nA,B','team,member\nA','team,member,member\nA,B,C','team,member\nA,"unclosed','team,member\nA,"B"oops','team,member\nA,Sam\na,sam','team,member,color\nA,Alex,#123456\nA,Sam,#654321','team,member\nA,','team,member\n'])assert.throws(()=>parseRosterCSV(csv));
 assert.throws(()=>parseRosterCSV('team,member\n'+Array.from({length:51},(_,i)=>`A,Person ${i}`).join('\n')));
 assert.throws(()=>parseRosterCSV('x'.repeat(150001)));
});
