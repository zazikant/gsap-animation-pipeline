/**
 * Per-Elementor-widget selector profiles.
 *
 * Each preset maps to:
 *   - The Elementor widget type (used in the container selector)
 *   - The CSS selectors actually inside that widget (used for the
 *     CSS-selectors list shown in the Preview pane)
 *   - Human-readable notes describing the layout
 *   - A canonical `treeTemplate` describing the recursive widget hierarchy
 *     the GSAP code is expected to address. The AX-style signature in
 *     `dspy-signature.ts` asks the LLM to instantiate this template
 *     (filling in `props.text` / `props.src` / `props.label` and the
 *     `state.count` for the carousel/pagination containers) and emit the
 *     resulting tree as JSON.
 *
 * Replaces the generic `.elementor-heading-title / .elementor-button` defaults
 * that were causing selector-mismatch bugs (Preview showed one set, the
 * generated code queried another set).
 */

import type { ElementorWidget } from './elementor-widget';

export interface WidgetProfile {
  widgetType: string;
  width: string;
  breakpoint: string;
  notes: string;
  /** Selectors the code will actually query, in priority order */
  selectors: string[];
  /**
   * Canonical recursive widget tree the LLM must instantiate.
   * Containers carry a `state.count` (or `_repeat`) telling the LLM how many
   * siblings to emit. Leaves carry `prop` placeholders like `{ text: "..." }`
   * for the LLM to fill from intent context.
   */
  treeTemplate: ElementorWidget;
  /**
   * Repeated subtree templates (Container nodes that should be emitted N times).
   * The LLM is told `count` comes from the user's intent (default provided).
   * Keyed by the parent Container id.
   */
  repeats?: Array<{
    parentId: string;
    childIdPrefix: string;
    defaultCount: number;
    child: ElementorWidget;
  }>;
}

