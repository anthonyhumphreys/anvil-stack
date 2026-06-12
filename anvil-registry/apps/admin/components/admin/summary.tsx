import { AlertTriangle, CheckCircle2, CircleSlash, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const toneIcon = {
  block: ShieldAlert,
  warn: AlertTriangle,
  quarantine: AlertTriangle,
  allow: CheckCircle2,
  muted: CircleSlash
};

export function SummaryTiles({ items }: { items: Array<{ label: string; value: React.ReactNode; tone?: keyof typeof toneIcon; detail?: string }> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => {
        const tone = item.tone ?? "muted";
        const Icon = toneIcon[tone];
        return (
          <Card key={item.label} className={cn(tone === "block" && "border-destructive/40", (tone === "warn" || tone === "quarantine") && "border-accent/40")}>
            <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{item.label}</CardTitle>
              <Icon className="text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tracking-normal">{item.value}</div>
              {item.detail ? <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p> : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function Section({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-xl font-semibold tracking-normal">{title}</h2>
          {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
