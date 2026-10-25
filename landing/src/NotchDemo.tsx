import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconFileText, IconMicrophone } from "@tabler/icons-react";
import { notchLine } from "./content";

type State = "idle" | "listening" | "thinking" | "tip" | "expanded";

const steps: readonly (readonly [State, number])[] = [
  ["idle", 1400],
  ["listening", 3200],
  ["thinking", 1400],
  ["tip", 3000],
  ["expanded", 4200],
];

const words = notchLine.split(" ");

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduce;
}

/**
 * Bee during a call: idle, listening, thinking, tip, expanded. Loops while on screen.
 * Reduced motion shows the tip state and does not loop. Click toggles the panel.
 */
export function NotchDemo() {
  const reduce = usePrefersReducedMotion();
  const [state, setState] = useState<State>("tip");
  const [spoken, setSpoken] = useState(words.length);
  const stage = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const idx = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const stream = useRef<number | undefined>(undefined);

  const stop = () => {
    window.clearTimeout(timer.current);
    window.clearInterval(stream.current);
  };

  const run = () => {
    const step = steps[idx.current];
    if (!step) return;
    const [next, ms] = step;
    setState(next);
    window.clearInterval(stream.current);
    if (next === "idle") setSpoken(0);
    if (next === "listening") {
      let n = 0;
      setSpoken(0);
      stream.current = window.setInterval(() => {
        n += 1;
        setSpoken(n);
        if (n >= words.length) window.clearInterval(stream.current);
      }, 480);
    }
    if (next === "thinking" || next === "tip" || next === "expanded") setSpoken(words.length);
    timer.current = window.setTimeout(() => {
      idx.current = (idx.current + 1) % steps.length;
      run();
    }, ms);
  };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e?.isIntersecting ?? false), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduce) {
      stop();
      setState("tip");
      setSpoken(words.length);
      return;
    }
    if (visible) {
      idx.current = 0;
      run();
    } else {
      stop();
    }
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce, visible]);

  const toggle = () => {
    if (reduce) {
      setState((s) => (s === "expanded" ? "tip" : "expanded"));
      return;
    }
    stop();
    idx.current = state === "expanded" ? 0 : 4;
    run();
  };

  return (
    <div className="relative mx-auto w-full max-w-[52rem] px-5 pb-16 sm:px-8 sm:pb-20 lg:px-10">
      <figure
        ref={stage}
        className="bee-stage m-0"
        aria-label="Bee during a call: the notch at the top centre listens, then shows a short tip and opens to two tips and a note"
      >
        <div className="bee-screen" aria-hidden="true">
          <div className="bee-call">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} />
            ))}
          </div>

          <div
            className="bee"
            data-state={state}
            role="button"
            tabIndex={0}
            aria-hidden="false"
            aria-label="Toggle the Bee tips panel"
            aria-expanded={state === "expanded"}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            }}
          >
            <div className="bee-notch">
              <span className="bee-notch-mic">
                <IconMicrophone size={14} stroke={2} />
              </span>
              <span className="bee-notch-body">
                <span className="bee-n-idle">Bee</span>
                <span className="bee-n-listen">
                  {Array.from({ length: 7 }, (_, i) => (
                    <i key={i} className="bee-level" />
                  ))}
                </span>
                <span className="bee-n-think">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="bee-n-tip">
                  <span>SSO ships in Q4</span>
                </span>
              </span>
              <IconChevronDown className="bee-notch-chev" size={14} stroke={2} />
            </div>

            <div className="bee-panel-clip">
              <div>
                <div className="bee-panel">
                  <div className="bee-tabs">
                    <span className="bee-tab bee-tab-on">Live</span>
                    <span className="bee-tab">Settings</span>
                    <span className="bee-avatar" />
                  </div>

                  <p className="bee-panel-label">Tips</p>
                  <div className="bee-tip">
                    <span className="bee-tip-mark" />
                    <span className="bee-tip-text">
                      SSO ships in Q4
                      <span className="bee-tip-src">Q4 roadmap.md</span>
                    </span>
                  </div>
                  <div className="bee-tip">
                    <span className="bee-tip-mark" />
                    <span className="bee-bars">
                      <span className="bee-bar" style={{ width: "80%" }} />
                      <span className="bee-bar" style={{ width: "45%" }} />
                    </span>
                  </div>

                  <p className="bee-panel-label">Notes</p>
                  <div className="bee-note">
                    <span className="bee-note-icon">
                      <IconFileText size={13} stroke={2} />
                    </span>
                    <span>
                      <span className="bee-note-title">Q4 roadmap</span>
                      <span className="bee-note-meta">Markdown note</span>
                    </span>
                  </div>

                  <div className="bee-panel-foot">
                    <span className="bee-fake-btn">End meeting &amp; save summary</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bee-caption" data-hidden={state === "idle"}>
            <span>{words.slice(0, spoken).join(" ")}</span>
          </div>
        </div>
      </figure>
    </div>
  );
}
