import { Copy, ExternalLink, X } from 'lucide-react';
import type { JSX, MouseEvent } from 'react';
import { useEffect } from 'react';

import {
  dockerHubUrl,
  imageDisplayName,
  imageReference,
  pullCommand,
  repositoryDisplay,
  toolLabel,
} from '../../../shared/images.ts';
import type { ImageCatalogEntry, ImagePlatform, RegisteredImageView } from '../../../shared/images.ts';
import { useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';
import { formatBytes, formatTime } from './ui.tsx';

export interface ImageDetailsDialogProps {
  readonly entry: ImageCatalogEntry | null;
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

  const image = registered?.image ?? null;
  const repository = image?.repository ?? entry?.repository ?? '';
  const tag = image?.tag ?? entry?.tag ?? null;
  const shownPlatform = image?.platform ?? platform ?? entry?.platforms[0]?.platform ?? 'linux/amd64';
  const pinned =
    image?.pinnedDigest ??
    entry?.platforms.find((candidate) => candidate.platform === shownPlatform)?.manifestDigest ??
    null;
  const command = pullCommand(repository, pinned, tag, shownPlatform);
  const hub = dockerHubUrl(repository);
  const tools = image !== null && image.tools.length > 0 ? image.tools : (entry?.tools ?? []);
  const title =
    image !== null
      ? imageDisplayName(image, language)
      : entry === null
        ? ''
        : `${entry.title[language]} / ${entry.release}`;
  const lead = entry?.description[language] ?? (image === null ? '' : imageReference(repository, pinned, tag));
  const availability = registered?.availability ?? null;

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
            {t('detailsTitle')} — {title}
          </h1>
          <button className="modal-x" type="button" onClick={onClose} aria-label={t('commonClose')}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          {lead === '' ? null : <p className="modal-lead">{lead}</p>}

          <dl className="kv details-kv">
            <dt>{t('detailsRepository')}</dt>
            <dd>
              {repositoryDisplay(repository)}
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
            <dd>{tag ?? t('commonNone')}</dd>
            {entry === null ? null : (
              <>
                <dt>{t('detailsIndexDigest')}</dt>
                <dd>{entry.indexDigest ?? t('commonNone')}</dd>
                <dt>{t('detailsPlatforms')}</dt>
                <dd>
                  {entry.platforms.map((candidate) => (
                    <div key={candidate.platform}>
                      {candidate.platform}: {candidate.manifestDigest ?? t('detailsNotPublished')}
                      {candidate.compressedLayerBytes === null
                        ? ''
                        : ` (${formatBytes(candidate.compressedLayerBytes)})`}
                    </div>
                  ))}
                </dd>
              </>
            )}
            {image === null ? null : (
              <>
                <dt>{t('detailsPinnedDigest')}</dt>
                <dd>
                  {image.pinnedDigest ?? t('detailsPinnedNone')} ({image.platform})
                </dd>
                <dt>{t('imageRegisteredAt')}</dt>
                <dd>{formatTime(image.registeredAt)}</dd>
              </>
            )}
            {availability !== null && availability.kind === 'ready' ? (
              <>
                <dt>{t('detailsLocalImageId')}</dt>
                <dd>{availability.localImageId}</dd>
                <dt>{t('detailsLocalSize')}</dt>
                <dd>{formatBytes(availability.localSizeBytes)}</dd>
              </>
            ) : null}
            {entry === null ? null : (
              <>
                <dt>{t('detailsRevision')}</dt>
                <dd>{entry.sourceRevision ?? t('commonNone')}</dd>
                <dt>{t('detailsPublishedAt')}</dt>
                <dd>{entry.publishedAt === null ? t('detailsNotPublished') : formatTime(entry.publishedAt)}</dd>
              </>
            )}
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
          {tools.length === 0 ? (
            <p className="modal-note">{t('detailsToolsUnknown')}</p>
          ) : (
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
          )}
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
