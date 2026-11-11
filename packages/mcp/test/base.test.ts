import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FeishuClient } from '@yisang0910/core';
import { registerBaseTools } from '../src/tools/base.js';

let server: McpServer;
let client: Client;
let chatsResponse: Response;
let botResponse: Response;

beforeEach(async () => {
  chatsResponse = Response.json({ code: 0, data: { items: [] } });
  botResponse = Response.json({ code: 0, bot: { open_id: 'bot_test', app_name: 'Test bot' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.includes('/tenant_access_token/')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    }
    if (input.includes('/bot/v3/info')) {
      return botResponse;
    }
    if (input.includes('/im/v1/chats')) return chatsResponse;
    throw new Error(`Unexpected request: ${input}`);
  }));
  const api = new FeishuClient({ appId: 'test-app', appSecret: 'test-secret', maxRetries: 0 });
  server = new McpServer({ name: 'test', version: '1.0.0' });
  registerBaseTools(server, { client: api, config: api.config, log: () => {} });
  client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  vi.unstubAllGlobals();
});

describe('feishu_whoami discovery', () => {
  it('distinguishes a failed chat lookup from an empty directory', async () => {
    chatsResponse = Response.json({ code: 99991672, msg: 'Access denied. scope im:chat:read is required' });
    const result = await client.callTool({ name: 'feishu_whoami' });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('Test bot');
    expect(JSON.stringify(result.content)).toContain('im:chat:read');
    expect(JSON.stringify(result.content)).not.toContain('还没进任何群');
    expect(result.structuredContent).toMatchObject({ chats: [], chats_error: expect.any(String) });
  });

  it('reports an empty directory only after a successful lookup', async () => {
    const result = await client.callTool({ name: 'feishu_whoami' });
    expect(JSON.stringify(result.content)).toContain('还没进任何群');
    expect(result.structuredContent).not.toHaveProperty('chats_error');
  });

  it('keeps successful directory results', async () => {
    chatsResponse = Response.json({ code: 0, data: { items: [{ chat_id: 'chat_test', name: 'Test group' }] } });
    const result = await client.callTool({ name: 'feishu_whoami' });
    expect(result.structuredContent).toMatchObject({ chats: [{ chat_id: 'chat_test', name: 'Test group' }] });
    expect(result.structuredContent).not.toHaveProperty('chats_error');
  });

  it('still fails when identity itself cannot be looked up', async () => {
    botResponse = Response.json({ code: 99991672, msg: 'Bot identity denied' });
    const result = await client.callTool({ name: 'feishu_whoami' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Bot identity denied');
  });

  it('advertises the identity tool through the real MCP tools/list endpoint', async () => {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'feishu_whoami')?.annotations?.readOnlyHint).toBe(true);
  });
});
