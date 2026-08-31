/**
 * Per-Elementor-widget selector profiles.
 *
 * Each preset maps to:
 *   - The Elementor widget type (used in the container selector)
 *   - The CSS selectors actually inside that widget (used for the
 *     CSS-selectors list shown in the Preview pane)
 *   - Human-readable notes describing the layout
 *
 * Replaces the generic `.elementor-heading-title / .elementor-button` defaults
 * that were causing selector-mismatch bugs (Preview showed one set, the
 * generated code queried another set).
 */

export interface WidgetProfile {
  widgetType: string;
  width: string;
  breakpoint: string;
  notes: string;
  /** Selectors the code will actually query, in priority order */
  selectors: string[];
}

export const WIDGET_PROFILES: Record<string, WidgetProfile> = {
  testimonial: {
    widgetType: 'slides', // Swiper-based carousel in Elementor
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
  },
  hero: {
    widgetType: 'heading',
    width: 'w100',
    breakpoint: 'lg-1',
    notes: 'Full-width hero section (heading + CTA)',
    selectors: [
      '.elementor-element.elementor-widget-heading',
      '.elementor-element.elementor-widget-heading .elementor-heading-title',
      '.elementor-element.elementor-widget-heading .elementor-widget-theme-content-wrapper p',
      '.elementor-element.elementor-widget-button .elementor-button',
    ],
  },
  cards: {
    widgetType: 'icon-box',
    width: 'w33',
    breakpoint: 'lg-4',
    notes: 'Three-column feature card grid',
    selectors: [
      '.elementor-element.elementor-widget-icon-box',
      '.elementor-element.elementor-widget-icon-box .elementor-icon-box-wrapper',
      '.elementor-element.elementor-widget-icon-box .elementor-icon-box-title',
      '.elementor-element.elementor-widget-icon-box .elementor-icon-box-description',
    ],
  },
  pricing: {
    widgetType: 'price-table',
    width: 'w25',
    breakpoint: 'lg-3',
    notes: 'Four-column pricing table',
    selectors: [
      '.elementor-element.elementor-widget-price-table',
      '.elementor-element.elementor-widget-price-table .elementor-price-table',
      '.elementor-element.elementor-widget-price-table .elementor-price-table__header',
      '.elementor-element.elementor-widget-price-table .elementor-price-table__price',
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
