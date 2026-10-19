import { stripVTControlCharacters } from "node:util";
import { Parser } from "htmlparser2";

const TEXT_LIMIT = 200000;
const SKIP = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "footer",
  "form",
  "button",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "tr",
  "br",
  "hr",
]);
export interface WebLink {
  title: string;
  url: string;
}
export interface WebContent {
  title: string;
  text: string;
  links: WebLink[];
  truncated: boolean;
}

export function cleanWebText(input: string): string {
  const controls =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove remote controls, retaining tabs/newlines.
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
  return stripVTControlCharacters(input)
    .replace(controls, "")
    .replace(/\r\n?/g, "\n");
}
const normalize = (input: string) =>
  cleanWebText(input)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function linkUrl(value: string, base?: string): string | undefined {
  try {
    if (value.length > 4096) return undefined;
    const url = new URL(value, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href.length <= 4096 ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function extractWebContent(
  body: string,
  contentType: string,
  url: string,
): WebContent {
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
    const text = cleanWebText(body).trim();
    return {
      title: "",
      text: text.slice(0, TEXT_LIMIT),
      links: [],
      truncated: text.length > TEXT_LIMIT,
    };
  }
  let all = "";
  let primary = "";
  let title = "";
  let truncated = false;
  let nodes = 0;
  const links: WebLink[] = [];
  const seen = new Set<string>();
  type Frame = {
    hidden: boolean;
    primary: boolean;
    title: boolean;
    anchor?: WebLink;
  };
  const stack: Frame[] = [];
  const append = (text: string) => {
    const frame = stack.at(-1);
    if (frame?.title) {
      title = (title + text).slice(0, 500);
      return;
    }
    if (frame?.hidden) return;
    if (all.length + text.length > TEXT_LIMIT) truncated = true;
    all += text.slice(0, Math.max(0, TEXT_LIMIT - all.length));
    if (frame?.primary)
      primary += text.slice(0, Math.max(0, TEXT_LIMIT - primary.length));
    if (frame?.anchor)
      frame.anchor.title = (frame.anchor.title + text).slice(0, 500);
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (++nodes > 100000 || stack.length >= 256) {
          truncated = true;
          parser.pause();
          return;
        }
        const parent = stack.at(-1);
        const hidden = Boolean(
          parent?.hidden ||
            SKIP.has(name) ||
            name === "head" ||
            "hidden" in attributes ||
            attributes["aria-hidden"] === "true" ||
            /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
              attributes.style ?? "",
            ),
        );
        const isTitle = name === "title" || Boolean(parent?.title);
        const frame: Frame = {
          hidden,
          primary: Boolean(
            parent?.primary || name === "main" || name === "article",
          ),
          title: isTitle,
        };
        if (parent?.anchor) frame.anchor = parent.anchor;
        if (!hidden && name === "a" && links.length < 50) {
          const href = linkUrl(attributes.href ?? "", url);
          if (href && !seen.has(href)) {
            seen.add(href);
            frame.anchor = { title: "", url: href };
            links.push(frame.anchor);
          }
        }
        stack.push(frame);
        if (BLOCK.has(name)) append("\n");
        if (name === "td" || name === "th") append(" | ");
      },
      ontext: append,
      onclosetag(name) {
        if (BLOCK.has(name)) append("\n");
        stack.pop();
      },
    },
    { decodeEntities: true },
  );
  parser.end(body);
  const selected = normalize(primary);
  return {
    title: normalize(title),
    text: selected.length >= 80 ? selected : normalize(all),
    links: links.map((link) => ({
      title: normalize(link.title),
      url: link.url,
    })),
    truncated,
  };
}

export interface SearchResult extends WebLink {
  snippet: string;
}
/** Parse RSS only. HTML challenge/error pages must not masquerade as results. */
export function parseSearchResults(
  body: string,
  count: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  let item: { title: string; link: string; description: string } | undefined;
  let nodes = 0;
  const plain = (value: string) =>
    extractWebContent(value, "text/html", "https://www.bing.com/").text;
  const parser = new Parser(
    {
      onopentag(name) {
        if (++nodes > 50000 || stack.length >= 64) {
          parser.pause();
          return;
        }
        stack.push(name);
        if (stack.join("/") === "rss/channel/item")
          item = { title: "", link: "", description: "" };
      },
      ontext(text) {
        if (!item || stack.length !== 4) return;
        const key = stack[3];
        if (key === "title" || key === "link" || key === "description")
          item[key] = (item[key] + text).slice(0, key === "link" ? 8192 : 8000);
      },
      onclosetag(name) {
        if (name === "item" && stack.join("/") === "rss/channel/item" && item) {
          const url = linkUrl(item.link.trim());
          const title = normalize(plain(item.title)).slice(0, 500);
          if (
            url &&
            title &&
            !seen.has(url) &&
            results.length < Math.min(10, Math.max(1, count))
          ) {
            seen.add(url);
            results.push({
              title,
              url,
              snippet: normalize(plain(item.description)).slice(0, 1500),
            });
          }
          item = undefined;
        }
        stack.pop();
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.end(body);
  return results;
}
