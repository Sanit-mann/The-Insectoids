import { BookOpenCheck, Bot, CheckCircle2, FileText, Gavel, type LucideIcon, ListChecks, Megaphone, Trophy } from 'lucide-react';
import type { RecordKind, Trust } from '@insectoids/shared';

export const KINDS: ReadonlyArray<{ kind: RecordKind; label: string; icon: LucideIcon }> = [
  { kind: 'decision', label: 'Decision', icon: Gavel },
  { kind: 'fact', label: 'Fact', icon: CheckCircle2 },
  { kind: 'task', label: 'Task', icon: ListChecks },
  { kind: 'outcome', label: 'Outcome', icon: Trophy },
  { kind: 'file', label: 'File', icon: FileText },
  { kind: 'update', label: 'Update', icon: Megaphone },
  { kind: 'agent_memory', label: 'Agent memory', icon: Bot },
  { kind: 'lesson', label: 'Lesson', icon: BookOpenCheck },
];

export const kindInfo = (k: RecordKind) => KINDS.find((x) => x.kind === k) ?? KINDS[0]!;

/** Trust as words plus a status colour (Memory 01-D3; never colour-only). */
export const TRUST: Record<Trust, { label: string; hint: string; className: string }> = {
  confirmed: { label: 'Confirmed', hint: 'You confirmed this, or you wrote it.', className: 'border-st-done/50 text-st-done' },
  unconfirmed: { label: 'Unconfirmed', hint: 'An agent noted this; it is waiting for you to confirm.', className: 'border-st-waiting/50 text-st-waiting' },
  proposed: { label: 'Proposed', hint: 'An agent proposed this decision; it needs your approval.', className: 'border-st-paused/50 text-st-paused' },
};

/**
 * How each kind is drawn in the graph (Phase 2 B5): its own shape AND colour, so identity never rests
 * on colour alone. Colours are the `--kind-n` tokens (validated categorical palette), in KINDS order.
 */
export type KindShape = 'diamond' | 'circle' | 'square' | 'star' | 'pentagon' | 'triangle' | 'hexagon' | 'triangle-down';
export const KIND_MARK: Record<RecordKind, { shape: KindShape; color: string }> = {
  decision: { shape: 'diamond', color: 'var(--kind-1)' },
  fact: { shape: 'circle', color: 'var(--kind-2)' },
  task: { shape: 'square', color: 'var(--kind-3)' },
  outcome: { shape: 'star', color: 'var(--kind-4)' },
  file: { shape: 'pentagon', color: 'var(--kind-5)' },
  update: { shape: 'triangle', color: 'var(--kind-6)' },
  agent_memory: { shape: 'hexagon', color: 'var(--kind-7)' },
  lesson: { shape: 'triangle-down', color: 'var(--kind-8)' },
};

function polygon(sides: number, radius: number, startDeg: number, inner?: number): string {
  const pts: string[] = [];
  const steps = inner === undefined ? sides : sides * 2;
  for (let i = 0; i < steps; i++) {
    const r = inner !== undefined && i % 2 === 1 ? radius * inner : radius;
    const a = ((startDeg + (360 / steps) * i) * Math.PI) / 180;
    pts.push(`${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`);
  }
  return `M ${pts.join(' L ')} Z`;
}

/** An SVG path for a shape of about radius `r`, centred on (0, 0). Areas are roughly equal across shapes. */
export function shapePath(shape: KindShape, r: number): string {
  switch (shape) {
    case 'circle':
      return `M ${r} 0 A ${r} ${r} 0 1 1 ${-r} 0 A ${r} ${r} 0 1 1 ${r} 0 Z`;
    case 'square': {
      const s = r * 0.89;
      return `M ${-s} ${-s} H ${s} V ${s} H ${-s} Z`;
    }
    case 'diamond':
      return polygon(4, r * 1.25, -90);
    case 'triangle':
      return polygon(3, r * 1.35, -90);
    case 'triangle-down':
      return polygon(3, r * 1.35, 90);
    case 'pentagon':
      return polygon(5, r * 1.1, -90);
    case 'hexagon':
      return polygon(6, r * 1.06, 0);
    case 'star':
      return polygon(5, r * 1.4, -90, 0.5);
  }
}
