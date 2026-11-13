import type { ApprovalItem, Brain, LibraryItem } from '@insectoids/brain';
import { type DoneCard, type FolderScan, type RepeatedWork, type SkillDraft, type UserLibrary, findRepeatedWork } from '@insectoids/harness';
import { type LibraryImportResult, type LibraryScan, LibraryScanSchema } from '@insectoids/shared';

/**
 * The library's keeper in the Brain host (Capabilities 03-D5, D6; Phase 2 C3): imports, skills learned from
 * repeated work, retirement, and the user's decisions on them. Every change to what the hive may use waits for
 * the user's yes (an approval from the Librarian); the Queen relays one activity line (02-D4).
 */
export const LIBRARIAN = 'Librarian';
/** At most one skill proposal a day (03-D6: proposals shouldn't nag). */
export const PROPOSAL_EVERY_MS = 24 * 60 * 60_000;
/** At most this many retirement proposals per audit. */
const MAX_RETIREMENTS_PER_AUDIT = 3;

type LibraryPayload = { action: 'library-draft'; name: string } | { action: 'library-retire'; name: string; why: 'failing' | 'unused' };

export interface LibraryKeeperDeps {
  brain: Brain;
  user: UserLibrary;
  /** One activity line (relayed by the Queen). */
  note: (kind: string, text: string) => void;
  now: () => number;
  /** Skills that are never retired: the castes' and roles' defaults. */
  keep: ReadonlySet<string>;
}

const asScan = (s: FolderScan): LibraryScan => ({ verdict: s.verdict, findings: s.findings, scannedAt: s.scannedAt });

/** A list of findings in plain words for an approval ("2 warnings: …"). */
function findingsLine(scan: LibraryScan): string {
  if (!scan.findings.length) return 'The safety check found nothing to worry about.';
  const warn = scan.findings.filter((f) => f.severity === 'warn');
  const shown = warn
    .slice(0, 3)
    .map((f) => `${f.file}${f.line ? ` line ${f.line}` : ''}: ${f.message}`)
    .join(' ');
  return `The safety check found ${warn.length} thing${warn.length === 1 ? '' : 's'} to look at: ${shown}${warn.length > 3 ? ' …' : ''}`;
}

const quote = (s: string): string => `"${s}"`;

export class LibraryKeeper {
  constructor(private readonly d: LibraryKeeperDeps) {}

  // ---- imports (03-D5) -----------------------------------------------------------------------------

