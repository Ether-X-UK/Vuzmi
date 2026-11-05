# Vuzmi native companion

Status: native UI/build plan recorded before implementation, 4 November 2026. The Release iOS Simulator app has compiled, installed, and launched. The verification record below distinguishes native checks from JavaScript bundling and device readiness.

## Scope and interface

The first companion uses React Native views, system typography, and the approved ink/teal palette. It connects to the existing API and reads the same shared `@vuzmi/core` contracts. There are no fixtures, provider credentials, external assets, automatic sends, or local approval simulations in the client.

The initial screens are:

1. **Connection:** editable loopback backend URL, a deliberate Connect action, observed connection/error state, and a clear Simulator-only explanation. Default: `http://127.0.0.1:4310`. Owner authentication is available on the local backend; the client does not widen its host/origin policy or claim physical iPhone connectivity. Remote addresses remain blocked until authenticated TLS device access is configured.
2. **Runs:** actual workspace name, real run counts, All runs/Needs review filters, pull-to-refresh, empty/loading/disconnected states, and explicit per-run Simulation/Local Ollama labels. Data remains server-owned. The app does not create missions in this first companion slice.
3. **Run detail:** title, persisted status, concrete events, selected model, actual execution/usage facts, exact proposed or saved Markdown, and retained source/memory evidence with citation identities. Queued/running/failed runs without a proposal show their actual state and never expose approval controls.
4. **Review:** an explicit Read exact document route, the action/destination/revision/fingerprint, and Approve local result/Reject proposal. The request binds to the displayed proposal fingerprint and run revision. Success is shown only after the API returns saved state. A 409 refreshes the run and asks the operator to inspect the current record; failed requests do not invent success.

The exact artifact is rendered as selectable native text, retaining all characters. Evidence is separately labelled as retained context; source retrieval is not factual verification. Historical excerpts remain visible with the retention boundary described by the web client. No notification-only or context-free approval is offered.

Controls have at least 44pt targets. Text supports platform scaling, content reflows within safe areas, status combines text with colour, and mutation/load transitions are announced accessibly. Large documents scroll; they are not truncated. Navigation is a small in-app screen stack with explicit accessible Back controls, avoiding an unnecessary routing dependency for this bounded slice.

## Transport and authentication seam

All requests use a single API client with an asynchronous authentication-header provider. The owner-authentication increment below supplies session cookies through the official Better Auth Expo/SecureStore client. No token is stored in plain preferences, logs, URLs, or source code. Remote physical-device access remains outside this loopback-only build.

HTTP is allowed only for loopback development addresses in the native configuration. There is no global arbitrary-load exception, local-network discovery, camera/microphone/photos access, notification registration, or paid cloud build service. A phone's loopback address refers to the phone, not the development Mac.

## Verified dependency baseline

Official metadata checked on 4 November 2026:

| Package                          | Version   | Reason                                  |
| -------------------------------- | --------- | --------------------------------------- |
| `expo`                           | `58.0.23` | Current stable published SDK 58 package |
| `react-native`                   | `0.88.1`  | SDK 58 compatibility metadata           |
| `react`                          | `19.3.0`  | SDK 58 compatibility metadata           |
| `react-native-safe-area-context` | `5.11.1`  | Safe-area handling for native screens   |
| `@types/react`                   | `~19.3.0` | Native React type baseline              |

Host checks found Node `22.23.1` and Xcode `27.0`. SDK 58 requires Node 22.13 or a supported newer line. The parent owns root dependency installation and the lockfile. No install runs from this package independently.

