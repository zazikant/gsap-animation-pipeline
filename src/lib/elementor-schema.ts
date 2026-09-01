/**
 * Zod schemas for the public types crossing the LLM boundary.
 *
 * The recursive `ElementorWidgetSchema` validates the structured JSON output
 * produced by the LLM (parsed in dspy-signature.ts). It rejects:
 *   - Container nodes with zero children (always at least one wrapper)
 *   - Leaf nodes (Image/Heading/Text/Button/Icon/Divider) with children
 *   - Non-kebab-case ids or classNames
 *   - Duplicate ids within a tree
 *   - Unknown `kind` values
 *   - Auto-generated id suffixes (e.g. `-1`, `-2`) — these signal the LLM
 *     enumerated instances when it should have used a class.
 *   - Nodes with neither id nor className (unreachable from code)
 *
 * Recursive schemas require `z.lazy` because of TypeScript's TS2742
 * ("type alias circularly references itself"). This file is imported only
 * server-side (pipeline-graph.ts, widget-profiles.ts) — never bundled to
 * the client.
 */

import { z } from 'zod';
import type { ElementorWidgetValidated } from './elementor-widget';

export const WidgetKindSchema = z.enum([
  'Container',
  'Image',
  'Heading',
  'Text',
  'Button',
  'Icon',
  'Divider',
]);

const LEAF_KINDS = ['Image', 'Heading', 'Text', 'Button', 'Icon', 'Divider'] as const;

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
// Auto-generated id suffix (e.g. "testimonial-slide-3"). If we see this on a
// repeating child, the LLM enumerated instances instead of using a class.
const AUTO_ID_RE = /-\d{1,3}$/;

const PropsSchema = z.record(z.string(), z.string()).optional();
const StateSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional();

const WidgetShape: z.ZodType<ElementorWidgetValidated> = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(KEBAB_RE, 'id must be kebab-case (lowercase, hyphens, digits)')
    .optional(),
  className: z
    .string()
    .min(2)
    .max(64)
    .regex(KEBAB_RE, 'className must be kebab-case (lowercase, hyphens, digits)')
    .optional(),
  index: z.number().int().min(0).max(999).optional(),
  kind: WidgetKindSchema,
  label: z.string().min(1).max(120).optional(),
  props: PropsSchema,
  layout: z.string().max(120).optional(),
  state: StateSchema,
  children: z.array(z.lazy(() => WidgetShape)).optional(),
}) as unknown as z.ZodType<ElementorWidgetValidated>;

export const ElementorWidgetSchema = WidgetShape;

/** Walk the tree and return flat issues (path + message). */
export function validateTree(
  tree: unknown,
): { ok: true; tree: ElementorWidgetValidated } | { ok: false; issues: string[] } {
  const parsed = ElementorWidgetSchema.safeParse(tree);
  if (parsed.success) {
    // Post-parse semantic checks (Zod only handles syntax; semantics live here).
    const issues = checkShape(parsed.data);
    if (issues.length > 0) {
      return { ok: false, issues };
    }
    return { ok: true, tree: parsed.data };
  }
  const issues = parsed.error.issues.map(
    (iss) => `${(iss.path as (string | number)[]).join('.') || '(root)'}: ${iss.message}`,
  );
  return { ok: false, issues };
}

function checkShape(tree: ElementorWidgetValidated): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const seenClasses = new Map<string, number>(); // className → repeat count

  const walk = (n: ElementorWidgetValidated, path: string): void => {
    const idPath = path || n.id || n.className || '(unnamed)';

    // Selector strategy: at least one of id or className must be present.
    if (!n.id && !n.className) {
      issues.push(`${idPath}: must have at least one of \`id\` or \`className\` (code can't reach an unselectable node)`);
    }

    // Auto-generated id suffix check
    if (n.id && AUTO_ID_RE.test(n.id)) {
      issues.push(
        `${idPath}: id "${n.id}" looks auto-generated (trailing -N). Repeating children should share a \`className\` (e.g. "${n.id.replace(/-\d+$/, '')}") rather than enumerated ids.`,
      );
    }

    // Duplicate id detection (within tree)
    if (n.id) {
      if (seenIds.has(n.id)) {
        issues.push(`${idPath}: duplicate id "${n.id}" in tree`);
      }
      seenIds.add(n.id);
    }

    // Track className usage
    if (n.className) {
      seenClasses.set(n.className, (seenClasses.get(n.className) ?? 0) + 1);
    }

    // Leaf vs Container children rule
    const isLeaf = (LEAF_KINDS as readonly string[]).includes(n.kind);
    if (isLeaf && n.children && n.children.length > 0) {
      issues.push(`${idPath}: Leaf widget (${n.kind}) cannot have children`);
    }
    if (n.kind === 'Container' && (!n.children || n.children.length === 0)) {
      issues.push(`${idPath}: Container must have at least one child`);
    }

    n.children?.forEach((c) => walk(c, c.id ?? c.className ?? ''));
  };

  walk(tree, '');

  // If a className is shared by many siblings, that's expected (slides, dots).
  // If ids appear under the same parent with numeric suffixes, flag as an
  // anti-pattern (auto-id enumeration).
  return issues;
}

/** Count nodes by kind (for telemetry + tree-aware strategy). */
export function countByKind(tree: ElementorWidgetValidated): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (n: ElementorWidgetValidated): void => {
    counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    n.children?.forEach(walk);
  };
  walk(tree);
  return counts;
}

/** Maximum depth of the tree (root = depth 1). */
export function maxDepth(tree: ElementorWidgetValidated): number {
  if (!tree.children || tree.children.length === 0) return 1;
  return 1 + Math.max(...tree.children.map(maxDepth));
}