  /** Import a skill or agent folder: copy, scan, and (unless blocked) ask the user. */
  importFolder(path: string): LibraryImportResult {
    const { brain, user } = this.d;
    const r = user.importFolder(path, { taken: (n) => brain.library.get(n) !== undefined, now: this.d.now });
    if (!r.ok) return { status: 'error', message: r.message };
    const scan = asScan(r.stored.scan);
    const { item } = r.stored;
    brain.library.addDraft({ ...item, scan });
    if (scan.verdict === 'blocked') {
      const n = scan.findings.filter((f) => f.severity === 'block').length;
      this.d.note('library', `Imported ${quote(item.name)}, but the safety check blocked it (${n} problem${n === 1 ? '' : 's'}). It stays in the Library's drafts with the reasons and is never used.`);
    } else {
      this.#ask(item.name, 'skill_import', {
        title: `Use the imported ${item.kind} ${quote(item.name)}?`,
        whyItNeedsYou: `You imported it, and imported ${item.kind}s are only used after you say yes. ${findingsLine(scan)}`,
        ifYouSayYes: item.kind === 'skill' ? 'It becomes a Ready skill the hive can switch on for cards that need it.' : 'It becomes a Ready agent in the library, kept for reference (the hive runs its own castes).',
      });
      this.d.note('library', `Imported ${quote(item.name)}. It waits for your OK in Approvals.`);
    }
    return { status: 'imported', name: item.name, scan };
  }

  // ---- learned skills (03-D6) ----------------------------------------------------------------------

  /** Whether a new proposal may be made now (at most one a day). */
  proposalDue(): boolean {
    const last = this.d.brain.library.lastProposalAt();
    return last === null || this.d.now() - last >= PROPOSAL_EVERY_MS;
  }

  /**
   * The first cluster of repeated successful work that hasn't been proposed and isn't already covered by a
   * skill in the library. A covered cluster is remembered, so it isn't checked again.
   */
  repeatedWork(cards: readonly DoneCard[]): RepeatedWork | null {
    const lib = this.d.brain.library;
    for (const w of findRepeatedWork(cards, { skip: lib.proposedCardIds() })) {
      if (lib.proposed(w.cluster)) continue;
      const covering = lib.activatable(w.words.join(' '), { caste: w.caste, limit: 1, minTerms: Math.min(3, w.words.length) })[0];
      if (covering) {
        lib.recordProposal({ cluster: w.cluster, caste: w.caste, cards: w.cards.map((c) => c.id), item: covering.name, outcome: 'covered' });
        continue;
      }
      return w;
    }
    return null;
  }

  /**
   * The Librarian drafts a skill from repeated work (one short run), it is scanned, and it waits as a draft
   * with an approval. A failed or unusable draft is dropped with one activity line. The cluster is
   * remembered before the run, so the same work is never proposed twice.
   */
  async propose(work: RepeatedWork, draft: (w: RepeatedWork) => Promise<SkillDraft>): Promise<string | null> {
    const lib = this.d.brain.library;
    const cards = work.cards.map((c) => c.id);
    lib.recordProposal({ cluster: work.cluster, caste: work.caste, cards, item: null, outcome: 'drafting' });
    let d: SkillDraft;
    try {
      d = await draft(work);
    } catch (err) {
      d = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!d.ok) {
      lib.recordProposal({ cluster: work.cluster, caste: work.caste, cards, item: null, outcome: 'dropped' });
      this.d.note('library', `The hive noticed repeated work, but the Librarian's skill draft was unusable (${d.error}). Nothing changed.`);
      return null;
    }
    const name = this.#freeName(d.name);
    const markdown = name === d.name ? d.markdown : d.markdown.replace(/^name:.*$/m, `name: ${name}`);
    const stored = this.d.user.writeLearned(name, markdown, { cards, now: this.d.now });
    const scan = asScan(stored.scan);
    lib.addDraft({ ...stored.item, scan });
    if (scan.verdict === 'blocked') {
      lib.recordProposal({ cluster: work.cluster, caste: work.caste, cards, item: name, outcome: 'blocked' });
      this.d.note('library', `The Librarian drafted ${quote(name)} from repeated work, but the safety check blocked it. It stays in the Library's drafts, unused.`);
      return name;
    }
    const titles = work.cards.slice(0, 3).map((c) => quote(c.title)).join(', ');
    this.#ask(name, 'skill_proposal', {
      title: `New skill learned: ${quote(name)}`,
      whyItNeedsYou: `The hive did the same kind of work ${work.cards.length} times (${titles}) and it passed every time. The Librarian wrote this skill from it, so the next ${work.caste} gets it right the first time. ${findingsLine(scan)}`,
      ifYouSayYes: 'It becomes a Ready skill the hive can switch on for cards that need it.',
    });
    lib.recordProposal({ cluster: work.cluster, caste: work.caste, cards, item: name, outcome: 'drafted' });
    this.d.note('library', `The hive noticed the same work ${work.cards.length} times, and the Librarian drafted a skill, ${quote(name)}. It waits for your OK in Approvals.`);
    return name;
  }

  /** A name nothing in the catalog uses yet: the draft's own, or it with "-learned" (and a number). */
  #freeName(name: string): string {
    const lib = this.d.brain.library;
    if (!lib.get(name)) return name;
    const base = `${name.slice(0, 70)}-learned`;
    if (!lib.get(base)) return base;
    for (let i = 2; ; i++) if (!lib.get(`${base}-${i}`)) return `${base}-${i}`;
  }

  // ---- retirement (03-D6) --------------------------------------------------------------------------

  /** Propose retiring skills that keep failing, or learned and imported ones gone unused (free, plain code). */
  proposeRetirements(): number {
    const lib = this.d.brain.library;
    const candidates = lib.retirementCandidates({ now: this.d.now(), keep: this.d.keep }).slice(0, MAX_RETIREMENTS_PER_AUDIT);
    for (const c of candidates) {
      const settled = c.passed + c.failed;
      const why =
        c.why === 'failing'
          ? `It was switched on for ${c.uses} cards and they passed only ${c.passed} of ${settled} times.`
          : `It hasn't been used for ${Math.floor((this.d.now() - (c.lastUsedAt ?? c.approvedAt ?? this.d.now())) / 86_400_000)} days.`;
      this.#ask(c.name, 'skill_retirement', {
        title: `Retire the skill ${quote(c.name)}?`,
        whyItNeedsYou: `${why} Retiring it keeps cards from carrying it.`,
        ifYouSayYes: 'It is no longer switched on for cards. You can bring it back from the Library.',
        payload: { action: 'library-retire', name: c.name, why: c.why },
      });
    }
    if (candidates.length) {
      this.d.note('library', `The Librarian suggests retiring ${candidates.length} skill${candidates.length === 1 ? '' : 's'} that ${candidates.length === 1 ? 'keeps' : 'keep'} failing or went unused. ${candidates.length === 1 ? 'It waits' : 'They wait'} for your OK in Approvals.`);
    }
    return candidates.length;
  }

  // ---- the user's decisions ------------------------------------------------------------------------

  /** Whether an approval is the library's (the keeper decides it, not the hive). */
  owns(approvalId: string): boolean {
    const a = this.d.brain.approvals.get(approvalId);
    return Boolean(a && libraryPayload(a));
  }

  /** The user approved or turned down a library approval. */
  decide(approvalId: string, yes: boolean): void {
    const { brain } = this.d;
    const a = brain.approvals.get(approvalId);
    if (!a) throw new Error(`No approval ${approvalId}`);
    if (a.status !== 'waiting') throw new Error('This was already decided.');
    const p = libraryPayload(a);
    if (!p) throw new Error('This is not a library approval.');
    const item = brain.library.get(p.name);
    if (p.action === 'library-draft') {
      if (item && item.status === 'draft' && yes) {
        if (scanOf(item)?.verdict === 'blocked') throw new Error("It failed the safety check, so it can't be approved.");
        brain.library.approve(p.name);
        this.d.note('library', `You approved ${quote(p.name)}. The hive can now switch it on for cards that need it.`);
      } else if (item && item.status === 'draft') {
        brain.library.retire(p.name, 'You said no.');
        this.d.note('library', `You turned down ${quote(p.name)}. It is retired and never used; you can bring it back from the Library.`);
      }
    } else if (item) {
      if (yes && item.status !== 'retired') {
        brain.library.retire(p.name, p.why === 'failing' ? 'Retired with your OK: it kept failing.' : 'Retired with your OK: it went unused.');
        this.d.note('library', `Retired ${quote(p.name)}. You can bring it back from the Library.`);
      } else brain.library.setApproval(p.name, null);
    }
    brain.approvals.decide(approvalId, yes ? 'approved' : 'denied', { type: 'user' });
  }

  /** The user retires an item from the Library screen (a ready skill, or a draft). */
  retire(name: string): void {
    const { brain } = this.d;
    const it = brain.library.get(name);
    if (!it) throw new Error(`No item called ${quote(name)}.`);
    if (it.status === 'retired') throw new Error(`${quote(name)} is already retired.`);
    if (it.status === 'dormant') throw new Error('Dormant items are never used, so there is nothing to retire.');
    if (this.d.keep.has(name) || it.status === 'active') throw new Error(`${quote(name)} is always on for its castes, so it can't be retired.`);
    // Retiring answers any question still waiting on it: no.
    if (it.approvalId) {
      const a = brain.approvals.get(it.approvalId);
      if (a?.status === 'waiting') brain.approvals.decide(a.id, 'denied', { type: 'user' });
    }
    brain.library.retire(name, 'Retired by you.');
    this.d.note('library', `Retired ${quote(name)}. You can bring it back from the Library.`);
  }

  /** The user brings a retired item back: ready again, or a draft that asks again when it was never approved. */
  restore(name: string): void {
    const { brain } = this.d;
    const it = brain.library.get(name);
    if (!it || it.status !== 'retired') throw new Error(`${quote(name)} is not retired.`);
    if (scanOf(it)?.verdict === 'blocked') throw new Error("It failed the safety check, so it can't be used.");
    const status = brain.library.restore(name);
    if (status === 'draft') {
      const scan = scanOf(it);
      this.#ask(name, it.origin === 'learned' ? 'skill_proposal' : 'skill_import', {
        title: `Use the ${it.origin === 'learned' ? 'learned' : 'imported'} ${it.kind} ${quote(name)}?`,
        whyItNeedsYou: `You brought it back, and it was never approved. ${scan ? findingsLine(scan) : ''}`.trim(),
        ifYouSayYes: 'It becomes a Ready skill the hive can switch on for cards that need it.',
      });
      this.d.note('library', `Brought ${quote(name)} back as a draft. It waits for your OK in Approvals.`);
    } else this.d.note('library', `Brought ${quote(name)} back. The hive can switch it on again.`);
  }

  #ask(name: string, kind: 'skill_import' | 'skill_proposal' | 'skill_retirement', a: { title: string; whyItNeedsYou: string; ifYouSayYes: string; payload?: LibraryPayload }): void {
    const { brain } = this.d;
    const approval = brain.approvals.create({
      kind,
      title: a.title,
      from: LIBRARIAN,
      whyItNeedsYou: a.whyItNeedsYou,
      ifYouSayYes: a.ifYouSayYes,
      payload: a.payload ?? { action: 'library-draft', name },
    });
    brain.library.setApproval(name, approval.id);
  }
}

function libraryPayload(a: ApprovalItem): LibraryPayload | null {
  const p = a.payload as { action?: unknown; name?: unknown; why?: unknown } | null;
  if (!p || typeof p.name !== 'string') return null;
  if (p.action === 'library-draft') return { action: 'library-draft', name: p.name };
  if (p.action === 'library-retire') return { action: 'library-retire', name: p.name, why: p.why === 'unused' ? 'unused' : 'failing' };
  return null;
}

/** An item's stored scan, when it is a valid one. */
export function scanOf(item: Pick<LibraryItem, 'scan'>): LibraryScan | null {
  const r = LibraryScanSchema.safeParse(item.scan);
  return r.success ? r.data : null;
}
