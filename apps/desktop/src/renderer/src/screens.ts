import {
  BookOpen,
  Brain,
  Clock,
  Columns3,
  GitBranch,
  Hexagon,
  Inbox,
  MessageSquare,
  Plug,
  Settings,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export type ScreenId =
  | 'queen'
  | 'approvals'
  | 'taskboard'
  | 'hive'
  | 'brain'
  | 'changes'
  | 'library'
  | 'connections'
  | 'budgets'
  | 'cadence'
  | 'settings';

export interface ScreenDef {
  id: ScreenId;
  label: string;
  icon: LucideIcon;
  /** Roadmap phase (function 10) in which the screen comes alive. */
  phase: number;
  blurb: string;
}

export const SCREENS: readonly ScreenDef[] = [
  { id: 'queen', label: 'Queen', icon: MessageSquare, phase: 1, blurb: 'Your one conversation with the hive.' },
  { id: 'approvals', label: 'Approvals', icon: Inbox, phase: 1, blurb: 'Everything the hive is waiting on you for.' },
  { id: 'taskboard', label: 'Taskboard', icon: Columns3, phase: 1, blurb: 'Task cards by wave and status. Insects pull cards for their caste.' },
  { id: 'hive', label: 'Hive', icon: Hexagon, phase: 1, blurb: 'Every agent: task, model, effort, tokens and live output.' },
  { id: 'brain', label: 'Brain', icon: Brain, phase: 1, blurb: 'The shared memory: decisions, files, tasks, facts and how they link.' },
  { id: 'changes', label: 'Changes', icon: GitBranch, phase: 1, blurb: 'What each card changed, undo, and merging into your main branch.' },
  { id: 'library', label: 'Library', icon: BookOpen, phase: 2, blurb: 'Agents, skills and tools: active and dormant.' },
  { id: 'connections', label: 'Connections', icon: Plug, phase: 2, blurb: 'AI engines, API providers, services and the vault.' },
  { id: 'budgets', label: 'Budgets', icon: Wallet, phase: 2, blurb: 'Goal, caste and subscription spend, and how the Treasurer routed each run.' },
  { id: 'cadence', label: 'Cadence', icon: Clock, phase: 3, blurb: 'Schedules, triggers and the "while you were away" digest.' },
  { id: 'settings', label: 'Settings', icon: Settings, phase: 1, blurb: 'Limits, protected paths, Brain location, theme.' },
];
