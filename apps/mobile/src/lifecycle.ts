/** Connection/session fences independent of React and native platform modules. */
export class NativeLifecycle {
  private epoch = 0;
  private active = false;
  private flight: { epoch: number; promise: Promise<void> } | undefined;
  constructor(private readonly onExpired: (error: unknown) => void) {}
  begin(): number {
    this.epoch += 1;
    this.active = true;
    this.flight = undefined;
    return this.epoch;
  }
  current(): number {
    return this.epoch;
  }
  /** Bind a rendered client to its own epoch; callbacks cannot borrow a newer one. */
  bind(epoch: number) {
    return Object.freeze({
      epoch,
      isCurrent: () => this.isCurrent(epoch),
      begin: () => (this.epoch === epoch ? this.begin() : undefined),
      close: () => {
        if (this.epoch !== epoch) return false;
        this.invalidate();
        return true;
      },
      invalidate: () => this.invalidate(epoch),
      commit: (apply: () => void) => this.commit(epoch, apply),
      request: <T>(operation: () => Promise<T>, apply?: (value: T) => void) =>
        this.request(epoch, operation, apply),
      refresh: (operation: () => Promise<void>) =>
        this.refresh(epoch, operation),
    });
  }
  isCurrent(epoch: number): boolean {
    return this.active && this.epoch === epoch;
  }
  invalidate(epoch?: number): boolean {
    if (epoch !== undefined && !this.isCurrent(epoch)) return false;
    this.epoch += 1;
    this.active = false;
    this.flight = undefined;
    return true;
  }
  commit(epoch: number, apply: () => void): boolean {
    if (!this.isCurrent(epoch)) return false;
    apply();
    return true;
  }
  async request<T>(
    epoch: number,
    operation: () => Promise<T>,
    apply?: (value: T) => void,
  ): Promise<T | undefined> {
    if (!this.isCurrent(epoch)) return undefined;
    try {
      const value = await operation();
      if (!this.isCurrent(epoch)) return undefined;
      apply?.(value);
      return value;
    } catch (error) {
      if (!this.isCurrent(epoch)) return undefined;
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 401
      ) {
        this.invalidate(epoch);
        this.onExpired(error);
        return undefined;
      }
      throw error;
    }
  }
  isRefreshing(epoch: number): boolean {
    return this.isCurrent(epoch) && this.flight?.epoch === epoch;
  }
  refresh(epoch: number, operation: () => Promise<void>): Promise<void> {
    if (!this.isCurrent(epoch)) return Promise.resolve();
    if (this.flight?.epoch === epoch) return this.flight.promise;
    const flight = { epoch, promise: Promise.resolve() };
    flight.promise = Promise.resolve()
      .then(async () => {
        if (this.isCurrent(epoch)) await operation();
      })
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
      });
    this.flight = flight;
    return flight.promise;
  }
}

import type { Run } from "@vuzmi/core";
/** A slower workspace response may add history, but cannot replace newer revisions. */
export function mergeNativeRuns(current: Run[], incoming: Run[]): Run[] {
  const result = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming)
    if (!result.has(run.id) || result.get(run.id)!.revision <= run.revision)
      result.set(run.id, run);
  return [...result.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}
