import type { ReviseDraftInput, Run } from "@vuzmi/core";

export type DraftSession = {
  id: string;
  origin: string;
  ownerId: string | null;
  initialRun: Run;
  initialBody: string;
  body: string;
  reason: string;
  attempt: ReviseDraftInput | null;
  error: string | null;
  conflicted: boolean;
  uncertain: boolean;
};

// Deliberately transient: never serialized to browser storage, a URL, or logs.
let session: DraftSession | null = null;
let guard: (() => Promise<boolean>) | null = null;
let guardingUnload = false;
const isDirty = () =>
  Boolean(session && (session.body !== session.initialBody || session.reason));
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = "";
};
function syncUnload() {
  const needed = isDirty();
  if (needed === guardingUnload) return;
  if (needed) window.addEventListener("beforeunload", beforeUnload);
  else window.removeEventListener("beforeunload", beforeUnload);
  guardingUnload = needed;
}
export function retainedDraft(ownerId: string | null): DraftSession | null {
  return session?.origin === window.location.origin &&
    session.ownerId === ownerId
    ? session
    : null;
}
export function reconcileDraftOwner(ownerId: string | null): void {
  if (
    session &&
    (session.origin !== window.location.origin || session.ownerId !== ownerId)
  ) {
    session = null;
    syncUnload();
  }
}
export function openDraftSession(
  ownerId: string | null,
  run: Run,
  body: string,
): DraftSession | null {
  const existing = retainedDraft(ownerId);
  if (existing?.initialRun.id === run.id) return existing;
  if (existing && !isDirty()) session = null;
  if (session) return null;
  session = {
    id: crypto.randomUUID(),
    origin: window.location.origin,
    ownerId,
    initialRun: run,
    initialBody: body,
    body,
    reason: "",
    attempt: null,
    error: null,
    conflicted: false,
    uncertain: false,
  };
  return session;
}
export function updateDraftSession(
  id: string,
  patch: Partial<
    Pick<
      DraftSession,
      "body" | "reason" | "attempt" | "error" | "conflicted" | "uncertain"
    >
  >,
): void {
  if (session?.id !== id) return;
  session = { ...session, ...patch };
  syncUnload();
}
export function clearDraftSession(id: string): void {
  if (session?.id !== id) return;
  session = null;
  syncUnload();
}
export function settleDraftAttempt(
  id: string,
  editId: string,
  result:
    | { saved: true }
    | { saved: false; error: string; conflicted: boolean; uncertain: boolean },
): void {
  if (session?.id !== id || session.attempt?.editId !== editId) return;
  if (result.saved) clearDraftSession(id);
  else updateDraftSession(id, result);
}
export function registerDraftDiscardGuard(
  next: () => Promise<boolean>,
): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}
export async function confirmDraftSignOut(): Promise<boolean> {
  if (guard) return guard();
  return !isDirty();
}
export function hasHeldDraft(): boolean {
  return isDirty();
}
