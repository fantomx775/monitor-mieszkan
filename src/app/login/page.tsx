import { Building2, LockKeyhole } from "lucide-react";
import { signIn } from "@/app/actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const params = await searchParams;
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand"><span className="brand-mark"><Building2 size={19} /></span><span><strong>Nocny Monitor</strong><small>nieruchomości</small></span></div>
        <p className="eyebrow">PRYWATNA PRZESTRZEŃ</p>
        <h1 id="login-title">Zaloguj się</h1>
        <p className="page-subtitle">Dostęp ma wyłącznie zaproszone konto w lokalnym workspace.</p>
        <form className="login-form" action={signIn}>
          <input type="hidden" name="next" value={params.next ?? "/"} />
          <label>Adres e-mail<input className="field" type="email" name="email" autoComplete="username" required /></label>
          <label>Hasło<input className="field" type="password" name="password" autoComplete="current-password" required /></label>
          <button className="button-primary" type="submit"><LockKeyhole size={14} /> Zaloguj do panelu</button>
        </form>
        {params.error && <div className="login-error" role="alert">Nie udało się zalogować. Sprawdź dane i członkostwo workspace.</div>}
        <p className="login-footnote">Publiczna rejestracja jest wyłączona. Konto lokalne tworzy skrypt <code>pnpm demo:seed</code>.</p>
      </section>
    </main>
  );
}