export const WIDGET_PROFILES: Record<string, WidgetProfile> = {
  testimonial: {
    widgetType: 'slides',
    width: 'w50',
    breakpoint: 'lg-2',
    notes: 'Two-column testimonial carousel (Swiper-based)',
    selectors: [
      '.elementor-element.elementor-widget-slides',
      '.elementor-element.elementor-widget-slides .swiper',
      '.elementor-element.elementor-widget-slides .swiper-slide',
      '.elementor-element.elementor-widget-slides .elementor-testimonial-content',
      '.elementor-element.elementor-widget-slides .elementor-testimonial-name',
    ],
    treeTemplate: {
      id: 'testimonial-swiper',
      kind: 'Container',
      label: 'Testimonial carousel',
      layout: 'relative',
      children: [
        {
          id: 'testimonial-wrapper',
          kind: 'Container',
          label: 'Slide wrapper',
          layout: 'flex row',
          children: [
            {
              id: 'testimonial-slide',
              kind: 'Container',
              label: 'Testimonial slide',
              layout: 'flex column',
              children: [
                { id: 'testimonial-quote', kind: 'Text', label: 'Quote', props: { text: '...' } },
                { id: 'testimonial-name', kind: 'Heading', label: 'Author name', props: { text: '...' } },
                { id: 'testimonial-role', kind: 'Text', label: 'Author role', props: { text: '...' } },
                { id: 'testimonial-avatar', kind: 'Image', label: 'Avatar', props: { src: '...' } },
              ],
            },
          ],
        },
        {
          id: 'testimonial-dots',
          kind: 'Container',
          label: 'Pagination dots',
          layout: 'flex row',
          children: [
            { id: 'testimonial-dot', kind: 'Icon', label: 'Dot', state: { active: false } },
          ],
        },
        { id: 'testimonial-prev', kind: 'Button', label: 'Previous' },
        { id: 'testimonial-next', kind: 'Button', label: 'Next' },
      ],
    },
    repeats: [
      {
        parentId: 'testimonial-wrapper',
        childIdPrefix: 'testimonial-slide',
        defaultCount: 3,
        child: {
          id: 'testimonial-slide',
          kind: 'Container',
          label: 'Testimonial slide',
          layout: 'flex column',
          children: [
            { id: 'testimonial-quote', kind: 'Text', label: 'Quote', props: { text: '...' } },
            { id: 'testimonial-name', kind: 'Heading', label: 'Author name', props: { text: '...' } },
            { id: 'testimonial-role', kind: 'Text', label: 'Author role', props: { text: '...' } },
            { id: 'testimonial-avatar', kind: 'Image', label: 'Avatar', props: { src: '...' } },
          ],
        },
      },
      {
        parentId: 'testimonial-dots',
        childIdPrefix: 'testimonial-dot',
        defaultCount: 3,
        child: { id: 'testimonial-dot', kind: 'Icon', label: 'Dot', state: { active: false } },
      },
    ],
  },

  hero: {
    widgetType: 'heading',
    width: 'w100',
    breakpoint: 'lg-1',
    notes: 'Full-width hero section (heading + CTA) — supports single image or multi-slide swiper',
    selectors: [
      '.elementor-element.elementor-widget-heading',
      '.elementor-element.elementor-widget-heading .elementor-heading-title',
      '.elementor-element.elementor-widget-heading .elementor-widget-theme-content-wrapper p',
      '.elementor-element.elementor-widget-button .elementor-button',
    ],
    treeTemplate: {
      id: 'hero-section',
      kind: 'Container',
      label: 'Hero section',
      layout: 'relative',
      children: [
        {
          id: 'hero-bg',
          kind: 'Image',
          label: 'Hero background',
          props: { src: '...' },
        },
        {
          id: 'hero-scrim',
          kind: 'Container',
          label: 'Gradient overlay',
          layout: 'absolute scrim',
        },
        {
          id: 'hero-card',
          kind: 'Container',
          label: 'Content card',
          layout: 'flex column',
          children: [
            { id: 'hero-eyebrow', kind: 'Text', label: 'Eyebrow', props: { text: '...' } },
            { id: 'hero-title', kind: 'Heading', label: 'Title', props: { text: '...' } },
            { id: 'hero-desc', kind: 'Text', label: 'Description', props: { text: '...' } },
            { id: 'hero-cta', kind: 'Button', label: 'Call to action', props: { label: '...', href: '#' } },
          ],
        },
      ],
    },
  },

  cards: {
    widgetType: 'icon-box',
    width: 'w33',
    breakpoint: 'lg-4',
    notes: 'Three-column feature card grid (icon + title + description)',
    selectors: [
      '.elementor-element.elementor-widget-icon-box',
      '.elementor-element.elementor-widget-icon-box .elementor-icon-box-wrapper',
      '.elementor-element.elementor-widget-icon-box .elementor-icon-box-title',
      '.elementor-element.elementor-widget-icon-box .elementor-icon-box-description',
    ],
    treeTemplate: {
      id: 'cards-grid',
      kind: 'Container',
      label: 'Feature cards grid',
      layout: 'flex row wrap',
      children: [
        {
          id: 'cards-row',
          kind: 'Container',
          label: 'Cards row',
          layout: 'flex row',
          children: [
            {
              id: 'card',
              kind: 'Container',
              label: 'Feature card',
              layout: 'flex column',
              children: [
                { id: 'card-icon', kind: 'Icon', label: 'Card icon' },
                { id: 'card-title', kind: 'Heading', label: 'Card title', props: { text: '...' } },
                { id: 'card-desc', kind: 'Text', label: 'Card description', props: { text: '...' } },
              ],
            },
          ],
        },
      ],
    },
    repeats: [
      {
        parentId: 'cards-row',
        childIdPrefix: 'card',
        defaultCount: 6,
        child: {
          id: 'card',
          kind: 'Container',
          label: 'Feature card',
          layout: 'flex column',
          children: [
            { id: 'card-icon', kind: 'Icon', label: 'Card icon' },
            { id: 'card-title', kind: 'Heading', label: 'Card title', props: { text: '...' } },
            { id: 'card-desc', kind: 'Text', label: 'Card description', props: { text: '...' } },
          ],
        },
      },
    ],
  },

  pricing: {
    widgetType: 'price-table',
    width: 'w25',
    breakpoint: 'lg-3',
    notes: 'Four-column pricing table (header + price + features + button)',
    selectors: [
      '.elementor-element.elementor-widget-price-table',
      '.elementor-element.elementor-widget-price-table .elementor-price-table',
      '.elementor-element.elementor-widget-price-table .elementor-price-table__header',
      '.elementor-element.elementor-widget-price-table .elementor-price-table__price',
    ],
    treeTemplate: {
      id: 'pricing-grid',
      kind: 'Container',
      label: 'Pricing table row',
      layout: 'flex row',
      children: [
        {
          id: 'pricing-row',
          kind: 'Container',
          label: 'Pricing columns',
          layout: 'flex row',
          children: [
            {
              id: 'pricing-col',
              kind: 'Container',
              label: 'Pricing column',
              layout: 'flex column',
              children: [
                { id: 'pricing-header', kind: 'Heading', label: 'Plan name', props: { text: '...' } },
                { id: 'pricing-price', kind: 'Heading', label: 'Price', props: { text: '...' } },
                { id: 'pricing-features', kind: 'Text', label: 'Feature list', props: { text: '...' } },
                { id: 'pricing-cta', kind: 'Button', label: 'Plan CTA', props: { label: '...' } },
              ],
            },
          ],
        },
      ],
    },
    repeats: [
      {
        parentId: 'pricing-row',
        childIdPrefix: 'pricing-col',
        defaultCount: 3,
        child: {
          id: 'pricing-col',
          kind: 'Container',
          label: 'Pricing column',
          layout: 'flex column',
          children: [
            { id: 'pricing-header', kind: 'Heading', label: 'Plan name', props: { text: '...' } },
            { id: 'pricing-price', kind: 'Heading', label: 'Price', props: { text: '...' } },
            { id: 'pricing-features', kind: 'Text', label: 'Feature list', props: { text: '...' } },
            { id: 'pricing-cta', kind: 'Button', label: 'Plan CTA', props: { label: '...' } },
          ],
        },
      },
    ],
  },

  gallery: {
    widgetType: 'image-gallery',
    width: 'w33',
    breakpoint: 'lg-4',
    notes: 'Three-column image gallery',
    selectors: [
      '.elementor-element.elementor-widget-image-gallery',
      '.elementor-element.elementor-widget-image-gallery .gallery-item',
      '.elementor-element.elementor-widget-image-gallery img',
    ],
    treeTemplate: {
      id: 'gallery-grid',
      kind: 'Container',
      label: 'Image gallery',
      layout: 'flex row wrap',
      children: [
        {
          id: 'gallery-row',
          kind: 'Container',
          label: 'Gallery row',
          layout: 'flex row',
          children: [
            { id: 'gallery-item', kind: 'Image', label: 'Gallery image', props: { src: '...' } },
          ],
        },
      ],
    },
    repeats: [
      {
        parentId: 'gallery-row',
        childIdPrefix: 'gallery-item',
        defaultCount: 6,
        child: { id: 'gallery-item', kind: 'Image', label: 'Gallery image', props: { src: '...' } },
      },
    ],
  },

  counter: {
    widgetType: 'counter',
    width: 'w25',
    breakpoint: 'lg-3',
    notes: 'Four-stat counter row',
    selectors: [
      '.elementor-element.elementor-widget-counter',
      '.elementor-element.elementor-widget-counter .elementor-counter',
      '.elementor-element.elementor-widget-counter .elementor-counter-number',
      '.elementor-element.elementor-widget-counter .elementor-counter-label',
    ],
    treeTemplate: {
      id: 'counter-row',
      kind: 'Container',
      label: 'Stats counter row',
      layout: 'flex row',
      children: [
        {
          id: 'counter-cells',
          kind: 'Container',
          label: 'Counter cells',
          layout: 'flex row',
          children: [
            {
              id: 'counter-cell',
              kind: 'Container',
              label: 'Stat cell',
              layout: 'flex column',
              children: [
                { id: 'counter-number', kind: 'Heading', label: 'Stat number', props: { text: '0' } },
                { id: 'counter-label', kind: 'Text', label: 'Stat label', props: { text: '...' } },
              ],
            },
          ],
        },
      ],
    },
    repeats: [
      {
        parentId: 'counter-cells',
        childIdPrefix: 'counter-cell',
        defaultCount: 4,
        child: {
          id: 'counter-cell',
          kind: 'Container',
          label: 'Stat cell',
          layout: 'flex column',
          children: [
            { id: 'counter-number', kind: 'Heading', label: 'Stat number', props: { text: '0' } },
            { id: 'counter-label', kind: 'Text', label: 'Stat label', props: { text: '...' } },
          ],
        },
      },
    ],
  },
};

