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
 * Selector strategy:
 *   - `id`        — kebab-case CSS id, used for ONE-OFF elements only
 *                    (root container, single-instance wrappers). Must be set
 *                    by the user in Elementor's Advanced tab; Elementor does
 *                    not auto-generate unique ids for widgets.
 *   - `className` — kebab-case CSS class. Used for REPEATING or shared
 *                    elements (slides, dots, cards, columns). These are
 *                    either:
 *                      (a) baked in by Elementor/Swiper
 *                          (e.g. `.swiper-slide`, `.swiper-pagination-bullet`,
 *                          `.elementor-icon-box`), or
 *                      (b) set by the user in Elementor's Advanced tab.
 *                    The LLM-generated code queries these by class selector.
 *
 * Repeating siblings share a single `className`; the code uses
 * querySelectorAll to get all of them, then addresses by index. The tree
 * describes ONE structural template — not N enumerated instances.
 *
 * Validation rules (in elementor-schema.ts):
 *   - Each node must have AT LEAST ONE of `id` or `className`. (A node with
 *     neither is unreachable from code.)
 *   - If both are set, prefer `id` for one-off roots and `className` for
 *     everything else. The validator accepts both — it just warns when an
 *     `id` looks like it might have been auto-generated (e.g. ends in
 *     `-N` for some integer N) because that suggests the LLM enumerated
 *     instances when it should have used a class.
 */
export interface ElementorWidget {
  /** Optional. One-off element id. Kebab-case when present. */
  id?: string;
  /** CSS class selector. Kebab-case when present. */
  className?: string;
  /**
   * 1-based ordinal within repeating siblings. `0` means "template" — the
   * tree describes the structure, the actual instances live on the page
   * and the code reaches them by class.
   */
  index?: number;
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
  id?: string;
  className?: string;
  index?: number;
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