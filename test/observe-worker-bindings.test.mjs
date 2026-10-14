import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveCloudflareWorkerStorageBindings} from '../scripts/derive-cloudflare-account-inventory.mjs';
const accountId='a'.repeat(32),tokenName='CF_WORKER_BINDING_TEST';
async function withToken(fn){
  const before=process.env[tokenName];
  process.env[tokenName]='fixture-internal-secret';
  try{return await fn();}
  finally{if(before===undefined)delete process.env[tokenName];else process.env[tokenName]=before;}
}
const ok=result=>({ok:true,json:async()=>({success:true,result})});
const mock=(scripts,settings)=>{
  const calls=[];
  const fetch=async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer fixture-internal-secret');
    calls.push({url,method:options.method??'GET'});
    if(url.endsWith('/workers/scripts'))return ok(scripts);
    const name=decodeURIComponent(url.split('/').at(-2));
    const value=settings[name];
    if(value===false)return {ok:false,status:403,json:async()=>({success:false,errors:[{message:'private-provider-reason'}]})};
    return ok(value);
  };
  return {calls,fetch};
};
const call=fetch=>deriveCloudflareWorkerStorageBindings({accountId,tokenEnvironmentVariable:tokenName,fetch});

test('real Cloudflare script Settings shape receives responsible KV, DO, R2 Worker bindings',async()=>{
  const {fetch,calls}=mock([{id:'site-a'},{id:'api-b'}],{
    'site-a':{bindings:[{name:'KV',type:'kv_namespace',namespace_id:'kv-A'},
      {name:'R2',type:'r2_bucket',bucket_name:'data',jurisdiction:'eu'},
      {name:'DB',type:'d1',database_id:'d1-123'},
      {name:'MESSAGES',type:'queue',queue_name:'incoming-work'},
      {name:'TEXT',type:'plain_text',text:'private-value'}]},
    'api-b':{bindings:[{name:'DO',type:'durable_object_namespace',class_name:'Thing',
      script_name:'stateful-owner',environment:'production'}]},
  });
  const out=await withToken(()=>call(fetch));
  assert.equal(out.type,'CloudflareWorkerStorageBindingObservation');
  assert.equal(out.scriptsEnumerated,2);
  assert.equal(out.settingsObserved,2);
  assert.equal(out.complete,true);
  assert.deepEqual(out.storageBindings,[
    {worker:'api-b',status:'observed',bindings:[
      {type:'durable_object_namespace',bindingName:'DO',namespaceId:null,className:'Thing',
        scriptName:'stateful-owner',environment:'production'}]},
    {worker:'site-a',status:'observed',bindings:[
      {type:'kv_namespace',bindingName:'KV',namespaceId:'kv-A'},
      {type:'r2_bucket',bindingName:'R2',namespaceId:null,bucketName:'data',jurisdiction:'eu'},
      {type:'d1',bindingName:'DB',namespaceId:null,databaseId:'d1-123'},
      {type:'queue',bindingName:'MESSAGES',namespaceId:null,queueName:'incoming-work'}]},
  ]);
  assert.equal(out.currentOperationUsage,'unknown');
  assert.equal(out.freeTierHeadroom,'unknown');
  assert.equal(calls.length,3);
  assert.ok(calls.every(x=>x.method==='GET'));
  assert.doesNotMatch(JSON.stringify(out),/fixture-internal-secret|private-value|private-provider-reason/);
});

test('missing or duplicate storage references keep the Worker settings explicitly unread',async()=>{
  for(const bindings of [
    [{name:'R2',type:'r2_bucket'}],
    [{name:'DB',type:'d1',database_id:''}],
    [{name:'Q',type:'queue',queue_name:null}],
    [{name:'KV',type:'kv_namespace'}],
    [{name:'DO',type:'durable_object_namespace'}],
    [{name:'R2',type:'r2_bucket',bucket_name:'one'},
     {name:'R2',type:'r2_bucket',bucket_name:'two'}],
  ]){
    const {fetch}=mock([{id:'stateful-worker'}],{
      'stateful-worker':{bindings},
    });
    const result=await withToken(()=>call(fetch));
    assert.equal(result.complete,false);
    assert.equal(result.settingsObserved,0);
    assert.deepEqual(result.unread,[{worker:'stateful-worker',status:'invalid-settings'}]);
    assert.deepEqual(result.storageBindings,[]);
  }
});

test('denied individual Worker settings do not turn into false zero-storage claim',async()=>{
  const {fetch}=mock([{id:'one'},{id:'two'}],{
    one:false,two:{bindings:[{name:'KV',type:'kv_namespace',namespace_id:'opaque'}]},
  });
  const out=await withToken(()=>call(fetch));
  assert.equal(out.complete,false);
  assert.equal(out.settingsObserved,1);
  assert.deepEqual(out.unread,[{worker:'one',status:'provider-refusal'}]);
  assert.equal(out.storageBindings.length,1);
});
test('ambiguous list or incomplete pagination is a typed refusal',async()=>{
  for(const payload of [
    [{id:'same'},{id:'same'}],
    [{id:'../bad'}],
    [{name:'not-an-id'}],
  ]){
    const {fetch}=mock(payload,{});
    const out=await withToken(()=>call(fetch));
    assert.equal(out.type,'CloudflareAccountInventoryRefusal');
    assert.equal(out.code,'CLOUDFLARE_WORKER_BINDING_COVERAGE_INCOMPLETE');
  }
  const fetch=async()=>({ok:true,json:async()=>({
    success:true,result:[{id:'ok'}],result_info:{total_pages:2,total_count:200},
  })});
  const out=await withToken(()=>call(fetch));
  assert.equal(out.code,'CLOUDFLARE_WORKER_BINDING_COVERAGE_INCOMPLETE');
});
test('missing account custody refuses without any native request',async()=>{
  const prior=process.env[tokenName];delete process.env[tokenName];
  try {
    const out=await call(async()=>assert.fail('called provider despite missing credentials'));
    assert.equal(out.code,'TOKEN_ENVIRONMENT_VARIABLE_UNSET');
  }finally{if(prior!==undefined)process.env[tokenName]=prior;}
});
