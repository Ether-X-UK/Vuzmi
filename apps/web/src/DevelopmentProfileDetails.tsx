import { developmentCheckNames, type DevelopmentProfile } from "@vuzmi/core";
import { developmentProfileLabel } from "./developmentProfiles";

export function DevelopmentProfileDetails({
  profile,
  title = "Pinned source and check profile",
}: {
  profile: DevelopmentProfile;
  title?: string;
}) {
  const checks = developmentCheckNames(profile);
  const contextBytes = profile.files.reduce(
    (total, file) => total + new TextEncoder().encode(file.text).byteLength,
    0,
  );
  return (
    <div className="development-profile">
      <Values
        entries={[
          ["Repository", profile.repository],
          ["Full pinned base commit", profile.baseCommit],
          [
            "Profile",
            `${developmentProfileLabel(profile)} · ${profile.id}@${profile.version}`,
          ],
          [
            "Permitted editable files",
            profile.files.map((file) => file.path).join("\n"),
          ],
          [
            "Baseline requirement",
            profile.baselineExpectation === "green"
              ? "All named regressions must pass"
              : "Reproduce the historical session-expiry failure",
          ],
        ]}
      />
      <p className="knowledge-hint">
        The model may replace a nonempty subset of these {profile.files.length}{" "}
        permitted {profile.files.length === 1 ? "file" : "files"}. Tests,
        manifests and dependencies remain read-only.
      </p>
      <details className="development-disclosure">
        <summary>{title}</summary>
        <p className="knowledge-hint">
          This is an operator-provisioned immutable source snapshot. The model
          cannot select commands, dependencies, images or expanded permissions.
        </p>
        <Values
          entries={[
            ["Platform", profile.platform],
            ["Policy", profile.policyId],
            ["Resolved base image", profile.baseImage],
            ["Profile SHA-256", profile.profileHash],
            ["Acceptance checks SHA-256", profile.acceptanceHash],
            ["Dependency lockfile SHA-256", profile.lockfileHash],
            ...(profile.sourceTree
              ? [["Source tree", profile.sourceTree] as [string, string]]
              : []),
            ...(profile.sourceArchiveSha256
              ? [
                  ["Source archive SHA-256", profile.sourceArchiveSha256] as [
                    string,
                    string,
                  ],
                ]
              : []),
            ...(profile.checkHarnessSha256
              ? [
                  ["Trusted harness SHA-256", profile.checkHarnessSha256] as [
                    string,
                    string,
                  ],
                ]
              : []),
          ]}
        />
        <p className="field-label">Fixed command</p>
        <pre className="development-code" tabIndex={0}>
          {JSON.stringify(profile.command, null, 2)}
        </pre>
        <p className="field-label">
          Trusted regressions · {checks.length} named checks
        </p>
        <ul className="development-check-names">
          {checks.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <p className="knowledge-hint">
          Passing these named regressions does not establish that the task was
          fulfilled, all repository checks passed or generated code is safe.
        </p>
        {profile.checkFiles && (
          <details className="development-disclosure">
            <summary>Read-only check file hashes</summary>
            <Values
              entries={profile.checkFiles.map((file) => [
                file.path,
                file.sha256,
              ])}
            />
          </details>
        )}
        <p className="field-label">
          Exact pinned source · {contextBytes.toLocaleString("en-GB")} UTF-8
          bytes across {profile.files.length}{" "}
          {profile.files.length === 1 ? "file" : "files"}
        </p>
        {profile.files.map((file) => (
          <details className="development-disclosure" key={file.path}>
            <summary>{file.path}</summary>
            <Values entries={[["Source SHA-256", file.sha256]]} />
            <pre
              className="development-code"
              tabIndex={0}
              aria-label={`Exact pinned source text: ${file.path}`}
            >
              {file.text}
            </pre>
          </details>
        ))}
      </details>
    </div>
  );
}

function Values({ entries }: { entries: [string, string][] }) {
  return (
    <dl className="development-values">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
