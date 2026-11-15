import Link from "next/link";
import { ArrowLeft, Link2 } from "lucide-react";
import { addManualListing } from "@/app/actions";
import { AppShell } from "@/app/_components/app-shell";
import { requireWorkspace } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function AddListingPage() {
  const { displayName } = await requireWorkspace();
  return <AppShell userName={displayName} active="/oferty">
    <div className="page-heading"><div><Link className="panel-link" href="/oferty"><ArrowLeft size={13} /> Wróć do ofert</Link><p className="eyebrow" style={{ marginTop: 17 }}>ZAPISZ LINK DO SPRAWDZENIA</p><h1>Dodaj ofertę</h1><p className="page-subtitle">Serwer zapisze link i podane przez Ciebie informacje. Nie pobiera dowolnych adresów.</p></div></div>
    <section className="detail-card" style={{ maxWidth: 720 }}>
      <form action={addManualListing} className="stack-form">
        <label>Link do ogłoszenia<input className="field" type="url" name="url" required placeholder="https://…" /></label>
        <div className="form-grid"><label>Tytuł<input className="field" name="title" maxLength={500} placeholder="Opcjonalnie" /></label><label>Miasto<input className="field" name="city" maxLength={160} placeholder="np. Katowice" /></label></div>
        <div className="form-grid"><label>Dzielnica<input className="field" name="district" maxLength={160} placeholder="Opcjonalnie" /></label><label>Cena (zł)<input className="field" name="price" inputMode="numeric" type="number" min="1" placeholder="Opcjonalnie" /></label></div>
        <div className="form-grid"><label>Powierzchnia (m²)<input className="field" name="area" inputMode="decimal" type="number" min="0.1" step="0.01" placeholder="Opcjonalnie" /></label><label>Liczba pokoi<input className="field" name="rooms" inputMode="numeric" type="number" min="1" step="1" placeholder="Opcjonalnie" /></label></div>
        <div className="disclaimer"><Link2 size={13} style={{ verticalAlign: "-2px" }} /> Ręczny wpis nie uruchamia pobierania strony ani nie próbuje omijać ograniczeń portalu. Link jest ograniczony do rozpoznanych domen ogłoszeniowych.</div>
        <button className="button-primary" type="submit">Zapisz do listy</button>
      </form>
    </section>
  </AppShell>;
}
