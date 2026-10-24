import test from "node:test";
import assert from "node:assert/strict";
import {observeCloudflareKvOperations} from "../scripts/derive-cloudflare-account-inventory.mjs";

const accountId="a".repeat(32),variable="KV_ANALYTICS_READ_TEST";
const day="2026-10-24",priorDay="2026-10-23";
const clock=()=>new Date("2026-10-24T22:30:00.000Z");
const namespaceA="b".repeat(32),namespaceB="c".repeat(32);
const row=(namespaceId,actionType,requests,date=day)=>({
  dimensions:{namespaceId,actionType,date},sum:{requests}
});
const analytics=(rows,options={})=>({
  data:{viewer:{accounts:options.accounts??[{kvOperationsAdaptiveGroups:rows}]}},
  ...(options.errors?{errors:options.errors}:{}),
});
const observe=(response,fetchOverride)=>{
  const calls=[];
  const sourceFetch=fetchOverride??(async (url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify(response),{
      status:200,headers:{"content-type":"application/json"},
    });
  });
  return {
    calls,
    run:(options={})=>observeCloudflareKvOperations({
      accountId,day:options.day??day,tokenEnvironmentVariable:variable,fetch:sourceFetch,
    },{environment:options.environment??{[variable]:"private-fixture-token"},now:options.now??clock}),
  };
};

test("native account GraphQL groups exact namespace/action operations, without claiming billable events",async()=>{
  const fixture=observe(analytics([
    row(namespaceA,"write",777),row(namespaceB,"write",129),
    row(namespaceA,"read",400),row(namespaceB,"list",5),
  ]));
  const result=await fixture.run();
  assert.equal(result.type,"CloudflareKvOperationsObservation");
  assert.equal(result.accountId,accountId);
  assert.equal(result.day,day);
  assert.equal(result.coverage,"partial-day-analytics");
  assert.equal(result.analyticsReportedRequests,1311);
  assert.deepEqual(result.groups,[
    {namespaceId:namespaceA,actionType:"read",requests:400},
    {namespaceId:namespaceA,actionType:"write",requests:777},
    {namespaceId:namespaceB,actionType:"list",requests:5},
    {namespaceId:namespaceB,actionType:"write",requests:129},
  ]);
  assert.equal(result.freeTierHeadroom,"unknown");
  assert.equal(result.chargedUsage,"unknown");
  assert.equal(result.acceptedService,"unknown");
  assert.equal(fixture.calls.length,1);
  assert.equal(fixture.calls[0].url,"https://api.cloudflare.com/client/v4/graphql");
  assert.equal(fixture.calls[0].options.method,"POST");
  assert.equal(fixture.calls[0].options.headers.authorization,"Bearer private-fixture-token");
  const sent=JSON.parse(fixture.calls[0].options.body);
  assert.deepEqual(sent.variables,{accountTag:accountId,day});
  assert.match(sent.query,/kvOperationsAdaptiveGroups/u);
  assert.match(sent.query,/namespaceId/u);
  assert.match(sent.query,/actionType/u);
  assert.match(sent.query,/limit:\s*1000/u);
  assert.doesNotMatch(JSON.stringify(result),/private-fixture-token/u);
});

test("complete historical empty analytics result is a reported zero, not measured free capacity",async()=>{
  const fixture=observe(analytics([]));
  const result=await fixture.run({day:priorDay});
  assert.equal(result.coverage,"historical-day-analytics");
  assert.equal(result.analyticsReportedRequests,0);
  assert.deepEqual(result.groups,[]);
  assert.equal(result.freeTierHeadroom,"unknown");
});

test("missing token or outside provider retention refuses before any API call",async()=>{
  const fixture=observe(analytics([]));
  const missing=await fixture.run({environment:{}});
  assert.equal(missing.code,"TOKEN_ENVIRONMENT_VARIABLE_UNSET");
  const older=await fixture.run({day:"2026-09-01"});
  assert.equal(older.code,"CLOUDFLARE_KV_ANALYTICS_OUTSIDE_RETENTION");
  const future=await fixture.run({day:"2026-10-25"});
  assert.equal(future.code,"CLOUDFLARE_KV_ANALYTICS_OUTSIDE_RETENTION");
  assert.equal(fixture.calls.length,0);
});

