// Pins the real path of `messages draft --file` (#507): the files go up
// privately before the draft is created, and the output carries their ids. The
// dry-run and bad-path refusals are covered by dry-run.test.ts; the upload and
// cleanup order by src/lib/draft-files.test.ts.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authLib from '../lib/auth.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createMessagesCommand } from './messages.ts';

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

const STANDARD: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  auth_type: 'standard',
  token: 'xoxb-fake',
  token_type: 'bot',
};

let stdout: string;
let stderr: string;
let calls: Array<{ method: string; args: unknown[] }>;
let dir: string;

function fakeClient(config: WorkspaceConfig): SlackClient {
  const client = new SlackClient(config);
  spyOn(client, 'request').mockImplementation(async (method) => {
    throw new Error(`unexpected request ${method}`);
  });
  spyOn(client, 'uploadFilesExternal').mockImplementation(async (...args: unknown[]) => {
    calls.push({ method: 'uploadFilesExternal', args });
    return { ok: true, files: (args[1] as string[]).map((_, i) => ({ id: `F${i + 1}` })) } as any;
  });
  spyOn(client, 'createDraft').mockImplementation(async (...args: unknown[]) => {
    calls.push({ method: 'createDraft', args });
    return { ok: true, draft: { id: 'Dr0123456789' } } as any;
  });
  return client;
}

async function draft(argv: string[], config: WorkspaceConfig = BROWSER): Promise<void> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(fakeClient(config));
  await createMessagesCommand().parseAsync(['draft', ...argv], { from: 'user' });
}

describe('messages draft --file', () => {
  let savedExitCode: typeof process.exitCode;
  let a: string;
  let b: string;

  beforeEach(async () => {
    stdout = '';
    stderr = '';
    calls = [];
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    dir = await mkdtemp(join(tmpdir(), 'slackcli-draft-file-'));
    a = join(dir, 'a.png');
    b = join(dir, 'b.png');
    await Bun.write(a, 'alpha');
    await Bun.write(b, 'bravo');
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(async () => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads the files privately, creates the draft with their ids and emits file_ids', async () => {
    await draft(['--recipient-id', 'C0123456789', '--message', 'Charts', '--file', a, '--file', b, '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toStrictEqual([
      { method: 'uploadFilesExternal', args: [undefined, [a, b]] },
      { method: 'createDraft', args: ['C0123456789', 'Charts', { thread_ts: undefined, file_ids: ['F1', 'F2'] }] },
    ]);
    expect(JSON.parse(stdout)).toStrictEqual({
      channel_id: 'C0123456789',
      draft_id: 'Dr0123456789',
      file_ids: ['F1', 'F2'],
    });
  });

  it('prints the draft id and the attached file count as text', async () => {
    await draft(['--recipient-id', 'C0123456789', '--message', 'Chart', '--file', a]);

    expect(process.exitCode).toBe(0);
    expect(stdout).toContain('Draft ID: Dr0123456789');
    expect(stdout).toContain('1 file attached');
  });

  it('keeps a text-only draft unchanged: no upload and no file_ids in the output', async () => {
    await draft(['--recipient-id', 'C0123456789', '--message', 'Notes', '--json']);

    expect(calls.map((c) => c.method)).toStrictEqual(['createDraft']);
    expect(JSON.parse(stdout)).toStrictEqual({ channel_id: 'C0123456789', draft_id: 'Dr0123456789' });
  });

  it('refuses an app token before uploading anything', async () => {
    await draft(['--recipient-id', 'C0123456789', '--message', 'Chart', '--file', a, '--json'], STANDARD);

    expect(process.exitCode).toBe(1);
    expect(calls).toStrictEqual([]);
  });

  it('refuses the same file twice before any Slack call', async () => {
    await draft(['--recipient-id', 'C0123456789', '--message', 'Chart', '--file', a, '--file', a, '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toStrictEqual([]);
    expect(stderr).toContain('File given more than once');
  });
});
