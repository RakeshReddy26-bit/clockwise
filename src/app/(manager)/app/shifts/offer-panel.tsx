"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Send, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { sendShiftOffer } from "./actions";

export type CandidateView = {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  position: string | null;
  department: string | null;
  score: number;
  eligible: boolean;
  /** Message keys, resolved here — the server sends reason codes, not labels. */
  reasons: string[];
  alreadyInvited: boolean;
};

type Props = {
  shiftId: string;
  candidates: CandidateView[];
  remainingSeats: number;
};

export function OfferPanel({ shiftId, candidates, remainingSeats }: Props) {
  const t = useTranslations("planning");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showIneligible, setShowIneligible] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const eligible = candidates.filter((c) => c.eligible);
  const ineligible = candidates.filter((c) => !c.eligible);
  const selectable = eligible.filter((c) => !c.alreadyInvited);

  function toggle(employeeId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  }

  function send() {
    if (selected.size === 0) return;
    setResult(null);
    startTransition(async () => {
      const response = await sendShiftOffer({
        shiftId,
        employeeIds: [...selected],
      });

      if (!response.ok) {
        setResult(t("errorGeneric"));
        return;
      }

      const outcome = response.data;
      switch (outcome.kind) {
        case "sent":
          setResult(
            outcome.invited > 0
              ? t("offerSent", { count: outcome.invited })
              : t("offerAlreadySent")
          );
          setSelected(new Set());
          router.refresh();
          break;
        case "shift_not_open":
          setResult(t("errorShiftNotOpen"));
          break;
        case "shift_fully_staffed":
          setResult(t("errorFullyStaffed"));
          break;
        case "shift_in_past":
          setResult(t("errorShiftInPast"));
          break;
        case "no_eligible_selection":
          setResult(t("errorNoneEligible"));
          router.refresh();
          break;
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t("candidates")}{" "}
          <span className="font-normal text-muted-foreground">
            ({eligible.length}/{candidates.length})
          </span>
        </h3>
        <Button size="sm" onClick={send} disabled={isPending || selected.size === 0}>
          <Send /> {t("sendOffer", { count: selected.size })}
        </Button>
      </div>

      {result && (
        <p role="status" className="text-sm font-medium text-foreground">
          {result}
        </p>
      )}

      {selected.size > remainingSeats && (
        <p className="text-xs text-muted-foreground">
          {t("moreSelectedThanSeats", { seats: remainingSeats })}
        </p>
      )}

      {selectable.length === 0 && eligible.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          {t("noEligible")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {eligible.map((candidate) => (
            <li key={candidate.employeeId}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm transition-colors ${
                  candidate.alreadyInvited ? "opacity-60" : "hover:bg-secondary"
                }`}
              >
                <input
                  type="checkbox"
                  className="size-4"
                  checked={selected.has(candidate.employeeId)}
                  disabled={candidate.alreadyInvited || isPending}
                  onChange={() => toggle(candidate.employeeId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{candidate.fullName}</span>{" "}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {candidate.employeeNo}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[candidate.position, candidate.department].filter(Boolean).join(" · ") || "—"}
                  </span>
                </span>
                {candidate.alreadyInvited ? (
                  <Badge variant="secondary">{t("alreadyInvited")}</Badge>
                ) : (
                  candidate.score > 0 && (
                    <Badge variant="success" title={t("scoreHint")}>
                      +{candidate.score}
                    </Badge>
                  )
                )}
              </label>
            </li>
          ))}
        </ul>
      )}

      {ineligible.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowIneligible((v) => !v)}
            className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {showIneligible ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t("showIneligible", { count: ineligible.length })}
          </button>
          {showIneligible && (
            <ul className="flex flex-col gap-1">
              {ineligible.map((candidate) => (
                <li
                  key={candidate.employeeId}
                  className="flex items-center justify-between gap-3 rounded-md border border-dashed p-2 text-sm"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-muted-foreground">{candidate.fullName}</span>{" "}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {candidate.employeeNo}
                    </span>
                  </span>
                  <span className="flex flex-wrap justify-end gap-1">
                    {candidate.reasons.map((reason) => (
                      <Badge key={reason} variant="secondary">
                        {t(reason)}
                      </Badge>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
