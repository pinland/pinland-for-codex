import test from 'node:test';
import assert from 'node:assert/strict';
import {codexUsageReport, AccountUsageSync, usageFailureCode} from './account-usage.mjs';

test('prefers the Codex bucket; preserves windows, resets, and zero', () => {
  const result = codexUsageReport({rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:1800000000},
    secondary:{usedPercent:25,windowDurationMins:10080,resetsAt:1800500000}}}}, 1700000000000);
  assert.equal(result.windows[0].usedPercent,0);
  assert.equal(result.windows[1].durationMinutes,10080);
  assert.equal(result.windows[0].resetsAt,1800000000);
  assert.equal(result.status,'available');
});

test('missing, null, malformed and token-only data never become zero usage', () => {
  for(const value of [null, {}, {rateLimits:{primary:null}}, {rateLimits:{primary:{usedPercent:'50'}}},
    {totalTokens:10000}, {rateLimits:{primary:{usedPercent:-1}}}]) {
    assert.equal(codexUsageReport(value).status,'unsupported');
    assert.deepEqual(codexUsageReport(value).windows,[]);
  }
});

test('an empty or malformed Codex bucket falls back to a populated legacy snapshot', () => {
  for (const codex of [{}, {primary:null}, {primary:{usedPercent:'20'}}]) {
    const report=codexUsageReport({rateLimitsByLimitId:{codex},rateLimits:{primary:{usedPercent:35}}});
    assert.equal(report.status,'available');
    assert.equal(report.windows[0].usedPercent,35);
  }
  assert.equal(codexUsageReport({rateLimitsByLimitId:{other:{primary:{usedPercent:5}}}}).status,'unsupported');
  const report=codexUsageReport({rateLimits:{primary:{usedPercent:35,windowDurationMins:525601}}});
  assert.equal(report.windows[0].durationMinutes,undefined);
});

test('transient failures retry after 5/10/20/30 seconds and recovery restores normal polling', async () => {
  let now=100000, reads=0, fail=true;
  const sync=new AccountUsageSync({now:()=>now});
  const client={request:async(method,params,timeout)=>{
    assert.equal(timeout,15000); reads++;
    if(fail) throw Error('request timed out');
    return {rateLimits:{primary:{usedPercent:40}}};
  }};
  const bridge=async()=>({status:204});
  for(const delay of [5000,10000,20000,30000]) {
    const previousReads=reads;
    const pending=sync.refresh(client,bridge,'test','epoch');
    sync.refresh(client,bridge,'test','epoch');
    await pending;
    assert.equal(reads,previousReads+1,'concurrent triggers share one request');
    now+=delay-1;
    await sync.refresh(client,bridge,'test','epoch');
    assert.equal(reads,previousReads+1,'backoff must not poll early');
    now++;
  }
  fail=false;
  await sync.refresh(client,bridge,'test','epoch');
  assert.equal(sync.failures,0);
  const recoveredReads=reads;
  now+=29999;
  await sync.refresh(client,bridge,'test','epoch');
  assert.equal(reads,recoveredReads);
  now++;
  await sync.refresh(client,bridge,'test','epoch');
  assert.equal(reads,recoveredReads+1);
});

test('an empty successful response retries promptly instead of waiting for the regular poll', async () => {
  let now=100000, reads=0;
  const sync=new AccountUsageSync({now:()=>now});
  const client={request:async()=>{reads++;return {}}};
  await sync.refresh(client,async()=>({status:204}),'test','epoch');
  now+=5000;
  await sync.refresh(client,async()=>({status:204}),'test','epoch');
  assert.equal(reads,2);
});

test('a replaced app-server refreshes immediately and late failures cannot overwrite recovery', async () => {
  const sync=new AccountUsageSync(); const reports=[];
  let rejectOld,resolveNew;
  const oldClient={request:()=>new Promise((resolve,reject)=>{rejectOld=reject})};
  const newClient={request:()=>new Promise(resolve=>{resolveNew=resolve})};
  const bridge=async(route,token,body)=>{reports.push(body);return {status:204}};
  const oldPending=sync.refresh(oldClient,bridge,'test','epoch');
  const newPending=sync.refresh(newClient,bridge,'test','epoch');
  rejectOld(Error('Codex app-server exited'));
  await oldPending;
  assert.equal(sync.pending,newPending,'old completion must not clear the current request');
  assert.equal(reports.length,0);
  resolveNew({rateLimits:{primary:{usedPercent:10}}});
  await newPending;
  assert.equal(reports.length,1);
  assert.equal(reports[0].status,'available');
});

test('bridge delivery failures do not manufacture account failures and retry promptly', async () => {
  let now=100000,reads=0;
  const sync=new AccountUsageSync({now:()=>now}); const reports=[];
  const client={request:async()=>{reads++;return {rateLimits:{primary:{usedPercent:10}}}}};
  for(const mode of ['throw','unavailable']) {
    const bridge=async(route,token,body)=>{
      reports.push(body);
      if(mode==='throw') throw Error('bridge offline');
      return {status:503};
    };
    await sync.refresh(client,bridge,'test',mode);
    assert.equal(reports.at(-1).status,'available');
    assert.equal(sync.nextAttemptAt,now+5000);
  }
  assert.equal(reads,2);
  assert.equal(reports.length,2,'a transport error must not post a second unavailable report');
});

test('background poll is throttled, isolated from pin sync, and refreshed on app restart', async () => {
  const sync = new AccountUsageSync(); let reads=0; const reports=[];
  const client={request:async method=>{assert.equal(method,'account/rateLimits/read');reads++;throw Error('offline')}};
  const bridge=async(route,token,body)=>{assert.equal(route,'/v1/usage');reports.push(body)};
  sync.refresh(client,bridge,'test','epoch1'); await sync.pending;
  sync.refresh(client,bridge,'test','epoch1'); assert.equal(reads,1);
  sync.refresh(client,bridge,'test','epoch2'); await sync.pending;
  assert.equal(reads,2); assert.equal(reports[0].status,'unavailable');
});

test('usage failure diagnostics are allowlisted and never copy account errors', () => {
  assert.equal(usageFailureCode({code:-32601}), 'api_unsupported');
  assert.equal(usageFailureCode(Error('request timed out')), 'read_timeout');
  assert.equal(usageFailureCode(Error('not logged in, token=private')), 'login_required');
  assert.equal(usageFailureCode(Error('secret account details')), 'read_failed');
});
