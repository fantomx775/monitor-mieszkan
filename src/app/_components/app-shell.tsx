import Link from "next/link";
import { ArrowUpRight, Building2, Heart, Home, LogOut, Radio, Search } from "lucide-react";
import { signOut } from "@/app/actions";

const items = [
  { href: "/", label: "Przegląd", icon: Home },
  { href: "/oferty", label: "Oferty", icon: Building2 },
  { href: "/ulubione", label: "Ulubione", icon: Heart },
  { href: "/do-kontaktu", label: "Do kontaktu", icon: ArrowUpRight },
  { href: "/wyszukiwania", label: "Wyszukiwania", icon: Search },
  { href: "/zrodla", label: "Źródła i synchronizacje", icon: Radio },
];

export function AppShell({ children, userName, active }: { children: React.ReactNode; userName: string; active?: string }) {
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Nocny Monitor — przegląd">
          <span className="brand-mark"><Building2 size={19} strokeWidth={1.8} /></span>
          <span><strong>Nocny Monitor</strong><small>nieruchomości</small></span>
        </Link>
        <div className="workspace-label"><span className="status-dot" /> PRYWATNY WORKSPACE</div>
        <nav className="side-nav" aria-label="Główna nawigacja">
          {items.map(({ href, label, icon: Icon }) => (
            <Link className={`nav-link ${active === href ? "active" : ""}`} href={href} key={href}>
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-note"><span className="lock-dot" /> Prywatny panel zakupowy</div>
          <div className="user-row">
            <div className="avatar" aria-hidden="true">{userName.slice(0, 1).toLocaleUpperCase("pl-PL")}</div>
            <div className="user-copy"><strong>{userName}</strong><small>konto lokalne</small></div>
            <form action={signOut}><button className="icon-button" aria-label="Wyloguj" title="Wyloguj"><LogOut size={17} /></button></form>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span className="topbar-kicker">MONITORING ZAKUPÓW</span>
          <div className="topbar-right"><span className="online-pill"><i /> Lokalna baza</span><Link href="/dodaj" className="topbar-add"><span>+</span> Dodaj link</Link></div>
        </header>
        <main className="page-content">{children}</main>
        <footer className="footer-note">Prywatna lista zakupowa <span>·</span> Dane ofert pozostają w Twojej lokalnej bazie</footer>
      </div>
    </div>
  );
}
