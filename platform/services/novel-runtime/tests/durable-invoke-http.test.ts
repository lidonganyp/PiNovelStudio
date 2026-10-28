/** A dropped API socket cannot rerun accepted model work; completed replies survive router restart. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInvokeRouter } from '../src/routes/v1/invoke.js';
import { makeConfigForTest } from '../src/config.js';
import type { LoadedTools } from '../src/extension-loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { UsageReconciliationRequired } from '../src/metering-binder.js';

test('disconnect, duplicate request, and restart return one durable result from one invocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durable-http-'));
  let invoked = 0; let aborted = false; let finish!: () => void; let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const completion = new Promise<void>(resolve => { finish = resolve; });
  const tool = { name: 'novel_generate_chapter', invoke: async () => {} };
  const loaded = { byName: new Map([[tool.name, tool]]), filterResult: { allowed: [tool] }, distPath: '<fixture>' } as unknown as LoadedTools;
  const deps = {
    config: makeConfigForTest({ tempWorkspaceRoot: join(root, 'jobs') }),
    billingClient: { finalize: async () => { throw new Error('deliverable result must not refund'); } },
    workspaceManager: { deriveWorkspaceId: () => 'p1', materializeWorkspace: () => ({ tempProjectRoot: join(root, 'job'), workspacePath: join(root, 'job/workspaces/p1') }), cleanupWorkspace: () => {} },
    meteringBinder: { invokeWithMetering: async (_tool: unknown, _input: unknown, _ctx: unknown, signal: AbortSignal) => {
      invoked++; signal.addEventListener('abort', () => { aborted = true; }); started(); await completion;
      return { result: { status: 'ok', text: 'transport-placeholder' }, metering: { modelCallCount: 1, inputTokens: 2, outputTokens: 1, totalSettledAmountFen: 1, settleErrors: [] } };
    } },
  };
  const create = async (): Promise<http.Server> => {
    const app = express(); app.use(express.json());
    app.use((_req, res, next) => { res.locals.taskToken = { payload: { jobId: 'job-1', userId: '1', projectId: '1' } }; next(); });
    app.use('/v1', createInvokeRouter(loaded, deps as never));
    const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return server;
  };
  let server = await create();
  const address = (): string => `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/invoke`;
  const input = JSON.stringify({ tool: tool.name, input: { chapterId: '1', chapterNumber: 1 } });
  const post = (): Promise<Response> => fetch(address(), { method: 'POST', headers: { 'content-type':'application/json', 'x-novel-durable-invoke':'1' }, body: input });
  const close = (): Promise<void> => new Promise((resolve,reject) => { server.close(e=>e?reject(e):resolve()); server.closeAllConnections(); });
  try {
    const req = http.request(address(), { method:'POST', headers:{ 'content-type':'application/json', 'x-novel-durable-invoke':'1' } }); req.on('error',()=>{}); req.end(input);
    await running; req.destroy();
    const duplicate = await post(); assert.equal(duplicate.status,409); assert.equal((await duplicate.json()).code,'INVOCATION_RUNNING');
    assert.equal(aborted,false); assert.equal(invoked,1); finish();
    let result: Record<string,unknown> | undefined;
    for(let i=0;i<20;i++){ const response=await post(); if(response.status===200){result=await response.json() as Record<string,unknown>;break;} await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.deepEqual(result?.result,{status:'ok',text:'transport-placeholder'});
    await close(); server=await create();
    const replay=await post(); assert.equal(replay.status,200); assert.deepEqual(await replay.json(),result); assert.equal(invoked,1);
  } finally { finish(); await close(); rmSync(root,{recursive:true,force:true}); }
});

test('an accounting exception is refunded and its terminal failure receipt survives duplicate polling', async () => {
  const root=mkdtempSync(join(tmpdir(),'durable-error-'));let invoked=0;let finalized=0;
  const tool={name:'novel_generate_chapter',invoke:async()=>{}};
  const loaded={byName:new Map([[tool.name,tool]]),filterResult:{allowed:[tool]},distPath:'<fixture>'} as unknown as LoadedTools;
  const deps={config:makeConfigForTest({tempWorkspaceRoot:join(root,'jobs')}),
    billingClient:{finalize:async()=>{finalized++;return {status:'released'};}},
    workspaceManager:{deriveWorkspaceId:()=>'p1',materializeWorkspace:()=>({tempProjectRoot:join(root,'job')}),cleanupWorkspace:()=>{}},
    meteringBinder:{invokeWithMetering:async()=>{invoked++;throw new UsageReconciliationRequired();}}};
  const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.taskToken={payload:{jobId:'failed-1',userId:'1',projectId:'1'}};next();});
  app.use('/v1',createInvokeRouter(loaded,deps as never));app.use(errorHandler);
  const server=http.createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const post=()=>fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/invoke`,{method:'POST',headers:{'content-type':'application/json','x-novel-durable-invoke':'1'},body:JSON.stringify({tool:tool.name,input:{chapterId:'1',chapterNumber:1}})});
    const first=await post();assert.equal(first.status,422);const body=await first.json();
    assert.equal(body.failureEnvelope.code,'generation_usage_unknown');assert.equal(body.failureEnvelope.recoverable,true);
    const replay=await post();assert.equal(replay.status,422);assert.deepEqual(await replay.json(),body);
    assert.equal(invoked,1);assert.equal(finalized,1);
  }finally{await new Promise<void>((resolve,reject)=>{server.close(err=>err?reject(err):resolve());server.closeAllConnections();});rmSync(root,{recursive:true,force:true});}
});
