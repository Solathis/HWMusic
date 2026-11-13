/** Visibility revisions belong to the popup, not the lyric/config owner. */
export function createPresentationAcceptor(apply) {
  let revision = -1;
  let visible = false;
  return (payload) => {
    if (!payload || typeof payload.visible !== "boolean" || !Number.isSafeInteger(payload.revision)
      || payload.revision <= revision || payload.revision < 0) return false;
    revision = payload.revision;
    if (payload.visible !== visible) { visible = payload.visible; apply(visible); }
    return true;
  };
}
