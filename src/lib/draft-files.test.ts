import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDraftFiles, createDraftWithFiles, DRAFT_FILE_LIMIT } from './draft-files.ts';
import { InvalidInputError } from './cli-errors.ts';
import { SlackClient } from './slack-client.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slackcli-draft-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, body = 'x'): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, body);
  return path;
}

describe('checkDraftFiles', () => {
  it('returns each path with its name and size, in order', async () => {
    const a = await file('a.png', 'alpha');
    const b = await file('b.png', 'bo');
    expect(await checkDraftFiles([a, b])).toEqual([
      { path: a, filename: 'a.png', size: 5 },
      { path: b, filename: 'b.png', size: 2 },
    ]);
  });

  it(`accepts ${DRAFT_FILE_LIMIT} files and refuses one more`, async () => {
    const paths = await Promise.all(Array.from({ length: DRAFT_FILE_LIMIT + 1 }, (_, i) => file(`f${i}.txt`)));
    expect(await checkDraftFiles(paths.slice(0, DRAFT_FILE_LIMIT))).toHaveLength(DRAFT_FILE_LIMIT);
    await expect(checkDraftFiles(paths)).rejects.toThrow(InvalidInputError);
    await expect(checkDraftFiles(paths)).rejects.toThrow(`at most ${DRAFT_FILE_LIMIT} files`);
  });

  it('refuses the same file given twice, also through a different spelling of its path', async () => {
    const a = await file('a.png');
    await expect(checkDraftFiles([a, a])).rejects.toThrow('File given more than once');
    await expect(checkDraftFiles([a, join(dir, '.', 'a.png')])).rejects.toThrow('File given more than once');
  });

  it('refuses a missing, empty or non-regular path', async () => {
    const a = await file('a.png');
    const empty = await file('empty.png', '');
    const folder = join(dir, 'folder');
    await mkdir(folder);
    await expect(checkDraftFiles([a, join(dir, 'nope.png')])).rejects.toThrow('File not found');
    await expect(checkDraftFiles([empty])).rejects.toThrow('Cannot upload empty file');
    await expect(checkDraftFiles([folder])).rejects.toThrow('Cannot upload non-file path');
  });
});

// A client that records the calls createDraftWithFiles makes, without Slack.
function fakeClient(options: { draftFails?: boolean; deleteFails?: string[]; confirmed?: number } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    async uploadFilesExternal(...args: unknown[]) {
      calls.push({ method: 'uploadFilesExternal', args });
      const paths = args[1] as string[];
      const ids = paths.map((_, i) => ({ id: `F${i + 1}` })).slice(0, options.confirmed ?? paths.length);
      return { ok: true, files: ids };
    },
    async createDraft(...args: unknown[]) {
      calls.push({ method: 'createDraft', args });
      if (options.draftFails) throw new Error('Slack API error: channel_not_found');
      return { ok: true, draft: { id: 'Dr123' } };
    },
    async deleteFile(id: string) {
      calls.push({ method: 'deleteFile', args: [id] });
      if (options.deleteFails?.includes(id)) throw new Error('file_not_found');
    },
  } as unknown as SlackClient;
  return { client, calls };
}

describe('createDraftWithFiles', () => {
  it('uploads privately first, then creates the draft carrying the file ids', async () => {
    const files = await checkDraftFiles([await file('a.png'), await file('b.png')]);
    const { client, calls } = fakeClient();

    const result = await createDraftWithFiles(client, 'D1', 'see charts', { thread_ts: '1.2', files });

    expect(result).toEqual({ draftId: 'Dr123', fileIds: ['F1', 'F2'] });
    expect(calls).toEqual([
      { method: 'uploadFilesExternal', args: [undefined, [files[0].path, files[1].path]] },
      { method: 'createDraft', args: ['D1', 'see charts', { thread_ts: '1.2', file_ids: ['F1', 'F2'] }] },
    ]);
  });

  it('deletes the uploads and rethrows when the draft cannot be created', async () => {
    const files = await checkDraftFiles([await file('a.png'), await file('b.png')]);
    const { client, calls } = fakeClient({ draftFails: true });

    await expect(createDraftWithFiles(client, 'D1', 'hi', { files })).rejects.toThrow('channel_not_found');
    expect(calls.filter((c) => c.method === 'deleteFile').map((c) => c.args[0])).toEqual(['F1', 'F2']);
  });

  it('names the uploads it could not delete in the error', async () => {
    const files = await checkDraftFiles([await file('a.png'), await file('b.png')]);
    const { client } = fakeClient({ draftFails: true, deleteFails: ['F2'] });

    await expect(createDraftWithFiles(client, 'D1', 'hi', { files })).rejects.toThrow(
      'uploaded files not removed: F2',
    );
  });

  it('creates no draft and removes the uploads when Slack confirms fewer files than were sent', async () => {
    const files = await checkDraftFiles([await file('a.png'), await file('b.png')]);
    const { client, calls } = fakeClient({ confirmed: 1 });

    await expect(createDraftWithFiles(client, 'D1', 'hi', { files })).rejects.toThrow('1 of 2');
    expect(calls.map((c) => c.method)).toEqual(['uploadFilesExternal', 'deleteFile']);
  });
});
