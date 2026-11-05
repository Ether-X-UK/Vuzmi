import { z } from "zod";

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const githubPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((path) => {
    const parts = path.split("/");
    return (
      parts.length <= 8 &&
      parts.every(
        (part) =>
          /^[A-Za-z0-9_. -]+$/.test(part) &&
          part !== "." &&
          part !== ".." &&
          part.trim() === part &&
          part.length > 0,
      ) &&
      /\.(md|txt)$/i.test(path)
    );
  }, "Use a relative Markdown or text file path with at most eight segments.");
export const githubPreviewInputSchema = z
  .object({
    commit: oid,
    path: githubPathSchema,
    title: z.string().trim().min(3).max(120),
  })
  .strict();
export type GithubPreviewInput = z.infer<typeof githubPreviewInputSchema>;

export const githubOriginSchema = z
  .object({
    kind: z.literal("github-public"),
    repositoryId: z.number().int().positive().safe(),
    owner: z.literal("Ether-X-UK"),
    repository: z.literal("Vuzmi"),
    path: githubPathSchema,
    gitHashAlgorithm: z.literal("sha1"),
    commitOid: oid,
    blobOid: oid,
    rawSha256: sha256,
    rawBytes: z.number().int().min(10).max(65_536),
    normalizedSha256: sha256,
    normalizedBytes: z.number().int().min(10).max(65_536),
    normalizationVersion: z.literal("plain-text-v1"),
    fetchedAt: z.string().datetime(),
  })
  .strict();
export type GithubOrigin = z.infer<typeof githubOriginSchema>;
export const githubPreviewSchema = z
  .object({
    previewId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    fingerprint: sha256,
    title: z.string().trim().min(3).max(120),
    format: z.enum(["markdown", "text"]),
    text: z.string().min(10).max(64_000),
    origin: githubOriginSchema,
  })
  .strict();
export type GithubPreview = z.infer<typeof githubPreviewSchema>;
/** Stable server-owned preview envelope; identity, expiry, text and origin are all bound. */
export function githubPreviewFingerprintInput(
  value: Omit<GithubPreview, "fingerprint"> | GithubPreview,
): string {
  return JSON.stringify({
    previewId: value.previewId,
    expiresAt: value.expiresAt,
    title: value.title,
    format: value.format,
    text: value.text,
    origin: githubOriginSchema.parse(value.origin),
  });
}
export const githubImportInputSchema = z
  .object({
    importId: z.string().uuid(),
    previewId: z.string().uuid(),
    fingerprint: sha256,
  })
  .strict();
export type GithubImportInput = z.infer<typeof githubImportInputSchema>;

export function githubFileUrl(origin: GithubOrigin): string {
  return `https://github.com/${origin.owner}/${origin.repository}/blob/${origin.commitOid}/${origin.path.split("/").map(encodeURIComponent).join("/")}`;
}
