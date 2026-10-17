import { IconWorld } from "@tabler/icons-react";
import { useEffect, useState } from "react";

// Icons come from main as data URLs (the CSP allows no remote images). Remembered per domain for this window.
const known = new Map<string, string | null>();

/** A site's icon. A globe shows first and when there is none, so chips never wait on it. */
export function Favicon({ domain }: { domain: string }) {
  const [icon, setIcon] = useState<string | null>(known.get(domain) ?? null);
  useEffect(() => {
    let live = true;
    if (known.has(domain)) {
      setIcon(known.get(domain) ?? null);
      return;
    }
    window.bee
      .getFavicon(domain)
      .catch(() => null)
      .then((dataUrl) => {
        known.set(domain, dataUrl);
        if (live) setIcon(dataUrl);
      });
    return () => {
      live = false;
    };
  }, [domain]);
  return icon ? <img className="favicon" src={icon} alt="" width={14} height={14} /> : <IconWorld size={14} stroke={1.75} aria-hidden />;
}
