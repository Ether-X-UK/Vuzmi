import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { authStateSchema, type AuthState } from "@vuzmi/core";
import { BrandMark } from "./icons";
import { App } from "./App";

async function authRequest(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as {
    error?: { message?: string };
    message?: string;
  };
  if (!response.ok)
    throw new Error(
      result.error?.message ??
        result.message ??
        "Authentication could not complete. Check your details and try again.",
    );
  return result;
}
export function AuthGate() {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const observedMode = useRef<AuthState["mode"] | null>(null);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = authStateSchema.parse(await authRequest("/v1/auth/state"));
      if (current === generation.current) {
        if (observedMode.current && result.mode !== observedMode.current) {
          setState(null);
          setError(
            "The backend authentication mode changed. Reload deliberately to inspect its configuration; no fallback was selected.",
          );
          return;
        }
        observedMode.current = result.mode;
        setState(result);
        setError(null);
      }
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The local backend could not be reached.",
        );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => {
      ++generation.current;
      setState(null);
      void refresh();
    };
    window.addEventListener("vuzmi:session-expired", expired);
    return () => {
      ++generation.current;
      window.removeEventListener("vuzmi:session-expired", expired);
    };
  }, [refresh]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !state) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    try {
      if (state.setupNeeded) {
        await authRequest("/v1/auth/setup", {
          token: String(data.get("token") ?? ""),
          name: String(data.get("name") ?? ""),
          email,
          password,
        });
        setState({ mode: "owner", setupNeeded: false, user: null });
      }
      await authRequest("/api/auth/sign-in/email", { email, password });
      form.reset();
      await refresh();
    } catch (cause) {
      await refresh();
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await authRequest("/api/auth/sign-out", {});
      ++generation.current;
      setState({ mode: "owner", setupNeeded: false, user: null });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Sign-out could not complete.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (state && (state.mode === "development" || state.user))
    return (
      <>
        <App
          owner={state.user}
          development={state.mode === "development"}
          onSignOut={() => void signOut()}
          signingOut={busy}
        />
        {error && (
          <div className="auth-session-error" role="alert">
            {error}
            <button
              className="button button-small"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}
      </>
    );
  return (
    <main className="auth-page">
      <div className="auth-brand">
        <BrandMark size={34} />
        <span>VUZMI</span>
        <small>PRIVATE ALPHA</small>
      </div>
      <section className="auth-card">
        <span className="eyebrow">YOUR BUSINESS. ONE CONTROL PLANE.</span>
        <h1>
          {!state
            ? "Connecting your workspace"
            : state.setupNeeded
              ? "Make this workspace yours."
              : "Welcome back."}
        </h1>
        <p className="auth-intro">
          {state?.setupNeeded
            ? "Create the single owner account for this private Vuzmi workspace. Your credentials stay on your backend."
            : "Sign in to orchestrate your next move."}
        </p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {!state ? (
          <button
            className="button button-primary"
            onClick={() => void refresh()}
          >
            Reconnect
          </button>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            {state.setupNeeded && (
              <>
                <label htmlFor="setup-key">Private setup key</label>
                <input
                  id="setup-key"
                  name="token"
                  type="password"
                  autoComplete="off"
                  minLength={32}
                  maxLength={256}
                  required
                />
                <p className="field-help">
                  Use the key created on the backend at{" "}
                  <code>.data/dev/owner-setup-key</code>.
                </p>
                <label htmlFor="owner-name">Your name</label>
                <input
                  id="owner-name"
                  name="name"
                  autoComplete="name"
                  maxLength={120}
                  required
                />
              </>
            )}
            <label htmlFor="owner-email">Email</label>
            <input
              id="owner-email"
              name="email"
              type="email"
              autoComplete="username"
              maxLength={254}
              required
            />
            <label htmlFor="owner-password">Password</label>
            <input
              id="owner-password"
              name="password"
              type="password"
              autoComplete={
                state.setupNeeded ? "new-password" : "current-password"
              }
              minLength={12}
              maxLength={128}
              required
            />
            {state.setupNeeded && (
              <p className="field-help">
                Choose at least 12 characters. No email service is needed for
                this private alpha.
              </p>
            )}
            <button
              className="button button-primary auth-submit"
              type="submit"
              disabled={busy}
            >
              {busy
                ? "Securing your session…"
                : state.setupNeeded
                  ? "Create owner & enter workspace"
                  : "Enter workspace"}
              <span aria-hidden="true">↗</span>
            </button>
          </form>
        )}
        <p className="auth-footnote">
          Local intelligence · Human authority · Your infrastructure
        </p>
      </section>
      <span className="auth-orbit" aria-hidden="true" />
    </main>
  );
}
