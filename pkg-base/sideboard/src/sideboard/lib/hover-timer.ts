/**
 * "Hold a drag over this for `ms` and something happens": spring-loading a
 * document, or opening a folder. `start` on every dragover is fine — it only
 * arms once, and after it fires it stays quiet until `stop` (the drag left).
 */
export function createHoverTimer(ms: number, fire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  return {
    /** true if this call armed the timer */
    start(): boolean {
      if (timer || fired) return false;
      timer = setTimeout(() => {
        timer = undefined;
        fired = true;
        fire();
      }, ms);
      return true;
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      fired = false;
    },
  };
}
