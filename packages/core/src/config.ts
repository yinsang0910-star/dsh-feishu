/**
 * 配置加载：环境变量优先，其次可选 JSON 文件。
 *
 * 刻意不把 secret 写进任何会被提交的文件——MCP 客户端用 env 传。
 */

import fs from 'node:fs';
import path from 'node:path';
import { FeishuClient } from './client.js';
import type { FeishuConfig, ReceiveIdType } from './types.js';

const RECEIVE_ID_TYPES: ReceiveIdType[] = ['chat_id', 'open_id', 'email', 'user_id', 'union_id'];

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath?: string,
): FeishuConfig {
  let fileConf: Partial<FeishuConfig> = {};
  const explicit = configPath ?? firstEnv(env, ['FEISHU_CONFIG']);
  if (explicit) {
    const abs = path.resolve(explicit);
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
    fileConf = {
      appId: typeof raw['appId'] === 'string' ? raw['appId'] : undefined,
      appSecret: typeof raw['appSecret'] === 'string' ? raw['appSecret'] : undefined,
      domain: typeof raw['domain'] === 'string' ? raw['domain'] : undefined,
      defaultChatId: typeof raw['defaultChatId'] === 'string' ? raw['defaultChatId'] : undefined,
      defaultReceiveIdType:
        typeof raw['defaultReceiveIdType'] === 'string'
          ? (raw['defaultReceiveIdType'] as ReceiveIdType)
          : undefined,
      requestTimeoutMs:
        typeof raw['requestTimeoutMs'] === 'number' ? raw['requestTimeoutMs'] : undefined,
      maxRetries: typeof raw['maxRetries'] === 'number' ? raw['maxRetries'] : undefined,
    };
  }

  const appId = firstEnv(env, ['FEISHU_APP_ID', 'LARK_APP_ID']) ?? fileConf.appId ?? '';
  const appSecret =
    firstEnv(env, ['FEISHU_APP_SECRET', 'LARK_APP_SECRET']) ?? fileConf.appSecret ?? '';
  if (!appId) {
    throw new Error(
      '缺少 FEISHU_APP_ID。请设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（或 LARK_* 前缀）。',
    );
  }
  if (!appSecret) {
    throw new Error('缺少 FEISHU_APP_SECRET。请设置环境变量 FEISHU_APP_SECRET。');
  }

  const domainRaw =
    firstEnv(env, ['FEISHU_DOMAIN', 'LARK_DOMAIN']) ??
    fileConf.domain ??
    'https://open.feishu.cn';
  // 在这里统一裁尾斜杠：gateway 会把 config.domain 直接交给飞书 SDK，
  // 少裁一次就会拼出 `https://open.feishu.cn//open-apis/...`。
  const domain = domainRaw.replace(/\/+$/, '');
  const defaultChatId =
    firstEnv(env, ['FEISHU_DEFAULT_CHAT_ID', 'LARK_DEFAULT_CHAT_ID']) ?? fileConf.defaultChatId;

  const rawType = firstEnv(env, ['FEISHU_DEFAULT_RECEIVE_ID_TYPE']) ?? fileConf.defaultReceiveIdType;
  const defaultReceiveIdType: ReceiveIdType =
    rawType && (RECEIVE_ID_TYPES as string[]).includes(rawType)
      ? (rawType as ReceiveIdType)
      : 'chat_id';

  return {
    appId,
    appSecret,
    domain,
    ...(defaultChatId ? { defaultChatId } : {}),
    defaultReceiveIdType,
    requestTimeoutMs: fileConf.requestTimeoutMs ?? 30_000,
    maxRetries: fileConf.maxRetries ?? 2,
  };
}

export function createClient(env: NodeJS.ProcessEnv = process.env, configPath?: string): FeishuClient {
  return new FeishuClient(loadConfig(env, configPath));
}
