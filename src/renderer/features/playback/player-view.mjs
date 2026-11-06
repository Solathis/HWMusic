export const SHELL_VIEW_KEYS = Object.freeze(["entries", "index", "track", "offlineIds"]);

export function selectShellView(state) {
  return {
    entries: state.entries,
    index: state.index,
    track: state.track,
    offlineIds: state.offlineIds,
  };
}

function sameSelection(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
}

export function createSelectorCache(select) {
  let previousState;
  let previousSelection;
  let initialized = false;

  return (state) => {
    if (initialized && Object.is(state, previousState)) return previousSelection;
    const selection = select(state);
    if (initialized && sameSelection(selection, previousSelection)) {
      previousState = state;
      return previousSelection;
    }
    previousState = state;
    previousSelection = selection;
    initialized = true;
    return selection;
  };
}
