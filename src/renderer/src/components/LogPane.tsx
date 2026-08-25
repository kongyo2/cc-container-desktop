/** Scrollback for build and provisioning output, pinned to the bottom while the user is there. */

import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

import { useApp } from '../store.ts';

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function LogPane(): JSX.Element {
  const logs = useApp((state) => state.logs);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lineCount = logs.length;

  useEffect(() => {
    const node = ref.current;
    if (node === null || lineCount === 0 || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [lineCount]);

  return (
    <div
      className="logpane"
      ref={ref}
      onScroll={(event) => {
        const node = event.currentTarget;
        // Re-pin only when the user scrolls back to within a line of the bottom.
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
    >
      {lineCount === 0 ? <span className="l-time">—</span> : null}
      {logs.map((line) => (
        <div key={line.seq} className={`l-${line.level}`}>
          <span className="l-time">{stamp(line.at)} </span>
          {line.text}
        </div>
      ))}
    </div>
  );
}
