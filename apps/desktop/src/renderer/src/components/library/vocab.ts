import type { CasteView, LibraryItemDetail, LibraryItemView, LibraryStatus } from '@insectoids/shared';
import { Bot, BookOpenCheck, CircleCheck, CircleDashed, CircleX, FileText, Globe, Library, LoaderCircle, PencilLine, type LucideIcon, Moon, Power, Wrench, WifiOff } from 'lucide-react';

/** Status wording follows the shared contract (LibraryStatusSchema), in the user's words. */
export const STATUS: Record<LibraryStatus, { label: string; icon: LucideIcon; explain: string; className: string }> = {
  active: {
    label: 'Active',
    icon: Power,
    explain: 'Always on for its castes: the caste agents and their default skills.',
    className: 'border-st-done/60 text-st-done',
  },
  ready: {
    label: 'Ready',
    icon: BookOpenCheck,
    explain: 'Rewritten and safety-checked. Switched on for a card only when that card needs it.',
    className: 'border-honey/60 text-honey-text',
  },
  dormant: {
    label: 'Dormant',
    icon: Moon,
    explain: 'Listed in the catalog only. Not rewritten or safety-scanned yet, so it is never switched on.',
    className: 'border-line text-muted',
  },
  draft: {
    label: 'Draft',
    icon: PencilLine,
    explain: 'Proposed by the hive and waiting for you.',
    className: 'border-dashed border-line text-muted',
  },
};

export const STATUS_ORDER: LibraryStatus[] = ['active', 'ready', 'dormant', 'draft'];

export const KIND: Record<LibraryItemView['kind'], { label: string; plural: string; icon: LucideIcon }> = {
  agent: { label: 'Agent', plural: 'Agents', icon: Bot },
  skill: { label: 'Skill', plural: 'Skills', icon: FileText },
  tool: { label: 'Tool', plural: 'Tools', icon: Wrench },
};

export const NETWORK: Record<CasteView['network'], { label: string; hint: string; icon: LucideIcon }> = {
  none: { label: 'No network', hint: 'Works offline: no internet at all.', icon: WifiOff },
  docs: { label: 'Documentation sites only', hint: 'May read documentation sites, nothing else.', icon: Library },
  web: { label: 'Read-only web', hint: 'May read the open web; never posts or changes anything there.', icon: Globe },
};

export const SAFETY: Record<LibraryItemView['safety'], string> = {
  vetted: 'Safety-checked, not yet field-tested',
  unscanned: 'Not checked yet: never switched on',
};

export const OUTCOME: Record<LibraryItemDetail['recentCards'][number]['outcome'], { label: string; icon: LucideIcon; className: string }> = {
  passed: { label: 'Passed', icon: CircleCheck, className: 'text-st-done' },
  failed: { label: 'Failed', icon: CircleX, className: 'text-st-blocked' },
  running: { label: 'Running', icon: LoaderCircle, className: 'text-st-working' },
};

export const DormantIcon = CircleDashed;

/** "Used 4 times · passed 3"; "Not used yet". */
export function usageLine(u: LibraryItemView['usage']): string {
  if (u.uses === 0) return 'Not used yet';
  return `Used ${u.uses} ${u.uses === 1 ? 'time' : 'times'} · passed ${u.passed}${u.failed ? ` · failed ${u.failed}` : ''}`;
}
