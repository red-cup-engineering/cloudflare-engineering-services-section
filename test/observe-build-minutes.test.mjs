import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCloudflareBuildMinutes } from '../scripts/derive-cloudflare-account-inventory.mjs';

const accountId='a'.repeat(32);
const variable='CF_BUILDS_TEST_TOKEN';
const withToken=async (fn)=>{
  const previous=process.env[variable];
  process.env[variable]='fixture-token-not-a-credential';
  try {return await fn();} finally {
    if(previous===undefined)delete process.env[variable];else process.env[variable]=previous;
  }
};
const invoke=(body, status=200)=>observeCloudflareBuildMinutes({
  accountId,tokenEnvironmentVariable:variable,
  fetch:async (url,options)=>{
    assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+accountId+'/builds/account/limits');
    assert.equal(options.headers.authorization,'Bearer fixture-token-not-a-credential');
    return {ok:status>=200&&status<300,json:async()=>body};
  }
});

test('native Workers Builds exhausted signal is scoped, dated and not a cost claim',async()=>{
  const received=await withToken(()=>invoke({success:true,result:{
    has_reached_build_minutes_limit:true,
    build_minutes_refresh_on:'2026-11-01T00:00:00.000Z',
  }}));
  assert.equal(received.type,'CloudflareWorkersBuildMinutesObservation');
  assert.equal(received.status,'exhausted');
  assert.equal(received.refreshAt,'2026-11-01T00:00:00.000Z');
  assert.equal(received.accountId,accountId);
  assert.ok(Number.isFinite(Date.parse(received.observedAt)));
  assert.match(received.claim,/not measure remaining minutes, billable cost, KV, R2/);
  assert.equal(JSON.stringify(received).includes('fixture-token'),false);
});

test('unexhausted limit is not equal to verified unused minutes or zero billing',async()=>{
  const received=await withToken(()=>invoke({success:true,result:{
    has_reached_build_minutes_limit:false,
  }}));
  assert.equal(received.status,'not-exhausted');
  assert.equal(received.refreshAt,null);
  assert.equal('remainingMinutes' in received,false);
  assert.equal('free' in received,false);
});

test('paid-plan omission is UNKNOWN, not an unbounded free build allowance',async()=>{
  const received=await withToken(()=>invoke({success:true,result:{}}));
  assert.equal(received.status,'unknown');
});

test('incomplete, unauthorized or failed provider reply produces a typed refusal',async()=>{
  for(const [body,status,code] of [
    [{success:true,result:null},200,'CLOUDFLARE_BUILD_LIMIT_INVALID'],
    [{success:true,result:{has_reached_build_minutes_limit:'false'}},200,'CLOUDFLARE_BUILD_LIMIT_INVALID'],
    [{success:true,result:{build_minutes_refresh_on:'not-a-time'}},200,'CLOUDFLARE_BUILD_LIMIT_INVALID'],
    [{success:false,errors:[{message:'internal-token-material'}]},403,'CLOUDFLARE_BUILD_LIMIT_UNAVAILABLE'],
  ]){
    const received=await withToken(()=>invoke(body,status));
    assert.equal(received.type,'CloudflareAccountInventoryRefusal');
    assert.equal(received.code,code);
    assert.equal(JSON.stringify(received).includes('internal-token-material'),false);
  }
});

test('caller cannot read capacity without an actual token or exact account id',async()=>{
  const previous=process.env[variable];
  delete process.env[variable];
  try{
    const missing=await observeCloudflareBuildMinutes({accountId,tokenEnvironmentVariable:variable,fetch:async()=>assert.fail('no auth means no API call')});
    assert.equal(missing.code,'TOKEN_ENVIRONMENT_VARIABLE_UNSET');
  }finally{
    if(previous!==undefined)process.env[variable]=previous;
  }
  await assert.rejects(()=>observeCloudflareBuildMinutes({accountId:'wrong',tokenEnvironmentVariable:variable}),/exact account id/);
});
