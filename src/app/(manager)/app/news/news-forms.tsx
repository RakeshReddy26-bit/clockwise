"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { publishAnnouncement, setAnnouncementPublished } from "./actions";

/**
 * Write an announcement, or take one down.
 *
 * Both controls report their outcome inline rather than navigating: publishing
 * is the kind of thing somebody does twice if the first click looked like it
 * did nothing.
 */

export function NewsComposer() {
  const t = useTranslations("news");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  function submit(formData: FormData, draft: boolean) {
    setNotice(null);
    startTransition(async () => {
      const result = await publishAnnouncement({
        title: String(formData.get("title") ?? ""),
        body: String(formData.get("body") ?? ""),
        category: String(formData.get("category") ?? "") || undefined,
        draft,
      });
      if (!result.ok || result.data.kind === "refused") {
        setNotice({ text: t("saveFailed"), tone: "error" });
        return;
      }
      setNotice({ text: t(draft ? "savedDraft" : "savedPublished"), tone: "success" });
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t("newPost")}
        </Button>
        {notice && (
          <p
            role="status"
            className={`text-xs ${notice.tone === "success" ? "text-success" : "text-destructive"}`}
          >
            {notice.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      action={(formData) => submit(formData, false)}
      className="flex flex-col gap-3 rounded-lg border bg-card p-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="news-title">{t("fieldTitle")}</Label>
        <Input id="news-title" name="title" required maxLength={200} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="news-category">{t("fieldCategory")}</Label>
        <Input id="news-category" name="category" maxLength={60} placeholder={t("categoryHint")} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="news-body">{t("fieldBody")}</Label>
        <textarea
          id="news-body"
          name="body"
          required
          rows={5}
          maxLength={4000}
          className="rounded-md border border-input bg-background p-2 text-sm"
        />
      </div>

      {notice && (
        <p
          role="alert"
          className={`text-xs ${notice.tone === "success" ? "text-success" : "text-destructive"}`}
        >
          {notice.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {t("publish")}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={isPending}
          formAction={(formData) => submit(formData, true)}
        >
          {t("saveDraft")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

export function PublishToggle({ postId, published }: { postId: string; published: boolean }) {
  const t = useTranslations("news");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function toggle() {
    setError(false);
    startTransition(async () => {
      const result = await setAnnouncementPublished({ postId, published: !published });
      if (!result.ok || result.data.kind === "refused") {
        setError(true);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={toggle} disabled={isPending}>
        {t(published ? "unpublish" : "publish")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t("saveFailed")}
        </p>
      )}
    </div>
  );
}
