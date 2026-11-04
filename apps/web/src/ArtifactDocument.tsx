import { Children, isValidElement, useRef, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EvidenceSnapshot } from "@vuzmi/core";
import { focusEvidence } from "./Evidence";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};
const citationPattern = /^vuzmi-citation:([SM][1-9][0-9]*)$/;

function evidenceCitationLinks() {
  return (tree: unknown) => {
    const walk = (node: MarkdownNode): void => {
      if (
        !node.children ||
        [
          "code",
          "inlineCode",
          "link",
          "linkReference",
          "definition",
          "image",
          "imageReference",
          "html",
        ].includes(node.type)
      )
        return;
      const next: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) {
          walk(child);
          next.push(child);
          continue;
        }
        let offset = 0;
        for (const match of child.value.matchAll(/\[([SM][1-9][0-9]*)\]/g)) {
          const index = match.index!;
          if (index > offset)
            next.push({
              type: "text",
              value: child.value.slice(offset, index),
            });
          next.push({
            type: "link",
            url: `vuzmi-citation:${match[1]}`,
            children: [{ type: "text", value: match[0] }],
          });
          offset = index + match[0].length;
        }
        if (offset === 0) next.push(child);
        else if (offset < child.value.length)
          next.push({ type: "text", value: child.value.slice(offset) });
      }
      node.children = next;
    };
    walk(tree as MarkdownNode);
  };
}

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plainText(child.props.children)
          : "",
    )
    .join("");
}

function safeUrl(url: string, key: string): string {
  if (key !== "href") return "";
  if (citationPattern.test(url) || url.startsWith("#")) return url;
  try {
    const target = new URL(url);
    return ["http:", "https:"].includes(target.protocol) &&
      !target.username &&
      !target.password
      ? target.href
      : "";
  } catch {
    return "";
  }
}

export function ArtifactDocument({
  content,
  evidence,
  prefix = "document",
}: {
  content: string;
  evidence?: EvidenceSnapshot;
  prefix?: string;
}) {
  const article = useRef<HTMLElement>(null);
  const citation = (id: string, text: ReactNode) => {
    const item = evidence?.items.find((entry) => entry.citation === id);
    return item ? (
      <button
        type="button"
        className="document-citation"
        aria-label={`Citation ${id}: ${item.title}, revision ${item.revision}`}
        onClick={() => focusEvidence(prefix, id)}
      >
        {text}
      </button>
    ) : (
      <span
        className="unsupported-citation"
        title="No matching recorded evidence"
        aria-label={`${id}: no matching recorded evidence`}
      >
        {text}
      </span>
    );
  };
  const localLink = (href: string) => {
    let id: string;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const target = [
      ...(article.current?.querySelectorAll<HTMLElement>("[id]") ?? []),
    ].find((node) => node.id === id);
    if (target) {
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "center" });
    }
  };
  const components: Components = {
    h1: ({ node: _node, ...props }) => <h2 {...props} />,
    h2: ({ node: _node, ...props }) => <h3 {...props} />,
    h3: ({ node: _node, ...props }) => (
      <h4
        {...props}
        style={{
          fontSize: 16,
          lineHeight: 1.6,
          fontWeight: 600,
          margin: "22px 0 9px",
          color: "#d0e0dc",
        }}
      />
    ),
    a: ({ node: _node, href, children, id }) => {
      const marker =
        href?.match(citationPattern)?.[1] ??
        plainText(children).match(/^\[?([SM][1-9][0-9]*)\]?$/)?.[1];
      if (marker) return citation(marker, children);
      if (href?.startsWith("#"))
        return (
          <button
            type="button"
            id={id}
            className="document-citation"
            onClick={() => localLink(href)}
          >
            {children}
          </button>
        );
      if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
      return (
        <a
          id={id}
          href={href}
          target="_blank"
          rel="nofollow noopener noreferrer"
          referrerPolicy="no-referrer"
          style={{
            color: "#79e4d0",
            textDecoration: "underline",
            textUnderlineOffset: 3,
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ alt }) => (
      <span style={{ color: "#93aaa9", fontStyle: "italic" }}>
        {alt ? `Image: ${alt}` : "Image omitted"}
      </span>
    ),
    pre: ({ node: _node, ...props }) => (
      <pre
        {...props}
        style={{
          maxWidth: "100%",
          overflowX: "auto",
          whiteSpace: "pre",
          padding: 16,
          border: "1px solid #2c454e",
          borderRadius: 7,
          background: "#09151c",
          fontSize: 13,
          lineHeight: 1.8,
          margin: "15px 0",
        }}
      />
    ),
    table: ({ node: _node, ...props }) => (
      <div style={{ maxWidth: "100%", overflowX: "auto", margin: "18px 0" }}>
        <table
          {...props}
          style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}
        />
      </div>
    ),
    th: ({ node: _node, ...props }) => (
      <th
        {...props}
        style={{
          textAlign: "left",
          border: "1px solid #35504f",
          padding: "10px 12px",
          background: "#172923",
          color: "#c6dbce",
        }}
      />
    ),
    td: ({ node: _node, ...props }) => (
      <td
        {...props}
        style={{
          border: "1px solid #2d4347",
          padding: "10px 12px",
          verticalAlign: "top",
        }}
      />
    ),
    ol: ({ node: _node, ...props }) => (
      <ol
        {...props}
        style={{ listStyle: "decimal", paddingLeft: 23, margin: "12px 0" }}
      />
    ),
    ul: ({ node: _node, ...props }) => (
      <ul
        {...props}
        style={{ listStyle: "disc", paddingLeft: 23, margin: "12px 0" }}
      />
    ),
    li: ({ node: _node, ...props }) => (
      <li
        {...props}
        style={{ paddingLeft: 2, margin: "7px 0", lineHeight: 1.85 }}
      />
    ),
    input: ({ checked }) => (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled
        readOnly
        aria-label={
          checked ? "Completed checklist item" : "Incomplete checklist item"
        }
        style={{
          width: 14,
          height: 14,
          marginRight: 8,
          accentColor: "#b9d799",
        }}
      />
    ),
  };
  return (
    <article ref={article} className="markdown-document artifact-document">
      <style>{`.artifact-document li::before{display:none}.artifact-document .contains-task-list{list-style:none!important;padding-left:0!important}.artifact-document .task-list-item{list-style:none}.artifact-document code{font-size:13px;color:#c6d9d6}.artifact-document p>code,.artifact-document li>code{background:#1b3032;padding:2px 5px;border-radius:4px}.artifact-document hr{border:0;border-top:1px solid #2f484c;margin:24px 0}.artifact-document .footnotes{border-top:1px solid #2f484c;margin-top:25px;padding-top:12px}`}</style>
      <Markdown
        remarkPlugins={[remarkGfm, evidenceCitationLinks]}
        components={components}
        skipHtml
        urlTransform={safeUrl}
      >
        {content}
      </Markdown>
    </article>
  );
}
