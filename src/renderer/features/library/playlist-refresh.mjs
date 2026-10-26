/**
 * 「歌单变了」的刷新入口（R62）：加歌这类写操作发生在内容区，拿不到侧栏的闭包，
 * 所以侧栏订阅这里、写成功之后调 `notifyPlaylistsChanged()` 重取一次。
 * 通知前先快照订阅者：回调里退订/再订阅都不会打乱这一轮遍历。
 */
const listeners = new Set();

/** @returns {() => void} 退订（组件卸载时调） */
export function onPlaylistsChanged(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyPlaylistsChanged() {
  for (const listener of [...listeners]) listener();
}
