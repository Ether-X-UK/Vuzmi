import {
  developmentInputSchema,
  type DevelopmentInput,
  type DevelopmentProfile,
  type DevelopmentRuntime,
} from "@vuzmi/core";

export type DevelopmentTaskFields = {
  title: string;
  brief: string;
  issueNumber: string;
};
export type DevelopmentAdmission = { key: string; input: DevelopmentInput };

export function developmentProfiles(
  runtime: DevelopmentRuntime | null,
): DevelopmentProfile[] {
  return runtime?.profiles ?? (runtime?.profile ? [runtime.profile] : []);
}

/** A chosen immutable snapshot stays selected when a poll advertises a different default/catalog. */
export function observeDevelopmentProfile(
  selected: DevelopmentProfile | null,
  runtime: DevelopmentRuntime | null,
): DevelopmentProfile | null {
  if (selected) return selected;
  const profiles = developmentProfiles(runtime);
  return (
    profiles.find(
      (profile) => profile.profileHash === runtime?.profile?.profileHash,
    ) ??
    profiles[0] ??
    null
  );
}

export function developmentProfileAvailable(
  profile: DevelopmentProfile | null,
  runtime: DevelopmentRuntime | null,
): boolean {
  return Boolean(
    profile &&
    runtime?.ready &&
    developmentProfiles(runtime).some(
      (item) => item.profileHash === profile.profileHash,
    ),
  );
}

export function developmentAdmissionKey(
  fields: DevelopmentTaskFields,
  profile: DevelopmentProfile | null,
): string {
  return JSON.stringify({
    ...fields,
    profileHash: profile?.profileHash ?? null,
  });
}

/** Exact retries retain the original model and profile even if readiness/defaults changed. */
export function captureDevelopmentAdmission(
  previous: DevelopmentAdmission | null,
  fields: DevelopmentTaskFields,
  profile: DevelopmentProfile | null,
  model: string,
  createId: () => string,
): DevelopmentAdmission {
  const key = developmentAdmissionKey(fields, profile);
  if (previous?.key === key) return previous;
  if (!profile)
    throw new Error(
      "Select an available pinned development profile before starting.",
    );
  const input = developmentInputSchema.parse({
    requestId: createId(),
    title: fields.title,
    brief: fields.brief,
    model,
    profileHash: profile.profileHash,
    ...(fields.issueNumber ? { issueNumber: Number(fields.issueNumber) } : {}),
  });
  return { key, input };
}

export function developmentProfileLabel(profile: DevelopmentProfile): string {
  return profile.id === "web-client-regressions"
    ? "Web client regressions"
    : "Web session expiry (legacy)";
}
