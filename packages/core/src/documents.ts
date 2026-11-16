import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { excluded, hash, within } from './security';
import { subprocess } from './ssh';

const requestSchema = z
  .object({
    file: z.string().min(1).max(500),
    firstPage: z.number().int().min(1).max(200).default(1),
    pages: z.number().int().min(1).max(20).default(20),
    ocr: z.boolean().default(false),
  })
  .strict()
  .refine((input) => !input.ocr || input.pages <= 3, {
    message: 'OCR supports at most three selected pages per preview',
  });
type Request = z.infer<typeof requestSchema>;
type Preview = {
  file: string;
  sourceHash: string;
  pages: { page: number; text: string; method: string }[];
  totalPages: number;
  warnings: string[];
  reviewHash: string;
};

export class Documents {
  private previews = new Map<
    string,
    { request: Request; preview: Preview; created: number }
  >();
  private active = 0;
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly requests = new Set<Promise<unknown>>();
  constructor(
    readonly root: string,
    readonly assets: string,
  ) {}
  status() {
    return this.call({ action: 'status' });
  }
  private source(file: string) {
    if (excluded(file.toLowerCase()) || !/\.(pdf|md|txt)$/i.test(file))
      throw new Error(
        'Select a non-secret PDF, Markdown or UTF-8 text file in this workspace',
      );
    const full = within(this.root, file);
    const descriptor = fs.openSync(
      full,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size > 25 * 1024 * 1024)
        throw new Error('Documents must be regular files up to 25 MB');
      const digest = crypto.createHash('sha256'),
        buffer = Buffer.alloc(65536);
      let size = 0,
        bytes: number;
      while (
        (bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))
      ) {
        size += bytes;
        if (size > 25 * 1024 * 1024)
          throw new Error('Document grew beyond 25 MB');
        digest.update(buffer.subarray(0, bytes));
      }
      return { full, sha256: digest.digest('hex') };
    } finally {
      fs.closeSync(descriptor);
    }
  }
  async preview(input: unknown) {
    const request = requestSchema.parse(input);
    if (this.active >= 2)
      throw new Error('Two document extractions are already active');
    this.active++;
    try {
      const source = this.source(request.file);
      const result = await this.call({
        action: 'extract',
        ...request,
        file: source.full,
      });
      if (
        result.sourceHash !== source.sha256 ||
        this.source(request.file).sha256 !== source.sha256
      )
        throw new Error('Source changed during extraction; preview again');
      const data = { ...result, file: request.file };
      const preview = {
        ...data,
        reviewHash: hash(JSON.stringify({ request, data })),
      } as Preview;
      if (this.previews.size >= 4)
        this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(preview.reviewHash, {
        request,
        preview,
        created: Date.now(),
      });
      return preview;
    } finally {
      this.active--;
    }
  }
  save(input: unknown) {
    const args = z
      .object({
        file: z.string(),
        firstPage: z.number().optional(),
        pages: z.number().optional(),
        ocr: z.boolean().optional(),
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(input);
    const request = requestSchema.parse({
      file: args.file,
      firstPage: args.firstPage,
      pages: args.pages,
      ocr: args.ocr,
    });
    const entry = this.previews.get(args.reviewHash);
    if (
      !entry ||
      Date.now() - entry.created > 30 * 60000 ||
      JSON.stringify(entry.request) !== JSON.stringify(request)
    )
      throw new Error('Extraction review expired or changed; preview again');
    if (this.source(request.file).sha256 !== entry.preview.sourceHash)
      throw new Error('Source changed after review; preview again');
    if (!entry.preview.pages.some((page) => page.text.trim()))
      throw new Error(
        'No extracted text to save; try local OCR or another document',
      );
    const folder = within(this.root, 'documents', true);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const relative = `documents/${args.name}.md`,
      file = within(this.root, relative, true);
    const link = request.file.split('/').map(encodeURIComponent).join('/');
    const body =
      `<!-- aiide-document-source-v1:${Buffer.from(JSON.stringify({ file: request.file, hash: entry.preview.sourceHash })).toString('base64url')} -->\n# ${args.name}\n\nSource: ${request.file}\n\nSHA-256: ${entry.preview.sourceHash}\n\n` +
      entry.preview.pages
        .map(
          (page) =>
            `## Page ${page.page}\n\n[Source page ${page.page}](../${link}${/\.pdf$/i.test(request.file) ? `#page=${page.page}` : ''}) · ${page.method}\n\n${page.text || '_No text extracted._'}\n`,
        )
        .join('\n');
    let created = false;
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, body, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (created) fs.unlinkSync(file);
      throw error;
    }
    return {
      file: relative,
      source: request.file,
      sourceHash: entry.preview.sourceHash,
      pages: entry.preview.pages.length,
    };
  }
  private call(request: unknown) {
    if (this.closed)
      return Promise.reject(new Error('Document service is closed'));
    const controller = new AbortController();
    this.controllers.add(controller);
    const operation = subprocess(
      process.platform === 'win32' ? 'python' : 'python3',
      [path.join(this.assets, 'python', 'aiide_documents', '__main__.py')],
      request,
      120000,
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SYSTEMROOT: process.env.SYSTEMROOT,
        PYTHONDONTWRITEBYTECODE: '1',
      } as NodeJS.ProcessEnv,
      controller.signal,
    );
    this.requests.add(operation);
    void operation
      .finally(() => {
        this.controllers.delete(controller);
        this.requests.delete(operation);
      })
      .catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.requests]);
    this.previews.clear();
  }
}
