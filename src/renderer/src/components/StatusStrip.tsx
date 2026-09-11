import type { JSX } from 'react';

import type { Snapshot } from '../../../shared/types.ts';
import { useT } from '../i18n.ts';
import { useActiveOperationList } from '../store.ts';

export type Lamp = 'live' | 'hold' | 'fault' | 'off';

function Cell({
  legend,
  lamp,
  value,
  testId,
}: {
  legend: string;
  lamp: Lamp;
  value: string;
  testId?: string;
}): JSX.Element {
  return (
    <div className={`panel-cell lamp-${lamp}`} data-testid={testId}>
      <span className="panel-legend">{legend}</span>
      <span className="panel-value">
        <span className="lamp" />
        {value}
      </span>
    </div>
  );
}

export function StatusStrip({ snapshot }: { snapshot: Snapshot | null }): JSX.Element {
  const t = useT();
  const activeOperations = useActiveOperationList();

  if (snapshot === null) {
    return (
      <div className="panel-strip">
        <Cell legend={t('panelDocker')} lamp="off" value="—" />
      </div>
    );
  }

  const { docker, images, tasks, config } = snapshot;
  const running = tasks.filter((view) => view.container.running).length;
  const ready = images.filter((view) => view.availability.kind === 'ready').length;
  const mcpCount = config.extensions.mcpServers.filter((server) => server.enabled).length;
  const skillCount = config.extensions.skillInstalls.filter((skill) => skill.enabled).length;
  const pluginCount = config.extensions.plugins.filter((plugin) => plugin.enabled).length;

  const dockerValue = docker.available
    ? `${docker.version ?? 'ok'}${docker.platform === null ? '' : ` · ${docker.platform}`}`
    : t('panelDown');
  const imagesValue =
    images.length === 0
      ? t('panelNone')
      : `${ready} ${t('panelReady')} / ${images.length} ${t('panelRegistered')}${activeOperations.length === 0 ? '' : ` · ↓${activeOperations.length}`}`;

  return (
    <div className="panel-strip">
      <Cell
        legend={t('panelDocker')}
        lamp={docker.available ? 'live' : 'fault'}
        value={dockerValue}
        testId="strip-docker"
      />
      <Cell
        legend={t('panelImages')}
        lamp={activeOperations.length > 0 ? 'hold' : ready > 0 ? 'live' : images.length > 0 ? 'hold' : 'off'}
        value={imagesValue}
        testId="strip-images"
      />
      <Cell
        legend={t('panelTasks')}
        lamp={running > 0 ? 'live' : tasks.length > 0 ? 'hold' : 'off'}
        value={tasks.length === 0 ? t('panelNone') : `${running} ${t('panelRunning')} / ${tasks.length}`}
      />
      <Cell
        legend={t('panelExtensions')}
        lamp={mcpCount + pluginCount + skillCount > 0 ? 'live' : 'off'}
        value={`mcp ${mcpCount} · plg ${pluginCount} · skl ${skillCount}`}
      />
    </div>
  );
}
