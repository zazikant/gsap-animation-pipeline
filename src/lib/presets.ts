export interface AnimationPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  defaultPrompt: string;
}

export const PRESETS: AnimationPreset[] = [
  {
    id: 'testimonial-carousel',
    name: 'Testimonial Carousel',
    description: 'Animated testimonial carousel with fade-in quotes and slide-',
    icon: 'Quote',
    defaultPrompt: 'Build a testimonial carousel that fades in quotes and slides them up smoothly',
  },
  {
    id: 'hero-section',
    name: 'Hero Section',
    description: 'Hero section with staggered fade-up animation for heading, s',
    icon: 'Sparkles',
    defaultPrompt: 'Hero section with staggered fade-up animation for heading, subheading, and CTA button',
  },
  {
    id: 'feature-cards',
    name: 'Feature Cards',
    description: 'Feature cards with scroll-triggered scale-up animation and s',
    icon: 'LayoutGrid',
    defaultPrompt: 'Feature cards grid with scroll-triggered scale-up animation and staggered reveal',
  },
  {
    id: 'pricing-table',
    name: 'Pricing Table',
    description: 'Pricing table with hover lift effect on cards and pulse anim',
    icon: 'Tag',
    defaultPrompt: 'Pricing table with hover lift effect on cards and pulse animation on the recommended plan',
  },
  {
    id: 'image-gallery',
    name: 'Image Gallery',
    description: 'Image gallery with staggered fade-in on load and zoom-on-hov',
    icon: 'Images',
    defaultPrompt: 'Image gallery with staggered fade-in on load and zoom-on-hover effect',
  },
  {
    id: 'stats-counter',
    name: 'Stats Counter',
    description: 'Animated stats section with count-up numbers and staggered f',
    icon: 'BarChart',
    defaultPrompt: 'Animated stats section with count-up numbers and staggered fade-in',
  },
];

export interface ElementorGridHints {
  widths: string;
  breakpoints: string;
  rationale: string;
}

export const ELEMENTOR_GRID_HINTS = {
  widths: 'w0–w12',
  breakpoints: 'lg1–lg5 • t1–t5 • rb1–rb3 • p1 • c1–c8',
  rationale: 'Auto-derived from description',
} as const;

export interface PipelineStep {
  id: 'intent' | 'generate' | 'preview' | 'deploy';
  label: string;
  description: string;
}

export const PIPELINE_STEPS: PipelineStep[] = [
  {
    id: 'intent',
    label: 'You give intent',
    description: 'Describe what you want',
  },
  {
    id: 'generate',
    label: 'AI maps w0',
    description: 'Auto-derives container structure & selectors',
  },
  {
    id: 'preview',
    label: 'AI writes code',
    description: 'LangGraph loop + validation',
  },
  {
    id: 'deploy',
    label: 'You preview',
    description: 'Live animation + GTM guide',
  },
];
