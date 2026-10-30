import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import type { ChatAttachment, ChatAttachmentInput } from '../../shared/types.js';

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 75 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.sql': 'application/sql',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/sql': '.sql',
  'application/xml': '.xml',
  'application/yaml': '.yaml',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

export function prepareChatAttachments(inputs: ChatAttachmentInput[]): ChatAttachment[] {
  if (!Array.isArray(inputs)) {
    throw new Error('Invalid attachment payload.');
  }
  if (inputs.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
  }

  const attachments = inputs.map((input) => {
    if (input.path) return prepareExistingFileAttachment(input);
    if (input.dataUrl) return prepareInlineAttachment(input);
    throw new Error(`Attachment ${input.name || 'file'} has no readable file data.`);
  });

  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`Attachments are limited to ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} total.`);
  }

  return attachments;
}

export async function selectChatAttachmentFiles(): Promise<ChatAttachment[]> {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(focusedWindow!, {
    title: 'Attach files to chat',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });

  if (canceled) return [];
  return prepareChatAttachments(
    filePaths.map((filePath) => ({ name: path.basename(filePath), path: filePath })),
  );
}

function prepareExistingFileAttachment(input: ChatAttachmentInput): ChatAttachment {
  const filePath = path.resolve(input.path!);
  if (!existsSync(filePath)) {
    throw new Error(`Attachment not found: ${filePath}`);
  }

  const fileStat = statSync(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Only files can be attached: ${filePath}`);
  }
  assertFileSize(fileStat.size, input.name || path.basename(filePath));

  const name = sanitizeFileName(input.name || path.basename(filePath));
  const mimeType = normaliseMimeType(input.mimeType) ?? inferMimeType(name, filePath);

  return {
    id: input.id ?? randomUUID(),
    name,
    mimeType,
    size: fileStat.size,
    kind: isImageMimeType(mimeType) ? 'image' : 'file',
    path: filePath,
    createdAt: new Date().toISOString(),
  };
}

function prepareInlineAttachment(input: ChatAttachmentInput): ChatAttachment {
  const parsed = parseDataUrl(input.dataUrl!);
  const mimeType = normaliseMimeType(input.mimeType) ?? parsed.mimeType;
  assertFileSize(parsed.buffer.byteLength, input.name || 'pasted file');

  const safeName = ensureFileExtension(sanitizeFileName(input.name || 'pasted-file'), mimeType);
  const outputDir = getAttachmentStorageDir();
  const outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}-${safeName}`);
  writeFileSync(outputPath, parsed.buffer);

  return {
    id: input.id ?? randomUUID(),
    name: safeName,
    mimeType,
    size: parsed.buffer.byteLength,
    kind: isImageMimeType(mimeType) ? 'image' : 'file',
    path: outputPath,
    createdAt: new Date().toISOString(),
  };
}

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/);
  if (!match) {
    throw new Error('Pasted attachment data was not a supported data URL.');
  }

  const mimeType = normaliseMimeType(match[1]) ?? 'application/octet-stream';
  return {
    mimeType,
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function getAttachmentStorageDir(): string {
  const dateSegment = new Date().toISOString().slice(0, 10);
  const dir = path.join(app.getPath('userData'), 'chat-attachments', dateSegment);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFileName(name: string): string {
  const candidate = name
    .trim()
    .replace(/[\\/:\0]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return candidate || 'attachment';
}

function ensureFileExtension(fileName: string, mimeType: string): string {
  const parsed = path.parse(fileName);
  if (parsed.ext) return fileName;
  return `${fileName}${EXTENSION_BY_MIME[mimeType] ?? '.bin'}`;
}

function inferMimeType(fileName: string, filePath: string): string {
  const ext = path.extname(fileName || filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

function normaliseMimeType(mimeType: string | undefined): string | null {
  const value = mimeType?.trim().toLowerCase();
  return value || null;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function assertFileSize(size: number, name: string): void {
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}
