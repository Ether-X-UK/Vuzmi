import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  domainLabels,
  type AuthState,
  type Run,
  type WorkspaceSnapshot,
} from "@vuzmi/core";
import { NativeApi, NativeApiError } from "./src/api";
import {
  createNativeAuth,
  sessionHeaders,
  type NativeAuthClient,
} from "./src/auth";
import {
  Action,
  Badge,
  Brand,
  colors,
  Empty,
  ErrorNotice,
  Eyebrow,
  Fact,
  Panel,
  RunBadge,
  statusLabels,
  styles,
} from "./src/ui";

type Tab = "runs" | "approvals" | "connection";
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Please refresh and try again.";
}
function date(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function mergeRuns(current: Run[], incoming: Run[]): Run[] {
  const result = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming)
    if (!result.has(run.id) || result.get(run.id)!.revision <= run.revision)
      result.set(run.id, run);
  return [...result.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export default function App() {
  const [client, setClient] = useState<NativeApi | null>(null);
  const [authClient, setAuthClient] = useState<NativeAuthClient | null>(null);
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const authRef = useRef<AuthState | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("connection");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const connectionVersion = useRef(0);
  const observeAuth = (state: AuthState) => {
    authRef.current = state;
    setAuthState(state);
  };
  const storeWorkspace = (workspace: WorkspaceSnapshot) => {
    setSnapshot({ ...workspace, runs: mergeRuns([], workspace.runs) });
    setSelectedId(null);
    setTab("runs");
    setLastChecked(new Date().toISOString());
  };

  const connect = async (url: string) => {
    const version = ++connectionVersion.current;
    requestVersion.current += 1;
    setConnecting(true);
    setError(null);
    try {
      const session = createNativeAuth(url);
      const next = new NativeApi(url, sessionHeaders(session));
      const state = await next.authState();
      if (version !== connectionVersion.current) return;
      // Better Auth's client is a callable proxy; keep React from invoking it as a state updater.
      setClient(next);
      setAuthClient(() => session);
      observeAuth(state);
      setSelectedId(null);
      setSnapshot(null);
      if (state.mode === "owner" && (state.setupNeeded || !state.user)) {
        setTab("connection");
        return;
      }
      const workspace = await next.workspace();
      if (version !== connectionVersion.current) return;
      storeWorkspace(workspace);
      AccessibilityInfo.announceForAccessibility(
        state.mode === "development"
          ? "Connected with explicit development authentication bypass."
          : "Owner session verified. Workspace runs are ready.",
      );
    } catch (caught) {
      if (version === connectionVersion.current) setError(message(caught));
    } finally {
      if (version === connectionVersion.current) setConnecting(false);
    }
  };

  const signIn = async (email: string, password: string): Promise<boolean> => {
    if (!authClient || !client) return false;
    const version = ++connectionVersion.current;
    setConnecting(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({
        email: email.trim(),
        password,
      });
      if (result.error)
        throw new Error(result.error.message ?? "The owner could not sign in.");
      const state = await client.authState();
      if (version !== connectionVersion.current) return false;
      if (state.mode !== "owner" || !state.user || state.setupNeeded)
        throw new Error(
          "An authenticated owner session was not confirmed. Reconnect and inspect backend mode.",
        );
      observeAuth(state);
      const workspace = await client.workspace();
      if (version !== connectionVersion.current) return false;
      storeWorkspace(workspace);
      AccessibilityInfo.announceForAccessibility(
        "Signed in. Owner session verified.",
      );
      return true;
    } catch (caught) {
      if (version === connectionVersion.current) setError(message(caught));
      return false;
    } finally {
      if (version === connectionVersion.current) setConnecting(false);
    }
  };

  const signOut = async () => {
    if (!authClient || !client) return;
    const version = ++connectionVersion.current;
    setConnecting(true);
    setError(null);
    try {
      const result = await authClient.signOut();
      if (result.error)
        throw new Error(
          result.error.message ?? "Sign-out could not be confirmed.",
        );
      const state = await client.authState();
      if (version !== connectionVersion.current) return;
      if (state.user)
        throw new Error(
          "The backend still reports an owner session. Sign-out has not been confirmed.",
        );
      requestVersion.current += 1;
      observeAuth(state);
      setSnapshot(null);
      setSelectedId(null);
      setTab("connection");
      AccessibilityInfo.announceForAccessibility(
        "Signed out. The owner session is no longer active.",
      );
    } catch (caught) {
      if (version === connectionVersion.current) setError(message(caught));
    } finally {
      if (version === connectionVersion.current) setConnecting(false);
    }
  };

  const refresh = useCallback(
    async (showSpinner = false) => {
      if (!client) return;
      const version = ++requestVersion.current;
      if (showSpinner) setRefreshing(true);
      try {
        const state = await client.authState();
        if (version !== requestVersion.current) return;
        if (authRef.current && state.mode !== authRef.current.mode) {
          setSnapshot(null);
          setSelectedId(null);
          setTab("connection");
          setError(
            "Backend authentication mode changed. Connect explicitly to inspect the new mode; no fallback was selected.",
          );
          setRefreshing(false);
          return;
        }
        authRef.current = state;
        setAuthState(state);
        if (state.mode === "owner" && (!state.user || state.setupNeeded)) {
          setSnapshot(null);
          setSelectedId(null);
          setTab("connection");
          setError(
            state.setupNeeded
              ? "Complete owner setup in the web workspace before signing in here."
              : "Your owner session has ended. Sign in again before loading runs or recording a decision.",
          );
          setRefreshing(false);
          return;
        }
        const workspace = await client.workspace();
        if (version !== requestVersion.current) return;
        setSnapshot((current) => ({
          ...workspace,
          runs: mergeRuns(current?.runs ?? [], workspace.runs),
        }));
        setError(null);
        setLastChecked(new Date().toISOString());
      } catch (caught) {
        if (version !== requestVersion.current) return;
        setError(message(caught));
        if (caught instanceof NativeApiError && caught.status === 401) {
          setSnapshot(null);
          setSelectedId(null);
          setTab("connection");
          if (authRef.current?.mode === "owner") {
            const ended = { ...authRef.current, user: null };
            authRef.current = ended;
            setAuthState(ended);
          }
        }
      } finally {
        if (version === requestVersion.current) setRefreshing(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!client || !snapshot) return;
    const interval = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 5000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
      requestVersion.current += 1;
    };
  }, [client, Boolean(snapshot), refresh]);

  const updateRun = useCallback((run: Run) => {
    requestVersion.current += 1;
    setSnapshot((current) =>
      current ? { ...current, runs: mergeRuns(current.runs, [run]) } : current,
    );
    setRefreshing(false);
    setError(null);
    setLastChecked(new Date().toISOString());
    AccessibilityInfo.announceForAccessibility(
      `${run.title}: ${statusLabels[run.status]}.${run.artifact ? " Local artifact saved." : run.decision?.decision === "reject" ? " No artifact was saved." : ""}`,
    );
  }, []);
  const openRun = (run: Run) => {
    setSelectedId(run.id);
    const version = requestVersion.current;
    if (client)
      void client
        .run(run.id)
        .then((fresh) => {
          if (version === requestVersion.current) updateRun(fresh);
        })
        .catch((caught: unknown) => {
          if (version === requestVersion.current) setError(message(caught));
        });
  };
  const selected = snapshot?.runs.find((run) => run.id === selectedId);
  const navigate = (next: Tab) => {
    setSelectedId(null);
    setTab(next);
  };
  const disconnect = () => {
    requestVersion.current += 1;
    connectionVersion.current += 1;
    setClient(null);
    setAuthClient(null);
    authRef.current = null;
    setAuthState(null);
    setSnapshot(null);
    setSelectedId(null);
    setError(null);
    setLastChecked(null);
    setTab("connection");
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safe}>
        <View style={styles.container}>
          {authState?.mode === "development" && client && (
            <View
              style={{
                paddingHorizontal: 18,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: "#5a533b",
                backgroundColor: "#282519",
              }}
            >
              <Badge tone="warning">
                Development bypass · No owner authentication
              </Badge>
            </View>
          )}
          {tab === "connection" || !client || !snapshot ? (
            <ConnectionScreen
              value={client?.baseUrl ?? "http://127.0.0.1:4310"}
              connecting={connecting}
              connected={Boolean(client && snapshot)}
              authState={authState}
              error={error}
              onConnect={connect}
              onSignIn={signIn}
              onSignOut={signOut}
              onDisconnect={disconnect}
              onBack={client && snapshot ? () => setTab("runs") : undefined}
            />
          ) : selected ? (
            <RunDetail
              key={selected.id}
              run={selected}
              client={client}
              connected={!error && !connecting}
              storage={snapshot.workspace.storage}
              onBack={() => setSelectedId(null)}
              onUpdate={updateRun}
              error={error}
              onRefresh={() => {
                void refresh(true);
              }}
              refreshing={refreshing}
            />
          ) : (
            <RunList
              snapshot={snapshot}
              pendingOnly={tab === "approvals"}
              error={error}
              lastChecked={lastChecked}
              refreshing={refreshing}
              onRefresh={() => {
                void refresh(true);
              }}
              onOpen={openRun}
            />
          )}
          {client && snapshot && !selected && (
            <View style={mobile.navigation} accessibilityRole="tablist">
              {(
                [
                  ["runs", "Runs"],
                  ["approvals", "Approvals"],
                  ["connection", "Connection"],
                ] as const
              ).map(([value, label]) => (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: tab === value }}
                  onPress={() => navigate(value)}
                  style={({ pressed }) => [
                    mobile.navItem,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      mobile.navLabel,
                      tab === value && { color: colors.accent },
                    ]}
                  >
                    {label}
                  </Text>
                  {value === "approvals" && (
                    <Text
                      style={[
                        mobile.navCount,
                        tab === value && { color: colors.lime },
                      ]}
                    >
                      {
                        snapshot.runs.filter(
                          (run) => run.status === "waiting_approval",
                        ).length
                      }
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function ConnectionScreen({
  value,
  connecting,
  connected,
  authState,
  error,
  onConnect,
  onSignIn,
  onSignOut,
  onDisconnect,
  onBack,
}: {
  value: string;
  connecting: boolean;
  connected: boolean;
  authState: AuthState | null;
  error: string | null;
  onConnect: (url: string) => Promise<void>;
  onSignIn: (email: string, password: string) => Promise<boolean>;
  onSignOut: () => Promise<void>;
  onDisconnect: () => void;
  onBack?: () => void;
}) {
  const [url, setUrl] = useState(value);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    setUrl(value);
  }, [value]);
  const sameBackend = url.trim().replace(/\/+$/, "") === value;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { flexGrow: 1 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={mobile.connectionBrand}>
          <Brand />
          {onBack && (
            <Action label="Back to runs" kind="quiet" onPress={onBack} />
          )}
        </View>
        <View style={mobile.connectionIntro}>
          <Eyebrow>NATIVE COMPANION / PRIVATE ALPHA</Eyebrow>
          <Text accessibilityRole="header" style={styles.title}>
            Your business.{"\n"}
            <Text style={styles.titleMuted}>Within reach.</Text>
          </Text>
          <Text style={[styles.body, { marginTop: 19 }]}>
            A clear view of your runs. The exact context behind a decision. You
            remain in control.
          </Text>
        </View>
        <Panel>
          <View style={styles.row}>
            <Badge tone="accent">Local-only</Badge>
            <Badge>Simulator connection</Badge>
          </View>
          <Text style={styles.heading}>Connect to your workspace.</Text>
          <Text style={styles.body}>
            Connect to the backend on this Mac, then verify the owner session
            before loading business data.
          </Text>
          <View>
            <Text style={styles.label}>Backend URL</Text>
            <TextInput
              accessibilityLabel="Backend URL"
              accessibilityHint="Loopback origin for the API on this Mac"
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              editable={!connecting}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (!connecting) void onConnect(url);
              }}
            />
          </View>
          <Action
            label={
              connecting
                ? "Working…"
                : authState
                  ? "Refresh connection"
                  : "Connect workspace"
            }
            onPress={() => {
              void onConnect(url);
            }}
            busy={connecting}
          />
          <Text style={styles.caption}>
            Loopback is for the iOS Simulator on this Mac. Physical iPhone
            access still requires a separately configured authenticated TLS
            endpoint; this app does not widen the API’s network boundary.
          </Text>
        </Panel>
        {error && <ErrorNotice message={error} />}
        {authState?.mode === "owner" && (
          <Panel style={{ marginTop: 18 }}>
            <Eyebrow>OWNER AUTHENTICATION</Eyebrow>
            {authState.setupNeeded ? (
              <>
                <Text style={styles.heading}>Set up the owner on the web.</Text>
                <Text style={styles.body}>
                  Complete the one-time owner setup in the web workspace on this
                  Mac. This companion does not accept the bootstrap token or
                  create an owner.
                </Text>
                <Text style={styles.caption}>
                  After setup, refresh this connection and sign in.
                </Text>
              </>
            ) : authState.user ? (
              <>
                <Text style={styles.heading}>Owner session verified.</Text>
                <Text selectable style={styles.body}>
                  {authState.user.name}
                  {"\n"}
                  {authState.user.email}
                </Text>
                <Action
                  label="Sign out"
                  kind="secondary"
                  disabled={connecting}
                  onPress={() => {
                    void onSignOut();
                  }}
                />
              </>
            ) : (
              <>
                <Text style={styles.heading}>Sign in as the owner.</Text>
                <Text style={styles.body}>
                  Session cookies are managed by the official Expo client and
                  stored in the iOS Keychain.
                </Text>
                {!sameBackend && (
                  <Text style={styles.caption}>
                    Connect the changed backend address before signing in.
                  </Text>
                )}
                <View>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    accessibilityLabel="Owner email"
                    style={styles.input}
                    value={email}
                    onChangeText={setEmail}
                    editable={!connecting && sameBackend}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    textContentType="username"
                    autoComplete="username"
                  />
                </View>
                <View>
                  <Text style={styles.label}>Password</Text>
                  <TextInput
                    accessibilityLabel="Owner password"
                    style={styles.input}
                    value={password}
                    onChangeText={setPassword}
                    editable={!connecting && sameBackend}
                    secureTextEntry
                    textContentType="password"
                    autoComplete="current-password"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <Action
                  label={connecting ? "Signing in…" : "Sign in"}
                  disabled={!sameBackend || !email.trim() || !password}
                  busy={connecting}
                  onPress={() => {
                    void onSignIn(email, password).then((success) => {
                      if (success) setPassword("");
                    });
                  }}
                />
              </>
            )}
          </Panel>
        )}
        {connected && (
          <View style={{ marginTop: 16 }}>
            <Action
              label="Disconnect this view"
              kind="quiet"
              onPress={onDisconnect}
              disabled={connecting}
            />
            <Text
              style={[styles.caption, { textAlign: "center", marginTop: 8 }]}
            >
              Clears the in-memory view. It does not sign out or revoke a
              session; use Sign out for that.
            </Text>
          </View>
        )}
        <View style={mobile.connectionFooter}>
          <Text style={styles.caption}>vuzmi / local alpha</Text>
          <Text style={styles.caption}>No cloud fallback</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function RunList({
  snapshot,
  pendingOnly,
  error,
  lastChecked,
  refreshing,
  onRefresh,
  onOpen,
}: {
  snapshot: WorkspaceSnapshot;
  pendingOnly: boolean;
  error: string | null;
  lastChecked: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (run: Run) => void;
}) {
  const runs = snapshot.runs.filter(
    (run) => !pendingOnly || run.status === "waiting_approval",
  );
  const waiting = snapshot.runs.filter(
    (run) => run.status === "waiting_approval",
  ).length;
  return (
    <FlatList
      data={runs}
      keyExtractor={(run) => run.id}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      ListHeaderComponent={
        <View>
          <View
            style={[
              styles.row,
              { justifyContent: "space-between", marginBottom: 28 },
            ]}
          >
            <Brand compact />
            <Text style={styles.caption}>{snapshot.workspace.name}</Text>
          </View>
          <Eyebrow>
            {pendingOnly ? "YOUR AUTHORITY / APPROVALS" : "WORKSPACE / RUNS"}
          </Eyebrow>
          <Text accessibilityRole="header" style={styles.title}>
            {pendingOnly ? "Your next decision." : "The work,"}
            {!pendingOnly && (
              <Text style={styles.titleMuted}>{"\n"}in your hands.</Text>
            )}
          </Text>
          <Text style={[styles.body, { marginTop: 15, marginBottom: 23 }]}>
            {pendingOnly
              ? "Review the exact proposal before authorising a local result."
              : "Actual runs, recorded decisions, and reviewable local results."}
          </Text>
          <View style={mobile.counts}>
            <View>
              <Text style={mobile.countValue}>{snapshot.runs.length}</Text>
              <Text style={styles.caption}>Runs created</Text>
            </View>
            <View style={mobile.countDivider} />
            <View>
              <Text style={[mobile.countValue, { color: colors.lime }]}>
                {waiting}
              </Text>
              <Text style={styles.caption}>Needs review</Text>
            </View>
          </View>
          {error && (
            <ErrorNotice
              message={`${error}${lastChecked ? ` Last observed ${date(lastChecked)}.` : ""}`}
            />
          )}
          <Text style={[styles.caption, { marginBottom: 17 }]}>
            LOCAL-ONLY /{" "}
            {pendingOnly ? "PENDING DECISIONS" : "EXECUTION HISTORY"}
          </Text>
        </View>
      }
      ListEmptyComponent={
        <Empty
          title={pendingOnly ? "Nothing waiting on you." : "A clear slate."}
          detail={
            pendingOnly
              ? "New proposals will appear here when a run needs your decision."
              : "Create a mission in the web workspace. Its actual run and review state will appear here."
          }
        />
      }
      renderItem={({ item: run }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${run.title}. ${statusLabels[run.status]}. ${domainLabels[run.domain]}. Open run.`}
          onPress={() => onOpen(run)}
          style={({ pressed }) => [mobile.runRow, pressed && mobile.runPressed]}
        >
          <View
            style={[
              styles.row,
              { justifyContent: "space-between", alignItems: "flex-start" },
            ]}
          >
            <Badge>{domainLabels[run.domain]}</Badge>
            <RunBadge status={run.status} />
          </View>
          <Text style={mobile.runTitle}>{run.title}</Text>
          <Text style={styles.caption}>
            {run.mode === "simulation"
              ? "Local simulation · No model call"
              : `Local Ollama · ${run.route.model ?? "Model not recorded"}`}
          </Text>
          <Text style={mobile.runStep}>
            {run.artifact
              ? "Local artifact saved"
              : run.status === "waiting_approval"
                ? "Exact proposal ready for review"
                : (run.events.at(-1)?.message ?? "No execution event recorded")}
          </Text>
          <View
            style={[
              styles.row,
              { justifyContent: "space-between", marginTop: 17 },
            ]}
          >
            <Text style={styles.caption}>{date(run.createdAt)}</Text>
            <Text style={mobile.openArrow} accessibilityElementsHidden>
              →
            </Text>
          </View>
        </Pressable>
      )}
    />
  );
}

function RunDetail({
  run,
  client,
  connected,
  storage,
  onBack,
  onUpdate,
  error: connectionError,
  onRefresh,
  refreshing,
}: {
  run: Run;
  client: NativeApi;
  connected: boolean;
  storage: WorkspaceSnapshot["workspace"]["storage"];
  onBack: () => void;
  onUpdate: (run: Run) => void;
  error: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [section, setSection] = useState<"summary" | "document" | "evidence">(
    "summary",
  );
  const [returnSection, setReturnSection] = useState<"summary" | "document">(
    "summary",
  );
  const [selectedCitation, setSelectedCitation] = useState<string | null>(null);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = run.proposal;
  const document = run.artifact?.content ?? proposal?.content;
  const approved = Boolean(run.artifact);
  const rejected = run.decision?.decision === "reject";
  const showEvidence = (citation?: string) => {
    setReturnSection(section === "document" ? "document" : "summary");
    setSelectedCitation(citation ?? null);
    setSection("evidence");
  };
  const decide = async (choice: "approve" | "reject") => {
    if (!proposal || run.status !== "waiting_approval") return;
    setDecision(choice);
    setError(null);
    try {
      onUpdate(await client.decide(run, choice));
    } catch (caught) {
      setError(message(caught));
      AccessibilityInfo.announceForAccessibility(message(caught));
      if (caught instanceof NativeApiError && caught.status === 409) {
        try {
          onUpdate(await client.run(run.id));
        } catch {
          /* Preserve the visible conflict message. */
        }
      }
    } finally {
      setDecision(null);
    }
  };
  const back = () => {
    if (section === "summary") onBack();
    else setSection(section === "evidence" ? returnSection : "summary");
  };
  const header = (
    <View style={mobile.detailNavigation}>
      <Action
        label={
          section === "summary"
            ? "‹ Runs"
            : section === "evidence" && returnSection === "document"
              ? "‹ Document"
              : "‹ Review"
        }
        kind="quiet"
        onPress={back}
        disabled={Boolean(decision)}
      />
      <Text style={styles.caption}>
        {section === "summary"
          ? "RUN DETAIL"
          : section === "document"
            ? "EXACT DOCUMENT"
            : "RETAINED EVIDENCE"}
      </Text>
      {section === "summary" ? (
        <Action
          label={refreshing ? "Refreshing…" : "Refresh"}
          kind="quiet"
          onPress={onRefresh}
          disabled={refreshing || Boolean(decision)}
        />
      ) : (
        <View style={{ width: 12 }} />
      )}
    </View>
  );

  if (section === "document")
    return (
      <View style={{ flex: 1 }}>
        {header}
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Eyebrow>
            {approved
              ? "SAVED ARTIFACT"
              : rejected
                ? "REJECTED PROPOSAL"
                : "EXACT PROPOSAL"}
          </Eyebrow>
          <Text accessibilityRole="header" style={styles.heading}>
            {run.title}
          </Text>
          <Text style={[styles.caption, { marginVertical: 14 }]}>
            Revision {run.decision?.revision ?? run.revision} · Selectable
            complete Markdown · No content is omitted.
          </Text>
          {run.mode === "ollama" && (
            <Panel style={{ marginBottom: 18 }}>
              <Text style={styles.body}>
                Unverified local model output.{" "}
                {run.evidence?.status === "matched"
                  ? "Recorded evidence is available below; claims still require review."
                  : "No retrieval was used."}{" "}
                No repository inspection, tests, deployment, or external
                messages were performed.
              </Text>
            </Panel>
          )}
          <Text selectable style={mobile.exactDocument}>
            {document ?? "No document has been recorded."}
          </Text>
          {run.evidence && (
            <View style={{ marginTop: 26, gap: 10 }}>
              <Text style={styles.subheading}>Read the retained context</Text>
              {run.evidence.items.map((item) => (
                <Action
                  key={item.citation}
                  label={`[${item.citation}] ${item.title} · revision ${item.revision}`}
                  kind="secondary"
                  onPress={() => showEvidence(item.citation)}
                />
              ))}
            </View>
          )}
          <View style={{ marginTop: 25 }}>
            <Action
              label="Back to review"
              kind="secondary"
              onPress={() => setSection("summary")}
            />
          </View>
        </ScrollView>
      </View>
    );

  if (section === "evidence") {
    const evidence = run.evidence;
    const items = evidence
      ? [...evidence.items].sort(
          (a, b) =>
            Number(b.citation === selectedCitation) -
            Number(a.citation === selectedCitation),
        )
      : [];
    return (
      <View style={{ flex: 1 }}>
        {header}
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Eyebrow>EXACT RETAINED SNAPSHOT</Eyebrow>
          <Text accessibilityRole="header" style={styles.heading}>
            {evidence?.status === "insufficient"
              ? "Insufficient evidence."
              : evidence
                ? "Evidence behind the draft."
                : run.knowledge
                  ? "Evidence is required."
                  : "No retrieval requested."}
          </Text>
          <Text style={[styles.body, { marginTop: 13, marginBottom: 21 }]}>
            {evidence?.status === "insufficient"
              ? "Required context was not sufficient. Generation must not proceed without it."
              : evidence
                ? "These excerpts were recorded as context. Their presence does not independently verify generated claims."
                : run.knowledge
                  ? "No retrieval result has been recorded yet."
                  : "This mission did not request source or memory retrieval."}
          </Text>
          {evidence && (
            <>
              <Text style={styles.label}>Retrieval query</Text>
              <Text selectable style={[styles.body, { marginBottom: 20 }]}>
                {evidence.query}
              </Text>
              {evidence.messages.map((item, index) => (
                <Text
                  style={[styles.caption, { marginBottom: 12 }]}
                  key={index}
                >
                  {item}
                </Text>
              ))}
            </>
          )}
          {items.map((item) => (
            <Panel
              key={item.citation}
              style={[
                { marginBottom: 16 },
                selectedCitation === item.citation && {
                  borderColor: colors.accent,
                },
              ]}
            >
              <View style={styles.row}>
                <Badge tone="warning">{`[${item.citation}]`}</Badge>
                <Badge>{item.kind === "source" ? "Source" : "Memory"}</Badge>
              </View>
              <Text accessibilityRole="header" style={styles.subheading}>
                {item.title}
              </Text>
              <Text style={styles.caption}>
                Revision {item.revision}
                {item.lineStart !== null
                  ? ` · Lines ${item.lineStart}–${item.lineEnd ?? item.lineStart}`
                  : ""}
                {item.chunkIndex !== null
                  ? ` · Passage ${item.chunkIndex + 1}`
                  : ""}
              </Text>
              <Text selectable style={styles.body}>
                {item.text}
              </Text>
              <Text selectable style={mobile.hash}>
                {item.contentHash}
              </Text>
            </Panel>
          ))}
          {evidence && (
            <Text style={styles.caption}>
              Retrieved {date(evidence.retrievedAt)}. Historical excerpts remain
              retained if the source or memory is later deleted.
            </Text>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {header}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        <View style={[styles.row, { marginBottom: 17 }]}>
          <RunBadge status={run.status} />
          <Badge>
            {run.mode === "simulation" ? "Local simulation" : "Local Ollama"}
          </Badge>
        </View>
        <Text
          accessibilityRole="header"
          style={[styles.title, { fontSize: 30, lineHeight: 37 }]}
        >
          {run.title}
        </Text>
        <Text style={[styles.caption, { marginTop: 13, marginBottom: 23 }]}>
          {domainLabels[run.domain]} · {date(run.createdAt)}
        </Text>
        {connectionError && <ErrorNotice message={connectionError} />}
        <Panel
          style={[mobile.reviewPanel, approved && { borderColor: "#4a7358" }]}
        >
          <Eyebrow>
            {approved
              ? "DECISION RECORDED"
              : rejected
                ? "REVIEW CLOSED"
                : proposal
                  ? "YOUR DECISION"
                  : "EXECUTION STATUS"}
          </Eyebrow>
          <Text style={styles.heading}>
            {approved
              ? "A clear local result."
              : rejected
                ? "Proposal rejected."
                : proposal
                  ? "Ready for your review."
                  : run.status === "failed"
                    ? "No draft is ready."
                    : run.status === "running"
                      ? "Your mission is running."
                      : "Waiting for the worker."}
          </Text>
          <Text style={styles.body}>
            {approved
              ? "This exact document was saved to the local artifact library."
              : rejected
                ? "Your rejection is recorded. No artifact was saved by this run."
                : proposal
                  ? "Approve the displayed document to save it as a local artifact."
                  : "No reviewable document has been recorded. The execution trail below shows the actual progress."}
          </Text>
          {run.error && (
            <ErrorNotice message={`${run.error.code}: ${run.error.message}`} />
          )}
          <Text style={styles.caption}>
            No deployment, publication, purchase, or external message is
            authorised by this review.
          </Text>
          {document !== undefined && (
            <Action
              label="Read exact document"
              kind="secondary"
              hint="Opens the full selectable artifact without truncation"
              onPress={() => setSection("document")}
            />
          )}
          <Action
            label={
              run.evidence
                ? `${run.evidence.status === "insufficient" ? "Insufficient evidence" : `Read evidence · ${run.evidence.items.length} excerpts`}`
                : run.knowledge
                  ? "Required evidence · pending"
                  : "Evidence · not requested"
            }
            kind="quiet"
            onPress={() => showEvidence()}
          />
          {error && <ErrorNotice message={error} />}{" "}
          {proposal && run.status === "waiting_approval" && (
            <View style={{ gap: 9 }}>
              <Action
                label={
                  decision === "approve"
                    ? "Saving local result…"
                    : "Approve local result"
                }
                disabled={!connected || Boolean(decision)}
                busy={decision === "approve"}
                onPress={() => {
                  void decide("approve");
                }}
                hint="Sends this exact proposal fingerprint and revision for approval"
              />
              <Action
                label={
                  decision === "reject"
                    ? "Recording rejection…"
                    : "Reject proposal"
                }
                kind="quiet"
                disabled={!connected || Boolean(decision)}
                busy={decision === "reject"}
                onPress={() => {
                  void decide("reject");
                }}
              />
              {!connected && (
                <Text style={styles.caption}>
                  Refresh the backend connection before recording a decision.
                </Text>
              )}
            </View>
          )}
          {run.decision && (
            <Text style={styles.caption}>
              {run.decision.decision === "approve" ? "Approved" : "Rejected"} by{" "}
              {run.decision.actorName ??
                (run.decision.actor === "local-operator"
                  ? "local operator"
                  : "workspace owner")}{" "}
              · {date(run.decision.decidedAt)}
            </Text>
          )}
        </Panel>
        {document !== undefined && (
          <Panel style={{ marginTop: 18 }}>
            <Eyebrow>DOCUMENT PREVIEW</Eyebrow>
            <Text style={styles.body} numberOfLines={6}>
              {document}
            </Text>
            <Text style={styles.caption}>
              Preview only. Read exact document opens every character.
            </Text>
            <Action
              label="Open full document"
              kind="secondary"
              onPress={() => setSection("document")}
            />
          </Panel>
        )}
        <View style={{ marginTop: 28 }}>
          <Eyebrow>EXECUTION CONTEXT</Eyebrow>
          <Panel style={{ gap: 0 }}>
            <Fact
              label="Mode"
              value={
                run.mode === "simulation" ? "Local simulation" : "Local Ollama"
              }
            />
            <Fact label="Policy" value="Local only · Cloud fallback off" />
            <Fact
              label="Model"
              value={
                run.mode === "simulation"
                  ? "No model call"
                  : (run.route.model ?? "Not recorded")
              }
            />
            <Fact
              label="Generation"
              value={
                run.mode === "simulation"
                  ? "Deterministic template"
                  : run.route.executed
                    ? "Provider output recorded"
                    : "No output recorded"
              }
            />
            <Fact
              label="Storage"
              value={storage === "postgres" ? "PostgreSQL" : "Local file"}
            />
            <Fact
              label="Evidence"
              value={
                run.evidence
                  ? run.evidence.status === "matched"
                    ? `${run.evidence.items.length} retained excerpts`
                    : "Insufficient"
                  : run.knowledge
                    ? "Required · pending"
                    : "Not requested"
              }
            />
            {run.usage && (
              <>
                <Fact
                  label="Input tokens"
                  value={
                    run.usage.inputTokens === null
                      ? "Not recorded"
                      : run.usage.inputTokens.toLocaleString("en-GB")
                  }
                />
                <Fact
                  label="Output tokens"
                  value={
                    run.usage.outputTokens === null
                      ? "Not recorded"
                      : run.usage.outputTokens.toLocaleString("en-GB")
                  }
                />
                <Fact
                  label="Provider duration"
                  value={
                    run.usage.durationMs === null
                      ? "Not recorded"
                      : `${(run.usage.durationMs / 1000).toLocaleString("en-GB", { maximumFractionDigits: 2 })}s`
                  }
                />
              </>
            )}
            <Text style={[styles.caption, { marginTop: 15 }]}>
              {run.route.reason}
            </Text>
          </Panel>
        </View>
        <View style={{ marginTop: 27 }}>
          <Eyebrow>A RECORD YOU CAN FOLLOW</Eyebrow>
          <Text style={[styles.heading, { marginBottom: 18 }]}>
            Execution trail · {run.events.length}
          </Text>
          {run.events.map((event) => (
            <View style={mobile.event} key={event.sequence}>
              <View style={mobile.eventDot} />
              <View style={{ flex: 1 }}>
                <Text style={mobile.eventTitle}>
                  {event.type.split(".").join(" · ")}
                </Text>
                <Text style={[styles.body, { marginTop: 6 }]}>
                  {event.message}
                </Text>
                <Text style={[styles.caption, { marginTop: 7 }]}>
                  {date(event.occurredAt)}
                </Text>
              </View>
            </View>
          ))}
        </View>
        <Panel style={{ marginTop: 14 }}>
          <Eyebrow>EXACT ACTION RECORD</Eyebrow>
          <Text style={styles.caption}>
            Run revision {run.revision}
            {proposal
              ? ` · Proposal revision ${run.decision?.revision ?? run.revision}`
              : ""}
          </Text>
          {proposal && (
            <>
              <Text style={styles.label}>Proposal fingerprint</Text>
              <Text selectable style={mobile.hash}>
                {proposal.fingerprint}
              </Text>
            </>
          )}
          <Text style={styles.label}>Run ID</Text>
          <Text selectable style={mobile.hash}>
            {run.id}
          </Text>
          {run.attemptId && (
            <>
              <Text style={styles.label}>Attempt ID</Text>
              <Text selectable style={mobile.hash}>
                {run.attemptId}
              </Text>
            </>
          )}
          <Text style={styles.label}>Original brief</Text>
          <Text selectable style={styles.body}>
            {run.brief}
          </Text>
        </Panel>
      </ScrollView>
    </View>
  );
}

const mobile = StyleSheet.create({
  connectionBrand: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 36,
  },
  connectionIntro: { marginBottom: 27 },
  connectionFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
    marginTop: "auto",
    paddingTop: 32,
  },
  navigation: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: "#0d1920",
    paddingHorizontal: 8,
    paddingTop: 5,
    paddingBottom: 4,
  },
  navItem: {
    flex: 1,
    minHeight: 55,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  navLabel: {
    color: "#879fa9",
    fontSize: 13,
    lineHeight: 20,
    fontWeight: "500",
  },
  navCount: { fontSize: 12, lineHeight: 17, color: "#719286" },
  counts: {
    flexDirection: "row",
    alignItems: "center",
    gap: 27,
    padding: 21,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface,
    marginBottom: 27,
  },
  countValue: {
    fontSize: 32,
    lineHeight: 39,
    fontWeight: "500",
    color: colors.text,
    marginBottom: 5,
    fontVariant: ["tabular-nums"],
  },
  countDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: colors.border,
  },
  runRow: {
    padding: 20,
    borderWidth: 1,
    borderColor: "#2c454d",
    borderRadius: 11,
    backgroundColor: colors.surface,
    marginBottom: 13,
  },
  runPressed: { backgroundColor: "#192d32" },
  runTitle: {
    fontSize: 18,
    lineHeight: 26,
    letterSpacing: -0.2,
    fontWeight: "500",
    color: colors.text,
    marginTop: 17,
    marginBottom: 9,
  },
  runStep: { fontSize: 14, lineHeight: 22, color: "#94b4ad", marginTop: 13 },
  openArrow: { color: colors.accent, fontSize: 22, lineHeight: 25 },
  detailNavigation: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#243a43",
  },
  reviewPanel: { backgroundColor: "#17261f", borderColor: "#51613f", gap: 16 },
  exactDocument: {
    fontSize: 14,
    lineHeight: 23,
    color: "#ceddd8",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  hash: {
    fontSize: 12,
    lineHeight: 20,
    color: "#8eaeb1",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  event: { flexDirection: "row", gap: 13, paddingBottom: 24 },
  eventDot: {
    height: 8,
    width: 8,
    borderRadius: 4,
    backgroundColor: "#79b29a",
    marginTop: 7,
  },
  eventTitle: {
    fontSize: 13,
    lineHeight: 20,
    color: "#abc8bf",
    fontWeight: "500",
  },
});
