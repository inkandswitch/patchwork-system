import { For, Show, createSignal, createMemo, createEffect } from "solid-js";
import type { HistoryItem as HistoryItemType } from "../../types";
import { formatTimeOnly, getChangeLabel, type ChangeSizeThresholds } from "../utils";
import { TimelineCard } from "./TimelineCard";

export interface HistoryItemProps {
  item: HistoryItemType;
  isSelected: boolean;
  thresholds: ChangeSizeThresholds;
  onClick: (e: MouseEvent) => void;
  onRename: (label: string) => void;
  onSubItemClick?: (item: HistoryItemType, e: MouseEvent) => void;
  isSubItemSelected?: (item: HistoryItemType) => boolean;
}

function authorColor(authorId: string): string {
  let hash = 0;
  for (let i = 0; i < authorId.length; i++) {
    hash = authorId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 63%)`;
}

function getInitials(authorId: string): string {
  const parts = authorId.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (authorId.includes("@")) {
    return authorId.split("@")[0].slice(0, 2).toUpperCase();
  }
  return authorId.slice(0, 2).toUpperCase();
}

function barWidth(value: number, large: number): number {
  if (value === 0) return 0;
  return Math.max(2, Math.min(60, (value / Math.max(large, value)) * 60));
}

export function HistoryItem(props: HistoryItemProps) {
  const timeDisplay = () => formatTimeOnly(props.item.endTime);
  const additions = () => props.item.additions ?? 0;
  const deletions = () => props.item.deletions ?? 0;
  const label = () => props.item.customLabel ?? getChangeLabel(props.item, props.thresholds);
  const authors = () => props.item.authors ?? [];
  const visibleAuthors = () => authors().slice(0, 3);
  const extraAuthors = () => Math.max(0, authors().length - 3);
  const subItems = () => props.item.subItems ?? [];

  const [isEditing, setIsEditing] = createSignal(false);
  const [editValue, setEditValue] = createSignal("");

  const [isOpen, setIsOpen] = createSignal(false);
  const isMultiAuthorWithSubItems = () => authors().length > 1 && subItems().length > 0;
  const isExpanded = createMemo(() => isOpen() && isMultiAuthorWithSubItems());

  const anySubItemSelected = createMemo(() =>
    subItems().some((si) => props.isSubItemSelected?.(si) ?? false)
  );

  // Auto-collapse when neither the parent nor any sub-item is selected
  createEffect(() => {
    if (!props.isSelected && !anySubItemSelected()) setIsOpen(false);
  });

  const startEdit = (e: MouseEvent) => {
    e.stopPropagation();
    setEditValue(label());
    setIsEditing(true);
  };

  const commitEdit = () => {
    const trimmed = editValue().trim();
    if (trimmed !== label()) {
      props.onRename(trimmed);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
    if (e.key === "Escape") { setIsEditing(false); }
  };

  const handleParentClick = (e: MouseEvent) => {
    if (isMultiAuthorWithSubItems()) setIsOpen((v) => !v);
    props.onClick(e);
  };

  return (
    <div>
      <TimelineCard isSelected={props.isSelected} onClick={handleParentClick}>
        <div style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
          <div style={{ display: "flex", "align-items": "center", "flex-shrink": "0" }}>
            <For each={visibleAuthors()}>
              {(author, i) => (
                <div
                  title={author}
                  style={{
                    background: authorColor(author),
                    "margin-left": i() === 0 ? "0" : "-4px",
                    "z-index": visibleAuthors().length - i(),
                    "font-size": "9px",
                    position: "relative",
                    width: "18px",
                    height: "18px",
                    "border-radius": "50%",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    color: "white",
                    "font-weight": "300",
                    "user-select": "none",
                    "flex-shrink": "0",
                  }}
                >
                  {getInitials(author)}
                </div>
              )}
            </For>
            <Show when={extraAuthors() > 0}>
              <div
                style={{
                  "margin-left": "-4px",
                  "font-size": "7px",
                  width: "18px",
                  height: "18px",
                  "border-radius": "50%",
                  background: "var(--history-muted-fg)",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  color: "white",
                  position: "relative",
                  "flex-shrink": "0",
                }}
              >
                +{extraAuthors()}
              </div>
            </Show>
          </div>

          <Show
            when={isEditing()}
            fallback={
              <>
                <div
                  style={{ display: "flex", "align-items": "center", gap: "0.25rem", cursor: "var(--studio-cursor-text, text)", "min-width": "0", overflow: "hidden", "flex-shrink": "1" }}
                  onDblClick={startEdit}
                  title="Double-click to rename"
                >
                  <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--history-secondary-fg)" }}>
                    <Show
                      when={props.item.isVirtual && !props.item.customLabel}
                      fallback={label()}
                    >
                      <em>Making changes...</em>
                    </Show>
                  </span>
                  <svg
                    style={{ "flex-shrink": "0", width: "12px", height: "12px", opacity: "0", cursor: "var(--studio-cursor-pointer, pointer)", color: "inherit", transition: "opacity max(1ms, calc(0.15s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1)))" }}
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-label="Edit label"
                    onClick={startEdit}
                  >
                    <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Z" />
                  </svg>
                </div>
                <div style={{ flex: "1" }} />
              </>
            }
          >
            <input
              style={{ flex: "1", "min-width": "0", background: "transparent", border: "none", "border-bottom": "var(--studio-border-width, 1px) var(--studio-border-style, solid) currentColor", outline: "none", padding: "0", "line-height": "1", font: "inherit", color: "inherit" }}
              value={editValue()}
              onInput={(e) => setEditValue(e.currentTarget.value)}
              onBlur={commitEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
            />
          </Show>

          <div style={{ display: "flex", "align-items": "center", gap: "0.375rem", "flex-shrink": "0" }}>
            <Show when={additions() > 0}>
              <div style={{ display: "flex", "align-items": "center", gap: "0.125rem" }}>
                <div style={{ height: "6px", "border-radius": "2px", background: "var(--history-addition)", width: `${barWidth(additions(), props.thresholds.large)}px` }} />
                <span style={{ color: "var(--history-addition-fg)", "font-size": "11px", "font-weight": "300" }}>+{additions()}</span>
              </div>
            </Show>
            <Show when={deletions() > 0}>
              <div style={{ display: "flex", "align-items": "center", gap: "0.125rem" }}>
                <div style={{ height: "6px", "border-radius": "2px", background: "var(--history-deletion)", width: `${barWidth(deletions(), props.thresholds.large)}px` }} />
                <span style={{ color: "var(--history-deletion-fg)", "font-size": "11px", "font-weight": "300" }}>-{deletions()}</span>
              </div>
            </Show>
          </div>

          <span style={{ color: "var(--history-muted-fg)", "font-size": "11px", "font-weight": "300", "flex-shrink": "0", width: "3.5rem", "text-align": "right" }}>
            {timeDisplay()}
          </span>
        </div>
      </TimelineCard>

      <Show when={isExpanded()}>
        <div class="history-subitems" style={{ "margin-left": "1rem", "margin-top": "0.25rem", display: "flex", "flex-direction": "column", gap: "0.25rem" }}>
          <For each={subItems()}>
            {(subItem) => {
              const subAdd = () => subItem.additions ?? 0;
              const subDel = () => subItem.deletions ?? 0;
              const subAuthor = () => subItem.authors[0] ?? "";

              return (
                <TimelineCard
                  isSelected={props.isSubItemSelected?.(subItem) ?? false}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onSubItemClick?.(subItem, e);
                  }}
                >
                  <div style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
                    <div
                      title={subAuthor()}
                      style={{
                        background: authorColor(subAuthor()),
                        "font-size": "9px",
                        width: "18px",
                        height: "18px",
                        "border-radius": "50%",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        color: "white",
                        "font-weight": "300",
                        "user-select": "none",
                        "flex-shrink": "0",
                      }}
                    >
                      {getInitials(subAuthor())}
                    </div>

                    <span style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--history-secondary-fg)" }}>
                      {getChangeLabel(subItem, props.thresholds)}
                    </span>

                    <div style={{ display: "flex", "align-items": "center", gap: "0.375rem", "flex-shrink": "0" }}>
                      <Show when={subAdd() > 0}>
                        <div style={{ display: "flex", "align-items": "center", gap: "0.125rem" }}>
                          <div style={{ height: "6px", "border-radius": "2px", background: "var(--history-addition)", width: `${barWidth(subAdd(), props.thresholds.large)}px` }} />
                          <span style={{ color: "var(--history-addition-fg)", "font-size": "11px", "font-weight": "300" }}>+{subAdd()}</span>
                        </div>
                      </Show>
                      <Show when={subDel() > 0}>
                        <div style={{ display: "flex", "align-items": "center", gap: "0.125rem" }}>
                          <div style={{ height: "6px", "border-radius": "2px", background: "var(--history-deletion)", width: `${barWidth(subDel(), props.thresholds.large)}px` }} />
                          <span style={{ color: "var(--history-deletion-fg)", "font-size": "11px", "font-weight": "300" }}>-{subDel()}</span>
                        </div>
                      </Show>
                    </div>

                    <span style={{ color: "var(--history-muted-fg)", "font-size": "11px", "font-weight": "300", "flex-shrink": "0", width: "3.5rem", "text-align": "right" }}>
                      {formatTimeOnly(subItem.endTime)}
                    </span>
                  </div>
                </TimelineCard>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
