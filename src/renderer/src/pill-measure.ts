// The compact pill's width comes from its header's content (core/overlay-size.ts). Shared by App.tsx and the screenshot pages.

/**
 * The header's natural width in CSS px: laid out as max-content for one read, then restored before anything paints. The
 * status text counts at most its CSS cap (.notch-status-text), so a long status truncates instead of widening the pill.
 */
export function naturalWidth(header: HTMLElement): number {
  const width = header.style.width;
  header.style.width = "max-content";
  const natural = header.getBoundingClientRect().width;
  header.style.width = width;
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
