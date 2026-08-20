import { getTranslations } from "next-intl/server";
import { ComingSoon } from "@/components/coming-soon";

export default async function Page() {
  const t = await getTranslations("employeeNav");
  return <ComingSoon title={t("time")} />;
}
