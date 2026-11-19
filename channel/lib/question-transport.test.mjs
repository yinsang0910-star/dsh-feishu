import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guardFeishuQuestion} from './index.js';
test('web questions still delegate to the original answerer', () => {
  for (const request of [{}, {agent:{session:{id:'web'}}}]) {
    assert.equal(guardFeishuQuestion(request, () => 'original answer', () => false), 'original answer');
  }
});
test('Feishu question and approval cannot wait on browser UI or invent consent', () => {
  for (const intent of [undefined, {kind:'approval'}, {kind:'plan-review'}]) {
    assert.throws(() => guardFeishuQuestion({agent:{session:{id:'feishu'}},questions:[{intent}]},
      () => assert.fail('must not forward to browser'), () => true), /No user answer or approval was given/);
  }
});

test('registered question handler guards the actual bound agent after HTTP ingest', async (t) => {
  const {apply} = await import('./index.js');
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createServer} = await import('node:net');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const stateDir = await mkdtemp(join(tmpdir(), 'feishu-question-'));
  const handlers = new Map();
  const cleanup = [];
  let viewReady;
  let ready;
  const listening = new Promise((resolve) => { ready = resolve; });
  let composed = false;
  let mounts = 0;
  let resumes = 0;
  const agent = {
    session: {id: 'bound-session'}, status: 'idle',
    ctx: {}, options: {model: 'test-model'},
    inbox: {nextTurn: [], nextStep: [], hasPending: () => false},
    followup() {},
  };
  apply({
    agents: {
      get: () => undefined,
      resume: async ({resumeSessionId}) => {
        assert.equal(resumeSessionId, 'bound-session');
        resumes += 1;
        return {agent};
      },
    },
    agentPresets: {
      composedPreset: (ctx) => { assert.equal(ctx, agent.ctx); return composed; },
      mount: async (ctx, preset) => {
        assert.equal(ctx, agent.ctx);
        assert.equal(preset, 'standard');
        composed = true;
        mounts += 1;
      },
    },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { if (event === 'feishu/view') viewReady?.(payload.view); },
    effect(fn) { cleanup.push(fn()); },
    logger: {info: ready, warn() {}},
  }, {host: '127.0.0.1', port, stateDir});
  t.after(async () => {
    for (const dispose of cleanup) dispose();
    await rm(stateDir, {recursive: true, force: true});
  });
  await listening;
  const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({chatId: 'test-chat', msgId: 'test-message', openId: 'test-user', text: 'hello', resumeSessionId: 'bound-session'}),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);

  const handler = handlers.get('user-questions/request');
  assert.throws(() => handler({agent}, () => assert.fail('must not wait on web UI')), /normal assistant text reply/);
  // Session ids alone must not hijack a different live agent's question.
  assert.equal(handler({agent: {session: {id: 'bound-session'}}}, () => 'web'), 'web');
  await t.test('blocked turns publish a failure view and a new turn clears it', async () => {
    const pushed = new Promise((resolve) => { viewReady = resolve; });
    handlers.get('session/event')(agent.session, {
      type: 'turn/end', data: {reason: {kind: 'blocked'}},
    });
    assert.match(JSON.stringify((await pushed).card), /执行在进入模型步骤前被阻止/);
    const readView = async () => (await (await fetch(`http://127.0.0.1:${port}/control`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({type: 'view', key: 'lark:default:test-chat'}),
    })).json()).view;
    assert.match((await readView()).error, /可能会话已归档或前置检查未通过/);
    agent.status = 'running';
    handlers.get('agent/status')({agent, status: 'running'});
    assert.equal((await readView()).error, null);
  });
  await t.test('legacy resume mounts missing preset once and preserves mounted presets', async () => {
    assert.equal(resumes, 1);
    assert.equal(mounts, 1);
    agent.status = 'idle';
    const again = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({chatId: 'test-chat', rootId: 'new-root', msgId: 'second-message',
        openId: 'test-user', text: 'hello again', resumeSessionId: 'bound-session'}),
    });
    assert.equal((await again.json()).ok, true);
    assert.equal(resumes, 2);
    assert.equal(mounts, 1);
  });
});
