import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Copies text: the async Clipboard API, with the old textarea route as a fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/**
 * An exact command in a mono box with a Copy button (Connections 04-D6: the user sees exactly what
 * would run). It is also the fallback next to the one-click install with consent (EngineInstall, C4).
 */
export function CopyCommand({ label, command, note, testId }: { label: string; command: string; note: string; testId?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex min-h-10 min-w-0 flex-1 items-center whitespace-pre-wrap break-all rounded-[10px] border border-line bg-ground px-3 py-2 font-mono text-xs text-text">
          {command}
        </code>
        <Button
          aria-label={`Copy: ${command}`}
          onClick={() => void copyText(command).then((ok) => setState(ok ? 'copied' : 'failed'))}
          size="sm"
          type="button"
          variant="outline"
        >
          {state === 'copied' ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted">{note}</p>
      <span aria-live="polite" className="sr-only">
        {state === 'copied' ? 'Command copied' : state === 'failed' ? 'Could not copy; select the command and copy it by hand' : ''}
      </span>
    </div>
  );
}
