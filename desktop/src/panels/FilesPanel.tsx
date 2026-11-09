import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ArrowUp,
  ChevronRight,
  Download,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderUp,
  HardDrive,
  RefreshCw,
  UploadCloud,
  Ban,
} from 'lucide-react';
import { t } from '../i18n';
import { formatBytes, formatDateTime } from '../lib/format';
import { platform } from '../platform';
import { controller } from '../session/controller';
import { collectDropped, itemsFromInput, type LsResult, type UploadItem } from '../session/files';
import { notify, useApp } from '../store/app';
import { EmptyState, Skeleton } from '../components/ui';
import { TransferList } from './TransferList';

function splitPath(p: string): { label: string; path: string }[] {
  if (!p) return [];
  const win = /^[A-Za-z]:/.test(p) || p.includes('\\');
  const sep = win ? '\\' : '/';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = win ? '' : '/';
  parts.forEach((part, i) => {
    acc = win ? (i === 0 ? `${part}${sep}` : `${acc}${acc.endsWith(sep) ? '' : sep}${part}`) : `${acc}${acc.endsWith('/') ? '' : '/'}${part}`;
    out.push({ label: part, path: acc });
  });
  if (!win) out.unshift({ label: '/', path: '/' });
  return out;
}

export function FilesPanel() {
  const viewer = useApp((s) => s.viewer)!;
  const allowed = viewer.permissions.files;
  const [listing, setListing] = useState<LsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const destRootRef = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const vs = controller.viewer;

  const ls = useCallback(
    async (path: string) => {
      if (!vs) return;
      setLoading(true);
      setError(null);
      try {
        // the files channel may still be opening right after connect
        for (let i = 0; i < 20 && !vs.files.ready; i++) await new Promise((r) => setTimeout(r, 250));
        const r = await vs.files.ls(path);
        setListing(r);
        setSelected(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [vs],
  );

  useEffect(() => {
    if (allowed && viewer.status === 'streaming' && !listing && !loading) void ls('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, viewer.status]);

  if (!allowed) {
    return (
      <div className="files">
        <EmptyState icon={<Ban />} title={t.files.disabled} />
      </div>
    );
  }

  const upload = (items: UploadItem[]) => {
    if (!vs || items.length === 0) return;
    const first = items[0].relPath;
    const label = items.length === 1 ? first : first.includes('/') ? `${first.split('/')[0]}/` : `${items.length} arquivos`;
    void vs.files.upload(items, label, listing?.path || undefined).then(() => {
      if (listing?.path) void ls(listing.path);
    });
  };

  const download = async (path: string, name: string) => {
    if (!vs) return;
    let dest = destRootRef.current;
    if (dest == null) {
      dest = await platform.pickDownloadDir();
      if (dest == null) return;
      destRootRef.current = dest;
    }
    vs.files.download(path, name, dest);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    try {
      upload(await collectDropped(e.dataTransfer));
    } catch (err) {
      notify('error', t.notif.transferFailed, String(err));
    }
  };

  const crumbs = splitPath(listing?.path ?? '');

  return (
    <div
      className={`files${drag ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={onDrop}
      data-testid="files-panel"
    >
      <div className="files-actions">
        <button className="btn btn-primary btn-sm" onClick={() => fileInput.current?.click()} data-testid="upload-files">
          <FilePlus2 /> {t.files.upload}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => dirInput.current?.click()}>
          <FolderUp /> {t.files.uploadFolder}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="upload-input"
          onChange={(e) => {
            upload(itemsFromInput(e.target.files));
            e.target.value = '';
          }}
        />
        <input
          ref={dirInput}
          type="file"
          hidden
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            upload(itemsFromInput(e.target.files));
            e.target.value = '';
          }}
        />
      </div>
      <div className="files-dest subtle">{t.files.sendTo(listing?.path || t.files.defaultDest)}</div>

      <div className="files-browser">
        <div className="files-crumbs">
          <button className="icon-btn sm" disabled={!listing?.path} onClick={() => void ls(listing?.parent ?? '')} title={t.files.up} aria-label={t.files.up}>
            <ArrowUp />
          </button>
          <div className="crumbs">
            <button className="crumb" onClick={() => void ls('')}>
              <HardDrive size={13} /> {t.files.roots}
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="crumb-wrap">
                <ChevronRight size={12} />
                <button className="crumb" onClick={() => void ls(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </div>
          <button className="icon-btn sm" onClick={() => void ls(listing?.path ?? '')} title={t.files.refresh} aria-label={t.files.refresh}>
            <RefreshCw className={loading ? 'spin' : ''} />
          </button>
        </div>
        <div className="files-list" data-testid="remote-file-list">
          {error ? (
            <div className="files-error">{error}</div>
          ) : !listing ? (
            <div style={{ padding: 12, display: 'grid', gap: 10 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} h={14} w={`${60 + ((i * 17) % 35)}%`} />
              ))}
            </div>
          ) : listing.entries.length === 0 ? (
            <div className="files-error subtle">{t.files.empty}</div>
          ) : (
            [...listing.entries]
              .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'pt-BR'))
              .map((en) => (
                <div
                  key={en.path}
                  className={`file-row${selected === en.path ? ' selected' : ''}`}
                  onClick={() => setSelected(en.path)}
                  onDoubleClick={() => (en.isDir ? void ls(en.path) : void download(en.path, en.name))}
                  data-testid="remote-entry"
                  data-name={en.name}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') en.isDir ? void ls(en.path) : void download(en.path, en.name);
                  }}
                >
                  <span className={`file-ic ${en.isDir ? 'dir' : ''}`}>{en.isDir ? <Folder /> : <FileIcon />}</span>
                  <span className="file-name" title={en.name}>
                    {en.name}
                  </span>
                  <span className="file-meta tabular">{en.isDir ? '' : formatBytes(en.size)}</span>
                  <button
                    className="icon-btn sm file-dl"
                    title={t.files.download}
                    aria-label={`${t.files.download} ${en.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void download(en.path, en.name);
                    }}
                    data-testid="download-entry"
                  >
                    <Download />
                  </button>
                  <span className="sr-only">{formatDateTime(en.modified)}</span>
                </div>
              ))
          )}
        </div>
      </div>

      <div className="files-transfers">
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          {t.files.transfers}
        </div>
        <TransferList
          transfers={viewer.transfers}
          onCancel={(id) => controller.viewer?.files.cancel(id)}
          onOpen={platform.canHost ? (p) => void platform.openPath(p) : undefined}
          openDirection="download"
        />
      </div>
      {drag && (
        <div className="drop-overlay">
          <UploadCloud />
          <span>{t.files.dropHere}</span>
        </div>
      )}
    </div>
  );
}
