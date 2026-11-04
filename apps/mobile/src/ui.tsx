import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { RunStatus } from "@vuzmi/core";

export const colors = {
  background: "#080e13",
  surface: "#0e171e",
  raised: "#14212a",
  border: "#2b414b",
  text: "#edf5f3",
  muted: "#9bb0b8",
  faint: "#7d97a2",
  accent: "#79e4d0",
  lime: "#d2ee94",
  warning: "#f0bc72",
  danger: "#ff8995",
};
export const statusLabels: Record<RunStatus, string> = {
  queued: "Queued",
  running: "In progress",
  waiting_approval: "Needs review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <View style={styles.brand} accessibilityLabel="Vuzmi">
      <View style={styles.mark}>
        <View style={styles.markLeft} />
        <View style={styles.markRight} />
        <View style={styles.markInner} />
      </View>
      {!compact && (
        <Text style={styles.wordmark}>
          vuzmi<Text style={{ color: colors.accent }}>.</Text>
        </Text>
      )}
    </View>
  );
}

export function Action({
  label,
  onPress,
  kind = "primary",
  disabled = false,
  busy = false,
  hint,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "quiet" | "danger";
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        kind === "primary"
          ? styles.primary
          : kind === "secondary"
            ? styles.secondary
            : kind === "danger"
              ? styles.danger
              : styles.quiet,
        (disabled || busy) && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy && (
        <ActivityIndicator
          size="small"
          color={kind === "primary" ? "#15342b" : colors.accent}
        />
      )}
      <Text
        style={[
          styles.actionText,
          kind === "primary"
            ? { color: "#10352b" }
            : kind === "danger"
              ? { color: "#ffc1cd" }
              : { color: colors.text },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Eyebrow({ children }: { children: string }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}
export function Badge({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: "muted" | "accent" | "warning" | "danger";
}) {
  const color =
    tone === "accent"
      ? colors.accent
      : tone === "warning"
        ? colors.lime
        : tone === "danger"
          ? colors.danger
          : colors.muted;
  return (
    <View
      style={[
        styles.badge,
        { borderColor: color + "60", backgroundColor: color + "12" },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{children}</Text>
    </View>
  );
}
export function RunBadge({ status }: { status: RunStatus }) {
  return (
    <Badge
      tone={
        status === "waiting_approval"
          ? "warning"
          : status === "completed"
            ? "accent"
            : status === "failed"
              ? "danger"
              : "muted"
      }
    >
      {statusLabels[status]}
    </Badge>
  );
}
export function Panel({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.panel, style]}>{children}</View>;
}
export function ErrorNotice({ message }: { message: string }) {
  return (
    <View accessibilityRole="alert" style={styles.error}>
      <Text style={styles.errorTitle}>Needs attention</Text>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={styles.empty}>
      <Text accessibilityRole="header" style={styles.emptyTitle}>
        {title}
      </Text>
      <Text style={styles.body}>{detail}</Text>
    </View>
  );
}
export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text selectable style={styles.factValue}>
        {value}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  safe: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, width: "100%", maxWidth: 900, alignSelf: "center" },
  scrollContent: { padding: 24, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 9 },
  mark: { width: 33, height: 35, position: "relative" },
  markLeft: {
    position: "absolute",
    width: 3,
    height: 27,
    backgroundColor: colors.accent,
    transform: [{ rotate: "-29deg" }],
    left: 9,
    top: 3,
    borderRadius: 2,
  },
  markRight: {
    position: "absolute",
    width: 3,
    height: 27,
    backgroundColor: colors.accent,
    transform: [{ rotate: "29deg" }],
    left: 21,
    top: 3,
    borderRadius: 2,
  },
  markInner: {
    position: "absolute",
    width: 3,
    height: 15,
    backgroundColor: colors.accent,
    transform: [{ rotate: "-29deg" }],
    left: 18,
    top: 2,
    borderRadius: 2,
  },
  wordmark: {
    fontSize: 32,
    fontWeight: "600",
    letterSpacing: -1.6,
    color: colors.text,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 1.4,
    lineHeight: 19,
    color: "#88a9a6",
    marginBottom: 12,
  },
  title: {
    fontSize: 35,
    lineHeight: 41,
    letterSpacing: -1.1,
    fontWeight: "500",
    color: colors.text,
  },
  titleMuted: { color: "#9eafb1" },
  body: { fontSize: 15, lineHeight: 24, color: colors.muted },
  caption: { fontSize: 12, lineHeight: 19, color: colors.faint },
  heading: {
    fontSize: 21,
    lineHeight: 29,
    fontWeight: "500",
    letterSpacing: -0.4,
    color: colors.text,
  },
  subheading: {
    fontSize: 17,
    lineHeight: 25,
    fontWeight: "500",
    color: "#d4e3df",
  },
  action: {
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 9,
  },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: "#15262e", borderColor: "#3a535c" },
  quiet: { backgroundColor: "transparent", borderColor: "transparent" },
  danger: { backgroundColor: "#3b2730", borderColor: "#724350" },
  actionText: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "600",
    textAlign: "center",
    flexShrink: 1,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderWidth: 1,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  badgeText: { fontSize: 12, fontWeight: "500", lineHeight: 17, flexShrink: 1 },
  dot: { height: 4, width: 4, borderRadius: 2 },
  panel: {
    padding: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    gap: 15,
  },
  error: {
    padding: 16,
    borderWidth: 1,
    borderColor: "#77414f",
    backgroundColor: "#30212a",
    borderRadius: 9,
    gap: 7,
    marginVertical: 10,
  },
  errorTitle: {
    color: "#ffc3cd",
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "600",
  },
  errorText: { fontSize: 14, lineHeight: 22, color: "#e4b1bb" },
  empty: {
    paddingVertical: 36,
    paddingHorizontal: 23,
    borderWidth: 1,
    borderColor: "#2c454d",
    borderStyle: "dashed",
    borderRadius: 12,
    backgroundColor: "#0c171e",
    gap: 13,
  },
  emptyTitle: {
    fontSize: 23,
    lineHeight: 30,
    color: colors.text,
    fontWeight: "500",
    letterSpacing: -0.5,
  },
  fact: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#233a44",
  },
  factLabel: { fontSize: 13, lineHeight: 21, color: "#829fa9", flex: 1 },
  factValue: {
    fontSize: 13,
    lineHeight: 21,
    color: "#c0d5d1",
    flex: 1.5,
    textAlign: "right",
  },
  label: {
    fontSize: 13,
    fontWeight: "500",
    lineHeight: 21,
    color: "#c1d4d0",
    marginBottom: 9,
  },
  input: {
    minHeight: 48,
    padding: 13,
    borderWidth: 1,
    borderColor: "#36515c",
    borderRadius: 8,
    backgroundColor: "#0a161d",
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  divider: { height: 1, backgroundColor: colors.border },
});
