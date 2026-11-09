import { Button } from "@vvedantb/ui";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { statusClick } from "./island-click";
import { NotchStatus } from "./NotchStatus";

// The UI package does not load under node; a stub Button is enough to compare element types.
vi.mock("@vvedantb/ui", () => ({ Button: function Button() {} }));

type Props = { title?: string; tabIndex?: number; "aria-disabled"?: boolean; onClick?: () => void; children?: unknown };

/** The element NotchStatus renders for this status, with the panel open or closed. */
function render(status: string, panelOpen: boolean, onOpen = vi.fn()): ReactElement<Props> {
  const click = statusClick({ kind: "idle", panelOpen, bodyShown: false, answerFolded: false });
  const el = NotchStatus({ status, click, error: false, onOpen });
  if (!isValidElement<Props>(el)) throw new Error("not an element");
  return el;
}

describe("NotchStatus", () => {
  it("renders the same element type with the panel open or closed, so toggling does not remount it", () => {
    const closed = render("Listening…", false);
    const open = render("Listening…", true);
    expect(closed.type).toBe(Button);
    expect(open.type).toBe(closed.type);
    expect(open.props.children).toStrictEqual(closed.props.children);
  });

  it("is clickable with the panel closed and inert with it open", () => {
    const onOpen = vi.fn();
    const closed = render("Listening…", false, onOpen);
    closed.props.onClick?.();
    expect(onOpen).toHaveBeenCalledWith("panel");
    expect(closed.props.tabIndex).toBeUndefined();

    const open = render("Listening…", true);
    expect(open.props.onClick).toBeUndefined();
    expect(open.props.tabIndex).toBe(-1);
    expect(open.props["aria-disabled"]).toBe(true);
  });
});
