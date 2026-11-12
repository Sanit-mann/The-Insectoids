/**
 * Eval queries over the corpus in corpus.ts. Paraphrases deliberately avoid the passages' own words
 * (that is the case meaning search must win); keyword queries are the case FTS5 already handles well.
 */
export interface EvalQuery {
  q: string;
  relevant: string[];
  kind: 'paraphrase' | 'keyword';
}

const p = (q: string, ...relevant: string[]): EvalQuery => ({ q, relevant, kind: 'paraphrase' });
const k = (q: string, ...relevant: string[]): EvalQuery => ({ q, relevant, kind: 'keyword' });

export const QUERIES: EvalQuery[] = [
  p('how does the system stop helpers from ever reading my passwords for outside tools', '04#5', '04#4', '04#9'),
  p('what happens when a worker keeps failing the same job', '02#5', '02#4'),
  p('which part decides how pricey a model each job gets', 'a:treasurer', '02#9', '02#6'),
  p('jobs that repeat on their own while I am away from the computer', '05#2', '05#4', '05#1'),
  p('the questions asked about me the very first time I open it', '08#3', '08#6'),
  p('separate copies of the project so parallel work never collides', '06#4', '06#2'),
  p('remembering things across sessions without wasting the context window', '01#2', '01#1', '01#15'),
  p('helper that checks finished work against the agreed done criteria', 'a:inspector', 's:verification-before-completion'),
  p('investigate a failure methodically before changing anything', 's:systematic-debugging'),
  p('write the failing check first and only then the code', 's:test-driven-development'),
  p('smallest possible edit that fixes the problem and nothing more', 's:surgical-patch'),
  p('restructure code without changing how it behaves', 's:safe-refactor'),
  p('schema changes that can be undone if they go wrong', 's:reversible-migration'),
  p('make the interface usable for blind people and keyboard-only users', 's:accessibility', '07#12'),
  p('colours and typefaces of the desktop app', '07#13'),
  p('who turns my request into a plan split into stages', 'a:queen', '02#4'),
  p('helper that explores an unknown codebase before anything is planned', 'a:scout'),
  p('notice agents stuck repeating themselves and stop them', 'a:watchdog', '02#6'),
  p('keeping the shared memory tidy: duplicates, stale notes, overall health', 'a:librarian', '01#15'),
  p('which programming language and frameworks the product is made with', '09#3', '09#9'),
  p('in what order features get delivered over time', '10#5', '10#6', '10#2'),
  p('make answers shorter to spend less money', 's:compact-output'),
  p('pass unfinished work on so the next helper can pick it up', 's:task-handoff'),
  p('dangerous terminal commands are refused before they run', '06#4', '06#2'),
  p('which outside apps can be connected, like code hosting or issue trackers', '04#3', '04#9'),
  p('use my own model service, a local server or a router of many models', '04#3', '01#10', '04#9'),
  p('how a new instruction file for a helper should be written', 's:writing-skills'),
  p('a large collection of helpers that stay asleep until a job needs them', '03#7'),
  p('collecting helper definitions from public code repositories', '03#8', '03#9'),
  p('look over someone else’s changes for bugs and maintainability', 's:code-review', 'a:reviewer'),
  p('try the website in a real browser the way a person would', 's:web-app-qa', 's:e2e-testing', 's:browser-automation'),
  p('turn numbers into conclusions for the business', 'a:analyst'),
  p('drafting marketing copy and articles', 'a:writer', 's:writing-guidelines'),
  p('producing user manuals and project readmes', 'a:documenter', 's:technical-writing'),
  p('look for existing solutions before building anything new', 's:search-first', 's:deep-research'),
  p('hand independent jobs to several helpers at the same time', 's:dispatching-parallel-work'),
  p('what every screen shows while empty, loading or broken', '07#11'),
  p('things I personally approved versus things helpers only suggested', '01#18', '01#14'),
  p('the little icon by the clock, the badge for waiting decisions and the bar at the top', '07#8', '07#5'),
  p('a picture of how notes link to each other', '01#11', '01#18'),
  k('Munder Difflin', '01#9', '04#4', '05#3', '06#3', '02#10'),
  k('Docker containers', 's:docker-patterns'),
  k('PostgreSQL queries', 's:postgres-patterns'),
  k('React rendering performance', 's:react-performance'),
  k('TypeScript review', 's:typescript-review'),
  k('Kokonut UI components', '07#14', '07#4'),
  k('Ruflo hive-mind', '02#7', '02#11', '01#8'),
  k('Phase 3 Cadence & Polish', '10#7'),
  k('FastAPI', 's:fastapi-patterns'),
  k('Django', 's:django-patterns'),
];
