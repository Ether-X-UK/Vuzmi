import type { EvidenceSnapshot } from "./knowledge.js";

export type DraftOrigin = "model" | "human";

export class DraftDocumentError extends Error {
  readonly code = "INVALID_CITATION";
  constructor(message: string) {
    super(message);
    this.name = "DraftDocumentError";
  }
}

/** Citation syntax is checked here; neither a valid ID nor a quote proves truth. */
export function validateDraftCitations(
  body: string,
  evidence?: EvidenceSnapshot,
): void {
  const allowed = new Set(evidence?.items.map((item) => item.citation) ?? []);
  let referenced = false;
  for (const match of body.matchAll(/\[([^\]\r\n]+)\]/g)) {
    const label = match[1];
    // Preserve the original provider policy for ordinary Markdown/task boxes,
    // citation-like IDs, grouped references, numeric footnotes and linked IDs.
    if (!/^(?:[A-Za-z][A-Za-z0-9_-]*\d|\^?\d)/.test(label)) continue;
    if (
      !allowed.has(label) ||
      body.slice(match.index! + match[0].length).startsWith("(")
    ) {
      throw new DraftDocumentError(
        "The local draft used an unsupported reference ID. No draft was accepted; review the evidence and try again.",
      );
    }
    referenced = true;
  }
  if (evidence && !referenced) {
    throw new DraftDocumentError(
      "The local draft did not cite its selected evidence. No draft was accepted; review the evidence and try again.",
    );
  }
}

function jsonFence(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const longest = Math.max(
    0,
    ...Array.from(json.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

function references(evidence: EvidenceSnapshot): string {
  const sections = [
    "## Vuzmi reference record",
    "This appendix was attached by Vuzmi from the selected evidence snapshot. Citations identify supplied claims, not independently verified outcomes.",
    jsonFence({
      policy: evidence.policy,
      retrievedAt: evidence.retrievedAt,
      embeddingProfile: evidence.profile,
    }),
  ];
  for (const item of evidence.items) {
    sections.push(
      `### [${item.citation}] ${item.kind === "source" ? "Source" : "Memory"} reference`,
      jsonFence({
        kind: item.kind,
        ownerId: item.ownerId,
        title: item.title,
        revision: item.revision,
        chunkIndex: item.chunkIndex,
        lineStart: item.lineStart,
        lineEnd: item.lineEnd,
        contentHash: item.contentHash,
        excerpt: item.text,
      }),
    );
  }
  return sections.join("\n\n");
}

function provenance(
  evidence: EvidenceSnapshot | undefined,
  origin: DraftOrigin,
): string {
  if (origin !== "model" && origin !== "human")
    throw new TypeError("Unsupported draft origin.");
  const boundary = evidence
    ? "This run used selected source/memory excerpts; their claims remain unverified. No repository inspection, tests, deployment, publication, or customer contact was performed."
    : "This run did not inspect a repository, retrieve knowledge, run tests, deploy, publish, or contact customers.";
  const prefix =
    origin === "model"
      ? "> Local Ollama draft — unverified."
      : "> Human-revised draft — unverified. This document was revised by the owner. Model usage describes the original local Ollama call, not human work.";
  return `${prefix} ${boundary}`;
}

/** Pure formatting only. Callers validate body bounds, controls, citations and authority. */
export function renderDraftDocument(
  body: string,
  evidence?: EvidenceSnapshot,
  origin: DraftOrigin = "model",
): string {
  return `${provenance(evidence, origin)}\n\n${body}${evidence ? `\n\n${references(evidence)}` : ""}`;
}

/** Recognize exact application-owned boundaries, never a heading guessed inside the body. */
export function extractDraftBody(
  content: string,
  evidence?: EvidenceSnapshot,
  origin: DraftOrigin = "model",
): string | undefined {
  if (typeof content !== "string" || (origin !== "model" && origin !== "human"))
    return undefined;
  const prefix = `${provenance(evidence, origin)}\n\n`;
  const suffix = evidence ? `\n\n${references(evidence)}` : "";
  if (
    !content.startsWith(prefix) ||
    !content.endsWith(suffix) ||
    content.length <= prefix.length + suffix.length
  )
    return undefined;
  const body = content.slice(
    prefix.length,
    suffix ? -suffix.length : undefined,
  );
  if (!body.trim() || renderDraftDocument(body, evidence, origin) !== content)
    return undefined;
  return body;
}
