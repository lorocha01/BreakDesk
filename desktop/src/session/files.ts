// Viewer side of the `files` data channel (PROTOCOL.md §4.2).
import type { FilesMsg, RemoteEntry } from '../net/protocol';
import type { DownloadSink, Platform } from '../platform/types';
import type { Transfer } from '../store/app';

export const CHUNK = 16 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const READ_BLOCK = 1024 * 1024;
const FLUSH_AT = 1024 * 1024;

export interface UploadItem {
  file: File;
  /** Relative path including the file name, e.g. "pasta/sub/a.txt" or "a.txt". */
  relPath: string;
}

export interface LsResult {
  path: string;
  parent: string | null;
  entries: RemoteEntry[];
}

type TransferPatch = Partial<Transfer> & { id: string };

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

interface DownloadJob {
  id: number;
  uiId: string;
  destRoot: string;
  files: Map<number, { relPath: string; size: number }>;
  sinks: Map<number, Promise<DownloadSink>>;
  buffers: Map<number, { parts: Uint8Array[]; len: number }>;
  chain: Promise<void>;
  bytes: number;
  total: number;
  cancelled: boolean;
  failed: boolean;
  lastPath?: string;
  meter: Meter;
}

interface UploadBatch {
  uiId: string;
  cancelled: boolean;
  currentId: number | null;
}

class Meter {
  private lastT = performance.now();
  private lastB = 0;
  private lastEmit = 0;
  speed = 0;
  tick(bytes: number): boolean {
    const now = performance.now();
    const dt = now - this.lastT;
    if (dt >= 500) {
      const inst = ((bytes - this.lastB) * 1000) / dt;
      this.speed = this.speed === 0 ? inst : this.speed * 0.6 + inst * 0.4;
      this.lastT = now;
      this.lastB = bytes;
    }
    if (now - this.lastEmit >= 200) {
      this.lastEmit = now;
      return true;
    }
    return false;
  }
}

function frame(id: number, fileIndex: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, id >>> 0, false);
  dv.setUint32(4, fileIndex >>> 0, false);
  out.set(payload, 8);
  return out;
}

