import { createSignal, createMemo, createEffect, Show, For, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { makeDocumentProjection } from "solid-automerge";
import { OpenDocumentEvent } from "@inkandswitch/patchwork-elements";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import {
  type PatchworkToolProps,
  type HistoryDoc,
  type HistoryEntry,
} from "./types.ts";
import "./NotebookViewer.css";
import "./index.css";

const LS_INDEX_KEY = "notebook-viewer-current-index";
const LS_STEP_KEY = "notebook-viewer-step-size";
const LS_STEP_MODE_KEY = "notebook-viewer-step-mode";
const LS_TIME_UNIT_KEY = "notebook-viewer-time-unit";
const LS_TIME_AMOUNT_KEY = "notebook-viewer-time-amount";

// Discrete step size options for "entries" mode
const ALL_STEP_SIZES = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

type StepMode = "entries" | "time";
type TimeUnit = "minutes" | "hours" | "days" | "weeks";

const TIME_UNIT_OPTIONS: { unit: TimeUnit; label: string; amounts: number[]; msPerUnit: number }[] = [
  { unit: "minutes", label: "min",   amounts: [1, 5, 15, 30, 60],        msPerUnit: 60 * 1000 },
  { unit: "hours",   label: "hr",    amounts: [1, 2, 4, 6, 8, 12, 24],   msPerUnit: 60 * 60 * 1000 },
  { unit: "days",    label: "day",   amounts: [1, 2, 3, 5, 7],           msPerUnit: 24 * 60 * 60 * 1000 },
  { unit: "weeks",   label: "wk",    amounts: [1, 2, 4, 6, 13, 26, 52], msPerUnit: 7 * 24 * 60 * 60 * 1000 },
];

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Find the index of the entry nearest to targetTimestamp, searching in the given direction. */
function findNearestEntryIndex(
  entries: HistoryEntry[],
  currentIdx: number,
  targetTimestamp: number,
  direction: "back" | "forward"
): number {
  if (direction === "back") {
    // Search backwards from currentIdx for the last entry at or before targetTimestamp
    for (let i = currentIdx - 1; i >= 0; i--) {
      if (entries[i].timestamp <= targetTimestamp) return i;
    }
    return 0; // clamp to first
  } else {
    // Search forwards from currentIdx for the first entry at or after targetTimestamp
    for (let i = currentIdx + 1; i < entries.length; i++) {
      if (entries[i].timestamp >= targetTimestamp) return i;
    }
    return entries.length - 1; // clamp to last
  }
}

export function NotebookViewer(props: PatchworkToolProps<HistoryDoc>) {
  const historyDoc = makeDocumentProjection<HistoryDoc>(props.handle);

  // Entries are already in chronological order (HistoryRecorder appends)
  const entries = createMemo(() => historyDoc.entries || []);
  const totalEntries = createMemo(() => entries().length);

  // Total time span of history in ms
  const historySpanMs = createMemo(() => {
    const e = entries();
    if (e.length < 2) return 0;
    return e[e.length - 1].timestamp - e[0].timestamp;
  });

  // --- Entry step sizes ---
  const availableStepSizes = createMemo(() => {
    const total = totalEntries();
    return ALL_STEP_SIZES.filter((s) => s <= total);
  });

  // --- Time step: available amounts per unit, filtered by history span ---
  const availableTimeAmounts = createMemo(() => {
    const span = historySpanMs();
    const result: Record<TimeUnit, number[]> = {
      minutes: [],
      hours: [],
      days: [],
      weeks: [],
    };
    for (const opt of TIME_UNIT_OPTIONS) {
      result[opt.unit] = opt.amounts.filter((a) => a * opt.msPerUnit <= span);
    }
    return result;
  });

  // Which time units have at least one available amount
  const availableTimeUnits = createMemo(() =>
    TIME_UNIT_OPTIONS.filter((opt) => availableTimeAmounts()[opt.unit].length > 0)
  );

  // --- Load saved state from localStorage ---
  const savedIndexRaw = localStorage.getItem(LS_INDEX_KEY);
  const hasSavedIndex = savedIndexRaw !== null;
  const savedIndex = hasSavedIndex ? parseInt(savedIndexRaw, 10) : -1;
  const savedStepSize = parseInt(localStorage.getItem(LS_STEP_KEY) || "1", 10);
  const savedStepMode = (localStorage.getItem(LS_STEP_MODE_KEY) || "entries") as StepMode;
  const savedTimeUnit = (localStorage.getItem(LS_TIME_UNIT_KEY) || "hours") as TimeUnit;
  const savedTimeAmount = parseInt(localStorage.getItem(LS_TIME_AMOUNT_KEY) || "1", 10);

  const [rawCurrentIndex, setRawCurrentIndex] = createSignal(
    hasSavedIndex && Number.isFinite(savedIndex) ? Math.max(0, savedIndex) : -1
  );
  const [stepSize, setStepSize] = createSignal(
    Number.isFinite(savedStepSize) ? Math.max(1, savedStepSize) : 1
  );
  const [stepMode, setStepMode] = createSignal<StepMode>(savedStepMode);
  const [timeUnit, setTimeUnit] = createSignal<TimeUnit>(savedTimeUnit);
  const [timeAmount, setTimeAmount] = createSignal(
    Number.isFinite(savedTimeAmount) ? Math.max(1, savedTimeAmount) : 1
  );

  // Clamped current index: -1 means "no saved position" → latest entry
  const currentIndex = createMemo(() => {
    const total = totalEntries();
    if (total === 0) return 0;
    const raw = rawCurrentIndex();
    if (raw < 0) return total - 1;
    return Math.min(Math.max(0, raw), total - 1);
  });

  const currentEntry = createMemo(() => {
    const e = entries();
    const idx = currentIndex();
    return e.length > 0 ? e[idx] : undefined;
  });

  const currentDateLabel = createMemo(() => {
    const entry = currentEntry();
    if (!entry) return "";
    return dateTimeFormatter.format(new Date(entry.timestamp));
  });

  const viewDocUrl = createMemo(() => {
    const entry = currentEntry();
    if (!entry) return undefined;
    if (entry.heads && entry.heads.length > 0) {
      return `${entry.docUrl}#${entry.heads.join("|")}` as AutomergeUrl;
    }
    return entry.docUrl;
  });

  const viewToolId = createMemo(() => currentEntry()?.toolId);

  const viewKey = createMemo(() => {
    const url = viewDocUrl();
    const toolId = viewToolId();
    return url ? `${url}-${toolId || "default"}` : undefined;
  });

  // --- Navigation ---
  const canGoBack = createMemo(() => currentIndex() > 0);
  const canGoForward = createMemo(() => {
    const total = totalEntries();
    return total > 0 && currentIndex() < total - 1;
  });

  // Compute time step duration in ms
  const timeStepMs = createMemo(() => {
    const unit = timeUnit();
    const amount = timeAmount();
    const opt = TIME_UNIT_OPTIONS.find((o) => o.unit === unit);
    return opt ? amount * opt.msPerUnit : 0;
  });

  const goBack = () => {
    if (stepMode() === "entries") {
      setRawCurrentIndex(Math.max(0, currentIndex() - stepSize()));
    } else {
      const entry = currentEntry();
      if (!entry) return;
      const targetTs = entry.timestamp - timeStepMs();
      const newIdx = findNearestEntryIndex(entries(), currentIndex(), targetTs, "back");
      setRawCurrentIndex(newIdx);
    }
  };

  const goForward = () => {
    if (stepMode() === "entries") {
      setRawCurrentIndex(Math.min(totalEntries() - 1, currentIndex() + stepSize()));
    } else {
      const entry = currentEntry();
      if (!entry) return;
      const targetTs = entry.timestamp + timeStepMs();
      const newIdx = findNearestEntryIndex(entries(), currentIndex(), targetTs, "forward");
      setRawCurrentIndex(newIdx);
    }
  };

  // --- Entry step size slider helpers ---
  const stepSizeSliderIndex = createMemo(() => {
    const sizes = availableStepSizes();
    const idx = sizes.indexOf(stepSize());
    if (idx >= 0) return idx;
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (sizes[i] <= stepSize()) return i;
    }
    return 0;
  });

  const updateStepSizeFromSlider = (sliderIndex: number) => {
    const sizes = availableStepSizes();
    const clamped = Math.max(0, Math.min(sliderIndex, sizes.length - 1));
    setStepSize(sizes[clamped] || 1);
  };

  // --- Time amount slider helpers ---
  const currentTimeAmounts = createMemo(() => availableTimeAmounts()[timeUnit()] || []);

  const timeAmountSliderIndex = createMemo(() => {
    const amounts = currentTimeAmounts();
    const idx = amounts.indexOf(timeAmount());
    if (idx >= 0) return idx;
    for (let i = amounts.length - 1; i >= 0; i--) {
      if (amounts[i] <= timeAmount()) return i;
    }
    return 0;
  });

  const updateTimeAmountFromSlider = (sliderIndex: number) => {
    const amounts = currentTimeAmounts();
    const clamped = Math.max(0, Math.min(sliderIndex, amounts.length - 1));
    setTimeAmount(amounts[clamped] || 1);
  };

  // Format the time step display label
  const timeStepLabel = createMemo(() => {
    const amount = timeAmount();
    const unit = timeUnit();
    const opt = TIME_UNIT_OPTIONS.find((o) => o.unit === unit);
    if (!opt) return "";
    const label = amount === 1 ? opt.label : opt.label + "s";
    return `${amount} ${label}`;
  });

  const goToFirst = () => setRawCurrentIndex(0);
  const goToLatest = () => setRawCurrentIndex(totalEntries() - 1);

  // --- Playback ---
  const [isPlaying, setIsPlaying] = createSignal(false);
  const [playDirection, setPlayDirection] = createSignal<"forward" | "reverse">("forward");
  let playIntervalId: number | undefined;

  const stopPlayback = () => {
    setIsPlaying(false);
    if (playIntervalId !== undefined) {
      clearInterval(playIntervalId);
      playIntervalId = undefined;
    }
  };

  const togglePlayback = () => {
    if (isPlaying()) {
      stopPlayback();
    } else {
      setIsPlaying(true);
      playIntervalId = window.setInterval(() => {
        const dir = playDirection();
        if (dir === "forward") {
          if (!canGoForward()) {
            stopPlayback();
            return;
          }
          goForward();
        } else {
          if (!canGoBack()) {
            stopPlayback();
            return;
          }
          goBack();
        }
      }, 1000);
    }
  };

  onCleanup(stopPlayback);

  // --- Open Document ---
  const [showVersionDropdown, setShowVersionDropdown] = createSignal(false);

  // Check if the current entry has saved heads (meaning it's a snapshot from a point in time).
  // If it has heads, we offer the choice of opening "this version" vs "latest version".
  const hasHeads = createMemo(() => {
    const entry = currentEntry();
    return !!(entry && entry.heads && entry.heads.length > 0);
  });

  const openDocument = (useLatest: boolean) => {
    const entry = currentEntry();
    if (!entry) return;

    let url: AutomergeUrl;
    if (useLatest || !entry.heads || entry.heads.length === 0) {
      url = entry.docUrl;
    } else {
      url = `${entry.docUrl}#${entry.heads.join("|")}` as AutomergeUrl;
    }

    props.element.dispatchEvent(
      new OpenDocumentEvent({
        url,
        toolId: entry.toolId,
      })
    );

    setShowVersionDropdown(false);
  };

  const handleOpenDocClick = () => {
    if (hasHeads()) {
      setShowVersionDropdown((v) => !v);
    } else {
      openDocument(true);
    }
  };

  // Close dropdown when clicking outside
  const onClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".notebook-viewer-open-doc")) {
      setShowVersionDropdown(false);
    }
  };

  document.addEventListener("click", onClickOutside);
  onCleanup(() => document.removeEventListener("click", onClickOutside));

  // Keyboard navigation
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goBack();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goForward();
    }
  };

  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  // Persist state to localStorage
  createEffect(() => localStorage.setItem(LS_INDEX_KEY, String(currentIndex())));
  createEffect(() => localStorage.setItem(LS_STEP_KEY, String(stepSize())));
  createEffect(() => localStorage.setItem(LS_STEP_MODE_KEY, stepMode()));
  createEffect(() => localStorage.setItem(LS_TIME_UNIT_KEY, timeUnit()));
  createEffect(() => localStorage.setItem(LS_TIME_AMOUNT_KEY, String(timeAmount())));

  // Arrow tooltip text
  const stepDescription = createMemo(() => {
    if (stepMode() === "entries") {
      const s = stepSize();
      return `${s} ${s === 1 ? "entry" : "entries"}`;
    }
    return timeStepLabel();
  });

  return (
    <div class="notebook-viewer">
      <Show
        when={totalEntries() > 0}
        fallback={
          <div class="notebook-viewer-empty">
            No history entries yet. Open some documents to start tracking history.
          </div>
        }
      >
        {/* Playback controls — floating top-left */}
        <div class="notebook-viewer-playback">
          {/* Direction toggle */}
          <div
            class="notebook-viewer-direction-toggle"
            onClick={() => setPlayDirection((d) => d === "forward" ? "reverse" : "forward")}
            title={`Direction: ${playDirection()}`}
          >
            <span class={`notebook-viewer-direction-option ${playDirection() === "reverse" ? "active" : ""}`}>
              Rev
            </span>
            <span class={`notebook-viewer-direction-option ${playDirection() === "forward" ? "active" : ""}`}>
              Fwd
            </span>
            <div class={`notebook-viewer-direction-thumb ${playDirection() === "forward" ? "right" : "left"}`} />
          </div>

          {/* Play/Pause button */}
          <button
            class="notebook-viewer-play-button"
            onClick={togglePlayback}
            title={isPlaying() ? "Pause" : "Play"}
          >
            <Show when={!isPlaying()}>
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
                fill="currentColor" stroke="none">
                <polygon points="6 3 20 12 6 21" />
              </svg>
            </Show>
            <Show when={isPlaying()}>
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
                fill="currentColor" stroke="none">
                <rect x="5" y="3" width="5" height="18" />
                <rect x="14" y="3" width="5" height="18" />
              </svg>
            </Show>
          </button>
        </div>

        {/* Open document — floating top-right */}
        <div class="notebook-viewer-open-doc">
          <button
            class="notebook-viewer-open-doc-button"
            onClick={handleOpenDocClick}
            title="Open this document"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Open document
          </button>

          <Show when={showVersionDropdown()}>
            <div class="notebook-viewer-version-dropdown">
              <button
                class="notebook-viewer-version-option"
                onClick={() => openDocument(true)}
              >
                Latest version
              </button>
              <button
                class="notebook-viewer-version-option"
                onClick={() => openDocument(false)}
              >
                This version
              </button>
            </div>
          </Show>
        </div>

        {/* Timeline controls */}
        <div class="notebook-viewer-timeline">
          <div class="notebook-viewer-date-label">{currentDateLabel()}</div>
          <div class="notebook-viewer-timeline-row">
            <button
              class="notebook-viewer-timeline-label"
              onClick={goToFirst}
              title="Go to first entry"
            >
              First
            </button>
            <input
              type="range"
              class="notebook-viewer-timeline-slider"
              min={0}
              max={totalEntries() - 1}
              value={currentIndex()}
              onInput={(e) => setRawCurrentIndex(parseInt(e.currentTarget.value, 10))}
            />
            <button
              class="notebook-viewer-timeline-label"
              onClick={goToLatest}
              title="Go to latest entry"
            >
              Latest
            </button>
          </div>
        </div>

        {/* Page area with arrow buttons */}
        <div class="notebook-viewer-page-area">
          <button
            class="notebook-viewer-arrow"
            onClick={goBack}
            disabled={!canGoBack()}
            aria-label="Go back"
            title={`Go back ${stepDescription()}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <div class="notebook-viewer-page">
            <Show when={viewKey()} keyed>
              {(_key) => (
                <patchwork-view
                  doc-url={viewDocUrl()!}
                  tool-id={viewToolId()!}
                />
              )}
            </Show>
          </div>

          <button
            class="notebook-viewer-arrow"
            onClick={goForward}
            disabled={!canGoForward()}
            aria-label="Go forward"
            title={`Go forward ${stepDescription()}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        {/* Bottom controls */}
        <div class="notebook-viewer-bottom">
          <div class="notebook-viewer-step-row">
            {/* Step mode dropdown */}
            <select
              class="notebook-viewer-select"
              value={stepMode()}
              onChange={(e) => setStepMode(e.currentTarget.value as StepMode)}
            >
              <option value="entries">Step by entries</option>
              <option value="time">Step by time</option>
            </select>

            {/* Time unit dropdown (only in time mode) */}
            <Show when={stepMode() === "time"}>
              <select
                class="notebook-viewer-select"
                value={timeUnit()}
                onChange={(e) => {
                  const unit = e.currentTarget.value as TimeUnit;
                  setTimeUnit(unit);
                  const amounts = availableTimeAmounts()[unit];
                  if (amounts.length > 0 && !amounts.includes(timeAmount())) {
                    setTimeAmount(amounts[0]);
                  }
                }}
              >
                <For each={availableTimeUnits()}>
                  {(opt) => (
                    <option value={opt.unit}>{opt.unit}</option>
                  )}
                </For>
              </select>
            </Show>

            {/* Slider + value for entries mode */}
            <Show when={stepMode() === "entries"}>
              <input
                type="range"
                class="notebook-viewer-step-slider"
                min={0}
                max={Math.max(0, availableStepSizes().length - 1)}
                value={stepSizeSliderIndex()}
                onInput={(e) => updateStepSizeFromSlider(parseInt(e.currentTarget.value, 10))}
              />
              <span class="notebook-viewer-step-value">{stepSize()}</span>
            </Show>

            {/* Slider + value for time mode */}
            <Show when={stepMode() === "time" && currentTimeAmounts().length > 0}>
              <input
                type="range"
                class="notebook-viewer-step-slider"
                min={0}
                max={Math.max(0, currentTimeAmounts().length - 1)}
                value={timeAmountSliderIndex()}
                onInput={(e) => updateTimeAmountFromSlider(parseInt(e.currentTarget.value, 10))}
              />
              <span class="notebook-viewer-step-value">{timeStepLabel()}</span>
            </Show>
          </div>

          <div class="notebook-viewer-entry-info">
            <span class="notebook-viewer-entry-info-position">
              Entry {currentIndex() + 1} of {totalEntries()}
            </span>
            <span>{currentEntry()?.docTitle}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}

export const renderNotebookViewer: ToolImplementation<HistoryDoc> = (
  handle,
  element
) => render(() => <NotebookViewer handle={handle} repo={element.repo} element={element} />, element);
