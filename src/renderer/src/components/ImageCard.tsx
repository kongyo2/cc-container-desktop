import { CheckCircle2, Download, Info, Layers, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import type { JSX } from 'react';

import { catalogPlatform, highlightTools, isTerminalPhase, toolLabel } from '../../../shared/images.ts';
import type { ImageCatalogEntry, ImageOperation, RegisteredImageView } from '../../../shared/images.ts';
import type { DockerStatus } from '../../../shared/types.ts';
import { availabilityKey, availabilityTone, phaseKey } from '../images.ts';
import { useLanguage, useT } from '../i18n.ts';
import { Pill, formatBytes } from './ui.tsx';

export interface ImageCardProps {
  readonly entry: ImageCatalogEntry;
  readonly registered: RegisteredImageView | null;
  readonly operation: ImageOperation | null;
  readonly docker: DockerStatus;
  readonly onDownload: (entry: ImageCatalogEntry) => void;
  readonly onRepair: (view: RegisteredImageView) => void;
  readonly onCancel: (operation: ImageOperation) => void;
  readonly onCreateEnvironment: (view: RegisteredImageView) => void;
  readonly onDetails: (entry: ImageCatalogEntry, view: RegisteredImageView | null) => void;
}

type Blocker = 'docker' | 'windows' | 'platform' | null;

function blockerOf(entry: ImageCatalogEntry, docker: DockerStatus): Blocker {
  if (!docker.available) return 'docker';
  if (docker.os !== null && docker.os.toLowerCase() !== 'linux') return 'windows';
  if (docker.platform === null) return 'platform';
  if (entry.platforms.length > 0 && catalogPlatform(entry, docker.platform) === null) return 'platform';
  return null;
}

export function ImageCard({
  entry,
  registered,
  operation,
  docker,
  onDownload,
  onRepair,
  onCancel,
  onCreateEnvironment,
  onDetails,
}: ImageCardProps): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const active = operation !== null && !isTerminalPhase(operation.phase);
  const failed = operation !== null && isTerminalPhase(operation.phase) && operation.phase !== 'succeeded';
  const blocker = blockerOf(entry, docker);
  const platformEntry = catalogPlatform(entry, docker.platform);
  const size =
    platformEntry?.compressedLayerBytes ??
    entry.platforms.find((p) => p.compressedLayerBytes !== null)?.compressedLayerBytes ??
    null;
  const published = entry.platforms.some((platform) => platform.manifestDigest !== null);
  const highlights = highlightTools(entry.tools);
  const availability = registered?.availability ?? null;

  const blockerText = (): string => {
    switch (blocker) {
      case 'docker':
        return t('imageDockerRequired');
      case 'windows':
        return t('imagesDockerWindows');
      case 'platform':
        return t('imageUnsupportedHere');
      default:
        return '';
    }
  };

  const primary = (): JSX.Element => {
    if (active && operation !== null) {
      return (
        <button
          className="btn sm"
          type="button"
          disabled={operation.cancelRequested || operation.phase === 'registering'}
          onClick={() => onCancel(operation)}
        >
          {t(phaseKey(operation.phase))}… · {t('imageCancel')}
        </button>
      );
    }
    if (registered !== null && availability !== null) {
      if (availability.kind === 'ready') {
        return (
          <button
            className="btn primary sm"
            type="button"
            onClick={() => onCreateEnvironment(registered)}
            data-testid="image-create-environment"
          >
            <Layers size={13} /> {t('imageCreateEnvironment')}
          </button>
        );
      }
      if (availability.kind === 'missing' || availability.kind === 'unverified' || availability.kind === 'error') {
        const missing = availability.kind === 'missing';
        return (
          <button
            className="btn primary sm"
            type="button"
            disabled={blocker !== null}
            title={blockerText()}
            onClick={() => onRepair(registered)}
            data-testid="image-repair"
          >
            {missing ? <RefreshCw size={13} /> : <ShieldCheck size={13} />}{' '}
            {missing ? t('imageRedownload') : t('imageVerify')}
          </button>
        );
      }
      return (
        <button
          className="btn sm"
          type="button"
          disabled
          title={availability.kind === 'incompatible' ? availability.message : ''}
        >
          {t(availabilityKey(availability))}
        </button>
      );
    }
    if (failed) {
      return (
        <button
          className="btn primary sm"
          type="button"
          disabled={blocker !== null}
          title={blockerText()}
          onClick={() => onDownload(entry)}
          data-testid="image-download"
        >
          <RotateCcw size={13} /> {t('imageRetry')}
        </button>
      );
    }
    return (
      <button
        className="btn primary sm"
        type="button"
        disabled={blocker !== null}
        title={blockerText()}
        onClick={() => onDownload(entry)}
        data-testid="image-download"
      >
        <Download size={13} /> {t('imageDownload')}
      </button>
    );
  };

  return (
    <div
      className={`image-card ${entry.recommended ? 'recommended' : ''} ${registered !== null ? 'registered' : ''}`}
      data-testid="image-card"
      data-variant={entry.variant}
      data-entry-id={entry.id}
    >
      <div className="image-card-head">
        <span className="image-card-title">{entry.title[language]}</span>
        <span className="tag">{entry.variant}</span>
        {entry.recommended ? <span className="tag ok">{t('imageRecommended')}</span> : null}
        {registered !== null && availability !== null ? (
          <Pill tone={availabilityTone(availability)}>
            {availability.kind === 'ready' ? t('imageRegistered') : t(availabilityKey(availability))}
          </Pill>
        ) : null}
      </div>
      <p className="image-card-summary">{entry.summary[language]}</p>
      <div className="image-card-tools">
        {entry.inherits === null ? null : (
          <span className="tag">
            {entry.inherits} {t('imageInherits')}
          </span>
        )}
        {highlights.map((tool) => (
          <span className="tool-chip" key={tool.id} title={tool.id}>
            {toolLabel(tool)}
          </span>
        ))}
      </div>
      <dl className="image-card-facts">
        <dt>{t('imageRelease')}</dt>
        <dd>{entry.release}</dd>
        <dt>{t('imageDistributionSize')}</dt>
        <dd>{size === null ? t('imageSizeUnknown') : formatBytes(size)}</dd>
        {registered !== null && availability?.kind === 'ready' ? (
          <>
            <dt>{t('imageLocalSize')}</dt>
            <dd>{formatBytes(availability.localSizeBytes)}</dd>
          </>
        ) : null}
      </dl>
      {published ? null : <p className="hint image-card-note">{t('detailsNotPublished')}</p>}
      {blocker !== null && !active && registered === null ? (
        <p className="hint warn image-card-note">{blockerText()}</p>
      ) : null}
      {failed && operation?.error !== null && operation !== null ? (
        <p className="hint err image-card-note" data-testid="image-card-error">
          {operation.error.message}
        </p>
      ) : null}
      <div className="row image-card-actions">
        {primary()}
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => onDetails(entry, registered)}
          data-testid="image-details"
        >
          <Info size={13} /> {t('imageDetails')}
        </button>
        {registered !== null && availability?.kind === 'ready' ? (
          <span className="image-card-check">
            <CheckCircle2 size={13} /> {t('imageRegistered')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
