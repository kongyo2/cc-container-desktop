import type { JSX } from 'react';

import type { Snapshot } from '../../../shared/types.ts';
import { useT } from '../i18n.ts';

export type Lamp = 'live' | 'hold' | 'fault' | 'off';

function Cell({ legend, lamp, value }: { legend: string; lamp: Lamp; value: string }): JSX.Element {
  return (
    <div className={`panel-cell lamp-${lamp}`}>
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

  if (snapshot === null) {
    return (
      <div className="panel-strip">
        <Cell legend={t('panelDocker')} lamp="off" value="—" />
      </div>
    );
  }

  const { docker, image, tasks, config } = snapshot;
  const running = tasks.filter((view) => view.container.running).length;
  const mcpCount = config.extensions.mcpServers.filter((server) => server.enabled).length;
  const skillCount = config.extensions.skillInstalls.filter((skill) => skill.enabled).length;
  const pluginCount = config.extensions.plugins.filter((plugin) => plugin.enabled).length;

  const short = (text: string, max = 22): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

  return (
    <div className="panel-strip">
      <Cell
        legend={t('panelDocker')}
        lamp={docker.available ? 'live' : 'fault'}
        value={docker.available ? (docker.version ?? 'ok') : t('panelDown')}
      />
      <Cell
        legend={t('panelImage')}
        lamp={image.exists ? 'live' : 'hold'}
        value={image.exists ? short(image.tag) : t('panelNotBuilt')}
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
