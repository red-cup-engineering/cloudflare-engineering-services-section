import assert from "node:assert/strict";
import test from "node:test";
import { derivePayPerCrawlExclusion } from "../scripts/derive-pay-per-crawl-exclusion.mjs";
import { receivePayPerCrawlExclusion } from "../scripts/receive-pay-per-crawl-exclusion.mjs";

const zoneId = "a".repeat(32), rulesetId = "b".repeat(32), ruleId = "c".repeat(32);
const origin = "https://market.561.group", zoneName = "561.group", token = "test-token-not-a-secret";
const catalog = { market: origin, offers: [{
  method: "GET", route: "/v1/astronomy/positions/{date}",
  url: origin + "/v1/astronomy/positions/{date}", listed: true,
}, {
  method: "GET", route: "/v1/weather/nws-metar/{station}",
  url: origin + "/v1/weather/nws-metar/{station}", listed: false,
}] };
const freePaths = ["/", "/mcp", "/.well-known/", "/openapi.json"];
const options = { origin, catalog, apiPrefix: "/v1/", freePaths, zoneId, zoneName, token };
const expected = derivePayPerCrawlExclusion(options).rule;
const other = { id: "d".repeat(32), ref: "unrelated_security_rule", action: "set_config",
  expression: "http.host eq \"example.com\"", enabled: true };

function fakeProvider({ current, mutate = true, wrongZone = false, missingPhase = false } = {}) {
  const calls = [], rules = [...(current ?? [])];
  const respond = result => Response.json({success:true,errors:[],messages:[],result});
  const fetchImpl = async (url, init) => {
    calls.push({url,method:init.method??"GET",auth:init.headers.authorization,body:init.body});
    assert.equal(init.headers.authorization, "Bearer " + token);
    if (url.endsWith("/zones/" + zoneId))
      return respond({id:zoneId,name:wrongZone?"unrelated.example":zoneName});
    if (url.endsWith("/rulesets/phases/http_config_settings/entrypoint")) {
      if (missingPhase) return Response.json({success:false,errors:[{code:10000,message:"missing"}]},{status:404});
      return respond({id:rulesetId,version:String(calls.length),phase:"http_config_settings",rules});
    }
    if (url.endsWith("/rulesets/" + rulesetId + "/rules") && init.method === "POST") {
      if (mutate) rules.push({ ...JSON.parse(init.body), id:ruleId });
      return respond({id:rulesetId,rules});
    }
    if (url.endsWith("/rulesets/" + rulesetId + "/rules/" + ruleId) && init.method === "PATCH") {
      if (mutate) rules.splice(rules.findIndex(row=>row.id===ruleId),1,{...JSON.parse(init.body),id:ruleId});
      return respond({id:rulesetId,rules});
    }
    throw Error("unexpected provider request " + url);
  };
  return {fetchImpl,calls,rules};
}

test("already installed house exception receives without mutations and without claiming crawler revenue", async()=>{
  const p=fakeProvider({current:[other,{...expected,id:ruleId}]});
  const result=await receivePayPerCrawlExclusion({...options,fetchImpl:p.fetchImpl});
  assert.equal(result.status,"received");
  assert.equal(result.ruleId,ruleId);
  assert.equal(result.ppcChargingEnabled,"unassayed");
  assert.equal(result.ppcPayoutReceived,false);
  assert.deepEqual(p.calls.map(x=>x.method),["GET","GET"]);
  assert.deepEqual(p.rules[0],other);
});

test("dry receiving reports missing rule; an explicitly authorized apply adds just one rule and reads back",async()=>{
  const p=fakeProvider({current:[other]});
  const dry=await receivePayPerCrawlExclusion({...options,fetchImpl:p.fetchImpl});
  assert.equal(dry.status,"change-required");
  assert.equal(p.calls.some(x=>x.method!=="GET"),false);
  const received=await receivePayPerCrawlExclusion({...options,apply:true,fetchImpl:p.fetchImpl});
  assert.equal(received.status,"received");
  assert.equal(received.ruleId,ruleId);
  assert.equal(p.calls.filter(x=>x.method==="POST").length,1);
  assert.equal(p.calls.filter(x=>x.method==="PUT").length,0);
  assert.deepEqual(p.rules.find(x=>x.ref===other.ref),other,"unrelated rules must be untouched");
});

test("owned rule drifts are patched one-by-one, never replaced by whole-ruleset PUT",async()=>{
  const p=fakeProvider({current:[other,{...expected,id:ruleId,expression:"false"}]});
  const result=await receivePayPerCrawlExclusion({...options,apply:true,fetchImpl:p.fetchImpl});
  assert.equal(result.status,"received");
  assert.equal(p.calls.filter(x=>x.method==="PATCH").length,1);
  assert.equal(p.calls.filter(x=>x.method==="POST").length,0);
  assert.equal(p.calls.filter(x=>x.method==="PUT").length,0);
  assert.deepEqual(p.rules[0],other);
  assert.equal(p.rules[1].expression,expected.expression);
});

test("provider claims without zone authority, existing phase, unique refs or verified readback refuse",async()=>{
  const p1=fakeProvider({wrongZone:true});
  await assert.rejects(receivePayPerCrawlExclusion({...options,apply:true,fetchImpl:p1.fetchImpl}),/zone identifier and zone name disagree/u);
  assert.equal(p1.calls.length,1);
  const p2=fakeProvider({missingPhase:true});
  await assert.rejects(receivePayPerCrawlExclusion({...options,apply:true,fetchImpl:p2.fetchImpl}),/HTTP 404/u);
  assert.equal(p2.calls.every(x=>x.method==="GET"),true);
  const p3=fakeProvider({current:[{...expected,id:ruleId},{...expected,id:"e".repeat(32)}]});
  await assert.rejects(receivePayPerCrawlExclusion({...options,apply:true,fetchImpl:p3.fetchImpl}),/duplicate/u);
  assert.equal(p3.calls.every(x=>x.method==="GET"),true);
  const p4=fakeProvider({mutate:false});
  await assert.rejects(receivePayPerCrawlExclusion({...options,apply:true,fetchImpl:p4.fetchImpl}),/readback/u);
});

test("unqualified site/zone identity refuses before any token-bearing provider request",async()=>{
  let calls=0;
  for(const bad of [
    {origin:"https://unrelated.example"},
    {zoneId:"not-a-cloudflare-zone"},
    {zoneName:"unrelated.example"},
    {token:""},
    {apply:"yes"},
  ]) {
    await assert.rejects(receivePayPerCrawlExclusion({...options,...bad,fetchImpl:async()=>{calls++;throw Error("must not fetch");}}));
  }
  assert.equal(calls,0);
});
