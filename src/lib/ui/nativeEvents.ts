/** Native listeners survive a subtree moving to an inert utility window.
 * Svelte's delegated event root stays in the original application's document. */
export function nativeEvent<K extends keyof HTMLElementEventMap>(name: K) {
  return (node: HTMLElement, initial?: (event: HTMLElementEventMap[K]) => void) => {
    let callback = initial;
    const listener = (event: HTMLElementEventMap[K]) => callback?.(event);
    node.addEventListener(name, listener);
    return {
      update(next?: (event: HTMLElementEventMap[K]) => void) { callback = next; },
      destroy() { node.removeEventListener(name, listener); },
    };
  };
}
export const nativeClick = nativeEvent("click");
export const nativeDoubleClick = nativeEvent("dblclick");
export const nativePointerDown = nativeEvent("pointerdown");
export const nativePointerMove = nativeEvent("pointermove");
export const nativePointerUp = nativeEvent("pointerup");
export const nativeScroll = nativeEvent("scroll");
export const nativeError = nativeEvent("error");
