import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { EmployeeForm, type Option } from "../employee-form";

/**
 * Create an employment record.
 *
 * No account is created and no invitation is sent: profile_id stays null, which
 * the schema has always allowed and which is what lets a manager prepare
 * staffing records before anyone logs in. Accounts, invitations and linking are
 * Phase G.
 */
export const dynamic = "force-dynamic";

export default async function NewEmployeePage() {
  const ctx = await getShellContext();
  const t = await getTranslations("employees");

  // The Server Action checks this again; redirecting here just avoids showing a
  // form that could only fail.
  if (!roleHas(ctx.membership.role, "employees.manage")) redirect("/app/employees");

  const [{ data: departments }, { data: locations }] = await Promise.all([
    ctx.supabase
      .from("departments")
      .select("id, name")
      .eq("company_id", ctx.membership.company_id)
      .order("name"),
    ctx.supabase
      .from("locations")
      .select("id, name")
      .eq("company_id", ctx.membership.company_id)
      .order("name"),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link href="/app/employees" className="text-xs text-muted-foreground hover:underline">
          ← {t("title")}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{t("newEmployee")}</h1>
        <p className="text-xs text-muted-foreground">{t("newEmployeeHint")}</p>
      </div>

      <EmployeeForm
        departments={(departments ?? []) as Option[]}
        locations={(locations ?? []) as Option[]}
      />
    </div>
  );
}
