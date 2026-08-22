"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { respondToOffer } from "@/app/(portal)/me/offers/actions";
import type { EmployeeResponse, ResponseState } from "@/lib/offer-transitions";

export type OfferCardData = {
  responseId: string;
  /** Worksite or client name — an identity, never translated. */
  siteName: string;
  clientName: string | null;
  /** Raw role value; localized for display by the server via roleLabel. */
  roleLabel: string | null;
  requiredQualification: string | null;
  dateLabel: string;
  timeLabel: string;
  hours: number;
  message: string | null;
  response: ResponseState;
  offerOpen: boolean;
  decided: boolean;
};

const STATE_VARIANT: Record<ResponseState, "secondary" | "success" | "destructive" | "warning"> = {
  pending: "secondary",
  interested: "success",
  declined: "destructive",
  withdrawn: "warning",
};

export function OfferCard({ offer }: { offer: OfferCardData }) {
  const t = useTranslations("offers");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<ResponseState>(offer.response);
  const [notice, setNotice] = useState<string | null>(null);

  const closed = !offer.offerOpen || offer.decided;

  function respond(intent: EmployeeResponse) {
    setNotice(null);
    startTransition(async () => {
      const result = await respondToOffer({ responseId: offer.responseId, intent });
      if (!result.ok) {
        setNotice(t("errorGeneric"));
        return;
      }
      switch (result.data.kind) {
        case "saved":
        case "unchanged":
          setState(result.data.response);
          router.refresh();
          break;
        case "offer_closed":
          setNotice(t("noticeClosed"));
          router.refresh();
          break;
        case "already_decided":
          setNotice(t("noticeDecided"));
          router.refresh();
          break;
        case "not_allowed":
          setNotice(t("errorNotAllowed"));
          break;
      }
    });
  }

  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium">{offer.siteName}</h3>
          {offer.clientName && (
            <p className="truncate text-xs text-muted-foreground">{offer.clientName}</p>
          )}
        </div>
        <Badge variant={STATE_VARIANT[state]}>{t(`state_${state}`)}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{t("when")}</dt>
          <dd className="font-medium tabular-nums">
            {offer.dateLabel} · {offer.timeLabel}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("hours")}</dt>
          <dd className="font-medium tabular-nums">{t("hoursValue", { hours: offer.hours })}</dd>
        </div>
        {offer.roleLabel && (
          <div>
            <dt className="text-xs text-muted-foreground">{t("role")}</dt>
            <dd className="font-medium">{offer.roleLabel}</dd>
          </div>
        )}
        {offer.requiredQualification && (
          <div>
            <dt className="text-xs text-muted-foreground">{t("qualification")}</dt>
            <dd className="font-medium">{offer.requiredQualification}</dd>
          </div>
        )}
      </dl>

      {offer.message && (
        <p className="rounded-md bg-secondary p-2 text-xs text-secondary-foreground">
          {offer.message}
        </p>
      )}

      {state === "interested" && !closed && (
        <p className="text-xs font-medium text-warning">{t("waitingForConfirmation")}</p>
      )}

      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}

      {closed ? (
        <p className="text-xs text-muted-foreground">{t("noticeClosed")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {state !== "interested" && (
            <Button size="sm" onClick={() => respond("interested")} disabled={isPending}>
              {t("actionInterested")}
            </Button>
          )}
          {state === "interested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => respond("withdrawn")}
              disabled={isPending}
            >
              {t("actionWithdraw")}
            </Button>
          )}
          {state !== "declined" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => respond("declined")}
              disabled={isPending}
            >
              {t("actionDecline")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
