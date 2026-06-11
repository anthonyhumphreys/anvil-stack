import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { DecisionTable } from "@/components/admin/data-tables";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { countActions, decisionActionFromSlug, decisionListTitle, getPersistence } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DecisionListPage({ params }: { params: Promise<{ action: string }> }) {
  const isAdmin = await isAdminSession();
  if (!isAdmin) return <LoginPanel />;

  const { action: slug } = await params;
  const action = decisionActionFromSlug(slug);
  if (!action) notFound();

  const decisions = await getPersistence().listPolicyDecisions({ actions: [action], limit: 100 });

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <h1 className="text-3xl font-semibold tracking-normal">{decisionListTitle(action)}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">Filtered policy decisions for packages that reached the {action} gate.</p>
        </section>
        <SummaryTiles
          items={[
            { label: "Decisions", value: decisions.length, tone: "muted" },
            { label: "Blocked", value: countActions(decisions, "block"), tone: "block" },
            { label: "Warned", value: countActions(decisions, "warn"), tone: "warn" },
            { label: "Allowed", value: countActions(decisions, "allow"), tone: "allow" }
          ]}
        />
        <Section title="Decision evidence">
          <DecisionTable decisions={decisions} />
        </Section>
      </div>
    </AdminShell>
  );
}