Primary references: [SDK 58 release](https://expo.dev/changelog/sdk-58), [published Expo metadata](https://registry.npmjs.org/expo/latest), [official SDK 58 compatibility map](https://github.com/expo/expo/blob/sdk-58/packages/expo/bundledNativeModules.json), [Expo monorepos](https://docs.expo.dev/guides/monorepos/), [local native builds](https://docs.expo.dev/guides/local-app-development/), [Apple local networking transport policy](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking).

## Build and verification sequence

1. Parent installs the declared workspace dependencies and records the resulting root lockfile.
2. Check native TypeScript separately from the web/Node type environment. Verify Expo configuration and SDK dependency compatibility without accepting unreviewed dependency changes.
3. Produce an iOS JavaScript export to verify Metro can resolve shared TypeScript and package dependencies. This remains a bundling check.
4. After authentication stabilises, generate native iOS sources locally through Expo prebuild, install CocoaPods locally, and compile a Simulator build with the installed Xcode/runtime. No EAS account or paid build is required.
5. Launch the real `.app` in the Simulator and exercise connection, real run list, exact artifact/evidence reading, approval, rejection, stale decision, backend loss, and refresh persistence against isolated owned test data.
6. Record actual commands/results and limitations below. Do not infer App Store or physical-device readiness from a Simulator run.

Expected commands after the parent installs dependencies:

```sh
npm run typecheck --workspace @vuzmi/mobile
npm run test --workspace @vuzmi/mobile
npm run export:ios --workspace @vuzmi/mobile
npm run ios --workspace @vuzmi/mobile
```

This package uses Expo Continuous Native Generation. Generated `ios/` and `android/` sources are intentionally ignored, together with Pods, Expo state, bundle output, build directories, signing archives, and derived products. App configuration and the root lockfile are the reproducible inputs. From `apps/mobile`, generate iOS sources without dependency updates:

```sh
EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 ../../node_modules/.bin/expo prebuild --platform ios --no-install --skip-dependency-update react,react-native
```

Then, from `apps/mobile/ios`:

```sh
COCOAPODS_DISABLE_STATS=true EXPO_NO_TELEMETRY=1 pod install
EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 xcodebuild -workspace Vuzmi.xcworkspace -scheme Vuzmi -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /private/tmp/vuzmi-ios-derived CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES build
```

The Simulator build uses local ad-hoc signing. Disabling signing entirely prevents SecureStore's Keychain reads in this Simulator; keep signing enabled with identity `-`. No development team, distribution certificate, paid build service, or Apple account is required for this local Simulator check. A generated `.app` can be installed and launched on an already booted Simulator using `xcrun simctl install booted /private/tmp/vuzmi-ios-derived/Build/Products/Release-iphonesimulator/Vuzmi.app` and `xcrun simctl launch booted com.vuzmi.localalpha`.

## Owner authentication increment

The settled server contract is `GET /v1/auth/state` returning the shared `AuthState`. The companion checks that state before loading business data. Owner setup remains a web-only operation; a fresh backend tells the native operator to complete setup there. Existing owners sign in through Better Auth's standard email/password API. The official `@better-auth/expo` client stores its session in Expo SecureStore with `cookiePrefix: 'vuzmi'` matching the server; each business request explicitly forwards `getCookie()` as `Cookie`, adds the exact `Origin: vuzmi://`, and keeps `credentials: omit`.

Sign-out uses the official client and reports failure rather than claiming revocation. Expired/revoked sessions stop business loading and decisions and return to sign-in. An owner-session failure never silently selects development mode. If the backend explicitly reports development mode after a deliberate connection, the companion displays a persistent Development bypass badge. Backend changes require an explicit connection and use a distinct SecureStore prefix so one loopback deployment's cookies are not reused for another.

Additional settled dependencies: `better-auth`/`@better-auth/expo` `1.7.17`, `expo-secure-store` `~58.0.2`, and `expo-network` `~58.0.4`. No biometric authentication, social OAuth, extra trusted-origin wildcard, or physical-device host exception is introduced. References: [official Better Auth Expo integration](https://better-auth.com/docs/integrations/expo), [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).

The official Expo auth plugin also imports `expo-linking` and references `expo-web-browser` during Metro resolution. SDK-matched `expo-linking` `~58.0.16`, `expo-web-browser` `~58.0.7`, and `expo-constants` `~58.0.15` are declared; their presence does not enable a social sign-in flow.

## Verification record

- Plan: recorded.
- Dependencies: installed by the parent from the declared stable SDK baseline and root lockfile.
- Native source: connection, run/approval lists, full selectable artifact, retained evidence, execution trace, and exact fingerprint/revision decisions implemented.
- Transport tests: `npm run test --workspace @vuzmi/mobile` passed 6/6 on 4 November 2026: loopback URL boundary, exact approval/cookie/origin request, stale conflict, no-proposal rejection, owner-state validation, and no unauthorised development fallback.
- TypeScript: `npm run typecheck --workspace @vuzmi/mobile` passed.
- Metro export: `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm run export:ios --workspace @vuzmi/mobile` passed (797 modules, 2.6 MB iOS Hermes bundle in the final shared-contract export). A mobile-only resolver maps shared core's Node ESM `.js` import names to its TypeScript sources.
- Native generation: local Expo prebuild completed without dependency changes. CocoaPods installed 102 pods.
- Native compilation: Xcode 27.0 Release Simulator build passed with local ad-hoc signing. Binary: `/private/tmp/vuzmi-ios-derived/Build/Products/Release-iphonesimulator/Vuzmi.app`.
- Simulator UI: installed and launched on iPhone 18 Pro / iOS 27.0 against an isolated disposable owner backend. Verified owner-state gate, successful sign-in, actual run list, session persistence after process relaunch, exact selectable document route, explicit no-retrieval evidence state, approval returning Completed/revision 2 with artifact-saved events, persisted state on refresh, empty approvals, and sign-out followed by refresh remaining gated without business data.
- Authentication: official native client, secure session storage, owner-state gate, sign-in/sign-out, and exact-origin business headers were exercised in the actual Simulator app. The founder's default owner database was not configured or seeded by this check. No credentials are committed.
- Remaining verification: rejection/conflict boundaries are covered by transport/core/API tests; their native UI paths, live retained-source citation navigation, backend-loss recovery, large accessibility text sizes, physical-device networking, distribution signing, and App Store delivery have not been exercised in this pass. This is a locally built Simulator companion, not a device or store release.

## Review recovery increment — 5 November 2026

Refresh now joins a single active request chain so five-second polling cannot suppress the twenty-second timeout. That deadline also covers stalled authentication-header and response-body reads. Any current protected request's401 returns to the owner gate, including malformed error responses and conflict recovery; old connection/session results are ignored. Newer run revisions survive slower workspace responses.

A changed proposal shows a notice on summary, document and evidence views. Approval and rejection stay blocked until **Review updated document** is used and that exact revision/fingerprint is acknowledged from its document screen. Another replacement invalidates acknowledgment. Conflicts and uncertain decision timeouts require a saved-state read and renewed review. A submitted decision retains its captured compare-and-swap arguments.

All 20 native tests pass, preserving the original six transport tests. The combined repository check passes 134 tests and strict root/mobile TypeScript. An 801-module/2.6MB iOS export and a fresh Xcode 27 Release Simulator build with local ad-hoc signing pass. These new controls have not yet had an interactive Simulator pass; earlier owner-flow UI evidence above is from the prior baseline. No operator credentials, schemas, or services were modified for this increment.
