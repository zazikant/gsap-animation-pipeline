'use client';

import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface DeployPaneProps {
  onBack: () => void;
}

export function DeployPane({ onBack }: DeployPaneProps) {
  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Preview
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>Deploy</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-600">
            Generate an animation first to see deployment options.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
