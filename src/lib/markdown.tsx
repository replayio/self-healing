import type { ReactNode } from "react";

function inline(s: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let k = 0;
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    if (m[2]) parts.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3]) parts.push(<em key={k++}>{m[3]}</em>);
    else if (m[4]) parts.push(<code key={k++}>{m[4]}</code>);
    else if (m[5] && m[6])
      parts.push(
        <a
          key={k++}
          href={m[6]}
          target={m[6].startsWith("http") ? "_blank" : undefined}
          rel={m[6].startsWith("http") ? "noopener noreferrer" : undefined}
        >
          {m[5]}
        </a>,
      );
    last = m.index + m[0].length;
  }

  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const block: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        block.push(lines[i]!);
        i++;
      }
      i++;
      elements.push(
        <pre key={key++} className="md-code" data-lang={lang || undefined}>
          <code>{block.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1]!.length;
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      elements.push(<Tag key={key++}>{inline(hMatch[2]!)}</Tag>);
      i++;
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // List items
    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      const ordered = !!line.match(/^\d+\.\s/);
      const items: string[] = [];
      while (
        i < lines.length &&
        (lines[i]!.match(/^[-*]\s/) ||
          lines[i]!.match(/^\d+\.\s/) ||
          (lines[i]!.startsWith("  ") && items.length > 0))
      ) {
        const l = lines[i]!;
        if (l.startsWith("  ") && items.length > 0) {
          items[items.length - 1] += " " + l.trim();
        } else {
          items.push(l.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));
        }
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      elements.push(
        <Tag key={key++}>
          {items.map((item, j) => (
            <li key={j}>{inline(item)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.startsWith("#") &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.match(/^[-*]\s/) &&
      !lines[i]!.match(/^\d+\.\s/)
    ) {
      para.push(lines[i]!);
      i++;
    }
    if (para.length) {
      elements.push(<p key={key++}>{inline(para.join(" "))}</p>);
    }
  }

  return <>{elements}</>;
}
