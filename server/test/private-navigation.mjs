import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { ProfileCredentialBroker, ProtectedPasteState } from '../dist/protected-paste.js';
import { navigatePrivateQboFile } from '../dist/private-navigation.js';
const root = await realpath(await mkdtemp('/tmp/qnav-'));
const cache = join(root, 'profiles/finance/cache');
await mkdir(join(cache, 'qbo-oauth-state'), {recursive:true, mode:0o700});
await mkdir(join(cache, 'vibe-mcp'), {mode:0o700});
const socket = join(cache, 'vibe-mcp/credential.sock');
const file = join(cache, 'qbo-oauth-state/authorization-url');
const url = 'https://appcenter.intuit.com/connect/oauth2?client_id=test&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=https%3A%2F%2Fqbo-oauth.aoclabs.ai%2Fcallback&state=secret-test-state';
let calls=[];
const bridge={async callTool(name,args){calls.push({name,args});return {content:[{type:'text',text:url}]};}};
const publish=async(value=url)=>writeFile(file,value,{mode:0o600});
try {
 await publish();
 assert.equal(await navigatePrivateQboFile(bridge,'hr',socket,7),'ERROR\n');
 assert.equal(await navigatePrivateQboFile(bridge,'finance',socket,0),'ERROR\n');
 await chmod(file,0o644);
 assert.equal(await navigatePrivateQboFile(bridge,'finance',socket,7),'ERROR\n');
 await chmod(file,0o600);
 assert.equal(calls.length,0);
 assert.equal(await navigatePrivateQboFile(bridge,'finance',socket,7),'NAVIGATED\n');
 assert.deepEqual(calls,[{name:'navigate_page',args:{pageId:7,type:'url',url,timeoutMs:25_000}}]);
 assert.equal(await navigatePrivateQboFile(bridge,'finance',socket,7),'ERROR\n');
 await publish(url.replace('appcenter.intuit.com','evil.example'));
 assert.equal(await navigatePrivateQboFile(bridge,'finance',socket,7),'ERROR\n');
 await rm(file); await symlink(join(root,'missing'),file);
 assert.equal(await navigatePrivateQboFile(bridge,'finance',socket,7),'ERROR\n');
 await rm(file); await publish();
 assert.equal(await navigatePrivateQboFile({async callTool(){throw Error(url);}},'finance',socket,7),'ERROR\n');
 assert.equal(calls.length,1);
 const broker = new ProfileCredentialBroker(socket,new ProtectedPasteState(),pageId=>navigatePrivateQboFile(bridge,'finance',socket,pageId));
 await broker.start();
 try {
   await publish();
   const receipt = await new Promise((resolve,reject)=>{
     const client=createConnection(socket); const chunks=[];
     client.on('connect',()=>client.end('QBO-NAVIGATE/1 8\n'));
     client.on('data',chunk=>chunks.push(chunk)); client.on('error',reject);
     client.on('end',()=>resolve(Buffer.concat(chunks).toString()));
   });
   assert.equal(receipt,'NAVIGATED\n');
   assert.equal(calls.at(-1).args.pageId,8);
 } finally {await broker.stop();}
 console.log('private navigation: profile, mode, symlink, origin, one-use, sanitized receipts passed');
} finally {await rm(root,{recursive:true,force:true});}
