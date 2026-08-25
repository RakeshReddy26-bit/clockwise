"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { availableActions, canPerform, type AccountState } from "@/lib/account";
import { inviteEmployee, resendInvite, setAccountAccess } from "./account-actions";

type Notice = { text: string; tone: "success" | "error" } | null;

/**
 * The Account section on the employee detail page.
 *
 * Four states, one action each. An account panel with every button visible at
 * once invites mistakes, and each state here has exactly one sensible next
 * move. Buttons the viewer may not use are not rendered — the Server Action and
 * the SQL function refuse regardless, so this is alignment, not authorization.
 *
 * Employment and access are kept visibly separate: this panel never shows or
 * changes employment status, and the status control never shows account state.
 */
export function AccountPanel({
  employeeId,
  state,
  email,
  role,
}: {
  employeeId: string;
  state: AccountState;
  email: string | null;
  role: string;
}) {
  const t = useTranslations("account");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);

  const actions = availableActions(state).filter((a) => canPerform(a, role));

  function run(action: string) {
    setNotice(null);
    startTransition(async () => {
      if (action === "invite") {
        const result = await inviteEmployee({ employeeId });
        if (!result.ok) return setNotice({ text: t("errorGeneric"), tone: "error" });
        if (result.data.kind === "refused") {
          return setNotice({ text: t(`refused_${result.data.reason}`), tone: "error" });
        }
        setNotice({ text: t("invited"), tone: "success" });
      } else if (action === "resend") {
        const result = await resendInvite({ employeeId });
        if (!result.ok) return setNotice({ text: t("errorGeneric"), tone: "error" });
        if (result.data.kind === "refused") {
          return setNotice({ text: t("refused_not_invited"), tone: "error" });
        }
        setNotice({ text: t("resent"), tone: "success" });
      } else {
        const suspend = action === "suspend";
        const result = await setAccountAccess({ employeeId, suspend });
        if (!result.ok) return setNotice({ text: t("errorGeneric"), tone: "error" });
        if (result.data.kind === "refused") {
          return setNotice({ text: t(`refusedAccess_${result.data.reason}`), tone: "error" });
        }
        setNotice({
          text: result.data.suspended ? t("suspended") : t("reactivated"),
          tone: "success",
        });
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            variant={
              state === "active" ? "success" : state === "invited" ? "warning" : "secondary"
            }
          >
            {t(`state_${state}`)}
          </Badge>
          {state !== "no_account" && email && (
            <span className="text-xs text-muted-foreground">{email}</span>
          )}
        </div>
        <div className="flex gap-1.5">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "suspend" ? "outline" : "default"}
              onClick={() => run(action)}
              disabled={isPending}
            >
              {t(`action_${action}`)}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">{t(`hint_${state}`)}</p>

      {notice && (
        <p
          role="status"
          className={`text-xs ${
            notice.tone === "success" ? "text-success" : "text-destructive"
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
