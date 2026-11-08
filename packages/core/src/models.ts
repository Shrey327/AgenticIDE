import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { endpoint, hash } from './security';
import { Connection } from './types';

const schema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  kind: z.enum(['model', 'qdrant', 'prometheus', 'grafana', 'wandb', 'otlp']),
  url: z.string(),
  model: z.string().max(200).optional(),
  inputPrice: z.number().nonnegative().optional(),
  outputPrice: z.number().nonnegative().optional(),
});

export interface Vault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}
export class SystemVault implements Vault {
  async get(key: string) {
    const { Entry } = require('@napi-rs/keyring');
    return (
      new Entry('aiide', key, {
        linux: { store: 'secret-service' },
      }).getPassword() || undefined
    );
  }
  async set(key: string, value: string) {
    const { Entry } = require('@napi-rs/keyring');
    new Entry('aiide', key, { linux: { store: 'secret-service' } }).setPassword(
      value,
    );
  }
}

export class Connections {
  private file: string;
  constructor(
    readonly directory: string,
    readonly vault: Vault = new SystemVault(),
  ) {
    this.file = path.join(directory, 'connections.json');
  }
  list(): Connection[] {
    return fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : [];
  }
  get(id: string): Connection {
    const connection = this.list().find((c) => c.id === id);
    if (!connection) throw new Error('Connection not found');
    return connection;
  }
  async save(input: unknown, secret?: string) {
    const connection: Connection = schema.parse(input);
    endpoint(connection.url);
    const previous = this.list().find((c) => c.id === connection.id);
    // Credentials are scoped to both workspace and origin; changing URL never reuses a secret.
    const key = hash(`${this.directory}:${connection.id}:${connection.url}`);
    if (secret) {
      await this.vault.set(key, secret);
      connection.credentialRef = key;
    } else if (previous?.url === connection.url)
      connection.credentialRef = previous.credentialRef;
    this.write(connection);
    return connection;
  }
  remove(id: string) {
    const all = this.list().filter((c) => c.id !== id);
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(all, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  write(connection: Connection) {
    const all = this.list().filter((c) => c.id !== connection.id);
    all.push(connection);
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(all, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  async request(
    id: string,
    resource: string,
    body?: unknown,
    signal?: AbortSignal,
    method?: string,
  ): Promise<Response> {
    const connection = this.get(id);
    endpoint(connection.url);
    if (!resource.startsWith('/') || resource.includes('..'))
      throw new Error('Invalid resource');
    const secret = connection.credentialRef
      ? await this.vault.get(connection.credentialRef)
      : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (secret)
      headers[connection.kind === 'qdrant' ? 'api-key' : 'Authorization'] =
        connection.kind === 'qdrant' ? secret : `Bearer ${secret}`;
    const response = await fetch(connection.url.replace(/\/$/, '') + resource, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        `${connection.kind} endpoint returned HTTP ${response.status}`,
      );
    return response;
  }
  async probe(id: string) {
    const c = this.get(id);
    if (c.kind !== 'model' || !c.model)
      throw new Error('Select a model before testing capabilities');
    const capabilities = {
      chat: false,
      streaming: false,
      tools: false,
      embeddings: false,
    };
    const errors: Record<string, string> = {};
    for (const capability of Object.keys(
      capabilities,
    ) as (keyof typeof capabilities)[]) {
      try {
        if (capability === 'embeddings') {
          const result = await this.embed(id, ['capability test']);
          capabilities.embeddings = result[0]?.length > 0;
          continue;
        }
        const body: any = {
          model: c.model,
          messages: [
            {
              role: 'user',
              content:
                capability === 'tools'
                  ? 'Call the ping tool with value ok.'
                  : 'Reply with OK.',
            },
          ],
          max_tokens: 64,
        };
        if (capability === 'tools') {
          body.tools = [
            {
              type: 'function',
              function: {
                name: 'ping',
                description: 'Test connectivity',
                parameters: {
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                },
              },
            },
          ];
          body.tool_choice = { type: 'function', function: { name: 'ping' } };
        }
        if (capability === 'streaming') body.stream = true;
        const response = await this.request(id, '/chat/completions', body);
        if (capability === 'streaming') {
          if (
            !response.headers.get('content-type')?.includes('text/event-stream')
          )
            throw new Error('Endpoint did not return an event stream');
          for await (const delta of readSse(response))
            if (delta.choices?.[0]?.delta?.content)
              capabilities.streaming = true;
        } else {
          const result: any = await response.json();
          capabilities[capability] =
            capability === 'tools'
              ? result.choices?.[0]?.message?.tool_calls?.[0]?.function
                  ?.name === 'ping'
              : typeof result.choices?.[0]?.message?.content === 'string';
        }
      } catch (error) {
        errors[capability] = String(error);
      }
    }
    this.write({ ...c, capabilities });
    return { capabilities, errors };
  }
  async embed(id: string, input: string[]): Promise<number[][]> {
    const c = this.get(id),
      response = await this.request(id, '/embeddings', {
        model: c.model,
        input,
      });
    const body: any = await response.json();
    const vectors = body.data
      ?.sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding);
    if (
      !Array.isArray(vectors) ||
      vectors.length !== input.length ||
      vectors.some(
        (v) =>
          !Array.isArray(v) ||
          !v.length ||
          v.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x)),
      )
    )
      throw new Error('Invalid embedding response');
    return vectors;
  }
}

export async function* readSse(response: Response): AsyncGenerator<any> {
  if (!response.body) throw new Error('Missing stream');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1024 * 1024)
        throw new Error('Model stream event too large');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        if (payload) yield JSON.parse(payload);
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
