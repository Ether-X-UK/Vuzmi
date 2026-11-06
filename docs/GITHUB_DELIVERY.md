# GitHub delivery

This increment connects an approved local development branch to a separately reviewed **draft** pull request in public `Ether-X-UK/Vuzmi`. Implementation and verification status are recorded in [STATUS.md](STATUS.md). It does not merge, deploy, dispatch workflows or send PR comments.

## Separate decisions

1. Package approval saves the exact development artifact.
2. Local application authorization creates its fixed local work branch and receipt.
3. GitHub delivery authorization publishes its exact objects/branch and creates the reviewed draft PR.

The third decision requires a new publication plan. It discloses the repository, branch, exact source commit and tree, observed `main` SHA, exact PR title/body, commit metadata and publication scope. Public source/history and PR text are sent to GitHub; its ordinary repository notifications and workflow triggers can run. The retained local commit includes internal run/application identifiers and a hex-encoded actor identifier. Inspect these in the plan before publication. Existing approval records are not edited to remove them.

## Operator configuration

The connector is disconnected by default. Plan preparation and public CI reads use bounded unauthenticated reads; publication requires an explicitly configured worker credential. The application never adopts the operator's Git CLI authentication.

Create a fine-grained GitHub token owned by an account authorized for `Ether-X-UK/Vuzmi`. Select **only that repository**, with **Contents: read and write** and **Pull requests: read and write**. Repository metadata read is implicit. Public Actions evidence uses public reads; do not add workflow-management, administration or other repository permissions. Organization approval may be required. GitHub account/token settings are an operator step, not a Vuzmi-created credential.

Save the token directly into a private absolute regular file owned by the worker's user, with mode `0600`, outside source control. Keep its parent directory private. Do not paste it into a PR, browser form, model prompt, log or chat. Set only its **path** in server configuration:

```dotenv
VUZMI_GITHUB_DELIVERY_TOKEN_FILE=/absolute/path/to/private/github-delivery-token
```

Restart the trusted worker after configuration. This alpha uses **one configured trusted publication worker per deployment**; do not run consumers with different delivery credentials against the same queue. A worker started disconnected does not acquire publication jobs and requires a restart after connection. The API/browser do not read the credential file. Missing, unsafe or changed credentials invalidate publication readiness; replacing a credential requires preparing and reviewing a fresh plan. Revocation at GitHub remains the operator's control. Token expiry, organization policy or insufficient permissions may prevent publication even if the local file is valid.

## Review and publication

Open an applied development run, enter its draft PR title/body and prepare a plan. Read the exact disclosure, commit metadata, destination and full plan fingerprint. Open the exact plan, acknowledge it and choose **Publish branch and create draft PR** only if you authorize that payload. A disconnected plan cannot be executed. Reprepare after connection, target or text changes and review the new fingerprint.

The worker uploads exact approved blobs/tree and reconstructs the canonical unsigned local commit through GitHub's Git database API. Every returned object identity must match the retained receipt before creating the fixed branch. GitHub's commit serialization is not assumed: an unexpected SHA stops the operation with no alternative commit or transport fallback. Unreferenced uploaded objects may already be public. Real API equivalence must be established by an explicitly authorized live attempt; adapter fixtures alone do not prove it.

Only the fixed `vuzmi/development/<run UUID>` branch may be created. Existing foreign branches/PRs are preserved. The target is `main`; GitHub creates PRs against a branch name, so target SHA checks cannot make it an atomic pinned-base transaction. The receipt and CI observation expose target movement. No force push or merge occurs.

## Unknown outcomes and recovery

Each write is preceded by a persisted phase/authority checkpoint. A timeout may mean an object, branch or PR was created. Vuzmi retains the stable operation and performs bounded **read-only** inspection of the exact branch/PR marker. It never blindly repeats a PR creation request, allocates another branch or treats a missing response as proof of no effect.

Inspect partial/unconfirmed/conflicting records and remote state before any separate operator intervention. Read-only refresh cannot authorize another write. A restored unfinished operation is quarantined, with its queue cancelled and connector readiness removed. Starting the worker cannot replay it on a different host. Database backup retains the operation/receipt; it does not back up the local Git object database or external GitHub state.

## CI evidence

Explicit refresh reads bounded public Actions evidence for the delivered head and the repository's `.github/workflows/checks.yml` PR workflow. Its newest run/attempt governs the displayed result; an older success cannot hide a newer failure or pending run. No matching runs is **not** a pass. Waiting, running, failed, cancelled, skipped, unavailable and moved-head/base states remain visible. The workflow/run/attempt/commit/time and validated GitHub URL are evidence for that named workflow, not a statement that all branch-protection or release requirements have passed.

GitHub `pull_request` workflows commonly check the synthetic merge commit. Inspect the recorded PR head and observed base/merge context when interpreting results. The observed current PR merge SHA is context, not verified evidence of the run's exact checkout. Vuzmi reports the Actions result without downloading logs or artifacts. It does not approve, rerun, cancel or dispatch Actions. Ordinary UI polling reads persisted local state rather than repeatedly contacting GitHub.

Primary protocols: [Git blobs](https://docs.github.com/en/rest/git/blobs#create-a-blob), [trees](https://docs.github.com/en/rest/git/trees#create-a-tree), [commits](https://docs.github.com/en/rest/git/commits#create-a-commit), [references](https://docs.github.com/en/rest/git/refs#create-a-reference), [pull requests](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [Actions runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository), [PR workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).
