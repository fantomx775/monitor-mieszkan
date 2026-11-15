import { ListingListPage } from "@/app/_components/listing-list-page";

export const dynamic = "force-dynamic";

export default async function ListingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  return <ListingListPage params={params} />;
}
