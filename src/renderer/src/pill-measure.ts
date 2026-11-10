// The compact pill's width comes from its header's content (core/overlay-size.ts). Shared by App.tsx and the screenshot pages.

/**
 * The header's natural width in CSS px, read from a hidden max-content copy beside it that is gone before anything paints, so
 * the live header never changes and a measure can never show. The status text counts at most its CSS cap
 * (.notch-status-text), so a long status truncates instead of widening the pill.
 */
export function naturalWidth(header: HTMLElement): number {
  const probe = header.cloneNode(true);
  if (!(probe instanceof HTMLElement) || !header.parentElement) return header.getBoundingClientRect().width;
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position: absolute; top: 0; left: 0; width: max-content; visibility: hidden; pointer-events: none";
  header.parentElement.append(probe);
  const natural = probe.getBoundingClientRect().width;
  probe.remove();
  return natural;
}

/**
 * Ref callback body: reports the header's natural width now, once the webfont is in, and after every content change (status
 * text, a button shown or hidden). The returned function stops watching.
 */
export function watchNaturalWidth(header: HTMLElement, report: (natural: number) => void): () => void {
  const measure = () => {
    if (header.isConnected) report(naturalWidth(header));
  };
  const mutations = new MutationObserver(measure);
  mutations.observe(header, { childList: true, subtree: true, characterData: true });
  void document.fonts.ready.then(measure);
  measure();
  return () => mutations.disconnect();
}
