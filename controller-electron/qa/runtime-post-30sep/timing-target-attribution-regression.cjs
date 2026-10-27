"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(process.argv[2]||path.join(__dirname,'../electron/game/flash_runtime.page.js')),'utf8')
 .replace('  window[KEY] = {','  window.__targetQa = {state,tickAutoNewContact};\n  window[KEY] = {');
function fixture(){
 const c=vm.createContext({console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},performance:{now:()=>1000},document:{hidden:false}});c.window=c;vm.runInContext(source,c);
 const q=c.__targetQa,E=q.state.tickEngine;q.state.timing.tick.auto=true;E.auto.margin=14;E.auto.sigma=4;E.auto.cooldown='global';
 return {q,E};
}
{
 const {q,E}=fixture();E.shots=[{n:2,k:0,b:0,ok:true,reactive:false,targetId:7,phase:14}];
 q.tickAutoNewContact(2,[],{p:30},8);assert.equal(E.auto.margin,14);
 console.log('PASS an untargeted rival winning cannot advance the shot aimed at another rival');
}
{
 const {q,E}=fixture();E.shots=[{n:2,k:0,b:0,ok:true,reactive:false,targetId:7,phase:14}];
 q.tickAutoNewContact(2,[],{p:30},7);assert.equal(E.auto.margin,14);assert.equal(E.auto.lost,1);
 console.log('PASS a loss against the actual target is observed without inventing the request landing time');
}
{
 const {q,E}=fixture();E.shots=[{n:2,k:0,b:0,ok:true,reactive:false,targetId:7,phase:14}];
 q.tickAutoNewContact(2,[{kind:'reject',p:14,target:8}],{p:30},8);assert.equal(E.auto.margin,14);
 console.log('PASS a reject for another rival cannot train this target\'s shot');
}
