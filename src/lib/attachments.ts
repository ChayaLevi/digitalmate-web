import type { Attachment, AttachmentMeta } from '../types';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
const MAX_TEXT_CHARS = 200_000;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx'
]);

export function attachmentKind(name: string, type: string): AttachmentMeta['kind'] {
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) return 'pdf';
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  if (TEXT_EXTENSIONS.has(extension) || type.startsWith('text/')) return 'text';
  return 'other';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function summarizeAttachment(attachment: Attachment): AttachmentMeta {
  return {
    name: attachment.name,
    size: attachment.size,
    type: attachment.type,
    kind: attachment.kind
  };
}

export function validateAttachment(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} is larger than 5 MB`;
  }
  return null;
}

export async function readAttachment(file: File): Promise<Attachment> {
  const base: Attachment = {
    id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    size: file.size,
    type: file.type,
    kind: attachmentKind(file.name, file.type)
  };

  if (base.kind === 'text') {
    const text = await file.text();
    return { ...base, text: text.slice(0, MAX_TEXT_CHARS) };
  }

  if (base.kind === 'image') {
    return { ...base, url: URL.createObjectURL(file), file };
  }

  if (base.kind === 'pdf') {
    const text = await extractPdfText(file).catch(() => '');
    return text ? { ...base, text } : base;
  }

  return base;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const document = await loadingTask.promise;
  try {
    const pages = Math.min(document.numPages, 20);
    let output = '';
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      if (output.length >= MAX_TEXT_CHARS) break;
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const line = content.items
        .map(item => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (line) output += `${line}\n\n`;
    }
    return output.slice(0, MAX_TEXT_CHARS).trim();
  } finally {
    await loadingTask.destroy();
  }
}

export function releaseAttachment(attachment: Attachment): void {
  if (attachment.url) URL.revokeObjectURL(attachment.url);
}
