import { githubFileUrl, type GithubOrigin } from "@vuzmi/core";

export function GithubProvenance({ origin }: { origin: GithubOrigin }) {
  return (
    <section
      className="github-provenance"
      aria-label="Recorded GitHub provenance"
    >
      <div className="github-provenance-heading">
        <span className="github-origin-badge">GitHub snapshot</span>
        <a
          href={githubFileUrl(origin)}
          target="_blank"
          rel="nofollow noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          Open pinned file on GitHub ↗
        </a>
      </div>
      <dl>
        <div>
          <dt>Repository</dt>
          <dd>
            {origin.owner}/{origin.repository}
          </dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd>
            <code>{origin.path}</code>
          </dd>
        </div>
        <div>
          <dt>Full commit</dt>
          <dd>
            <code>{origin.commitOid}</code>
          </dd>
        </div>
        <div>
          <dt>Git blob · {origin.gitHashAlgorithm.toUpperCase()}</dt>
          <dd>
            <code>{origin.blobOid}</code>
          </dd>
        </div>
        <div>
          <dt>Bytes</dt>
          <dd>
            {origin.rawBytes.toLocaleString("en-GB")} raw ·{" "}
            {origin.normalizedBytes.toLocaleString("en-GB")} normalized
          </dd>
        </div>
      </dl>
      <details>
        <summary>Hashes and recorded fetch</summary>
        <dl>
          <div>
            <dt>Repository ID</dt>
            <dd>{origin.repositoryId}</dd>
          </div>
          <div>
            <dt>Raw SHA-256</dt>
            <dd>
              <code>{origin.rawSha256}</code>
            </dd>
          </div>
          <div>
            <dt>Normalized SHA-256</dt>
            <dd>
              <code>{origin.normalizedSha256}</code>
            </dd>
          </div>
          <div>
            <dt>Normalization</dt>
            <dd>{origin.normalizationVersion}</dd>
          </div>
          <div>
            <dt>Fetched</dt>
            <dd>
              <time dateTime={origin.fetchedAt}>
                {new Date(origin.fetchedAt).toLocaleString("en-GB")}
              </time>
            </dd>
          </div>
        </dl>
      </details>
      <p>
        Line references describe the normalized local text. Recorded provenance
        identifies this snapshot; source claims remain unverified.
      </p>
    </section>
  );
}