export type WidgetKey = keyof typeof WIDGET_PROFILES;

/**
 * Pick the right widget profile based on intent keywords.
 */
export function selectWidgetProfile(intent: string): WidgetProfile {
  const lc = intent.toLowerCase();

  if (lc.includes('testimonial') || lc.includes('quote')) return WIDGET_PROFILES.testimonial;
  if (lc.includes('hero')) return WIDGET_PROFILES.hero;
  if (lc.includes('card') || lc.includes('feature')) return WIDGET_PROFILES.cards;
  if (lc.includes('pricing') || lc.includes('price')) return WIDGET_PROFILES.pricing;
  if (lc.includes('gallery') || lc.includes('image')) return WIDGET_PROFILES.gallery;
  if (lc.includes('counter') || lc.includes('stat') || lc.includes('number')) return WIDGET_PROFILES.counter;

  // Default fallback — hero section (most generic)
  return WIDGET_PROFILES.hero;
}

/**
 * Pick the appropriate repeat count from the user's prose. Recognises leading
 * cardinal digits, then a small set of synonyms). Returns the profile's
 * defaultCount when no count is found in the intent.
 */
export function inferRepeatCount(intent: string, defaultCount: number): number {
  const lc = intent.toLowerCase();
  // First try a digit: "4 slides", "three cards", "six testimonials"
  const digit = lc.match(/\b(\d{1,2})\b/);
  if (digit) {
    const n = parseInt(digit[1], 10);
    if (n >= 1 && n <= 24) return n;
  }
  const wordToN: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10,
  };
  for (const [w, n] of Object.entries(wordToN)) {
    if (lc.includes(`${w} `) || lc.includes(`${w}-`) || lc.endsWith(w)) {
      return n;
    }
  }
  return defaultCount;
}