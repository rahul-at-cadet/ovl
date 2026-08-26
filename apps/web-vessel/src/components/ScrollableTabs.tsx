'use client';

import { useEffect, useRef } from 'react';

/**
 * Keeps the selected tab visible in a horizontally scrollable strip.
 *
 * The section strips scroll on narrow screens, and a strip that lands scrolled
 * away from the active tab is worse than no strip: on the settings page the
 * selected section sat 349px off the left edge on a phone. Watches the list
 * for selection changes rather than taking the value as a prop, so it works
 * with the uncontrolled tabs this app uses.
 */
export function useScrollActiveTabIntoView<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const list = ref.current;
    if (!list) return;

    const bring = () => {
      const active = list.querySelector<HTMLElement>('[data-active], [aria-selected="true"]');
      if (!active) return;
      if (list.scrollWidth <= list.clientWidth) return;
      const l = list.getBoundingClientRect();
      const a = active.getBoundingClientRect();
      if (a.left < l.left) {
        list.scrollBy({ left: a.left - l.left - 8, behavior: 'auto' });
      } else if (a.right > l.right) {
        list.scrollBy({ left: a.right - l.right + 8, behavior: 'auto' });
      }
    };

    bring();
    const observer = new MutationObserver(bring);
    observer.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-active', 'aria-selected'] });
    return () => observer.disconnect();
  }, []);

  return ref;
}
