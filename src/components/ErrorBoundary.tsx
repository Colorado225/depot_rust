import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/src/components/ui/card';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <div className="flex items-center gap-2.5 text-destructive">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <CardTitle>Une erreur applicative est survenue</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                L&apos;interface a intercepté une exception inattendue afin de protéger l&apos;intégrité de la session.
                Vos données enregistrées dans SQLite restent intactes.
              </p>
              {this.state.error && (
                <pre className="overflow-x-auto rounded-md border border-border bg-secondary p-3 font-mono text-xs text-foreground">
                  {this.state.error.message}
                </pre>
              )}
              <Button onClick={() => window.location.reload()}>
                <RotateCcw className="h-4 w-4" />
                Recharger l&apos;interface
              </Button>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
