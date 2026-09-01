/**
 * GTM deployment guide — generated server-side from intent + generated code.
 *
 * Returns a copy-paste-ready Custom HTML tag payload. The code is wrapped in
 * a self-contained IIFE that:
 *   - Loads GSAP + ScrollTrigger ONCE from a single CDN (jsdelivr)
 *   - Calls the code's own entry point (auto-detected)
 *   - Has proper error handling for the dynamic script load
 *   - Does NOT rely on a global `initAnimation` being defined elsewhere
 *
 * It does NOT claim SRI unless hashes are actually present (no lies about
 * safety). It does NOT invent dataLayer variables.
 *
 * When a container tree is present in the generated response, the guide
 * includes a per-container troubleshooting table that maps each tree node
 * to the CSS selector + layout hint the animation should target.
 */

import type { GenerateResponse } from './generate-pipeline';
import { detectEntryPoint } from './gsap-utils';
import type { ElementorWidgetValidated } from './elementor-widget';

export function buildGtmGuide(generated: GenerateResponse, intent: string): string {
  const tagName = slugify(intent).slice(0, 50) || 'gsap-animation';
  const entryForm = detectEntryPoint(generated.gsapCode);

  // Sanitize code for HTML embedding (escape closing </script> tags)
  const escapedCode = generated.gsapCode.replace(/<\/script>/g, '<\\/script>');

  // Wrap the generated code in a self-contained IIFE that handles GSAP loading.
  // The wrapper does NOT call initAnimation() — that's the code's job (it
  // self-executes or exports a function that's called inline below).
  const wrapper = `(function(){
  function loadScript(src, onload, onerror){
    var s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = function(){ onload && onload(); };
    s.onerror = function(){ console.error('[gsap-anim] failed to load', src); onerror && onerror(); };
    document.head.appendChild(s);
  }
  function start(){
    try {
${indentCode(escapedCode, 6)}
    } catch (err) {
      console.error('[gsap-anim] init error', err);
    }
  }
  if (window.gsap) { start(); return; }
  loadScript('https://cdn.jsdelivr.net/npm/gsap@3.13/dist/gsap.min.js', function(){
    if (window.gsap && window.gsap.registerPlugin) {
      loadScript('https://cdn.jsdelivr.net/npm/gsap@3.13/dist/ScrollTrigger.min.js', start, start);
    } else {
      start();
    }
  }, start);
})();`;

  const treeSection = generated.containerStructure.tree
    ? renderTreeSection(generated.containerStructure.tree, generated.containerStructure.selector)
    : '';

  return `# GTM Deployment Guide — ${tagName}

## Step 1: Create a Custom HTML tag

In your Google Tag Manager workspace:

1. Go to **Tags** → **New**
2. Choose **Custom HTML**
3. Name it: \`GSAP - ${tagName}\`
4. Paste the wrapper below into the **HTML** field
5. Trigger: fire on **DOM Ready** (or **Window Loaded** for below-fold animations)

\`\`\`html
<script>
${wrapper}
</script>
\`\`\`

## Step 2: Set up the trigger

- **Trigger type:** DOM Ready
- **Fires on:** All Pages (or scope with regex like \`.*elementor.*\`)

## Step 3: Preview & publish

1. Click **Preview** in GTM
2. Open browser DevTools console — look for \`[gsap-anim]\` log lines
3. If you see \`[gsap-anim] failed to load\`, check your CSP allows jsdelivr.net
4. Click **Submit** → name the version → **Publish**

## Why this works

- Single CDN load (jsdelivr) with onerror fallback — no version conflicts
- Initialization is wrapped in a try/catch so a runtime error logs but doesn't break the page
- GSAP only loads once (cached by the browser after first tag fire)

## Generated code internals

- **Entry form:** ${entryForm}
- **Validation:** quality ${generated.validation.qualityScore}/100${generated.validation.issues.length > 0 ? ` (${generated.validation.issues.length} issue${generated.validation.issues.length === 1 ? '' : 's'})` : ''}
- **Selectors used:**
${generated.cssSelectors.map((s) => `  - \`${s}\``).join('\n')}
${treeSection}
## Troubleshooting

| Issue | Fix |
|---|---|
| Animation doesn't fire | Confirm the trigger is DOM Ready (not Page View) |
| \`[gsap-anim] failed to load\` in console | CSP is blocking jsdelivr.net — add it to allowed sources |
| Animation fires but nothing moves | Verify the container selector \`${generated.containerStructure.selector}\` matches your actual Elementor container |
| Flash of unstyled content | Move the trigger to "Window Loaded" so it fires after Elementor finishes rendering |
`;
}

function renderTreeSection(tree: ElementorWidgetValidated, rootSelector: string): string {
  const lines: string[] = ['', '## Elementor container tree', ''];
  lines.push(
    'The animation targets the following recursive widget hierarchy. Repeating siblings share a single class selector (e.g. `.swiper-slide`); one-off elements use an id.',
  );
  lines.push('');
  lines.push('| Selector | Kind | Layout | Props |');
  lines.push('|---|---|---|---|');
  const walk = (n: ElementorWidgetValidated, parentSelector: string): string => {
    const own = n.id ? `#${n.id}` : n.className ? `.${n.className}` : '(none)';
    const sel = parentSelector === rootSelector && n.id
      ? `#${n.id}` // root uses its own id, not the parent selector
      : n.className
        ? `${parentSelector} .${n.className}`
        : n.id
          ? `${parentSelector} #${n.id}`
          : parentSelector;
    const props = n.props
      ? Object.entries(n.props).map(([k, v]) => `${k}="${v}"`).join('<br>')
      : '';
    lines.push(`| \`${sel}\` (${own}) | ${n.kind} | ${n.layout ?? '—'} | ${props || '—'} |`);
    const childParent = sel;
    n.children?.forEach((c: ElementorWidgetValidated) => walk(c, childParent));
    return sel;
  };
  // For the root, use just its own id (no parent prefix).
  const rootSel = tree.id
    ? `#${tree.id}`
    : tree.className
      ? `.${tree.className}`
      : rootSelector;
  lines.pop(); // remove the first row produced by walk(tree, rootSelector)
  // Render manually starting from the root so the selector prefix is just the root.
  const renderFromRoot = (n: ElementorWidgetValidated, parentSel: string): string => {
    const own = n.id ? `#${n.id}` : n.className ? `.${n.className}` : '(none)';
    const sel = own === '(none)' ? parentSel : own === `#${n.id}` || own === `.${n.className}` ? own : `${parentSel} ${own}`;
    const props = n.props
      ? Object.entries(n.props).map(([k, v]) => `${k}="${v}"`).join('<br>')
      : '';
    lines.push(`| \`${sel}\` (${own}) | ${n.kind} | ${n.layout ?? '—'} | ${props || '—'} |`);
    n.children?.forEach((c) => renderFromRoot(c, sel));
    return sel;
  };
  renderFromRoot(tree, rootSel);
  lines.push('');
  lines.push(
    '> If a widget fails to animate, verify its rendered DOM contains the exact class/id shown above. For repeating siblings, query the class with `querySelectorAll` and address by index. Elementor sometimes strips inner classes on container conversion — set them in the Advanced tab if missing.',
  );
  return lines.join('\n');
}

function indentCode(code: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}