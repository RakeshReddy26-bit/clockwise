"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { WEEKDAYS, AVAILABILITY_TYPES } from "@/lib/employee";
import {
  updateOwnContact,
  updateOwnAccount,
  saveOwnEmergencyContact,
  deleteOwnEmergencyContact,
  addOwnAvailability,
  removeOwnAvailability,
} from "./actions";

type Notice = { text: string; tone: "success" | "error" } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role="status"
      className={`text-xs ${notice.tone === "success" ? "text-success" : "text-destructive"}`}
    >
      {notice.text}
    </p>
  );
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Phone. The only field on the employee record its owner may change. */
export function ContactForm({ phone }: { phone: string }) {
  const t = useTranslations("profile");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(phone);
  const [notice, setNotice] = useState<Notice>(null);

  function submit() {
    setNotice(null);
    startTransition(async () => {
      const result = await updateOwnContact({ phone: value.trim() || null });
      setNotice(
        result.ok
          ? { text: t("saved"), tone: "success" }
          : { text: t("errorGeneric"), tone: "error" }
      );
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="phone" className="text-xs">
            {t("fieldPhone")}
          </Label>
          <Input id="phone" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <Button size="sm" onClick={submit} disabled={isPending}>
          {t("save")}
        </Button>
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}

/** Display name and language — settings of the account, not of the employment. */
export function AccountForm({ fullName, locale }: { fullName: string; locale: string }) {
  const t = useTranslations("profile");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(fullName);
  const [lang, setLang] = useState(locale);
  const [notice, setNotice] = useState<Notice>(null);

  function submit() {
    setNotice(null);
    startTransition(async () => {
      const result = await updateOwnAccount({
        full_name: name.trim(),
        locale: lang as "de" | "en",
      });
      setNotice(
        result.ok
          ? { text: t("saved"), tone: "success" }
          : { text: t("errorGeneric"), tone: "error" }
      );
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="account_name" className="text-xs">
            {t("fieldDisplayName")}
          </Label>
          <Input id="account_name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account_locale" className="text-xs">
            {t("fieldLanguage")}
          </Label>
          <select
            id="account_locale"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </div>
        <Button size="sm" onClick={submit} disabled={isPending || !name.trim()}>
          {t("save")}
        </Button>
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}

export type EmergencyContactRow = {
  id: string;
  name: string;
  relationship: string | null;
  phone: string;
  phone_alt: string | null;
};

/**
 * The employee's emergency contact.
 *
 * Theirs to maintain, and it is not shown on the manager employee page — HR can
 * technically read the row, dispatch cannot see it at all, and it never enters
 * the audit trail.
 */
export function EmergencyContactForm({ contact }: { contact: EmergencyContactRow | null }) {
  const t = useTranslations("profile");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(contact?.name ?? "");
  const [relationship, setRelationship] = useState(contact?.relationship ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [notice, setNotice] = useState<Notice>(null);

  function submit() {
    setNotice(null);
    startTransition(async () => {
      const result = await saveOwnEmergencyContact({
        contactId: contact?.id,
        name: name.trim(),
        relationship: relationship.trim() || null,
        phone: phone.trim(),
        phone_alt: null,
      });
      setNotice(
        result.ok
          ? { text: t("saved"), tone: "success" }
          : { text: t("errorGeneric"), tone: "error" }
      );
      if (result.ok) router.refresh();
    });
  }

  function remove() {
    if (!contact) return;
    startTransition(async () => {
      const result = await deleteOwnEmergencyContact({ contactId: contact.id });
      if (result.ok) {
        setName("");
        setRelationship("");
        setPhone("");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ec_name" className="text-xs">
            {t("fieldContactName")}
          </Label>
          <Input id="ec_name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ec_rel" className="text-xs">
            {t("fieldRelationship")}
          </Label>
          <Input
            id="ec_rel"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ec_phone" className="text-xs">
            {t("fieldPhone")}
          </Label>
          <Input id="ec_phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <NoticeLine notice={notice} />
        <div className="flex gap-2">
          {contact && (
            <Button size="sm" variant="outline" onClick={remove} disabled={isPending}>
              {t("remove")}
            </Button>
          )}
          <Button size="sm" onClick={submit} disabled={isPending || !name.trim() || !phone.trim()}>
            {t("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export type AvailabilityRow = {
  id: string;
  weekday: number | null;
  start_time: string | null;
  end_time: string | null;
  type: string;
};

/**
 * Recurring weekly availability.
 *
 * Only an `unavailable` rule actually keeps someone off a candidate list; the
 * others record a preference a human reads. And none of it touches a shift
 * already accepted — the page says so, because that is the question people
 * actually have when they add one.
 */
export function AvailabilityEditor({ rows }: { rows: AvailabilityRow[] }) {
  const t = useTranslations("profile");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [weekday, setWeekday] = useState<string>("1");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [type, setType] = useState<string>("unavailable");
  const [notice, setNotice] = useState<Notice>(null);

  function add() {
    setNotice(null);
    startTransition(async () => {
      const result = await addOwnAvailability({
        weekday: weekday === "any" ? null : Number(weekday),
        start_time: start || null,
        end_time: end || null,
        type: type as (typeof AVAILABILITY_TYPES)[number],
      });
      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      if (result.data.kind === "refused") {
        setNotice({ text: t(`refused_${result.data.reason}`), tone: "error" });
        return;
      }
      setStart("");
      setEnd("");
      setNotice({ text: t("saved"), tone: "success" });
      router.refresh();
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const result = await removeOwnAvailability({ availabilityId: id });
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">{t("availabilityHint")}</p>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noAvailability")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <Badge variant={row.type === "unavailable" ? "secondary" : "success"}>
                  {t(`availability_${row.type}`)}
                </Badge>
                <span className="text-xs tabular-nums">
                  {row.weekday === null
                    ? t("everyDay")
                    : t(`weekday_${WEEKDAY_KEYS[row.weekday]}`)}
                  {row.start_time ? ` · ${row.start_time.slice(0, 5)}` : ""}
                  {row.end_time ? `–${row.end_time.slice(0, 5)}` : ""}
                </span>
              </span>
              <Button size="sm" variant="outline" onClick={() => remove(row.id)} disabled={isPending}>
                {t("remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="av_day" className="text-xs">
            {t("fieldWeekday")}
          </Label>
          <select
            id="av_day"
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
          >
            <option value="any">{t("everyDay")}</option>
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {t(`weekday_${WEEKDAY_KEYS[day]}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="av_type" className="text-xs">
            {t("fieldAvailabilityType")}
          </Label>
          <select
            id="av_type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
          >
            {AVAILABILITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`availability_${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="av_start" className="text-xs">
            {t("fieldFrom")}
          </Label>
          <Input
            id="av_start"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="av_end" className="text-xs">
            {t("fieldTo")}
          </Label>
          <Input id="av_end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <Button size="sm" variant="outline" onClick={add} disabled={isPending}>
          {t("add")}
        </Button>
      </div>

      <NoticeLine notice={notice} />
    </div>
  );
}
