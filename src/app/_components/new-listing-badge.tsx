"use client";

import { useEffect, useState } from "react";

export function NewListingBadge({ firstSeenAt }: { firstSeenAt: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const age = now == null ? null : now - new Date(firstSeenAt).getTime();
  return age != null && age >= 0 && age < 48 * 60 * 60 * 1000
    ? <span className="badge badge-new">Nowa w bazie</span>
    : null;
}
