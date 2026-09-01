/**
 * Elementor widget taxonomy — the kinds of nodes we can render in a tree.
 *
 * Leaf kinds (no children): Image, Heading, Text, Button, Icon, Divider.
 * Branch kinds (require children): Container.
 *
 * Mirrors what Elementor-Pro actually ships, trimmed to what a GSAP animation
 * needs to address.
 */

export type WidgetKind =
  | 'Container'
  | 'Image'
  | 'Heading'
  | 'Text'
  | 'Button'
  | 'Icon'
  | 'Divider';

/**
 * Recursive Elementor widget node.
 *
 * Used by:
 *   - `widget-profiles.ts` to ship a canonical `treeTemplate` per widget
 *   - `pipeline-graph.ts` to receive the LLM-generated `containerTree`
 *   - `preview-pane.tsx` to render the tree recursively
 *   - `gtm-guide.ts` to produce tree-aware troubleshooting notes
 *
 * Field semantics:
 *   - `id`: kebab-case CSS-suffix (e.g. "slide-bg-1"). Combined with the
 *     widget profile's container selector at render time to form the full
 *     Elementor selector. Must be unique within the tree.
 *   - `kind`: what kind of widget this is (Container, Image, …).
 *   - `label`: human-readable label shown in the Preview tree (not used by
 *     selectors).
 *   - `props`: free-form per-kind props (e.g. Image.src, Text.text,
 *     Button.label, Heading.text).
 *   - `layout`: human-readable layout hint ("flex row", "absolute",
 *     "gradient overlay"). UI only; doesn't affect selectors.
 *   - `state`: dynamic runtime flags (e.g. `{ active: false }` for a dot
 *     indicator). UI only.
 *   - `children`: only set on Container nodes.
 */
export interface ElementorWidget {
  id: string;
  kind: WidgetKind;
  label?: string;
  props?: Record<string, string>;
  layout?: string;
  state?: Record<string, string | number | boolean>;
  children?: ElementorWidget[];
}

/**
 * Same as ElementorWidget but `children` is recursively typed. The TS-side
 * distinction lets us tell "raw tree from the LLM" from "tree that has been
 * validated and is safe to render in the UI".
 */
export interface ElementorWidgetValidated {
  id: string;
  kind: WidgetKind;
  label?: string;
  props?: Record<string, string>;
  layout?: string;
  state?: Record<string, string | number | boolean>;
  children?: ElementorWidgetValidated[];
}

/** Build a fresh id counter from a prefix so trees can number siblings. */
let _idCounter = 0;
export function resetIdCounter(seed = 0): void {
  _idCounter = seed;
}
export function nextId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${_idCounter}`;
}