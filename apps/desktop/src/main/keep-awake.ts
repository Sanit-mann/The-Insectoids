/**
 * "Keep the computer awake while the hive works" (Cadence 05-D5; Phase 3 A2). Off by default, because it costs
 * battery. While the switch is on and at least one agent is working, the computer isn't allowed to go to sleep
 * on its own (the screen may still turn off); as soon as the hive is idle again, sleep is allowed. Nothing here
 * ever keeps the computer awake while the hive is idle.
 */
export interface SleepBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export class KeepAwake {
  #id: number | null = null;

  constructor(private readonly blocker: SleepBlocker) {}

  /** Applies the switch and the hive's state; returns whether the computer is being kept awake now. */
  update(o: { enabled: boolean; working: boolean }): boolean {
    const want = o.enabled && o.working;
    if (want && !this.active) this.#id = this.blocker.start('prevent-app-suspension');
    if (!want && this.#id !== null) {
      if (this.blocker.isStarted(this.#id)) this.blocker.stop(this.#id);
      this.#id = null;
    }
    return this.active;
  }

  get active(): boolean {
    return this.#id !== null && this.blocker.isStarted(this.#id);
  }

  /** On quit: never leave a blocker behind. */
  release(): void {
    this.update({ enabled: false, working: false });
  }
}
