import type { LibraryScan } from '@insectoids/shared';
import { cn } from '@/lib/utils';
import { RULE, VERDICT } from './vocab';

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The import safety scan (Capabilities 03-D5) for a learned or imported item: the verdict in words with an
 * icon, then every finding with its rule, where it is, and why. Never colour alone.
 */
export function ScanResult({ scan }: { scan: LibraryScan }) {
  const v = VERDICT[scan.verdict];
  const Icon = v.icon;
  const blockRules = [...new Set(scan.findings.filter((f) => f.severity === 'block').map((f) => RULE[f.rule].toLowerCase()))];
  return (
    <section aria-labelledby="lib-scan" className="flex flex-col gap-2 rounded-[10px] border border-line bg-ground p-3">
      <h3 className="m-0 font-display text-sm font-semibold" id="lib-scan">
        Safety scan
      </h3>
      <p className={cn('m-0 inline-flex flex-wrap items-center gap-1.5 text-sm font-semibold', v.className)} data-testid="scan-verdict" data-verdict={scan.verdict}>
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {v.label}
        <span className="font-normal text-muted">· scanned {when(scan.scannedAt)}</span>
      </p>
      <p className="m-0 text-xs text-muted">{v.explain}</p>
      {scan.verdict === 'blocked' ? (
        <p className="m-0 text-sm" data-testid="scan-blocked">
          This can&rsquo;t be approved: {blockRules.length ? blockRules.join(', ') : 'the scan blocked it'}.
        </p>
      ) : null}
      {scan.findings.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {scan.findings.map((f, i) => (
            <li
              className={cn('flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-xs', f.severity === 'block' ? 'border-st-blocked/50' : 'border-st-waiting/50')}
              data-rule={f.rule}
              data-severity={f.severity}
              data-testid="scan-finding"
              key={`${f.rule}-${f.file}-${f.line ?? 'x'}-${i}`}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{f.severity === 'block' ? 'Blocks it' : 'Worth a look'}</span>
                <span>· {RULE[f.rule]}</span>
                <span className="font-mono text-muted">
                  {f.file}
                  {f.line !== null ? `:${f.line}` : ''}
                </span>
              </span>
              <span className="break-words">{f.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
