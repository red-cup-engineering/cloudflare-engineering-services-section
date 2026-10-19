import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveCloudflareAccountInventory,observeCloudflareBuildMinutes,observeCloudflareR2Buckets}
  from '../scripts/derive-cloudflare-account-inventory.mjs';
const readers=[deriveCloudflareAccountInventory,observeCloudflareBuildMinutes,observeCloudflareR2Buckets];
const accountId='a'.repeat(32);
for(const reader of readers)test(`${reader.name} uses one explicit environment without ambient principal fallback`,async()=>{
  const before={...process.env};let calls=0;
  const result=await reader({accountId,tokenEnvironmentVariable:'PATH',fetch:async(url,options)=>{
    calls++;assert.equal(options.headers.authorization,'Bearer dummy-owned-token');
    const result=url.includes('/tokens/verify')?{status:'active'}:url.includes('/builds/')?{has_reached_build_minutes_limit:false}:url.includes('/r2/')?{buckets:[]}:[];
    return {ok:true,json:async()=>({success:true,result})};
  }},{environment:{PATH:'dummy-owned-token'}});
  assert.ok(calls>0);assert.notEqual(result.type,'CloudflareAccountInventoryRefusal');
  assert.equal(JSON.stringify(result).includes('dummy-owned-token'),false);
  assert.deepEqual({...process.env},before);
  const missing=await reader({accountId,tokenEnvironmentVariable:'PATH',fetch:()=>{throw Error('must not fall back to ambient PATH');}},{environment:{}});
  assert.equal(missing.code,'TOKEN_ENVIRONMENT_VARIABLE_UNSET');
});


test('operation owner is the only change from the exact current provider source, including explicit environment boundaries',async()=>{
  const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
  let source=await readFile(new URL('../scripts/derive-cloudflare-account-inventory.mjs',import.meta.url),'utf8');
  const runtime='@red-cup-engineering/javascript-node-operation-engineering-services-section/operation';
  assert.equal(source.split(runtime).length-1,1,'one original CLI binding selects the independent runtime');
  assert.equal(source.includes('@red-cup-engineering/javascript-node-services-section/operation'),false);
  source=source.replace(runtime,'@red-cup-engineering/javascript-node-services-section/operation');
  const bytes=Buffer.from(source);
  const identity=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  assert.equal(identity,'74f04a09e9bed39c4c96771a0785583807a54576','Cloudflare 5e68afa6 current source; all other function bytes must be preserved');
});
