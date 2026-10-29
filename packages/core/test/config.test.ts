/**
 * 配置加载单测。
 *
 * 重点不是 happy path，而是优先级与兜底：
 *   env > FEISHU_CONFIG 文件 > 默认值；
 *   非法 receiveIdType 必须静默回退 chat_id（否则发消息会 400）；
 *   缺 appId / appSecret 必须立刻抛错，而不是带着空凭据去请求飞书。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, loadConfig } from '../src/config.js';

let tmpDir = '';

function writeConf(name: string, data: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
  return p;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feishu-cfg-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig · 必填项与报错', () => {
  it('两个都没有时先报 FEISHU_APP_ID', () => {
    expect(() => loadConfig({})).toThrow(/FEISHU_APP_ID/);
  });

  it('有 appId 缺 appSecret 时报 FEISHU_APP_SECRET', () => {
    expect(() => loadConfig({ FEISHU_APP_ID: 'cli_x' })).toThrow(/FEISHU_APP_SECRET/);
  });

  it('纯空白的 env 视为未设置（不会把空格当凭据）', () => {
    expect(() => loadConfig({ FEISHU_APP_ID: '   ', FEISHU_APP_SECRET: '  ' })).toThrow(
      /FEISHU_APP_ID/,
    );
  });

  it('值两边的空白会被 trim', () => {
    const cfg = loadConfig({ FEISHU_APP_ID: '  cli_a  ', FEISHU_APP_SECRET: ' sec ' });
    expect(cfg.appId).toBe('cli_a');
    expect(cfg.appSecret).toBe('sec');
  });
});

describe('loadConfig · 默认值', () => {
  it('domain 默认飞书，超时 30s，重试 2 次，receiveIdType 默认 chat_id', () => {
    const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b' });
    expect(cfg.domain).toBe('https://open.feishu.cn');
    expect(cfg.requestTimeoutMs).toBe(30_000);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.defaultReceiveIdType).toBe('chat_id');
  });

  it('没配默认会话时 defaultChatId 这个键根本不出现（而不是空字符串）', () => {
    const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b' });
    expect('defaultChatId' in cfg).toBe(false);
  });
});

describe('loadConfig · env 优先级', () => {
  it('env 覆盖文件，未覆盖的字段仍然取自文件', () => {
    const p = writeConf('prio.json', {
      appId: 'file_id',
      appSecret: 'file_secret',
      domain: 'https://file.example',
      defaultChatId: 'oc_file',
    });
    const cfg = loadConfig({ FEISHU_APP_ID: 'env_id' }, p);
    expect(cfg.appId).toBe('env_id');
    expect(cfg.appSecret).toBe('file_secret');
    expect(cfg.domain).toBe('https://file.example');
    expect(cfg.defaultChatId).toBe('oc_file');
  });

  it('LARK_* 是 FEISHU_* 的次选前缀', () => {
    const cfg = loadConfig({ LARK_APP_ID: 'lark_id', LARK_APP_SECRET: 'lark_secret' });
    expect(cfg.appId).toBe('lark_id');
    expect(cfg.appSecret).toBe('lark_secret');
  });

  it('FEISHU_ 前缀优先于 LARK_ 前缀', () => {
    const cfg = loadConfig({
      FEISHU_APP_ID: 'feishu_id',
      LARK_APP_ID: 'lark_id',
      FEISHU_APP_SECRET: 's',
    });
    expect(cfg.appId).toBe('feishu_id');
  });

  it('只靠 FEISHU_CONFIG 指向文件也能加载', () => {
    const p = writeConf('via-env.json', { appId: 'cfg_id', appSecret: 'cfg_secret' });
    const cfg = loadConfig({ FEISHU_CONFIG: p });
    expect(cfg.appId).toBe('cfg_id');
  });

  it('显式传入的 configPath 覆盖 FEISHU_CONFIG', () => {
    const a = writeConf('a.json', { appId: 'from_a', appSecret: 's' });
    const b = writeConf('b.json', { appId: 'from_b', appSecret: 's' });
    expect(loadConfig({ FEISHU_CONFIG: a }, b).appId).toBe('from_b');
  });

  it('文件里的非字符串字段被忽略（防止 JSON 写错类型）', () => {
    const p = writeConf('bad-type.json', { appId: 123, appSecret: true });
    expect(() => loadConfig({}, p)).toThrow(/FEISHU_APP_ID/);
  });

  it('配置文件不存在时抛出（不静默降级）', () => {
    expect(() => loadConfig({}, path.join(tmpDir, 'nope.json'))).toThrow();
  });

  it('配置文件不是合法 JSON 时抛出', () => {
    const p = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(p, '{ not json', 'utf8');
    expect(() => loadConfig({}, p)).toThrow();
  });

  it('文件里的 requestTimeoutMs / maxRetries 生效', () => {
    const p = writeConf('timeout.json', { appId: 'a', appSecret: 'b', requestTimeoutMs: 5000, maxRetries: 0 });
    const cfg = loadConfig({}, p);
    expect(cfg.requestTimeoutMs).toBe(5000);
    expect(cfg.maxRetries).toBe(0);
  });
});

describe('loadConfig · domain 尾斜杠', () => {
  it('loadConfig 也裁掉 domain 尾斜杠（gateway 会把 config.domain 直接交给飞书 SDK）', () => {
    const cfg = loadConfig({
      FEISHU_APP_ID: 'a',
      FEISHU_APP_SECRET: 'b',
      FEISHU_DOMAIN: 'https://open.larksuite.com///',
    });
    expect(cfg.domain).toBe('https://open.larksuite.com');
  });

  it('createClient 产出的客户端会把 domain 的尾斜杠去掉（拼 URL 不会出现 //open-apis）', () => {
    const client = createClient({
      FEISHU_APP_ID: 'a',
      FEISHU_APP_SECRET: 'b',
      FEISHU_DOMAIN: 'https://open.larksuite.com///',
    });
    expect(client.config.domain).toBe('https://open.larksuite.com');
  });

  it('domain 也可以用 LARK_DOMAIN 指定', () => {
    const cfg = loadConfig({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', LARK_DOMAIN: 'https://open.larksuite.com' });
    expect(cfg.domain).toBe('https://open.larksuite.com');
  });
});

describe('loadConfig · defaultReceiveIdType 回退', () => {
  it('合法值保留', () => {
    for (const t of ['chat_id', 'open_id', 'email', 'user_id', 'union_id']) {
      const cfg = loadConfig({
        FEISHU_APP_ID: 'a',
        FEISHU_APP_SECRET: 'b',
        FEISHU_DEFAULT_RECEIVE_ID_TYPE: t,
      });
      expect(cfg.defaultReceiveIdType).toBe(t);
    }
  });

  it('非法值静默回退 chat_id', () => {
    const cfg = loadConfig({
      FEISHU_APP_ID: 'a',
      FEISHU_APP_SECRET: 'b',
      FEISHU_DEFAULT_RECEIVE_ID_TYPE: 'group_id',
    });
    expect(cfg.defaultReceiveIdType).toBe('chat_id');
  });

  it('大小写不匹配也算非法（不做小写归一）', () => {
    const cfg = loadConfig({
      FEISHU_APP_ID: 'a',
      FEISHU_APP_SECRET: 'b',
      FEISHU_DEFAULT_RECEIVE_ID_TYPE: 'CHAT_ID',
    });
    expect(cfg.defaultReceiveIdType).toBe('chat_id');
  });

  it('文件里写了非法值同样回退', () => {
    const p = writeConf('bad-type-id.json', { appId: 'a', appSecret: 'b', defaultReceiveIdType: 'nope' });
    expect(loadConfig({}, p).defaultReceiveIdType).toBe('chat_id');
  });

  it('env 优先于文件里的合法值', () => {
    const p = writeConf('type-prio.json', { appId: 'a', appSecret: 'b', defaultReceiveIdType: 'open_id' });
    const cfg = loadConfig({ FEISHU_DEFAULT_RECEIVE_ID_TYPE: 'email' }, p);
    expect(cfg.defaultReceiveIdType).toBe('email');
  });
});
