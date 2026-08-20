import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { homePathFor, type Role } from "@/lib/permissions";

export default async function RootPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("company_memberships")
    .select("role")
    .eq("profile_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (!membership) redirect("/login?error=nomember");
  redirect(homePathFor(membership.role as Role));
}
