// File attachments on `messages draft --file` (#507). The files are uploaded
// privately (no channel), so nobody sees them until a human sends the draft
// from Slack, and their ids go into drafts.create's file_ids.
import { resolve } from 'node:path';
import { InvalidInputError } from './cli-errors.ts';
import { checkUploadFile, type SlackClient } from './slack-client.ts';

// Slack's composer takes at most 10 files for one message.
export const DRAFT_FILE_LIMIT = 10;

export interface DraftFile {
  path: string;
  filename: string;
  size: number;
}

// The local checks before any Slack call: at most DRAFT_FILE_LIMIT files, no
// path given twice, and each a non-empty regular file. Any failure aborts the
// draft before a single byte is uploaded.
export async function checkDraftFiles(filePaths: string[]): Promise<DraftFile[]> {
  if (filePaths.length > DRAFT_FILE_LIMIT) {
    throw new InvalidInputError(
      `A draft can carry at most ${DRAFT_FILE_LIMIT} files; got ${filePaths.length}`,
    );
  }
  const seen = new Set<string>();
  for (const filePath of filePaths) {
    const key = resolve(filePath);
    if (seen.has(key)) {
      throw new InvalidInputError(`File given more than once: ${filePath}`);
    }
    seen.add(key);
  }
  return Promise.all(
    filePaths.map(async (filePath) => ({ path: filePath, ...(await checkUploadFile(filePath)) })),
  );
}

// Upload the files privately, then create the draft carrying them. If the
// draft call fails, the uploads are deleted so no orphaned private files stay
// behind; a failed cleanup is reported with the original error.
export async function createDraftWithFiles(
  client: SlackClient,
  channelId: string,
  text: string,
  options: { thread_ts?: string; files: DraftFile[] },
): Promise<{ draftId: string; fileIds: string[] }> {
  const upload = await client.uploadFilesExternal(undefined, options.files.map((f) => f.path));
  const fileIds = (upload.files ?? []).flatMap((f) => (f.id ? [f.id] : []));
  if (fileIds.length !== options.files.length) {
    await deleteUploads(client, fileIds);
    throw new Error(`Slack confirmed ${fileIds.length} of ${options.files.length} uploaded files`);
  }

  let response: any;
  try {
    response = await client.createDraft(channelId, text, { thread_ts: options.thread_ts, file_ids: fileIds });
  } catch (error) {
    const failed = await deleteUploads(client, fileIds);
    if (failed.length && error instanceof Error) {
      error.message += ` (uploaded files not removed: ${failed.join(', ')})`;
    }
    throw error;
  }
  return { draftId: response.draft.id, fileIds };
}

// Delete each upload; returns the ids that could not be deleted.
async function deleteUploads(client: SlackClient, fileIds: string[]): Promise<string[]> {
  const results = await Promise.allSettled(fileIds.map((id) => client.deleteFile(id)));
  return fileIds.filter((_, i) => results[i].status === 'rejected');
}