function concat(parts: Uint8Array[], len: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class ViewerFiles {
  private dc: RTCDataChannel | null = null;
  private nextId = 1;
  private reqSeq = 1;
  private lsWaiters = new Map<string, Waiter<LsResult>>();
  private putOk = new Map<number, Waiter<void>>();
  private putDone = new Map<number, Waiter<string | undefined>>();
  private downloads = new Map<number, DownloadJob>();
  private batches = new Map<string, UploadBatch>();

  constructor(
    private platform: Platform,
    private report: (patch: TransferPatch) => void,
  ) {}

  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onmessage = (ev) => this.onMessage(ev.data);
    dc.onclose = () => {
      if (this.dc === dc) this.fail('Canal de arquivos fechado');
    };
  }

  get ready(): boolean {
    return this.dc?.readyState === 'open';
  }

  close(): void {
    this.fail('Sessão encerrada');
    this.dc = null;
  }

  private fail(message: string) {
    const err = new Error(message);
    this.lsWaiters.forEach((w) => w.reject(err));
    this.putOk.forEach((w) => w.reject(err));
    this.putDone.forEach((w) => w.reject(err));
    this.lsWaiters.clear();
    this.putOk.clear();
    this.putDone.clear();
    for (const job of this.downloads.values()) {
      if (!job.cancelled) this.report({ id: job.uiId, state: 'error', message });
      void this.platform.abortDownload(job.id).catch(() => {});
    }
    this.downloads.clear();
    for (const b of this.batches.values()) {
      b.cancelled = true;
    }
  }

  private send(msg: FilesMsg) {
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('Canal de arquivos indisponível');
    this.dc.send(JSON.stringify(msg));
  }

  private async drain() {
    const dc = this.dc;
    if (!dc) throw new Error('Canal de arquivos indisponível');
    while (dc.bufferedAmount > HIGH_WATER) {
      if (dc.readyState !== 'open') throw new Error('Canal de arquivos fechado');
      await new Promise<void>((res) => {
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          dc.removeEventListener('close', done);
          clearTimeout(timer);
          res();
        };
        const timer = setTimeout(done, 1000);
        dc.addEventListener('bufferedamountlow', done);
        dc.addEventListener('close', done);
      });
    }
  }

  ls(path: string): Promise<LsResult> {
    const reqId = `ls${this.reqSeq++}`;
    return new Promise<LsResult>((resolve, reject) => {
      this.lsWaiters.set(reqId, { resolve, reject });
      try {
        this.send({ op: 'ls', reqId, path });
      } catch (e) {
        this.lsWaiters.delete(reqId);
        reject(e as Error);
      }
      setTimeout(() => {
        if (this.lsWaiters.delete(reqId)) reject(new Error('Tempo esgotado ao listar a pasta'));
      }, 15_000);
    });
  }

  /** Uploads a batch (one UI entry). Files are sent sequentially. */
  async upload(items: UploadItem[], label: string, dest?: string): Promise<void> {
    if (items.length === 0) return;
    const uiId = `u${this.nextId}-${Date.now()}`;
    const total = items.reduce((a, b) => a + b.file.size, 0);
    const batch: UploadBatch = { uiId, cancelled: false, currentId: null };
    this.batches.set(uiId, batch);
    const meter = new Meter();
    let bytes = 0;
    let lastPath: string | undefined;
    this.report({
      id: uiId,
      direction: 'upload',
      name: label,
      total,
      bytes: 0,
      state: 'active',
      startedAt: Date.now(),
      speed: 0,
      files: items.length,
    });
    try {
      for (const item of items) {
        if (batch.cancelled) break;
        const id = this.nextId++;
        batch.currentId = id;
        const okP = new Promise<void>((resolve, reject) => this.putOk.set(id, { resolve, reject }));
        this.send({ op: 'put', id, name: item.file.name, relPath: item.relPath, size: item.file.size, dest: dest || undefined });
        await okP;
        let off = 0;
        while (off < item.file.size) {
          if (batch.cancelled) break;
          const block = new Uint8Array(await item.file.slice(off, off + READ_BLOCK).arrayBuffer());
          for (let p = 0; p < block.length; p += CHUNK) {
            if (batch.cancelled) break;
            await this.drain();
            const piece = block.subarray(p, Math.min(p + CHUNK, block.length));
            this.dc!.send(frame(id, 0, piece));
            bytes += piece.length;
            if (meter.tick(bytes)) this.report({ id: uiId, bytes, speed: meter.speed });
          }
          off += block.length;
        }
        if (batch.cancelled) {
          try {
            this.send({ op: 'cancel', id });
          } catch {
            /* channel gone */
          }
          break;
        }
        const doneP = new Promise<string | undefined>((resolve, reject) => this.putDone.set(id, { resolve, reject }));
        this.send({ op: 'put_end', id });
        lastPath = await doneP;
      }
      if (batch.cancelled) {
        this.report({ id: uiId, state: 'cancelled', bytes, speed: 0 });
      } else {
        this.report({ id: uiId, state: 'done', bytes: total, speed: 0, path: lastPath });
      }
    } catch (e) {
      this.report({ id: uiId, state: 'error', message: (e as Error).message, speed: 0 });
    } finally {
      this.batches.delete(uiId);
    }
  }

  /** Requests a file or folder from the host. `destRoot` comes from platform.pickDownloadDir(). */
  download(path: string, name: string, destRoot: string): string {
    const id = this.nextId++;
    const uiId = `d${id}-${Date.now()}`;
    const job: DownloadJob = {
      id,
      uiId,
      destRoot,
      files: new Map(),
      sinks: new Map(),
      buffers: new Map(),
      chain: Promise.resolve(),
      bytes: 0,
      total: 0,
      cancelled: false,
      failed: false,
      meter: new Meter(),
    };
    this.downloads.set(id, job);
    this.report({
      id: uiId,
      direction: 'download',
      name,
      total: 0,
      bytes: 0,
      state: 'pending',
      startedAt: Date.now(),
      speed: 0,
    });
    try {
      this.send({ op: 'get', id, path });
    } catch (e) {
      this.report({ id: uiId, state: 'error', message: (e as Error).message });
      this.downloads.delete(id);
    }
    return uiId;
  }

  cancel(uiId: string): void {
    const batch = this.batches.get(uiId);
    if (batch) {
      batch.cancelled = true;
      return;
    }
    for (const job of this.downloads.values()) {
      if (job.uiId === uiId) {
        job.cancelled = true;
        try {
          this.send({ op: 'cancel', id: job.id });
        } catch {
          /* ignore */
        }
        this.downloads.delete(job.id);
        void this.platform.abortDownload(job.id).catch(() => {});
        this.report({ id: uiId, state: 'cancelled', speed: 0 });
      }
    }
  }

  private enqueue(job: DownloadJob, fn: () => Promise<void>) {
    job.chain = job.chain.then(async () => {
      if (job.cancelled || job.failed) return;
      try {
        await fn();
      } catch (e) {
        job.failed = true;
        this.report({ id: job.uiId, state: 'error', message: (e as Error).message, speed: 0 });
        try {
          this.send({ op: 'cancel', id: job.id });
        } catch {
          /* ignore */
        }
        this.downloads.delete(job.id);
        void this.platform.abortDownload(job.id).catch(() => {});
      }
    });
  }

  private sinkFor(job: DownloadJob, fileIndex: number): Promise<DownloadSink> {
    let s = job.sinks.get(fileIndex);
    if (!s) {
      const meta = job.files.get(fileIndex);
      const rel = meta?.relPath ?? `arquivo-${fileIndex}`;
      s = this.platform.openDownload(job.id, fileIndex, job.destRoot, rel);
      job.sinks.set(fileIndex, s);
    }
    return s;
  }

  private flush(job: DownloadJob, fileIndex: number) {
    const buf = job.buffers.get(fileIndex);
    if (!buf || buf.len === 0) return;
    const data = concat(buf.parts, buf.len);
    job.buffers.set(fileIndex, { parts: [], len: 0 });
    this.enqueue(job, async () => {
      const sink = await this.sinkFor(job, fileIndex);
      await sink.write(data);
    });
  }

  private onBinary(data: ArrayBuffer) {
    if (data.byteLength < 8) return;
    const dv = new DataView(data);
    const id = dv.getUint32(0, false);
    const fileIndex = dv.getUint32(4, false);
    const job = this.downloads.get(id);
    if (!job || job.cancelled || job.failed) return;
    const payload = new Uint8Array(data, 8);
    let buf = job.buffers.get(fileIndex);
    if (!buf) {
      buf = { parts: [], len: 0 };
      job.buffers.set(fileIndex, buf);
    }
    buf.parts.push(payload);
    buf.len += payload.length;
    job.bytes += payload.length;
    if (buf.len >= FLUSH_AT) this.flush(job, fileIndex);
    if (job.meter.tick(job.bytes)) this.report({ id: job.uiId, bytes: job.bytes, speed: job.meter.speed, state: 'active' });
  }

  private onMessage(data: unknown) {
    if (data instanceof ArrayBuffer) {
      this.onBinary(data);
      return;
    }
    if (typeof data !== 'string') return;
    let msg: FilesMsg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.op) {
      case 'ls_result': {
        const w = this.lsWaiters.get(msg.reqId);
        if (w) {
          this.lsWaiters.delete(msg.reqId);
          w.resolve({ path: msg.path, parent: msg.parent, entries: msg.entries });
        }
        break;
      }
      case 'error': {
        if (msg.reqId) {
          const w = this.lsWaiters.get(msg.reqId);
          if (w) {
            this.lsWaiters.delete(msg.reqId);
            w.reject(new Error(msg.message));
          }
        }
        if (msg.id != null) this.failId(msg.id, msg.message);
        break;
      }
      case 'put_ok': {
        this.putOk.get(msg.id)?.resolve();
        this.putOk.delete(msg.id);
        break;
      }
      case 'put_err': {
        this.failId(msg.id, msg.message);
        break;
      }
      case 'get_meta': {
        const job = this.downloads.get(msg.id);
        if (!job) break;
        msg.files.forEach((f) => job.files.set(f.fileIndex, { relPath: f.relPath, size: f.size }));
        job.total = msg.totalSize;
        this.report({ id: job.uiId, total: msg.totalSize, state: 'active', files: msg.files.length });
        // Zero-byte files never receive binary frames; open them eagerly so they exist on disk.
        msg.files.filter((f) => f.size === 0).forEach((f) => this.enqueue(job, async () => void (await this.sinkFor(job, f.fileIndex))));
        break;
      }
      case 'file_end': {
        const job = this.downloads.get(msg.id);
        if (!job) break;
        this.flush(job, msg.fileIndex);
        const fi = msg.fileIndex;
        this.enqueue(job, async () => {
          const sink = await this.sinkFor(job, fi);
          await sink.close();
          job.lastPath = sink.displayPath;
          job.sinks.delete(fi);
        });
        break;
      }
      case 'done': {
        const pd = this.putDone.get(msg.id);
        if (pd) {
          this.putDone.delete(msg.id);
          pd.resolve(msg.path);
          break;
        }
        const job = this.downloads.get(msg.id);
        if (!job) break;
        // flush any trailing buffers (defensive: file_end should have done it)
        for (const fi of job.buffers.keys()) this.flush(job, fi);
        job.chain = job.chain.then(() => {
          if (job.cancelled || job.failed) return;
          this.downloads.delete(job.id);
          this.report({ id: job.uiId, state: 'done', bytes: job.total || job.bytes, speed: 0, path: job.lastPath });
        });
        break;
      }
      case 'cancel': {
        this.failId(msg.id, 'Cancelado pelo computador remoto', 'cancelled');
        break;
      }
      default:
        break;
    }
  }

  private failId(id: number, message: string, state: 'error' | 'cancelled' = 'error') {
    const e = new Error(message);
    const ok = this.putOk.get(id);
    if (ok) {
      this.putOk.delete(id);
      ok.reject(e);
    }
    const done = this.putDone.get(id);
    if (done) {
      this.putDone.delete(id);
      done.reject(e);
    }
    for (const b of this.batches.values()) {
      if (b.currentId === id) {
        b.cancelled = true;
        this.report({ id: b.uiId, state, message, speed: 0 });
      }
    }
    const job = this.downloads.get(id);
    if (job) {
      job.failed = true;
      this.downloads.delete(id);
      void this.platform.abortDownload(id).catch(() => {});
      this.report({ id: job.uiId, state, message, speed: 0 });
    }
  }
}

/** Collects files (recursively for folders) from a drop event, preserving relative paths. */
export async function collectDropped(dt: DataTransfer): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, relPath: file.name }));
  }
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, relPath: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = [];
      // readEntries returns results in batches
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        children.push(...batch);
      }
      for (const c of children) await walk(c, `${prefix}${entry.name}/`);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

export function itemsFromInput(list: FileList | null): UploadItem[] {
  if (!list) return [];
  return Array.from(list).map((file) => ({
    file,
    relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}
