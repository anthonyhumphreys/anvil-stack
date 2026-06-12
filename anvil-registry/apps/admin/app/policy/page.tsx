import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { config, getPersistence } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PolicyPage() {
  const isAdmin = await isAdminSession();
  if (!isAdmin) return <LoginPanel />;

  const policyConfig = await getPersistence().putPolicyConfig({
    name: "effective",
    version: config.policy.version,
    active: true,
    config: {
      runtimeMode: config.RUNTIME_MODE,
      policy: config.policy
    }
  });

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Runtime {config.RUNTIME_MODE}</Badge>
          <h1 className="mt-4 text-3xl font-semibold tracking-normal">Effective policy</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">The deterministic policy engine is the enforcement authority. This is the runtime configuration currently shaping package decisions.</p>
        </section>
        <SummaryTiles
          items={[
            { label: "Policy version", value: config.policy.version, tone: "muted" },
            { label: "Package age window", value: `${config.policy.minimumPackageAgeDays} days`, tone: "warn" },
            { label: "LLM review", value: config.policy.llmReview.enabled ? "enabled" : "disabled", tone: config.policy.llmReview.enabled ? "warn" : "muted" },
            { label: "Overrides", value: config.policy.overrides.enabled ? "enabled" : "disabled", tone: config.policy.overrides.enabled ? "allow" : "muted" }
          ]}
        />
        <Section title="Deterministic gates">
          <div className="grid gap-3 lg:grid-cols-2">
            {Object.entries(flattenPolicy(config.policy)).map(([key, value]) => (
              <Card key={key}>
                <CardHeader className="pb-2">
                  <CardTitle className="font-mono text-sm">{key}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{String(value)}</CardContent>
              </Card>
            ))}
          </div>
        </Section>
        <Section title="Persisted snapshot">
          <pre className="code-window overflow-auto rounded-lg border p-5 font-mono text-sm text-[#f7faf9] shadow-anvil">{JSON.stringify(policyConfig, null, 2)}</pre>
        </Section>
      </div>
    </AdminShell>
  );
}

function flattenPolicy(value: unknown, prefix = ""): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { [prefix]: value };
  return Object.entries(value).reduce<Record<string, unknown>>((result, [key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) Object.assign(result, flattenPolicy(child, path));
    else result[path] = child;
    return result;
  }, {});
}
