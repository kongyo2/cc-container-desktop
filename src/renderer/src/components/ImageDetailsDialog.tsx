import { Copy, ExternalLink, X } from 'lucide-react';
import type { JSX, MouseEvent } from 'react';
import { useEffect } from 'react';

import { dockerHubUrl, pullCommand, repositoryDisplay, toolLabel } from '../../../shared/images.ts';
import type { ImageCatalogEntry, ImagePlatform, RegisteredImageView } from '../../../shared/images.ts';
import { useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';
import { formatBytes, formatTime } from './ui.tsx';

export interface ImageDetailsDialogProps {
  readonly entry: ImageCatalogEntry;
  readonly registered: RegisteredImageView | null;
  readonly platform: ImagePlatform | null;
  readonly onClose: () => void;
}

export function ImageDetailsDialog({ entry, registered, platform, onClose }: ImageDetailsDialogProps): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const setToast = useApp((state) => state.setToast);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  const copy = (text: string): void => {
    void window.cc.clipboardWrite(text).then(() => setToast(t('commonCopied')));
  };

  const shownPlatform = registered?.image.platform ?? platform ?? entry.platforms[0]?.platform ?? 'linux/amd64';
  const pinned =
    registered?.image.pinnedDigest ??
    entry.platforms.find((candidate) => candidate.platform === shownPlatform)?.manifestDigest ??
    null;
  const command = pullCommand(entry.repository, pinned, entry.tag, shownPlatform);
  const hub = dockerHubUrl(entry.repository);
  const tools = registered?.image.tools ?? entry.tools;

  return (
    <div className="modal-backdrop" onMouseDown={onBackdrop}>
      <div
        className="modal details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-details-title"
        data-testid="image-details-dialog"
      >
        <header className="modal-head">
          <h1 id="image-details-title">
            {t('detailsTitle')} — {entry.title[language]} / {entry.release}
          </h1>
          <button className="modal-x" type="button" onClick={onClose} aria-label={t('commonClose')}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <p className="modal-lead">{entry.description[language]}</p>

          <dl className="kv details-kv">
            <dt>{t('detailsRepository')}</dt>
            <dd>
              {repositoryDisplay(entry.repository)}
              {hub === null ? null : (
                <button
                  className="modal-link"
                  type="button"
                  onClick={() => void window.cc.openExternal(hub)}
                  style={{ marginLeft: 8 }}
                >
                  <ExternalLink size={12} /> {t('detailsOpenHub')}
                </button>
              )}
            </dd>
            <dt>{t('detailsTag')}</dt>
            <dd>{entry.tag}</dd>
            <dt>{t('detailsIndexDigest')}</dt>
            <dd>{registered?.image.indexDigest ?? entry.indexDigest ?? t('commonNone')}</dd>
            <dt>{t('detailsPlatforms')}</dt>
            <dd>
              {entry.platforms.map((candidate) => (
                <div key={candidate.platform}>
                  {candidate.platform}: {candidate.manifestDigest ?? t('detailsNotPublished')}
                  {candidate.compressedLayerBytes === null ? '' : ` (${formatBytes(candidate.compressedLayerBytes)})`}
                </div>
              ))}
            </dd>
            {registered === null ? null : (
              <>
                <dt>{t('detailsPinnedDigest')}</dt>
                <dd>
                  {registered.image.pinnedDigest} ({registered.image.digestKind}, {registered.image.platform})
                </dd>
                <dt>{t('detailsLocalImageId')}</dt>
                <dd>{registered.image.lastVerified.localImageId}</dd>
                <dt>{t('detailsLocalSize')}</dt>
                <dd>{formatBytes(registered.image.lastVerified.localSizeBytes)}</dd>
                <dt>{t('imageVerifiedAt')}</dt>
                <dd>{formatTime(registered.image.lastVerified.verifiedAt)}</dd>
              </>
            )}
            <dt>{t('detailsRevision')}</dt>
            <dd>{registered?.image.sourceRevision ?? entry.sourceRevision ?? t('commonNone')}</dd>
            <dt>{t('detailsPublishedAt')}</dt>
            <dd>{entry.publishedAt === null ? t('detailsNotPublished') : formatTime(entry.publishedAt)}</dd>
          </dl>

          <p className="modal-label">{t('detailsPullCommand')}</p>
          <div className="row" style={{ marginBottom: 20 }}>
            <code className="command" style={{ flex: 1 }}>
              {command}
            </code>
            <button className="btn sm" type="button" onClick={() => copy(command)}>
              <Copy size={13} /> {t('commonCopy')}
            </button>
          </div>

          <p className="modal-label">{t('detailsTools')}</p>
          <table className="tools-table" data-testid="image-tools">
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id}>
                  <td>{tool.name}</td>
                  <td>{tool.version === '' ? t('commonNone') : toolLabel({ ...tool, name: '' }).trim()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="modal-btn" type="button" onClick={onClose}>
            {t('commonClose')}
          </button>
        </footer>
      </div>
    </div>
  );
}
