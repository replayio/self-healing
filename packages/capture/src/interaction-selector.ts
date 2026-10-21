/** Generate only locators whose Playwright CSS/:has-text semantics identify this target. */
export function interactionSelector(target: Element): string | null {
  const doc = target.ownerDocument;
  if (!target.isConnected || !doc?.documentElement) return null;
  const normalize = (text: string) =>
    text
      .replace(/[\u200b\u00ad]/g, "")
      .trim()
      .replace(/\s+/g, " ");
  const quote = (text: string) =>
    '"' +
    Array.from(text, (char) => {
      const code = char.codePointAt(0)!;
      if (code < 32 || code === 127) return `\\${code.toString(16)} `;
      return char === '"' || char === "\\" ? `\\${char}` : char;
    }).join("") +
    '"';
  const parent = (element: Element): Element | null =>
    element.parentElement ??
    ((element.getRootNode() as ShadowRoot).host || null);
  // Playwright CSS pierces open shadow roots, so uniqueness must include those nodes.
  const elements: Element[] = [];
  const visit = (root: Document | ShadowRoot) => {
    for (const element of root.querySelectorAll("*")) {
      elements.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(doc);
  // Closed shadow roots cannot be addressed by the replay selector engine.
  if (!elements.includes(target)) return null;
  const textCache = new Map<Element, string>();
  const textOf = (element: Element): string => {
    const cached = textCache.get(element);
    if (cached !== undefined) return cached;
    let text = "";
    if (
      !["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName) &&
      !doc.head?.contains(element)
    ) {
      if (
        element.tagName === "INPUT" &&
        ["submit", "button"].includes((element as HTMLInputElement).type)
      ) {
        text = (element as HTMLInputElement).value;
      } else {
        for (const child of element.childNodes) {
          if (child.nodeType === 3) text += child.nodeValue ?? "";
          else if (child.nodeType === 1) text += textOf(child as Element);
        }
        if (element.shadowRoot)
          for (const child of element.shadowRoot.childNodes) {
            if (child.nodeType === 3) text += child.nodeValue ?? "";
            else if (child.nodeType === 1) text += textOf(child as Element);
          }
      }
    }
    textCache.set(element, text);
    return text;
  };
  type Part = { css: string; text?: string; direct?: boolean };
  const candidates = (element: Element, withText: boolean): Part[] => {
    const tag = CSS.escape(element.localName);
    const parts: Part[] = [];
    for (const attr of ["data-testid", "id", "aria-label", "name"]) {
      const value = element.getAttribute(attr);
      if (!value || value.includes("\0")) continue;
      parts.push({
        css:
          attr === "id"
            ? `#${CSS.escape(value)}`
            : `${attr === "data-testid" ? "" : tag}[${attr}=${quote(value)}]`,
      });
    }
    if (withText) {
      const text = normalize(textOf(element)).slice(0, 500);
      if (text) parts.push({ css: tag, text });
    }
    return parts;
  };
  const matches = (
    element: Element,
    parts: Part[],
    index = parts.length - 1,
  ): boolean => {
    const part = parts[index]!;
    if (
      !element.matches(part.css) ||
      (part.text !== undefined &&
        !normalize(textOf(element))
          .toLowerCase()
          .includes(normalize(part.text).toLowerCase()))
    )
      return false;
    if (index === 0) return true;
    for (
      let ancestor = parent(element);
      ancestor;
      ancestor = parent(ancestor)
    ) {
      if (matches(ancestor, parts, index - 1)) return true;
      if (part.direct) break;
    }
    return false;
  };
  const checked = (parts: Part[]): string | null => {
    const selector = parts
      .map(
        (part, i) =>
          `${i ? (part.direct ? " > " : " ") : ""}${part.css}${part.text === undefined ? "" : `:has-text(${JSON.stringify(part.text)})`}`,
      )
      .join("");
    if (selector.length > 2_000) return null;
    try {
      if (!matches(target, parts)) return null;
      return elements.some(
        (element) => element !== target && matches(element, parts),
      )
        ? null
        : selector;
    } catch {
      return null;
    }
  };
  const leaves = candidates(target, true);
  for (const leaf of leaves) {
    const selector = checked([leaf]);
    if (selector) return selector;
  }
  // Scope meaningful target selectors before resorting to DOM positions.
  for (let ancestor = parent(target); ancestor; ancestor = parent(ancestor)) {
    for (const scope of candidates(ancestor, false))
      for (const leaf of leaves) {
        const selector = checked([scope, leaf]);
        if (selector) return selector;
      }
  }
  const path: Part[] = [];
  for (
    let element: Element | null = target;
    element;
    element = parent(element)
  ) {
    // Prefer a stable anchor for the structural suffix.
    for (const anchor of candidates(element, false)) {
      const selector = checked([anchor, ...path]);
      if (selector) return selector;
    }
    const siblings =
      element.parentNode && "children" in element.parentNode
        ? Array.from((element.parentNode as ParentNode).children).filter(
            (sibling) => sibling.localName === element!.localName,
          )
        : [element];
    path.unshift({
      css: `${CSS.escape(element.localName)}:nth-of-type(${siblings.indexOf(element) + 1})`,
      direct: true,
    });
    const selector = checked(path);
    if (selector) return selector;
  }
  return null;
}
