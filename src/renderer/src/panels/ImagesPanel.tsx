import { Download, Info, Layers, RefreshCw, Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { suggestEnvironmentName } from '../../../shared/environments.ts';
import { newId } from '../../../shared/id.ts';
import {
  entryById,
  imageDisplayName,
  imageReference,
  imageReferenceProblem,
  isTerminalPhase,
  repositoryDisplay,
} from '../../../shared/images.ts';
import type { ImageCatalogEntry, ImageOperation, RegisteredImageView } from '../../../shared/images.ts';
import type { EnvironmentDraft } from '../../../shared/types.ts';
import { EnvironmentDialog } from '../components/EnvironmentDialog.tsx';
import { ImageCard } from '../components/ImageCard.tsx';
import { ImageDetailsDialog } from '../components/ImageDetailsDialog.tsx';
import { ImageOperationProgress } from '../components/ImageOperationProgress.tsx';
import { ConfirmBanner, Pill, Section, TextField, formatBytes, formatTime } from '../components/ui.tsx';
import { availabilityKey, availabilityTone, operationForTarget } from '../images.ts';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp, useOperationList } from '../store.ts';

interface DetailsState {
  readonly entry: ImageCatalogEntry | null;
  readonly registered: RegisteredImageView | null;
}

export function ImagesPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const snapshot = useApp((state) => state.snapshot);
  const operations = useOperationList();
  const busy = useApp((state) => state.busy);
  const run = useApp((state) => state.run);
  const request = useApp((state) => state.request);
  const refresh = useApp((state) => state.refresh);
  const applyOperation = useApp((state) => state.applyOperation);
  const setToast = useApp((state) => state.setToast);

  const [details, setDetails] = useState<DetailsState | null>(null);
  const [environmentDraft, setEnvironmentDraft] = useState<EnvironmentDraft | null>(null);
  const [confirmUnregister, setConfirmUnregister] = useState<string | null>(null);
  const [customReference, setCustomReference] = useState('');
  const [customName, setCustomName] = useState('');

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { catalog, docker, images, config } = snapshot;
  const working = busy !== null;
  const linuxMode = docker.os === null || docker.os.toLowerCase() === 'linux';
  const canFetch = docker.available && linuxMode && docker.platform !== null;
  const active = operations.filter((operation) => !isTerminalPhase(operation.phase));
  const recent = operations.filter((operation) => isTerminalPhase(operation.phase)).slice(0, 6);
  const published = catalog.entries.some((entry) =>
    entry.platforms.some((platform) => platform.manifestDigest !== null),
  );
  const customProblem = customReference.trim() === '' ? null : imageReferenceProblem(customReference, language);

  const registeredForEntry = (entry: ImageCatalogEntry): RegisteredImageView | null =>
    images.find(
      (view) =>
        view.image.catalogEntryId === entry.id && (docker.platform === null || view.image.platform === docker.platform),
    ) ??
    images.find((view) => view.image.catalogEntryId === entry.id) ??
    null;

  const started = async (operation: ImageOperation | null): Promise<void> => {
    if (operation !== null) applyOperation(operation);
    await refresh();
  };

  const download = (entry: ImageCatalogEntry): void => {
    void (async () => {
      await started(await request(() => window.cc.imageDownloadStart({ catalogEntryId: entry.id })));
    })();
  };

  const registerCustom = (reference: string, name: string): void => {
    void (async () => {
      const operation = await request(() => window.cc.imageCustomStart({ reference, name }));
      if (operation !== null) {
        setCustomReference('');
        setCustomName('');
      }
      await started(operation);
    })();
  };

  const repair = (view: RegisteredImageView): void => {
    void (async () => {
      await started(await request(() => window.cc.imageRepairStart({ imageId: view.image.id })));
    })();
  };

  const cancel = (operation: ImageOperation): void => {
    void (async () => {
      const updated = await request(() => window.cc.imageCancel({ operationId: operation.id }));
      if (updated !== null) applyOperation(updated);
    })();
  };

  const retry = (operation: ImageOperation): void => {
    if (operation.kind === 'repair' && operation.registeredImageId !== null) {
      const view = images.find((candidate) => candidate.image.id === operation.registeredImageId);
      if (view !== undefined) repair(view);
      return;
    }
    if (operation.kind === 'custom') {
      const { repository, pinnedDigest, tag, title } = operation.target;
      registerCustom(imageReference(repository, pinnedDigest, tag), title[language]);
      return;
    }
    if (operation.catalogEntryId !== null) {
      const entry = entryById(catalog, operation.catalogEntryId);
      if (entry !== null) download(entry);
    }
  };

  const createEnvironment = (view: RegisteredImageView): void => {
    setEnvironmentDraft({
      id: newId('env'),
      name: suggestEnvironmentName(config, language),
      imageId: view.image.id,
      envText: '',
      setupScript: '',
    });
  };

  const unregister = (view: RegisteredImageView): void => {
    setConfirmUnregister(null);
    void (async () => {
      const done = await run('image', () => window.cc.imageUnregister({ imageId: view.image.id }));
      if (done !== null) setToast(`${t('imageUnregisterDone')}: ${imageDisplayName(view.image, language)}`);
    })();
  };

  const dockerLine = (): { text: string; tone: 'ok' | 'warn' | 'err' } => {
    if (!docker.available)
      return { text: `${t('imagesDockerDown')}${docker.error === null ? '' : ` — ${docker.error}`}`, tone: 'err' };
    if (!linuxMode) return { text: t('imagesDockerWindows'), tone: 'err' };
    if (docker.platform === null)
      return {
        text: `${t('imagesDockerUnsupported')} (${docker.os ?? '?'}/${docker.architecture ?? '?'})`,
        tone: 'warn',
      };
    return {
      text: `${t('imagesDockerReady')} — ${docker.version ?? ''} · ${docker.platform}${docker.name === null ? '' : ` · ${docker.name}`}`,
      tone: 'ok',
    };
  };
  const dockerState = dockerLine();

  return (
    <>
      <Section
        title={t('imagesTitle')}
        actions={
          <button
            className="btn sm"
            type="button"
            disabled={working}
            onClick={() => void run('docker', () => window.cc.imageRefresh())}
            data-testid="images-refresh"
          >
            <RefreshCw size={13} /> {t('imagesRecheck')}
          </button>
        }
      >
        <p className="hint">{t('imagesIntro')}</p>
        <p
          className={`hint ${dockerState.tone === 'ok' ? '' : dockerState.tone === 'warn' ? 'warn' : 'err'}`}
          data-testid="images-docker-state"
        >
          {dockerState.text}
        </p>
      </Section>

      <Section title={t('imagesCatalogTitle')}>
        <p className="hint">{t('imagesCatalogHint')}</p>
        <p className="legend" style={{ margin: '0 0 10px' }}>
          {t('imagesCatalogRepository')}: {repositoryDisplay(catalog.repository)}
          {catalog.entries[0] === undefined ? '' : ` · ${t('imagesCatalogRelease')} ${catalog.entries[0].release}`}
        </p>
        {published ? null : <p className="hint warn">{t('imagesCatalogUnpublished')}</p>}
        <div className="image-grid" data-testid="image-catalog">
          {catalog.entries.map((entry) => (
            <ImageCard
              key={entry.id}
              entry={entry}
              registered={registeredForEntry(entry)}
              operation={operationForTarget(
                operations,
                (operation) => operation.catalogEntryId === entry.id && operation.kind === 'download',
              )}
              docker={docker}
              onDownload={download}
              onRepair={repair}
              onCancel={cancel}
              onCreateEnvironment={createEnvironment}
              onDetails={(target, registered) => setDetails({ entry: target, registered })}
            />
          ))}
        </div>
      </Section>

      <Section title={t('imagesCustomTitle')}>
        <p className="hint">{t('imagesCustomHint')}</p>
        <div className="grid2">
          <TextField
            label={t('imagesCustomReference')}
            value={customReference}
            onChange={setCustomReference}
            hint={t('imagesCustomReferenceHint')}
            placeholder="ghcr.io/owner/image:tag"
          />
          <TextField
            label={t('imagesCustomName')}
            value={customName}
            onChange={setCustomName}
            hint={t('imagesCustomNameHint')}
            mono={false}
          />
        </div>
        {customProblem === null ? null : <p className="hint warn">{customProblem}</p>}
        <div className="row">
          <button
            className="btn primary sm"
            type="button"
            disabled={working || !canFetch || customReference.trim() === '' || customProblem !== null}
            title={canFetch ? '' : dockerState.text}
            onClick={() => registerCustom(customReference, customName)}
            data-testid="custom-image-register"
          >
            <Download size={13} /> {t('imagesCustomRegister')}
          </button>
        </div>
      </Section>

      <Section title={t('imagesOperationsTitle')}>
        {active.length === 0 && recent.length === 0 ? <p className="empty">{t('imagesOperationsEmpty')}</p> : null}
        {active.map((operation) => (
          <ImageOperationProgress key={operation.id} operation={operation} onCancel={cancel} onRetry={retry} />
        ))}
        {recent.map((operation) => (
          <ImageOperationProgress key={operation.id} operation={operation} onCancel={cancel} onRetry={retry} compact />
        ))}
      </Section>

      <Section title={t('imagesRegisteredTitle')}>
        {images.length === 0 ? <p className="empty">{t('imagesRegisteredEmpty')}</p> : null}
        <div className="env-list" data-testid="registered-images">
          {images.map((view) => {
            const ready = view.availability.kind === 'ready';
            const repairable = view.availability.kind === 'missing' || view.availability.kind === 'error';
            const running = operationForTarget(
              operations,
              (operation) => operation.registeredImageId === view.image.id && !isTerminalPhase(operation.phase),
            );
            return (
              <div
                className="env-row image-row"
                key={view.image.id}
                data-image-id={view.image.id}
                data-testid="registered-image"
              >
                <div className="env-row-body">
                  <div className="env-row-name">
                    <span>{imageDisplayName(view.image, language)}</span>
                    <span className="tag">{view.image.variant ?? t('imageCustom')}</span>
                    <span className="tag">{view.image.platform}</span>
                    <Pill tone={availabilityTone(view.availability)}>{t(availabilityKey(view.availability))}</Pill>
                    {view.inCatalog ? null : (
                      <span className="tag warn" title={t('imageNotInCatalogHint')}>
                        {t('imageNotInCatalog')}
                      </span>
                    )}
                  </div>
                  <div className="env-row-meta" title={view.image.pinnedDigest ?? ''}>
                    {imageReference(view.image.repository, view.image.pinnedDigest, view.image.tag)}
                  </div>
                  <div className="env-row-meta">
                    {[
                      `${t('imageLocalSize')} ${ready ? formatBytes(view.availability.kind === 'ready' ? view.availability.localSizeBytes : null) : t('commonNone')}`,
                      pick(
                        language,
                        `環境 ${view.environmentIds.length} 件`,
                        `${view.environmentIds.length} environment${view.environmentIds.length === 1 ? '' : 's'}`,
                      ),
                      pick(
                        language,
                        `タスク ${view.appliedTaskIds.length} 件`,
                        `${view.appliedTaskIds.length} task${view.appliedTaskIds.length === 1 ? '' : 's'}`,
                      ),
                      `${t('imageRegisteredAt')} ${formatTime(view.image.registeredAt)}`,
                    ].join(' · ')}
                  </div>
                  {view.availability.kind === 'incompatible' ||
                  view.availability.kind === 'error' ||
                  view.availability.kind === 'unavailable' ? (
                    <div className="env-row-meta">{view.availability.message}</div>
                  ) : null}
                  {confirmUnregister === view.image.id ? (
                    <ConfirmBanner
                      message={t('imageUnregisterConfirm')}
                      onConfirm={() => unregister(view)}
                      onCancel={() => setConfirmUnregister(null)}
                      spaced
                    />
                  ) : null}
                </div>
                <div className="row">
                  {ready ? (
                    <button className="btn sm" type="button" disabled={working} onClick={() => createEnvironment(view)}>
                      <Layers size={13} /> {t('imageCreateEnvironment')}
                    </button>
                  ) : null}
                  {repairable && running === null ? (
                    <button
                      className="btn sm"
                      type="button"
                      disabled={working || !docker.available}
                      onClick={() => repair(view)}
                      data-testid="registered-image-repair"
                    >
                      <RefreshCw size={13} /> {t('imageRedownload')}
                    </button>
                  ) : null}
                  {running !== null ? <span className="tag warn">{t('commonRunning')}</span> : null}
                  <button
                    className="btn ghost sm"
                    type="button"
                    onClick={() =>
                      setDetails({
                        entry: entryById(catalog, view.image.catalogEntryId),
                        registered: view,
                      })
                    }
                  >
                    <Info size={13} /> {t('imageDetails')}
                  </button>
                  <button
                    className="btn danger sm"
                    type="button"
                    disabled={working || running !== null}
                    onClick={() => setConfirmUnregister(view.image.id)}
                    data-testid="registered-image-unregister"
                  >
                    <Trash2 size={13} /> {t('imageUnregister')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {details === null ? null : (
        <ImageDetailsDialog
          entry={details.entry}
          registered={details.registered}
          platform={docker.platform}
          onClose={() => setDetails(null)}
        />
      )}
      {environmentDraft === null ? null : (
        <EnvironmentDialog
          key={environmentDraft.id}
          mode="create"
          initial={environmentDraft}
          onClose={() => setEnvironmentDraft(null)}
        />
      )}
    </>
  );
}
