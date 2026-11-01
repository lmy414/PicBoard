import { useEffect, useState } from "react";
import { sidebarLayout, topbarLayout, type SidebarLayout, type TopbarLayout } from "./breakpoints";

export interface WindowLayout {
  sidebar: SidebarLayout;
  topbar: TopbarLayout;
}

function windowLayoutBuckets(windowWidth: number): WindowLayout {
  return { sidebar: sidebarLayout(windowWidth), topbar: topbarLayout(windowWidth) };
}

/**
 * Window-width buckets for the shell. The state only changes when a bucket
 * boundary is crossed, so window resizes never re-render per frame.
 */
export function useWindowLayout(): WindowLayout {
  const [layout, setLayout] = useState<WindowLayout>(() => windowLayoutBuckets(typeof window !== "undefined" ? window.innerWidth : 0));
  useEffect(() => {
    const measure = () => setLayout((current) => {
      const next = windowLayoutBuckets(window.innerWidth);
      return next.sidebar === current.sidebar && next.topbar === current.topbar ? current : next;
    });
    measure();
    window.addEventListener("resize", measure);
    // The main window can be created hidden at a placeholder size and resized
    // or shown later; the document element observer re-measures whenever the
    // viewport box actually changes, so buckets never stick to a 0-width read.
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);
  return layout;
}

