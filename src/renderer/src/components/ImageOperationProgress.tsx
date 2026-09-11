import { RotateCcw, X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { imageReference, isTerminalPhase, operationProgress } from '../../../shared/images.ts';
import type { ImageOperation } from '../../../shared/images.ts';
import { formatDuration, kindKey, phaseKey, phaseTone, stepKey } from '../images.ts';
import { useLanguage, useT } from '../i18n.ts';
import { Pill, formatBytes } from './ui.tsx';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function ImageOperationProgress({
  operation,
  onCancel,
  onRetry,
  compact = false,
}: {
  operation: ImageOperation;
  onCancel: (operation: ImageOperation) => void;
  onRetry: (operation: ImageOperation) => void;
  compact?: boolean;
}): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const active = !isTerminalPhase(operation.phase);
  const now = useNow(active);
  const ratio = operationProgress(operation);
  const started = new Date(operation.startedAt).getTime();
  const finished = operation.finishedAt === null ? now : new Date(operation.finishedAt).getTime();
  const elapsed = Number.isNaN(started) ? 0 : Math.max(0, finished - started);
  const step = stepKey(operation);
  const { target } = operation;

  return (
    <div className={`op-card phase-${operation.phase}`} data-testid="image-operation" data-operation-id={operation.id}>
      <div className="op-head">
        <span className="op-title">{target.title[language]}</span>
        <span className="tag">{t(kindKey(operation.kind))}</span>
        <Pill tone={phaseTone(operation.phase)}>{t(phaseKey(operation.phase))}</Pill>
        {operation.cancelRequested && active ? <span className="tag warn">{t('opPhaseCancelled')}…</span> : null}
        <span className="spacer" />
        <span className="op-meta">
          {t('opElapsed')} {formatDuration(elapsed)}
        </span>
        {active ? (
          <button
            className="btn ghost sm"
            type="button"
            disabled={operation.cancelRequested || operation.phase === 'registering'}
            onClick={() => onCancel(operation)}
            data-testid="image-operation-cancel"
          >
            <X size={13} /> {t('imageCancel')}
          </button>
        ) : operation.phase !== 'succeeded' ? (
          <button
            className="btn sm"
            type="button"
            onClick={() => onRetry(operation)}
            data-testid="image-operation-retry"
          >
            <RotateCcw size={13} /> {t('imageRetry')}
          </button>
        ) : null}
      </div>

      {active ? (
        <div className={`op-bar ${ratio === null ? 'indeterminate' : ''}`}>
          <span style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }} />
        </div>
      ) : null}

      <div className="op-meta-row">
        <span className="op-meta">{imageReference(target.repository, target.pinnedDigest, target.tag)}</span>
        {operation.phase === 'pulling' || operation.totalLayers > 0 ? (
          <span>
            {t('opReceived')} {formatBytes(operation.downloadedBytes)}
            {operation.totalBytes === null ? '' : ` / ${formatBytes(operation.totalBytes)}`}
            {' · '}
            {t('opLayers')} {operation.completedLayers}/{operation.totalLayers}
            {operation.pulled ? '' : ` · ${t('opStepLocalFound')}`}
          </span>
        ) : null}
        {step === null ? null : <span>{t(step)}</span>}
        {target.platform === null ? null : <span className="op-meta">{target.platform}</span>}
      </div>

      {!compact && operation.phase === 'pulling' && operation.layers.length > 0 ? (
        <div className="op-layers">
          {operation.layers.slice(0, 12).map((layer) => {
            const share =
              layer.total === null || layer.total === 0
                ? layer.done
                  ? 1
                  : 0
                : Math.min(1, layer.current / layer.total);
            return (
              <div className="op-layer" key={layer.id} title={`${layer.id} — ${layer.status}`}>
                <span className="op-layer-id">{layer.id.slice(0, 12)}</span>
                <span className="op-layer-bar">
                  <span style={{ width: `${Math.round(share * 100)}%` }} />
                </span>
                <span className="op-layer-status">{layer.status}</span>
              </div>
            );
          })}
          {operation.layers.length > 12 ? <div className="op-meta">… +{operation.layers.length - 12}</div> : null}
        </div>
      ) : null}

      {operation.error === null ? null : (
        <div className="op-error" data-testid="image-operation-error">
          <span className="tag err">{operation.error.code}</span> {operation.error.message}
          {operation.error.code === 'RATE_LIMITED' ? <p className="hint">{t('opRateLimitHint')}</p> : null}
        </div>
      )}
    </div>
  );
}
