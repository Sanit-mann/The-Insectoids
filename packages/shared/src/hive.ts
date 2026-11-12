import { z } from 'zod';

/** Insect castes (Capabilities 03-D3). New castes are added here when approved. */
export const CasteSchema = z.enum([
  'coder',
  'tester',
  'reviewer',
  'researcher',
  'documenter',
  'designer',
  'analyst',
  'writer',
]);
export type Caste = z.infer<typeof CasteSchema>;

/** Manager agents (Hive 02-D8). */
export const ManagerSchema = z.enum(['foreman', 'inspector', 'treasurer', 'librarian', 'watchdog', 'scout']);
export type Manager = z.infer<typeof ManagerSchema>;

/** Hierarchy rank (Hive 02-D1). */
export const RankSchema = z.enum(['queen', 'manager', 'insect']);
export type Rank = z.infer<typeof RankSchema>;

/** Live agent status shown in the UI; always paired with a text label (App 07-D9). */
export const AgentStatusSchema = z.enum(['working', 'waiting', 'blocked', 'done', 'paused', 'idle']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const PrioritySchema = z.enum(['critical', 'high', 'normal', 'low']);
export type Priority = z.infer<typeof PrioritySchema>;
