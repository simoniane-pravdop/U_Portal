"use client";

import { Children, cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuPosition } from "../lib/menu-position";

/** A body-level layer: card overflow, sticky sections and parent stacking cannot cover it. */
export function CardActionsMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const menu = panel.current;
    if (!button || !menu) return;
    const position = () => {
      const anchor = button.getBoundingClientRect();
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) { setOpen(false); return; }
      if (window.matchMedia("(max-width: 600px)").matches) {
        menu.style.removeProperty("left");
        menu.style.removeProperty("top");
      } else {
        const rect = menu.getBoundingClientRect();
        const point = menuPosition(anchor, rect, { width: window.innerWidth, height: window.innerHeight });
        menu.style.left = `${point.left}px`;
        menu.style.top = `${point.top}px`;
      }
    };
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !button.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); button.focus({ preventScroll: true }); }
    };
    const scroll = (event: Event) => { if (event.target !== menu) position(); };
    position();
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);

  const actions = Children.map(children, (child) => {
    if (!isValidElement<{ onClick?: MouseEventHandler<HTMLButtonElement> }>(child) || child.type !== "button") return child;
    return cloneElement(child, { onClick: (event) => {
      child.props.onClick?.(event);
      setOpen(false);
    } });
  });

  return <>
    <button ref={trigger} className="work-card-menu-trigger" aria-label="Інші дії з карткою" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>⋮ Дії</button>
    {open && createPortal(<div ref={panel} id={id} className="work-card-actions-popover" role="group" aria-label="Дії з карткою">{actions}</div>, document.body)}
  </>;
}
