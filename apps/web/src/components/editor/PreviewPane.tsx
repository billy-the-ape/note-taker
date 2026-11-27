/**
 * The rendered half of the editor (docs/plans/mvp/MVP-13.md §5).
 *
 * Three plugin decisions, and the third is the reason this file is a security review rather than a
 * `<div>`:
 *
 * * `remark-gfm` — tables, task lists, strikethrough and autolinks, which is the Markdown people actually
 *   write in a notes app (§6 asks for the table and the task list to render, and neither is CommonMark);
 * * `rehype-sanitize` — a *deny-by-default* schema over the hast tree, so the only attributes that survive
 *   are the ones the schema names: `<script>` and every event handler (`onclick`, `onerror`, the whole
 *   family) are gone before React is asked for an element, and `href` keeps only the protocols the schema
 *   lists, which is what makes a `javascript:` URL arrive as text rather than as a click waiting to happen;
 * * no `rehype-raw`, anywhere, ever — that is the plugin whose absence means raw HTML in a note is *text*.
 *   Sanitising an already-parsed `<script>` is a smaller blast radius than parsing it first, and the
 *   sanitiser is not the thing that decides whether the tag was markup at all.
 *
 * **`rel="noopener"` is added here rather than allowed by the schema**, and the order matters:
 * `rehype-sanitize` runs before react-markdown builds elements, so an attribute this map puts on the node
 * was never subject to the schema — which is fine for a constant string and would be terrible for anything
 * read out of the note. Hence the two overrides below name the attributes they set and pass only children
 * through: they never spread the incoming props.
 *
 * Scroll sync is `EditorPane`'s business (it owns both ends via the `ref` prop below); this component's job
 * is to be the element that gets scrolled, and to be labelled as one — `role` of a named `section` is the
 * accessibility-tree answer to "what am I looking at", and `data-testid="preview"` is PR-19's.
 */

import type { Ref } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/**
 * The schema: `defaultSchema` plus the handful of things a Markdown preview needs and the GitHub-shaped
 * default does not carry, and nothing else.
 *
 * `className` on list/table/task elements is there because `remark-gfm` marks a task-list item up with a
 * class, and dropping it would drop the alignment that makes a checkbox look like part of its line. Note
 * what is *not* in here, and is not: no `style`, no `id` (an `id` in a note would collide with the app's own
 * landmarks), no `form`, no `srcdoc`, and no event handler attribute under any spelling — the default
 * schema's `*` deny-list already removes `on*`, and it is inherited here rather than re-derived.
 */
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    ul: [...(defaultSchema.attributes?.ul ?? []), 'className'],
    li: [...(defaultSchema.attributes?.li ?? []), 'className'],
    input: [...(defaultSchema.attributes?.input ?? []), 'className'],
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    pre: [...(defaultSchema.attributes?.pre ?? []), 'className'],
    table: [...(defaultSchema.attributes?.table ?? []), 'className'],
    th: [...(defaultSchema.attributes?.th ?? []), 'className', 'colSpan', 'header'],
    td: [...(defaultSchema.attributes?.td ?? []), 'className', 'colSpan', 'header'],
  },
};

export interface PreviewPaneProps {
  /** The buffer, exactly as the editor holds it — the preview is a *view* of it, never a second copy. */
  readonly content: string;
  /** `false` in `write` mode, where the rendered half is out of the way but still mounted. */
  readonly hidden?: boolean;
  readonly className?: string;
  /**
   * The scroll element, handed to the caller. `EditorPane` pairs the two panes and needs this end to move
   * it; the alternative is a query, and a query is a selector nobody owns.
   */
  readonly ref?: Ref<HTMLDivElement>;
}

/** The rendered note. */
export function PreviewPane({ content, hidden = false, className = '', ref }: PreviewPaneProps) {
  return (
    <section
      ref={ref}
      data-testid="preview"
      aria-label="Rendered Markdown preview"
      // Two ways of saying the same thing, both needed: `hidden` keeps the layout and the accessibility
      // tree, and the label means the element is still describable when a caller shows it again.
      hidden={hidden}
      aria-hidden={hidden || undefined}
      // The typography is CSS rather than utilities because it styles elements Markdown creates, which no
      // utility can reach — see the `.markdown-preview` block in `styles/globals.css`.
      className={`markdown-preview h-full w-full overflow-auto rounded-md border border-line bg-surface p-4 text-sm
        leading-relaxed text-ink ${className}`}
    >
      {content.length === 0 ? (
        <p className="italic text-ink-muted" data-testid="preview-empty">
          Nothing to preview yet.
        </p>
      ) : (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, SCHEMA]]}
          components={COMPONENTS}
        >
          {content}
        </Markdown>
      )}
    </section>
  );
}

/**
 * The two element overrides.
 *
 * Each names the attributes it puts on the element instead of spreading the incoming props: that is the
 * difference between "the sanitiser decided, then we added `rel`" and "whatever the note said went on the
 * DOM node". `noreferrer` comes along with `noopener` because a note is allowed to contain a link to an
 * origin that would like to know you came from it.
 */
const COMPONENTS = {
  a: ({ href, title, children }) => (
    <a
      href={href}
      title={title}
      rel="noopener noreferrer"
      data-testid="preview-link"
      className="text-brand underline decoration-brand/40 underline-offset-2"
    >
      {children}
    </a>
  ),
  img: ({ src, alt, title }) => (
    // `loading="lazy"` because a note with thirty images should not ask for thirty of them in order to
    // draw its first screen.
    <img src={src} alt={alt} title={title} loading="lazy" decoding="async" className="max-w-full" />
  ),
} satisfies Components;
