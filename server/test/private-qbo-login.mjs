import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp, rm} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateQboPages, privateQboPaste, privateQboPasteExpression} from '../dist/private-qbo-login.js';
import {ProfileCredentialBroker, ProtectedPasteState} from '../dist/protected-paste.js';

function fixture(kind, overrides = {}) {
  class Input {
    constructor() { this._value = ''; this.type = kind === 'password' ? 'password' : 'email'; this.labels = [{textContent: kind === 'password' ? 'Password' : 'Email or user ID'}]; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    getClientRects() { return [{}]; }
    getAttribute() { return ''; }
    dispatchEvent() {}
  }
  const field = Object.assign(new Input(), overrides.field);
  const context = {HTMLInputElement:Input, document:{activeElement:field}, location:{protocol:'https:', hostname:'accounts.intuit.com', pathname:'/app/sign-in', ...overrides.location}, Event:class{}};
  return {field, context};
}
for (const kind of ['username','password']) {
  for (const [overrides, expected] of [[{},true], [{location:{hostname:'accounts.intuit.com.evil.invalid'}},false], [{location:{protocol:'http:'}},false], [{location:{pathname:'/app/sign-up'}},false], [{field:{_value:'existing'}},false], [{field:{disabled:true}},false], [{field:{readOnly:true}},false], [{field:{labels:[{textContent:'Unrelated'}]}},false], [{field:{getClientRects:()=>[]}},false], ...(kind === 'password' ? [[{field:{autocomplete:'new-password'}},false], [{field:{type:'text'}},false]] : [[{field:{type:'password'}},false]])]) {
    const {field, context} = fixture(kind, overrides);
    const result = vm.runInNewContext(privateQboPasteExpression(kind,'synthetic-secret'), context);
    assert.equal(result.pasted, expected);
    assert.equal(field.value === 'synthetic-secret', expected);
  }
  const {field, context} = fixture(kind, {field:{labels:[], getAttribute:(name)=> name === 'aria-labelledby' ? 'login-label' : ''}});
  context.document.getElementById = id => id === 'login-label' ? {textContent:kind === 'password' ? 'Password' : 'Email or user ID'} : null;
  assert.equal(vm.runInNewContext(privateQboPasteExpression(kind,'synthetic-secret'),context).pasted,true);
  assert.equal(field.value,'synthetic-secret');
}

const state = new ProtectedPasteState();
const bridge = {async callTool(name, args) {
  if (name === 'list_pages') return {content:[{type:'text',text:'Found 3 page(s):\nPage 7 [ACTIVE]: "Intuit" - https://accounts.intuit.com/app/sign-in?state=private\nPage 8: "Other" - https://accounts.intuit.com.evil.invalid/\nPage 9: "Private unrelated title" - https://example.com/'}]};
  assert.equal(name,'evaluate'); assert.equal(args.tabId,7);
  const {context} = fixture('username');
  return {content:[{type:'text',text:JSON.stringify(vm.runInNewContext(args.expression, context))}]};
}};
assert.equal(await privateQboPages(bridge,'finance'),'{"pages":[7]}\n');
assert.equal(await privateQboPages(bridge,'marketing'),'ERROR\n');
state.storeCredential(Buffer.from('synthetic-secret'));
assert.equal(await privateQboPaste(bridge,'finance',state,7,'username'),'PASTED\n');
assert.equal(state.takeCredential(),null);
assert.equal(await privateQboPaste(bridge,'finance',state,7,'username'),'ERROR staged\n');
state.storeCredential(Buffer.from('synthetic-secret'));
assert.equal(await privateQboPaste(bridge,'marketing',state,7,'username'),'ERROR\n');
assert.equal(state.takeCredential(),null);
for (const response of [{isError:true,content:[{type:'text',text:'synthetic-secret'}]}, {content:[{type:'text',text:'{"pasted":true,"value":"synthetic-secret"}'}]}, {content:[{type:'text',text:'{"pasted":false}'}]}]) {
  state.storeCredential(Buffer.from('synthetic-secret'));
  assert.equal(await privateQboPaste({callTool:async()=>response},'finance',state,7,'username'), response.isError ? 'ERROR bridge\n' : 'ERROR\n');
  assert.equal(state.takeCredential(),null);
  assert.equal(response.content[0].text,'');
}

const directory = await mkdtemp(join(tmpdir(),'qbo-paste-'));
const path = join(directory,'credential.sock');
const broker = new ProfileCredentialBroker(path,state,undefined,()=>privateQboPages(bridge,'finance'),(id,kind)=>privateQboPaste(bridge,'finance',state,id,kind));
function request(text) { return new Promise((resolve,reject)=>{ const c=createConnection(path); const chunks=[]; c.on('connect',()=>c.end(text)); c.on('data',b=>chunks.push(b)); c.on('error',reject); c.on('end',()=>resolve(Buffer.concat(chunks).toString())); }); }
try {
  await broker.start();
  assert.equal(await request('QBO-PAGES/1\n'),'{"pages":[7]}\n');
  state.storeCredential(Buffer.from('synthetic-secret'));
  assert.equal(await request('QBO-PASTE/1 7 username\n'),'PASTED\n');
  assert.equal(await request('QBO-PASTE/1 7 username\n'),'ERROR staged\n');
  assert.equal(await request('QBO-PASTE/1 7 arbitrary\n'),'ERROR\n');
} finally { await broker.stop(); await rm(directory,{recursive:true,force:true}); }
console.log('private QBO login: recipient, field, replay, profile, cleanup and socket checks passed');
