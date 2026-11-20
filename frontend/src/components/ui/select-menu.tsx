"use client";

/**
 * SelectMenu — a div-based dropdown that replaces native <select>.
 *
 * Native <select> renders its dropdown panel via the OS, so dark-themed
 * apps get a white panel on Windows / Linux that is unreadable. This
 * component renders the panel itself with Tailwind tokens (bg-popover,
 * border-input, accent on hover) so the result is identical on every OS.
 *
 * Keyboard: Space/Enter to open, ArrowUp/Down to navigate, Enter to
 * select, Escape to close. Click-outside closes too.
 */

import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export interface SelectMenuOption {
  /** Stable identifier persisted as the chosen value. */
  value: string;
  /** Primary line shown in the trigger and the menu row. */
  label: string;
  /** Optional muted sub-line shown after the label in the menu. */
  hint?: string;
  /** Optional grouping/category label rendered above the row. */
  group?: string;
  /** If true, the row is rendered but cannot be picked. */
  disabled?: boolean;
}

interface SelectMenuProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectMenuOption[];
  /** Shown when no option matches `value`. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Inline-rendered just below the menu items; useful for explanatory text. */
  footer?: React.ReactNode;
  id?: string;
}

export function SelectMenu({
  value,
  onValueChange,
  options,
  placeholder = "",
  disabled = false,
  className,
  footer,
  id,
}: SelectMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value && !o.disabled),
    ),
  );
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const itemRefs = React.useRef<Array<HTMLLIElement | null>>([]);

  const selected = options.find((o) => o.value === value);
  const enabledIndices = React.useMemo(
    () =>
      options
        .map((o, i) => (!o.disabled ? i : -1))
        .filter((i) => i >= 0),
    [options],
  );

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, [open]);

  // When opening, focus the menu and snap activeIndex to the current value.
  React.useEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.value === value && !o.disabled);
    if (i >= 0) setActiveIndex(i);
    // Defer focus until after layout so scrollIntoView works.
    requestAnimationFrame(() => {
      listRef.current?.focus();
      itemRefs.current[Math.max(0, i)]?.scrollIntoView({ block: "nearest" });
    });
  }, [open, options, value]);

  const move = (dir: 1 | -1) => {
    if (enabledIndices.length === 0) return;
    const pos = enabledIndices.indexOf(activeIndex);
    const nextPos =
      pos === -1
        ? 0
        : (pos + dir + enabledIndices.length) % enabledIndices.length;
    const next = enabledIndices[nextPos];
    setActiveIndex(next);
    itemRefs.current[next]?.scrollIntoView({ block: "nearest" });
  };

  const commit = (i: number) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    onValueChange(opt.value);
    setOpen(false);
  };

  // Render options with optional group headings.
  const rendered: React.ReactNode[] = [];
  let lastGroup: string | undefined;
  options.forEach((opt, i) => {
    if (opt.group && opt.group !== lastGroup) {
      rendered.push(
        <li
          key={`g-${opt.group}-${i}`}
          className="pointer-events-none px-2 pt-2 pb-1 text-muted-foreground text-xs uppercase tracking-wide"
        >
          {opt.group}
        </li>,
      );
      lastGroup = opt.group;
    }
    const isSelected = opt.value === value;
    const isActive = i === activeIndex && !opt.disabled;
    rendered.push(
      <li
        key={opt.value}
        ref={(el) => {
          itemRefs.current[i] = el;
        }}
        role="option"
        aria-selected={isSelected}
        aria-disabled={opt.disabled || undefined}
        onPointerEnter={() => !opt.disabled && setActiveIndex(i)}
        onClick={() => commit(i)}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
          opt.disabled && "cursor-not-allowed opacity-50",
          !opt.disabled &&
            isActive &&
            "bg-accent text-accent-foreground",
        )}
      >
        <Check
          className={cn(
            "h-4 w-4 shrink-0",
            isSelected ? "opacity-100" : "opacity-0",
          )}
        />
        <span className="min-w-0 flex-1 truncate">
          {opt.label}
          {opt.hint ? (
            <span className="ml-1 text-muted-foreground text-xs">
              — {opt.hint}
            </span>
          ) : null}
        </span>
      </li>,
    );
  });

  return (
    <div ref={rootRef} className={cn("relative w-full", className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) setOpen(true);
            else move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!open) setOpen(true);
            else commit(activeIndex);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-sm",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <ul
          ref={listRef}
          tabIndex={-1}
          role="listbox"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(activeIndex);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className={cn(
            "absolute left-0 right-0 top-[calc(100%+4px)] z-50",
            "max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
            "focus-visible:outline-none",
          )}
        >
          {rendered}
          {footer ? (
            <li className="pointer-events-none border-border/40 border-t px-2 pt-2 pb-1 text-muted-foreground text-xs">
              {footer}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
