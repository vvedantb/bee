// The island body as a teleprompter: new lines scroll into view until the user scrolls up. Decisions live in island.ts.
import { keepFollowing } from "./island";
import { motionReduced } from "./motion";

/**
 * Ref callback for a scroll container whose first child holds the content. Each time the content or the container
 * changes size, it scrolls to the bottom (instantly with reduced motion) unless the user has scrolled up.
 */
export function followBottom(node: HTMLElement | null): (() => void) | undefined {
  // React 19 runs the returned cleanup instead of calling again with null.
  if (!node) return undefined;
  let following = true;
  let lastTop = node.scrollTop;
  const onScroll = () => {
    following = keepFollowing(following, lastTop, node);
    lastTop = node.scrollTop;
  };
  const resize = new ResizeObserver(() => {
    if (following) node.scrollTo({ top: node.scrollHeight, behavior: motionReduced() ? "instant" : "smooth" });
  });
  resize.observe(node);
  if (node.firstElementChild) resize.observe(node.firstElementChild);
  node.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    resize.disconnect();
    node.removeEventListener("scroll", onScroll);
  };
}
