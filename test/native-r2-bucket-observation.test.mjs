import test from 'node:test';
import assert from 'node:assert/strict';
import {observeCloudflareR2Buckets} from '../scripts/derive-cloudflare-account-inventory.mjs';

const accountId='f'.repeat(32),key='R2_BUCKET_TEST_TOKEN';
async function withToken(run){
  const previous=process.env[key];process.env[key]='not-an-actual-token';
  try{return await run();}
  finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
}
const response=(buckets,cursor)=>({ok:true,success:true,result:{buckets},
  result_info:cursor===undefined?{}:{cursor}});
const bucket=(name)=>({name,location:'enam',jurisdiction:'default',
  storage_class:'Standard',creation_date:'2026-10-13T00:00:00.000Z'});
const reader=fetch=>observeCloudflareR2Buckets({accountId,tokenEnvironmentVariable:key,fetch});
const provider=(fn)=>async (url,options)=>{
  assert.equal(options.headers.authorization,'Bearer not-an-actual-token');
  assert.ok(options.signal,'native Cloudflare reads must have a bounded timeout');
  const body=await fn(url);
  return {ok:body.ok,json:async()=>body};
};

test('real owner reader traverses every cursor and projects only bucket carriers',async()=>{
  const calls=[];
  const out=await withToken(()=>reader(provider(async url=>{
    calls.push(url);
    return calls.length===1?response([bucket('weather-data')],'next')
      :response([bucket('astronomy-data')]);
  })));
  assert.deepEqual(calls,[
    'https://api.cloudflare.com/client/v4/accounts/'+accountId+'/r2/buckets',
    'https://api.cloudflare.com/client/v4/accounts/'+accountId+'/r2/buckets?cursor=next'
  ]);
  assert.equal(out.type,'CloudflareR2BucketObservation');
  assert.equal(out.coverage,'complete');
  assert.deepEqual(out.buckets.map(x=>x.name),['weather-data','astronomy-data']);
  assert.equal(out.rightsToResell,'unverified');
  assert.equal(out.objectInventory,'unobserved');
  assert.equal(out.quotaHeadroom,'unobserved');
  assert.equal(JSON.stringify(out).includes('not-an-actual-token'),false);
});

test('malformed/repeating/incomplete provider pages cannot masquerade as an empty account',async()=>{
  for(const invalid of [
    response([bucket('one'),bucket('one')]),
    response([null]),response([bucket('BAD NAME')]),
    {ok:true,success:true,result:{buckets:null}},
  ]){
    const out=await withToken(()=>reader(provider(async()=>invalid)));
    assert.equal(out.type,'CloudflareAccountInventoryRefusal');
    assert.equal(out.code,'CLOUDFLARE_R2_BUCKET_COVERAGE_INVALID');
  }
  let n=0;
  const cyclic=await withToken(()=>reader(provider(async()=>{
    n++;return response([bucket('bucket-'+n)],'same-cursor');
  })));
  assert.equal(cyclic.code,'CLOUDFLARE_R2_BUCKET_COVERAGE_INVALID');
  assert.ok(n<=2);
});
test('provider refusal, missing custody and transport error remain explicit',async()=>{
  const refused=await withToken(()=>reader(provider(async()=>({ok:false,success:false,errors:[{message:'PRIVATE'}]}))));
  assert.equal(refused.code,'CLOUDFLARE_R2_BUCKET_COVERAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(refused).includes('PRIVATE'),false);
  const timeout=await withToken(()=>reader(async()=>{throw new Error('PRIVATE_ERROR')}));
  assert.equal(timeout.code,'CLOUDFLARE_R2_BUCKET_COVERAGE_UNAVAILABLE');
  const previous=process.env[key];delete process.env[key];
  try{
    const missing=await reader(()=>assert.fail('must not call provider without token'));
    assert.equal(missing.code,'TOKEN_ENVIRONMENT_VARIABLE_UNSET');
  }finally{if(previous!==undefined)process.env[key]=previous;}
});
