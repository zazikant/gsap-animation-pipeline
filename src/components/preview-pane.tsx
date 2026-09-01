'use client';

import * as React from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Copy,
  Image as ImageIcon,
  Type as TypeIcon,
  Heading as HeadingIcon,
  MousePointerClick,
  Circle as IconIcon,
  Minus as DividerIcon,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GenerateResponse } from '@/lib/generate-pipeline';
import type { ElementorWidgetValidated } from '@/lib/elementor-widget';

interface PreviewPaneProps {
  generated: GenerateResponse;
  intent: string;
  onLooksGood: () => void;
  onReset: () => void;
}

const KIND_ICON: Record<ElementorWidgetValidated['kind'], React.ComponentType<{ className?: string }>> = {
  Container: Box,
  Image: ImageIcon,
  Heading: HeadingIcon,
  Text: TypeIcon,
  Button: MousePointerClick,
  Icon: IconIcon,
  Divider: DividerIcon,
};

export function PreviewPane({ generated, intent, onLooksGood, onReset }: PreviewPaneProps) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(generated.gsapCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Live Preview</h2>
          <p className="mt-1 text-xs text-zinc-600">
            Generated from: <span className="italic">"{intent}"</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={generated.validation.isValid ? 'default' : 'destructive'}>
            Quality: {generated.validation.qualityScore}
          </Badge>
          <Badge variant="outline">Attempts: {generated.attempts}</Badge>
          {generated.containerStructure.tree && (
            <Badge variant="outline" className="border-emerald-300 text-emerald-700">
              Tree: {generated.containerStructure.tree.id}
            </Badge>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Container</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div>
              <p className="text-zinc-500">Selector</p>
              <p className="mt-0.5 font-mono text-zinc-900">{generated.containerStructure.selector}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-zinc-500">Width</p>
                <p className="mt-0.5 font-mono">{generated.containerStructure.width}</p>
              </div>
              <div>
                <p className="text-zinc-500">Breakpoint</p>
                <p className="mt-0.5 font-mono">{generated.containerStructure.breakpoint}</p>
              </div>
            </div>
            <div>
              <p className="text-zinc-500">Notes</p>
              <p className="mt-0.5 text-zinc-700">{generated.containerStructure.notes}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">CSS Selectors</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-xs font-mono">
              {generated.cssSelectors.map((sel, i) => (
                <li
                  key={i}
                  className="break-all rounded border border-zinc-100 bg-zinc-50 px-2 py-1 text-zinc-900"
                  title={sel}
                >
                  {sel}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Strategy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-zinc-700">{generated.scalabilityStrategy}</p>
          </CardContent>
        </Card>
      </div>

      {generated.containerStructure.tree && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Elementor Container Tree</CardTitle>
            <p className="mt-0.5 text-xs text-zinc-500">
              Recursive widget hierarchy the animation targets. <code className="rounded bg-zinc-100 px-1">#id</code> marks one-off elements;
              <code className="rounded bg-zinc-100 px-1">.className</code> marks repeating siblings.
            </p>
          </CardHeader>
          <CardContent>
            <WidgetTreeView tree={generated.containerStructure.tree} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Generated GSAP Code</CardTitle>
          <Button size="sm" variant="ghost" onClick={handleCopy}>
            {copied ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy Code
              </>
            )}
          </Button>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-4 text-xs leading-relaxed">
            <code className="font-mono text-zinc-800">{generated.gsapCode}</code>
          </pre>
        </CardContent>
      </Card>

      {generated.validation.issues.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader>
            <CardTitle className="text-sm text-amber-900">Validation Issues</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
              {generated.validation.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <footer className="flex flex-wrap items-center justify-end gap-3">
        <Button variant="ghost" onClick={onReset}>
          <RotateCcw className="h-3.5 w-3.5" /> Start Over
        </Button>
        <Button onClick={onLooksGood}>
          Looks Good — Get Guide →
        </Button>
      </footer>
    </div>
  );
}

// ─── Recursive tree view ─────────────────────────────────────────────────────

function WidgetTreeView({ tree }: { tree: ElementorWidgetValidated }) {
  return (
    <ul className="space-y-1 text-xs">
      <WidgetTreeNode node={tree} depth={0} defaultOpen />
    </ul>
  );
}

function WidgetTreeNode({
  node,
  depth,
  defaultOpen,
  siblings,
}: {
  node: ElementorWidgetValidated;
  depth: number;
  defaultOpen?: boolean;
  /** Sibling list from the parent — used to decide if THIS node is a repeating sibling. */
  siblings?: ElementorWidgetValidated[];
}) {
  const [open, setOpen] = React.useState(defaultOpen ?? depth < 2);
  const Icon = KIND_ICON[node.kind] ?? Box;
  const hasChildren = !!node.children && node.children.length > 0;
  const toggle = () => {
    if (hasChildren) setOpen((v) => !v);
  };

  // Selector chip: prefer id (one-off), else className (repeating), else mark as unrepeatable.
  // "repeating" is meaningful only when this node is one of 2+ siblings sharing the same
  // className. A node with a unique className (one wrapper per carousel) is NOT repeating
  // even though it has a class.
  const selectorKind: 'id' | 'class' | 'none' = node.id ? 'id' : node.className ? 'class' : 'none';
  const selectorText = node.id
    ? `#${node.id}`
    : node.className
      ? `.${node.className}`
      : '(no selector)';

  const isRepeatingSibling =
    selectorKind === 'class' &&
    !!siblings &&
    siblings.filter((s) => s.className === node.className && s.kind === node.kind).length >= 2;

  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-1.5 rounded px-1 py-0.5 hover:bg-zinc-50"
        style={{ paddingLeft: depth * 12 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={toggle}
            className="inline-flex h-4 w-4 items-center justify-center text-zinc-500 hover:text-zinc-900"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block h-4 w-4" />
        )}
        <Icon className="h-3.5 w-3.5 text-zinc-500" />
        <span
          className={`font-mono ${selectorKind === 'id' ? 'text-zinc-900' : selectorKind === 'class' ? 'text-blue-700' : 'text-red-600'}`}
          title={
            selectorKind === 'id'
              ? 'One-off element (id)'
              : selectorKind === 'class'
                ? isRepeatingSibling
                  ? `Repeating sibling — ${siblings!.filter((s) => s.className === node.className).length} children of parent share this class`
                  : 'One-off wrapper with a class — not a sibling'
                : 'Unreachable from code — add id or className'
          }
        >
          {selectorText}
        </span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-zinc-600">
          {node.kind}
        </span>
        {isRepeatingSibling && (
          <span className="rounded border border-blue-200 bg-blue-50 px-1 py-0 font-mono text-[10px] text-blue-700">
            repeating
          </span>
        )}
        {node.label && <span className="text-zinc-600">— {node.label}</span>}
        {node.layout && (
          <span className="rounded border border-zinc-200 px-1 py-0 font-mono text-[10px] text-zinc-500">
            {node.layout}
          </span>
        )}
        {node.state && Object.entries(node.state).map(([k, v]) => (
          <span key={k} className="font-mono text-[10px] text-emerald-700">
            {k}={String(v)}
          </span>
        ))}
      </div>
      {/* Props: show on leaves AND on containers. Earlier version gated on hasChildren which hid props on Text/Heading/Image/Button. */}
      {node.props && Object.keys(node.props).length > 0 && (
        <div
          className="mt-0.5 ml-7 space-y-0.5"
          style={{ paddingLeft: depth * 12 + 24 }}
        >
          {Object.entries(node.props).map(([k, v]) => (
            <div key={k} className="font-mono text-[11px] text-zinc-600">
              <span className="text-zinc-400">{k}:</span> "{v}"
            </div>
          ))}
        </div>
      )}
      {hasChildren && open && (
        <ul className="mt-1 space-y-1">
          {node.children!.map((child: ElementorWidgetValidated) => (
            <WidgetTreeNode
              key={child.id ?? child.className ?? Math.random().toString()}
              node={child}
              depth={depth + 1}
              siblings={node.children}
            />
          ))}
        </ul>
      )}
    </li>
  );
}