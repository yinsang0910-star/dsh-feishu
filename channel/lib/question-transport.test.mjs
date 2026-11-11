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
  let ready;
  const listening = new Promise((resolve) => { ready = resolve; });
  const agent = {
    session: {id: 'bound-session'}, status: 'idle',
    inbox: {nextTurn: [], nextStep: [], hasPending: () => false},
    followup() {},
  };
  apply({
    agents: {get: () => agent}, agentPresets: {},
    on(event, handler) { handlers.set(event, handler); },
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
});
