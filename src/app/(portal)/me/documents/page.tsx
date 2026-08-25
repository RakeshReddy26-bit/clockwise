import { getTranslations } from "next-intl/server";
import { ComingSoon } from "@/components/coming-soon";

export default async function Page() {
  const t = await getTranslations("employeeNav");
  const tp = await getTranslations("planned");
  return <ComingSoon title={t("documents")} note={tp("meDocuments")} backHref="/me" />;
}
