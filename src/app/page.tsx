import type { Metadata } from 'next';
import { PipelineApp } from '@/components/pipeline-app';

export const metadata: Metadata = {
  title: 'GSAP Animation Pipeline - Elementor + GTM',
  description:
    'AI-powered GSAP animation generator for Elementor-built WordPress sites, deployed via Google Tag Manager. Powered by Nvidia GPT-OSS-120B with LangGraph validation loop and resilience layer.',
  openGraph: {
    title: 'GSAP Animation Pipeline',
    description: 'AI-powered GSAP animation generator for Elementor + GTM',
  },
};

export default function Page() {
  return <PipelineApp />;
}
