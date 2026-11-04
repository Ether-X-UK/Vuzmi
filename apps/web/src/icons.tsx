import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "command"
  | "runs"
  | "check"
  | "arrow"
  | "plus"
  | "close"
  | "refresh"
  | "knowledge"
  | "models"
  | "agents"
  | "chevron"
  | "download"
  | "copy"
  | "shield"
  | "external"
  | "clock"
  | "alert"
  | "build"
  | "operate"
  | "support"
  | "market"
  | "sell";

const paths: Record<IconName, ReactNode> = {
  command: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  runs: (
    <>
      <path d="M8 5h12M8 12h12M8 19h12" />
      <path d="M3 5h.01M3 12h.01M3 19h.01" strokeWidth="3" />
    </>
  ),
  check: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="m7 12 3 3 7-7" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 12h15M13 5l7 7-7 7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  refresh: (
    <>
      <path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" />
    </>
  ),
  knowledge: (
    <>
      <path d="M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Zm0 0v15" />
    </>
  ),
  models: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M7 12h4c4 0 2-7 6-7m-6 7c4 0 2 7 6 7" />
    </>
  ),
  agents: (
    <>
      <path d="M12 3v3M5 11H3m18 0h-2M7 20v1m10-1v1" />
      <rect x="5" y="6" width="14" height="14" rx="4" />
      <path d="M9 11h.01M15 11h.01M9 16h6" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v4m0 4h.01" />
    </>
  ),
  build: (
    <>
      <path d="m8 4-5 8 5 8m8-16 5 8-5 8M14 3l-4 18" />
    </>
  ),
  operate: (
    <>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </>
  ),
  support: (
    <>
      <path d="M4 13v-2a8 8 0 0 1 16 0v6a4 4 0 0 1-4 4h-4" />
      <rect x="2" y="10" width="4" height="7" rx="2" />
      <rect x="18" y="10" width="4" height="7" rx="2" />
    </>
  ),
  market: (
    <>
      <path d="m3 10 17-6v16L3 14v-4Zm4 5 2 6h4l-2-5M20 9l2-1m-2 7 2 1" />
    </>
  ),
  sell: (
    <>
      <path d="m3 17 6-6 4 3 8-10M15 4h6v6M3 21h18" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  className = "",
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m6 9 14 24L34 9M17 9l9 15"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
