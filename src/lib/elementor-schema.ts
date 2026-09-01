/**
 * Zod schemas for the public types crossing the LLM boundary.
 *
 * The recursive `ElementorWidgetSchema` validates the structured JSON output
 * produced by the LLM (parsed in dspy-signature.ts). It rejects:
 *   - Container nodes with zero children (always at least one wrapper)
 *   - Leaf nodes (Image/Heading/Text/Button/Icon/Divider) with children
 *   - Non-kebab-case ids
 *   - Duplicate ids within a tree
 *   - Unknown `kind` values
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

// Zod v4 changed `z.record(value)` → `z.record(key, value)`.
const PropsSchema = z.record(z.string(), z.string()).optional();
const StateSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional();

const WidgetShape: z.ZodType<ElementorWidgetValidated> = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(KEBAB_RE, 'id must be kebab-case (lowercase, hyphens, digits)'),
  kind: WidgetKindSchema,
  label: z.string().min(1).max(120).optional(),
  props: PropsSchema,
  layout: z.string().max(80).optional(),
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
    // Detect duplicate ids
    const seen = new Set<string>();
    const dupes: string[] = [];
    const walk = (n: ElementorWidgetValidated): void => {
      if (seen.has(n.id)) dupes.push(n.id);
      seen.add(n.id);
      n.children?.forEach(walk);
    };
    walk(parsed.data);
    if (dupes.length > 0) {
      return { ok: false, issues: [`Duplicate widget ids in tree: ${dupes.join(', ')}`] };
    }

    // Shape checks (Zod only handles syntax; semantics live here).
    const shapeIssues = checkShape(parsed.data);
    if (shapeIssues.length > 0) {
      return { ok: false, issues: shapeIssues };
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
  const walk = (n: ElementorWidgetValidated, path: string): void => {
    const idPath = path || n.id;
    const isLeaf = (LEAF_KINDS as readonly string[]).includes(n.kind);
    if (isLeaf && n.children && n.children.length > 0) {
      issues.push(`${idPath}: Leaf widget (${n.kind}) cannot have children`);
    }
    if (n.kind === 'Container' && (!n.children || n.children.length === 0)) {
      issues.push(`${idPath}: Container must have at least one child`);
    }
    n.children?.forEach((c) => walk(c, c.id));
  };
  walk(tree, '');
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