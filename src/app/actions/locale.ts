"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { locale as localeSchema } from "@/lib/validation";

export async function setLocale(formData: FormData) {
  const parsed = localeSchema.safeParse(formData.get("locale"));
  if (!parsed.success) return;

  const store = await cookies();
  store.set("locale", parsed.data, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}