test("ill-typed and impossible UTC dates reject without contacting Cloudflare",async()=>{
  const fixture=observe(analytics([]));
  for(const bad of ["2026-02-30","2026-10-24T00:00:00Z","2026-10-24Z","2026-13-01","2026-1-3",null]){
    await assert.rejects(fixture.run({day:bad}),/canonical UTC day/u);
  }
  assert.equal(fixture.calls.length,0);
});

test("denied transport, provider status and GraphQL errors never expose upstream body",async()=>{
  const forbidden="PRIVATE_API_TOKEN_OR_QUERY_DETAIL";
  for(const denied of [
    new Response(JSON.stringify({errors:[{message:forbidden}]}),{status:403}),
    new Response(JSON.stringify({errors:[{message:forbidden}],data:{viewer:{accounts:[]}}}),{status:200}),
  ]){
    const {run}=observe(null,async()=>denied);
    const refused=await run();
    assert.equal(refused.code,"CLOUDFLARE_KV_ANALYTICS_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(refused),/PRIVATE_API_TOKEN_OR_QUERY_DETAIL/u);
  }
  const {run}=observe(null,async()=>{throw Error(forbidden);});
  assert.equal((await run()).code,"CLOUDFLARE_KV_ANALYTICS_UNAVAILABLE");
});

test("unknown or missing account coverage must never become reported zero",async()=>{
  for(const value of [
    {data:{viewer:{accounts:[]}}},
    {data:{viewer:{accounts:[{kvOperationsAdaptiveGroups:null}]}}},
    {data:{viewer:{accounts:[{},{}]}}},
    {success:true,result:[]},
    {data:{viewer:null}},
  ]){
    const result=await observe(value).run();
    assert.equal(result.code,"CLOUDFLARE_KV_ANALYTICS_INVALID");
    assert.equal(result.analyticsReportedRequests,undefined);
  }
});

test("duplicate dimensions, mismatched day, malformed namespace/action and invalid count refuse",async()=>{
  const cases=[
    [row(namespaceA,"write",1),row(namespaceA,"write",2)],
    [row(namespaceA,"write",1,"2026-10-23")],
    [row("not-a-namespace","write",1)],
    [row(namespaceA,"",1)],
    [row(namespaceA,"write",-1)],
    [row(namespaceA,"write",1.5)],
    [row(namespaceA,"write",Number.MAX_SAFE_INTEGER+1)],
    [row(namespaceA,"write","12")],
  ];
  for(const rows of cases){
    const result=await observe(analytics(rows)).run();
    assert.equal(result.code,"CLOUDFLARE_KV_ANALYTICS_INVALID");
  }
});

test("saturated 1000-row GraphQL limit refuses silent truncation",async()=>{
  const many=Array.from({length:1000},(_,i)=>
    row(i.toString(16).padStart(32,"0"),"write",1));
  const result=await observe(analytics(many)).run();
  assert.equal(result.code,"CLOUDFLARE_KV_ANALYTICS_LIMIT");
  assert.equal(result.analyticsReportedRequests,undefined);
});

test("bounded body and response-shape refusals precede interpretation",async()=>{
  const tooLarge=new Response("ignored",{
    status:200,headers:{"content-length":"600000"},
  });
  const declared=await observe(null,async()=>tooLarge).run();
  assert.equal(declared.code,"CLOUDFLARE_KV_ANALYTICS_UNAVAILABLE");
  const oversized=await observe(null,async()=>new Response("x".repeat(263000),{status:200})).run();
  assert.equal(oversized.code,"CLOUDFLARE_KV_ANALYTICS_UNAVAILABLE");
  const malformed=await observe(null,async()=>new Response("{not-json",{
    status:200,
  })).run();
  assert.equal(malformed.code,"CLOUDFLARE_KV_ANALYTICS_UNAVAILABLE");
});
