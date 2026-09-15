import type React from "react";

/** Assign `node` to every ref, whether callback or object refs. */
export function assignRefs<T>(
  node: T | null,
  ...refs: (React.Ref<T> | undefined)[]
) {
  for (const ref of refs) {
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as React.RefObject<T | null>).current = node;
  }
}

/** Run the hook's handler, then the caller's (if any), with the same event. */
export function composeHandlers<E>(
  ours: (e: E) => void,
  theirs: ((e: E) => void) | undefined,
): (e: E) => void {
  return (e) => {
    ours(e);
    theirs?.(e);
  };
}
