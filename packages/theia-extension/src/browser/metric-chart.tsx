import React from '@theia/core/shared/react';
import type { EventRecord } from '../common/protocol.js';

export function MetricChart({
  values,
  compare = [],
}: {
  values: EventRecord[];
  compare?: EventRecord[];
}) {
  const primary = values.filter((v) => Number.isFinite(Number(v.value))),
    secondary = compare.filter((v) => Number.isFinite(Number(v.value)));
  if (!primary.length) return null;
  const all = [...primary, ...secondary],
    low = Math.min(...all.map((v) => Number(v.value))),
    high = Math.max(...all.map((v) => Number(v.value)));
  const axis = (v: EventRecord) => v.step ?? v.timestamp;
  const start = Math.min(...all.map(axis)),
    end = Math.max(...all.map(axis));
  const points = (series: EventRecord[]) =>
    series
      .map(
        (v) =>
          `${10 + ((axis(v) - start) / Math.max(1, end - start)) * 280},${90 - ((Number(v.value) - low) / Math.max(0.000001, high - low)) * 75}`,
      )
      .join(' ');
  return (
    <svg
      viewBox="0 0 300 115"
      role="img"
      aria-label={`${primary[0].name}: ${primary.length} samples, latest ${primary.at(-1)?.value}${secondary.length ? '; comparison shown dashed' : ''}`}
    >
      <path d="M10 90H290" stroke="currentColor" opacity=".2" />
      <polyline
        points={points(primary)}
        fill="none"
        stroke="var(--aiide-accent)"
        strokeWidth="2"
      />
      {secondary.length > 0 && (
        <polyline
          points={points(secondary)}
          fill="none"
          stroke="currentColor"
          opacity=".45"
          strokeDasharray="4 2"
          strokeWidth="2"
        />
      )}
      <text x="10" y="110" fill="currentColor" fontSize="10">
        {all.every((v) => v.step !== undefined) ? start : 'Start'}
      </text>
      <text x="260" y="110" fill="currentColor" fontSize="10">
        {all.every((v) => v.step !== undefined) ? end : 'Latest'}
      </text>
    </svg>
  );
}
