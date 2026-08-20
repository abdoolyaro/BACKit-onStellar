"use client";

import { useEffect, useState } from "react";

/**
 * Whether the user has asked for reduced motion.
 *
 * Returns `false` during server rendering and on the first client paint, so
 * markup matches between the two; the real value arrives after mount. That
 * ordering matters more than it looks: reading `matchMedia` during render would
 * produce a hydration mismatch on every machine whose preference differs from
 * the server's assumption.
 */
export function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(query.matches);

    const onChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    // `addEventListener` is unavailable on MediaQueryList in older Safari.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return prefersReducedMotion;
}
