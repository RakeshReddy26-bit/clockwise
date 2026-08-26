import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { isAiConfigured } from "@/lib/ai/anthropic";
import { EmptyState } from "@/components/empty-state";
import { AssistantChat } from "./assistant-chat";

/**
 * The assistant page.
 *
 * Two gates before the chat renders, and neither is what makes the feature
 * safe — the Server Actions enforce permission again on every call. These are
 * here so a member who cannot use it is told why instead of meeting a wall of
 * refusals, and so a deployment without a key says so plainly.
 */
export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("assistant");

  // Reading company data is the floor for asking anything useful at all.
  if (!roleHas(ctx.membership.role, "employees.read")) {
    return <EmptyState title={t("noAccessTitle")} body={t("noAccessBody")} />;
  }

  if (!isAiConfigured()) {
    return <EmptyState title={t("notConfiguredTitle")} body={t("notConfiguredBody")} />;
  }

  return <AssistantChat />;
}
