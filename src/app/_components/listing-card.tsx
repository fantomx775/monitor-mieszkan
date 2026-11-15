import Link from "next/link";
import { ArrowUpRight, BedDouble, Heart, MapPin, Ruler } from "lucide-react";
import { toggleFavorite } from "@/app/actions";
import { NewListingBadge } from "@/app/_components/new-listing-badge";
import { dateTime, pln, reviewLabels, sourceLabels, type ListingRow, type ListingState } from "@/lib/data";

export function ListingCard({ listing, state, priceDrop, duplicateSourceCount }: { listing: ListingRow; state?: ListingState; priceDrop?: boolean; duplicateSourceCount?: number }) {
  const duplicateSourceLabel = duplicateSourceCount === 2 ? "źródła" : "źródeł";
  return (
    <article className="listing-card">
      <Link href={`/oferty/${listing.id}`} className="listing-image" aria-label={`Szczegóły: ${listing.title || "mieszkanie na sprzedaż"}`}>
        <span className="image-icon">⌂</span>
        <span className="image-caption">PODGLĄD OFERTY</span>
        <span className="image-source">{sourceLabels[listing.source_key] ?? listing.source_key}</span>
      </Link>
      <div className="listing-main">
        <div className="listing-topline">
          <div className="listing-badges">
            {priceDrop && <span className="badge badge-drop">Cena ↓</span>}
            <NewListingBadge firstSeenAt={listing.first_seen_at} />
            {duplicateSourceCount && duplicateSourceCount > 1 && <span className="badge badge-muted" aria-label={`Możliwy duplikat, ${duplicateSourceCount} ${duplicateSourceLabel}`} title="Podobna oferta z innego portalu; nie scalono rekordów">Możliwy duplikat · {duplicateSourceCount} {duplicateSourceLabel}</span>}
            {state?.review_status === "to_review" && <span className="badge badge-muted">Nieprzejrzana</span>}
            {listing.life_cycle !== "active" && <span className="badge badge-muted">{listing.life_cycle === "potentially_stale" ? "Niepotwierdzona" : "Archiwalna"}</span>}
          </div>
          <form action={toggleFavorite.bind(null, listing.id)}>
            <button className={`favorite-button ${state?.favorite ? "is-favorite" : ""}`} aria-label={state?.favorite ? "Usuń z ulubionych" : "Dodaj do ulubionych"} title={state?.favorite ? "Usuń z ulubionych" : "Dodaj do ulubionych"}>
              <Heart size={18} fill={state?.favorite ? "currentColor" : "none"} />
            </button>
          </form>
        </div>
        <Link className="listing-title" href={`/oferty/${listing.id}`}>{listing.title || "Mieszkanie na sprzedaż"}</Link>
        <div className="listing-location"><MapPin size={14} /> <span>{[listing.district, listing.city].filter(Boolean).join(", ") || "Lokalizacja do uzupełnienia"}</span></div>
        <div className="listing-facts">
          <span><Ruler size={15} /> {listing.area_m2 == null ? "— m²" : `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(listing.area_m2)} m²`}</span>
          <span><BedDouble size={15} /> {listing.rooms == null ? "— pok." : `${listing.rooms} pok.`}</span>
          <span>{listing.market === "primary" ? "Pierwotny" : listing.market === "secondary" ? "Wtórny" : "Rynek nieznany"}</span>
        </div>
        <div className="listing-bottom">
          <div><strong className="listing-price">{pln(listing.price_pln)}</strong>{listing.price_pln && listing.area_m2 ? <small>{new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(listing.price_pln / listing.area_m2)} zł / m²</small> : <small>{reviewLabels[state?.review_status ?? "to_review"]}</small>}</div>
          <a className="original-link" href={listing.canonical_url} target="_blank" rel="noreferrer">Oryginał <ArrowUpRight size={14} /></a>
        </div>
        <div className="listing-meta">Wykryto {dateTime(listing.first_seen_at)} <span>·</span> widziano {dateTime(listing.last_seen_at)}</div>
      </div>
    </article>
  );
}
